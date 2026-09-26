// server.ts
// Servidor HTTP para el ESP32: recibe audio grabado, transcribe, genera
// respuesta con Ivi, y devuelve audio MP3 listo para decodificar en el ESP32.
//
// V1 (ahora): POST /api/touch — el ESP32 manda audio y recibe audio de vuelta.
// V2 (futuro): WebSocket para streaming bidireccional en tiempo real.

import "dotenv/config";
import path from "path";
import express from "express";
import { transcribirAudio } from "./stt";
import { generarRespuesta, extraerHechos } from "./llm";
import { generarAudioMP3 } from "./tts";
import { inicializarDB, obtenerHechos, guardarHecho } from "./memoria";
import { deviceRouter } from "./deviceRoutes";
import { loginAdmin, logoutAdmin } from "./auth";
import { obtenerSesion, agregarMensaje } from "./session";

const app = express();
// Confiar en el X-Forwarded-For de los proxies (Render) para que req.ip sea la
// IP real del ESP32 y las sesiones queden aisladas por dispositivo.
app.set("trust proxy", true);
const PORT = parseInt(process.env.PORT || "3000", 10);

// Body parser para audio crudo (ESP32 envía POST con Content-Type: audio/wav)
app.use("/api/touch", express.raw({ type: "audio/wav", limit: "10mb" }));

// JSON para el portal admin y la API de redes WiFi
app.use(express.json());

// Portal web (login + panel de redes WiFi)
app.post("/admin/login", loginAdmin);
app.post("/admin/logout", logoutAdmin);
// extensions: permite acceder /admin -> admin.html y /login -> login.html
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// API de dispositivos / redes (Prisma + PostgreSQL)
app.use(deviceRouter);

// --- Memoria persistente ---
let contextoHechos = "";

async function initMemory() {
  try {
    await inicializarDB();
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

// --- Health check ---
// Endpoint de "despertar"/healthcheck para Render: NO toca base de datos ni
// servicios de IA. Responde 200 "ok" lo más rápido posible (cold start de
// Render + chequeo de vida del free tier que duerme a los 15 min).
app.get("/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(200).send("ok");
});

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
      return;
    }
    console.log(`[touch] Audio con VOZ (RMS=${rms}) → Groq`);
  } catch (_e) {}

  // 1. Transcribir audio → texto
  const textoUsuario = await transcribirAudio(audioBuffer);
  if (!textoUsuario) {
    console.log("[touch] No se pudo transcribir el audio");
    res.status(422).json({ error: "No se pudo transcribir el audio" });
    return;
  }
  console.log(`[touch] Transcripción: "${textoUsuario}" (${Date.now() - inicio}ms)`);

  // 2. Sesión de conversación: cada cliente tiene su historial en memoria.
  //    Se abre de cero si pasó SESSION_IDLE_MS (default 15 min) sin hablar.
  const claveSesion = req.ip ?? req.socket.remoteAddress ?? "desconocido";
  const sesion = obtenerSesion(claveSesion);
  agregarMensaje(sesion, { role: "user", content: textoUsuario });
  console.log(
    `[touch] Sesión ${claveSesion}: historial de ${sesion.historial.length} mensaje(s)`
  );

  // 3. Generar respuesta de Ivi con el historial completo de la sesión
  const respuesta = await generarRespuesta(sesion.historial, contextoHechos);
  console.log(`[touch] Ivi [${respuesta.emocion}]: ${respuesta.texto} (${Date.now() - inicio}ms)`);

  // 4. Generar audio MP3 y agregar la respuesta al historial SOLO si se
  //    logró producir el audio (si no, el usuario no la oyó y mejor que la
  //    conversación no la recuerde).
  try {
    const mp3Buffer = await generarAudioMP3(respuesta.texto);

    // Responder con audio como body y texto/emoción en headers
    res.set({
      "Content-Type": "audio/mpeg",
      "X-Ivi-Texto": respuesta.texto,
      "X-Ivi-Emocion": respuesta.emocion,
      "X-Ivi-Audio-Length": String(mp3Buffer.length),
    });
    res.send(mp3Buffer);
    console.log(`[touch] Respuesta enviada: ${mp3Buffer.length} bytes MP3 (${Date.now() - inicio}ms total)`);

    agregarMensaje(sesion, { role: "assistant", content: respuesta.texto });
  } catch (err: any) {
    console.error("[touch] Error generando audio:", err.message);
    res.status(500).json({ error: "Error generando audio" });
    return;
  }

  // 5. Extraer hechos en background (fire-and-forget) de la conversación actual
  extraerHechos(sesion.historial)
    .then((nuevos) => {
      if (nuevos.length > 0) {
        console.log(`  [memoria] +${nuevos.length} hecho(s) guardado(s)`);
      }
      return Promise.all(nuevos.map(guardarHecho));
    })
    .catch((err) => console.error("Error guardando hechos:", err.message));
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
  });

  initMemory().catch((err) => {
    console.error("Memoria no disponible (el servidor sigue andando):", err.message);
  });
}

main().catch((err) => {
  console.error("Error iniciando servidor:", err);
  process.exit(1);
});
