// server.ts
// Servidor HTTP para el ESP32: recibe audio grabado, transcribe, genera
// respuesta con Ivi, y devuelve audio MP3 listo para decodificar en el ESP32.
//
// V1 (ahora): POST /api/touch — el ESP32 manda audio y recibe audio de vuelta.
// V2 (futuro): WebSocket para streaming bidireccional en tiempo real.

import "dotenv/config";
import path from "path";
import fs from "fs";
import express from "express";
import { transcribirAudio } from "./stt";
import {
  generarRespuesta,
  extraerHechos,
  sugiereExtraerHechos,
  resumenModelos,
  FRASES_EMERGENCIA,
  esFraseEmergencia,
} from "./llm";
import { generarAudioMP3, generarAudioMP3Cacheado, precachearFrases, setFallbackAudio, setFallbackNoAudio, obtenerFallbackNoAudio } from "./tts";
import { inicializarDB, obtenerHechos, guardarHecho } from "./memoria";
import { inicializarCopilotDB, obtenerUltimoEstado } from "./copilot/store";
import { construirContextoCopilot, proyectoCopilot } from "./copilot/contexto";
import { registrarTurno as registrarTurnoExp, condicionActual } from "./copilot/instrument";
import {
  inicializarHistorial,
  abrirConversacion,
  agregarMensajeHistorial,
  listarHistorial,
} from "./historial";
import { deviceRouter } from "./deviceRoutes";
import { copilotRouter } from "./copilot/routes";
import { loginAdmin, logoutAdmin, diagnosticoAuth, requireAdmin } from "./auth";
import {
  obtenerSesion,
  agregarMensaje,
  quitarUltimoMensajeUsuario,
  Session,
} from "./session";

const app = express();
// Confiar en el X-Forwarded-For de los proxies (Render) para que req.ip sea la
// IP real del ESP32 y las sesiones queden aisladas por dispositivo.
app.set("trust proxy", true);
const PORT = parseInt(process.env.PORT || "3000", 10);
// El ESP32 hace http.setTimeout(65000) en el POST /api/touch: si el server se
// pasa, el device cierra el socket y el turno se pierde. Este deadline es el
// tope de TODO el turno (STT ya corrido + LLM + TTS) y se comparte entre las
// dos etapas. 45s deja 20s de margen para latencia de red y arranque en frío.
const DEADLINE_TURNO_MS = parseInt(process.env.TURNO_DEADLINE_MS || "45000", 10);

// Body parser para audio crudo (ESP32 envía POST con Content-Type: audio/wav)
app.use("/api/touch", express.raw({ type: "audio/wav", limit: "10mb" }));

// JSON para el portal admin y la API de redes WiFi
app.use(express.json());

// Portal web (login + panel de redes WiFi)
app.post("/admin/login", loginAdmin);
app.post("/admin/logout", logoutAdmin);
// Diagnóstico de sesión: responde lo que llegó en ESTE request (sin exigir
// auth) para que el panel muestre por qué el navegador fue rechazado.
app.get("/admin/diag", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(diagnosticoAuth(_req));
});
// extensions: permite acceder /admin -> admin.html y /login -> login.html
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// API de dispositivos / redes (Prisma + PostgreSQL)
app.use(deviceRouter);

// Estado del copiloto: lo manda el plugin de OpenCode. Token propio,
// independiente del panel admin. Va ANTES del chat para que un payload
// invalido nunca llegue al LLM.
app.use("/api/copilot", copilotRouter);

// Historial de conversaciones (admin): últimas 50 conversaciones con sus
// mensajes, para la web /historial. Solo lectura.
app.get("/api/historial", requireAdmin, async (_req, res) => {
  try {
    const conversaciones = await listarHistorial(50);
    if (conversaciones === null) {
      res.status(503).json({ error: "Historial no disponible (Turso no configurado)" });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json({ conversaciones });
  } catch (err: any) {
    console.error("[historial] Error leyendo historial:", err?.message ?? err);
    res.status(500).json({ error: "Error leyendo historial" });
  }
});

// --- Memoria persistente ---
let contextoHechos = "";

// MP3 de emergencia: se cargan UNA vez al arrancar para que Ivi SIEMPRE tenga
// audio que reproducir (TTS caído o transcripción vacía -> frase cachada, no
// silencio). No dependen de ningún servicio externo en runtime.
function cargarFallbacksMp3() {
  const assets = path.join(__dirname, "assets");
  for (const [nombre, setter] of [
    ["fallback_audio", setFallbackAudio],
    ["fallback_noaudio", setFallbackNoAudio],
  ] as const) {
    try {
      setter(fs.readFileSync(path.join(assets, `${nombre}.mp3`)));
      console.log(`[assets] MP3 de emergencia cargado: ${nombre}.mp3`);
    } catch (err: any) {
      console.error(`[assets] No se pudo cargar ${nombre}.mp3:`, err.message);
    }
  }
}
cargarFallbacksMp3();

/**
 * Deja un valor listo para viajar en un header HTTP. Node lanza
 * ERR_INVALID_CHAR con cualquier carácter fuera de Latin-1: una raya (—), una
 * comilla tipográfica o una flecha en la respuesta de Ivi tumbaban el turno
 * entero con 500 y sin audio. Acá se reemplazan por su equivalente ASCII. El
 * texto limpio se pierde solo en el header (lo que se ESCUCHA es el MP3, que
 * ya va sintetizado con la ortografía correcta).
 */
function headerSeguro(valor: string): string {
  return valor
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E¡¿áéíóúüñÁÉÍÓÚÜÑ]/g, "?")
    .slice(0, 900);
}

/** ¿El cliente ya se fue y la respuesta ya no se puede enviar? */
function clienteSeFue(res: express.Response): boolean {
  return res.headersSent || res.writableEnded || res.destroyed;
}

// Precalientamos las frases de emergencia: son la respuesta más frecuente
// cuando Groq no tiene cuota diaria, y así salen al instante y con la misma
// voz de Ivi. Va en background: no detiene el arranque.
precachearFrases(FRASES_EMERGENCIA);

async function initMemory() {
  try {
    await inicializarDB();
    await inicializarHistorial();
    await inicializarCopilotDB();
    const hechos = await obtenerHechos();
    if (hechos.length > 0) {
      contextoHechos =
        "\n\nESTO ES LO QUE SABES DE LA PERSONA (úsalo con naturalidad, solo cuando venga al caso, nunca lo repitas como si fuera una lista):\n" +
        hechos.map((h) => `- ${h}`).join("\n");
    }
  } catch (err: any) {
    console.error("No se pudo conectar a Turso (memoria deshabilitada):", err.message);
  }
}

// --- Historial persistente (Turso) ---
// Registra un turno (usuario + Ivi) en fire-and-forget: abre la conversación
// si aún no existe (sesion.id) y encola los INSERT sin bloquear la respuesta
// de audio. Si Turso no está, no-op con log — nunca rompe el server. Acepta
// sesión ya obtenida para reutilizar su conversación; si viene undefined la
// obtiene sola (turnos que terminan antes del bloque de sesión, ej. eco).
function guardarEnHistorial(
  clave: string,
  sesionAnterior: Session | undefined,
  textoUsuario?: string,
  textoIvi?: string
): void {
  const sesion = sesionAnterior ?? obtenerSesion(clave);
  (async () => {
    try {
      if (sesion.id == null) sesion.id = await abrirConversacion(clave);
      if (sesion.id == null) return;
      if (textoUsuario) await agregarMensajeHistorial(sesion.id, "user", textoUsuario);
      if (textoIvi) await agregarMensajeHistorial(sesion.id, "assistant", textoIvi);
    } catch (err: any) {
      console.error("[historial] Error guardando turno:", err?.message ?? err);
    }
  })();
}

// Registro del experimento: pregunta/respuesta/latencia/condición, para poder
// comparar "Ivi con contexto de OpenCode" contra "Ivi sin nada".
function registrarTurno(
  clave: string,
  sesionAnterior: Session | undefined,
  textoUsuario?: string,
  textoIvi?: string,
  extra?: {
    llmMs?: number;
    contextoCopilot?: string | null;
    emocion?: string;
    emergency?: boolean;
    condicion?: "ivi" | "agentes" | "prueba";
  }
): void {
  guardarEnHistorial(clave, sesionAnterior, textoUsuario, textoIvi);
  try {
    registrarTurnoExp({
      ts: new Date().toISOString(),
      condicion: extra?.condicion ?? condicionActual(),
      sesion_ivi: clave,
      pregunta: textoUsuario ?? "",
      respuesta: textoIvi ?? "",
      emocion: extra?.emocion ?? "",
      latencia_ms: Date.now() - (sesionAnterior?.inicioTurno ?? Date.now()),
      llm_ms: extra?.llmMs,
      copilot: Boolean(extra?.contextoCopilot),
      chars_contexto: extra?.contextoCopilot?.length,
      emergency: extra?.emergency,
    });
  } catch (err: any) {
    console.warn("[instrument] fallo al registrar:", err?.message ?? err);
  }
}

// --- Health check ---
// Endpoint de "despertar"/healthcheck para Render: NO toca base de datos ni
// servicios de IA. Responde 200 "ok" lo más rápido posible (cold start de
// Render + chequeo de vida del free tier que duerme a los 15 min).
app.get("/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(200).send("ok");
});

/**
 * Condición del experimento A/B para ESTE turno.
 *
 * scripts/preguntar.mjs marca sus POSTs con `x-ivi-prueba` porque el server
 * corre en otro proceso (Render) y un IVI_CONDICION exportado en mi terminal
 * no llega ahí. Sin este header, una pregunta de prueba cae en "ivi" por el
 * default y contamina el log que el experimento está midiendo.
 */
function condicionDelTurno(req: express.Request): "ivi" | "agentes" | "prueba" {
  return req.headers["x-ivi-prueba"] ? "prueba" : condicionActual();
}

/**
 * energiaAudio: mide la energía real (RMS) de un WAV PCM 16-bit recibido.
 * Sirve para DISTINGUIR tres casos que Groq no puede distinguir por sí solo:
 *   - ECO/SILENCIO  → RMS bajo  (Groq alucina "Gracias.", "¡Suscríbase!", …)
 *   - VOZ CERCANA   → RMS alto con picos irregulares (la tuya)
 *   - RUIDO/AMBIENTE→ RMS medio plano (TV, vibración de placa)
 * Si el RMS es demasiado bajo, el server NO tiene por qué gastar una llamada
 * a Groq: responde "no te escuché" y le pide que acerque el micrófono.
 */
function energiaAudio(buf: Buffer): number | null {
  try {
    const hdr = 44; // 16-bit PCM WAV (el ESP manda cabecera completa)
    const data = buf;
    if (data.length <= hdr + 2) return null;
    // ignoramos la cabecera y mostreamos un trozo central (la voz en medio)
    let sum = 0;
    let n = 0;
    const inicio = hdr;
    const fin = data.length;
    // muestreamos 1 de cada 4 samples para velocidad; consideramos mono
    for (let i = inicio; i < fin - 1; i += 2) {
      const s16 = data.readInt16LE(i);
      sum += s16 * s16;
      n++;
    }
    if (n === 0) return null;
    return Math.sqrt(sum / n);
  } catch (_e) {
    return null;
  }
}

// --- Endpoint principal: audio → audio ---
// POST /api/touch
//   Body: audio WAV/PCM crudo (Content-Type: audio/wav)
//   Responde:
//     Headers: X-Ivi-Texto, X-Ivi-Emocion
//     Body: MP3 (24kHz, mono) — el ESP32 decodifica con ESP8266Audio antes de I2S → MAX98357
app.post("/api/touch", async (req, res) => {
  const inicio = Date.now();
  const audioBuffer = req.body as Buffer;

  if (!audioBuffer || audioBuffer.length === 0) {
    res.status(400).json({ error: "No se recibió audio" });
    return;
  }

  const claveCliente = req.ip ?? req.socket.remoteAddress ?? "desconocido";
  console.log(`[touch] Audio recibido: ${audioBuffer.length} bytes`);
  // DIAGNOSTICO: copia permanente del ULTIMO PTT tal cual lo oye Groq, para
  // que podamos analizar su perfil de energia (eco al inicio vs voz fresca).
  try { require("fs").writeFileSync("/tmp/last_ptt.wav", audioBuffer); } catch (_e) {}

  // VALIDACIÓN DE VOZ: si el clip es silencio puro / ruido sin voz, Groq
  // alucina frases ("Gracias.", "¡Suscríbase!", "vibración de una placa")
  // sobre el ambiente. Mido la energía real del PCM (16-bit WAV) y exijo
  // un mínimo de "voz activa" ANTES de gastar una llamada a Groq.
  try {
    const rms = energiaAudio(audioBuffer);
    if (rms !== null && rms < 300) {
      console.log(`[touch] Audio sin VOZ real (RMS=${rms}) → no se llama a Groq`);
      const mp3 = await generarAudioMP3("No te escuché, acerca el micrófono a tu boca y repite.");
      res.set({
        "Content-Type": "audio/mpeg",
        "X-Ivi-Texto": "No te escuché, acerca el micrófono a tu boca y repite.",
        "X-Ivi-Emocion": "neutral",
      });
      res.send(mp3);
      registrarTurno(
        claveCliente,
        undefined,
        "(silencio o eco, sin transcripción)",
        "No te escuché, acerca el micrófono a tu boca y repite.",
        { condicion: condicionDelTurno(req) }
      );
      return;
    }
    console.log(`[touch] Audio con VOZ (RMS=${rms}) → Groq`);
  } catch (_e) {}

  // 1. Transcribir audio → texto
  const textoUsuario = await transcribirAudio(audioBuffer);
  if (!textoUsuario) {
    // En vez de 422 (silencio en el ESP32), responder con el MP3 de emergencia:
    // Ivi pide que repitan, audible, en lugar de quedarse muda.
    console.log("[touch] STT vacío/fallido → MP3 de emergencia (audible)");
    const fallbackStt = obtenerFallbackNoAudio();
    if (fallbackStt) {
      res.set({
        "Content-Type": "audio/mpeg",
        "X-Ivi-Texto": "No te escuché bien, repetí lo que me dijiste, porfa.",
        "X-Ivi-Emocion": "neutral",
      });
      res.send(fallbackStt);
    } else {
      res.status(422).json({ error: "No se pudo transcribir el audio" });
    }
    registrarTurno(
      claveCliente,
      undefined,
      "(audio sin transcripción)",
      fallbackStt
        ? "No te escuché bien, repetí lo que me dijiste, porfa."
        : "(fallo STT sin audio de respaldo)",
      { condicion: condicionDelTurno(req) }
    );
    return;
  }
  console.log(`[touch] Transcripción: "${textoUsuario}" (${Date.now() - inicio}ms)`);

  // 2. Sesión de conversación: cada cliente tiene su historial en memoria.
  //    Se abre de cero si pasó SESSION_IDLE_MS (default 15 min) sin hablar.
  const sesion = obtenerSesion(claveCliente);
  // La instrumentación necesita el inicio del turno para medir la latencia
  // real de la request completa (no solo la del LLM).
  sesion.inicioTurno = inicio;
  agregarMensaje(sesion, { role: "user", content: textoUsuario });
  console.log(
    `[touch] Sesión ${claveCliente}: historial de ${sesion.historial.length} mensaje(s)`
  );

  // 3. Generar respuesta de Ivi con el historial completo de la sesión.
  //    El deadline es ABSOLUTO y se comparte con el TTS: el ESP32 aborta a los
  //    65s, así que todo el turno (LLM + síntesis) tiene que caber ahí con
  //    holgura. Antes el peor caso era 40s de LLM + 78s de TTS = 118s y el
  //    device se iba antes de oír nada.
  const deadline = inicio + DEADLINE_TURNO_MS;

  // 3b. Contexto del copiloto: qué está haciendo OpenCode en la otra pantalla.
  //     Se lee de libsql, no de memoria: el estado lo manda el plugin de
  //     OpenCode y esta sesion puede no existir todavia.
  //     Cualquier falla aqui se come sola. Perder contexto del copiloto NUNCA
  //     puede tumbar una respuesta de voz.
  let contextoCopilot: string | null = null;
  try {
    const estadoCopilot = await obtenerUltimoEstado(proyectoCopilot());
    contextoCopilot = construirContextoCopilot(estadoCopilot);
    if (contextoCopilot) {
      console.log(
        `[copilot] contexto inyectado (${contextoCopilot.length} chars) ` +
          `de la sesion ${estadoCopilot!.session_id.slice(0, 12)}…`
      );
    } else {
      console.log("[copilot] sin contexto usable (sin estado o muy viejo)");
    }
  } catch (err: any) {
    console.warn("[copilot] No se pudo obtener contexto:", err?.message ?? err);
  }

  const respuesta = await generarRespuesta(
    sesion.historial,
    contextoHechos,
    deadline,
    contextoCopilot
  );
  console.log(`[touch] Ivi [${respuesta.emocion}]: ${respuesta.texto} (${Date.now() - inicio}ms)`);
  const llmMs = Date.now() - inicio;

  // 4. Generar audio MP3 y agregar la respuesta al historial SOLO si se
  //    logró producir el audio (si no, el usuario no la oyó y mejor que la
  //    conversación no la recuerde).
  let motivoEmergencia: string | null = null;
  try {
    // Las frases de emergencia van por el cache precalentado: salen al
    // instante y con la misma voz de Ivi que cualquier respuesta normal.
    const mp3Buffer = esFraseEmergencia(respuesta.texto)
      ? await generarAudioMP3Cacheado(respuesta.texto, deadline)
      : await generarAudioMP3(respuesta.texto, undefined, (m) => {
          motivoEmergencia = m;
        }, deadline);

    // Si el TTS se cayó y servimos audio de emergencia, el usuario NO oyó la
    // respuesta real: headers e historial cuentan la verdad (lo que sonó).
    const TEXTO_EMERGENCIA = "Se me cortó la señal, decímelo otra vez";
    const textoOido = motivoEmergencia
      ? `${TEXTO_EMERGENCIA} (audio de emergencia: ${motivoEmergencia})`
      : respuesta.texto;

    // Responder con audio como body y texto/emoción en headers.
    // OJO: el texto va en un header, y Node lanza ERR_INVALID_CHAR con
    // cualquier carácter fuera de Latin-1 (raya, comilla tipográfica...). Eso
    // tumbaba el turno con 500 y dejaba la request colgada, así que aquí se
    // limpia SIEMPRE, sin importar qué haya inventado el modelo.
    res.set({
      "Content-Type": "audio/mpeg",
      "X-Ivi-Texto": headerSeguro(textoOido),
      "X-Ivi-Emocion": headerSeguro(respuesta.emocion),
      "X-Ivi-Audio-Length": String(mp3Buffer.length),
    });
    // Diagnostico SOLO para scripts/preguntar.mjs. En una respuesta rara hay
    // que separar "el modelo alucino" de "Whisper no entendio lo que dijiste",
    // y eso solo se ve con la transcripcion y con si entro el contexto. El
    // ESP32 no manda el header, asi que no recibe nada de esto.
    if (req.headers["x-ivi-prueba"]) {
      res.set({
        "X-Ivi-STT": headerSeguro(textoUsuario),
        "X-Ivi-Copilot": contextoCopilot ? "si" : "no",
        "X-Ivi-Contexto-Chars": String(contextoCopilot?.length ?? 0),
      });
    }
    res.send(mp3Buffer);
    console.log(`[touch] Respuesta enviada: ${mp3Buffer.length} bytes MP3 (${Date.now() - inicio}ms total)`);

    if (!motivoEmergencia) {
      agregarMensaje(sesion, { role: "assistant", content: respuesta.texto });
    } else {
      // La frase de emergencia NO entra como respuesta real del hilo: la
      // persona no la oyó, meterla contaminaría la conversación.
      quitarUltimoMensajeUsuario(sesion);
      console.log(`[touch] TTS en emergencia (${motivoEmergencia}): sin audio real para la persona`);
    }
    registrarTurno(claveCliente, sesion, textoUsuario, textoOido, {
      llmMs,
      contextoCopilot,
      emocion: respuesta.emocion,
      emergency: Boolean(motivoEmergencia),
      condicion: condicionDelTurno(req),
    });
  } catch (err: any) {
    // Si la respuesta ya se había enviado (o el device colgó antes de los
    // 65s), el error NO es del TTS: antes se guardaba como "error de audio" y
    // llenaba el historial de falsos positivos.
    if (clienteSeFue(res)) {
      console.warn(
        `[touch] El cliente ya no está (${Date.now() - inicio}ms), el audio llegó tarde: ${err.message}`
      );
      if (!motivoEmergencia) agregarMensaje(sesion, { role: "assistant", content: respuesta.texto });
      registrarTurno(claveCliente, sesion, textoUsuario, respuesta.texto, {
        llmMs,
        contextoCopilot,
        emocion: respuesta.emocion,
        condicion: condicionDelTurno(req),
      });
      return;
    }
    console.error("[touch] Error generando audio:", err.message);
    // Ivi no pudo responder: quitar la pregunta del historial para que no
    // quede como "contexto fantasma" que contamine la próxima pregunta.
    quitarUltimoMensajeUsuario(sesion);
    registrarTurno(claveCliente, sesion, textoUsuario, "(no llegó a hablar: error de audio)", {
      llmMs,
      contextoCopilot,
      emergency: true,
      condicion: condicionDelTurno(req),
    });
    // SIEMPRE respondemos algo: si no, el ESP32 se queda esperando hasta que
    // su propio timeout de 65s y la request queda colgada en el servidor.
    if (!res.headersSent) {
      res.status(500).json({ error: "Error generando audio" });
    } else {
      res.end();
    }
    return;
  }

  // 5. Extraer hechos en background (fire-and-forget) SOLO cuando la frase del
  //    usuario tiene pinta de contener datos personales. No corre en cada
  //    turno: es una llamada menos a Groq (menos rate-limits para Whisper/LLM),
  //    que son los que causan los silencios y el fallback "se me fue la señal".
  if (sugiereExtraerHechos(textoUsuario)) {
    extraerHechos(sesion.historial)
      .then((nuevos) => {
        if (nuevos.length > 0) {
          console.log(`  [memoria] +${nuevos.length} hecho(s) guardado(s)`);
        }
        return Promise.all(nuevos.map(guardarHecho));
      })
      .catch((err) => console.error("Error guardando hechos:", err.message));
  } else {
    console.log("  [memoria] omito extracción (sin datos personales evidentes)");
  }
});

// --- Iniciar servidor ---
// El listen() arranca INMEDIATO (sin esperar a la memoria) para que /health
// responda apenas el proceso levante, aunque la conexión a Turso tarde o falle.
// La memoria se inicializa en background y se "autoretira" si no hay DB.
async function main() {
  app.listen(PORT, () => {
    console.log(`Ivi server escuchando en http://localhost:${PORT}`);
    console.log(`  POST /api/touch — recibir audio del ESP32`);
    console.log(`  GET  /health    — health check (rápido, sin DB)`);
    console.log(`  Groq: ${resumenModelos()} | deadline de turno ${DEADLINE_TURNO_MS}ms`);
  });

  initMemory().catch((err) => {
    console.error("Memoria no disponible (el servidor sigue andando):", err.message);
  });
}

main().catch((err) => {
  console.error("Error iniciando servidor:", err);
  process.exit(1);
});
