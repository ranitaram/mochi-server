// tts.ts
// Convierte texto a audio usando el motor de voces neuronales de Microsoft
// Edge (gratuito, sin API key).

import { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions } from "msedge-tts";
import fs from "fs";
import path from "path";

// La voz de Ivi. OJO: este valor es la fuente de verdad y TODO lo que suene
// tiene que salir de acá: respuestas, frases de emergencia, MP3 pregrabados y
// el MP3 embebido en el firmware. Si el default y los .env se desincronizan,
// la frase de emergencia suena con OTRA voz que el resto del robot.
const VOZ = process.env.EDGE_TTS_VOICE || "es-MX-DaliaNeural";
const PITCH = process.env.TTS_PITCH || "+20Hz";
const RATE = process.env.TTS_RATE || "1.1";
const num = (v: string | undefined, def: number) => {
  const n = parseInt(v || "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

// Tope por intento de síntesis. 8s es el mismo que usa el LLM por request
// (GROQ_TIMEOUT_MS) y con UN reintento el peor caso es ~16s (8s + 400ms de
// backoff + 8s). Entra en el deadline de turno de 45s (TURNO_DEADLINE_MS)
// junto al LLM (12s) y el STT (2s), así el MP3 siempre llega al parlante.
// OJO: subir esto sin recalcular ese deadline hace que el device corte el POST
// a los 65s y el turno se pierda entero.
const TIMEOUT_MS = num(process.env.TTS_TIMEOUT_MS, 8_000);
const RETRIES = 1;
const BACKOFF_BASE_MS = 400;
const CARPETA_TEMP = "./audio-temp";

// MP3 de EMERGENCIA (commiteados en src/assets, cargados en memoria al
// arrancar). Reemplazan al silencio cuando Edge TTS o Groq Whisper fallan:
// Ivi SIEMPRE responde algo en el parlante.
let fallbackAudio: Buffer | null = null; //   TTS agotó reintentos
let fallbackNoAudio: Buffer | null = null; // STT no transcribió nada

// Último MP3 sintetizado con EXITO en esta instancia del server. Si Edge TTS
// se cae (muy común: Microsoft cambia endpoints / se satura), en vez de
// responder 500 y dejar a Ivi muda, reusamos este audio ya sintético. Es la
// red de seguridad que evita los turnos "(no llegó a hablar: error de audio)".
let ultimoMp3Valido: Buffer | null = null;

// MP3 ya sintetizados por texto. Al arrancar calentamos las frases de
// emergencia: son las que más se repiten cuando Groq no tiene cuota, y tenerlas
// listas las hace instantáneas y SIEMPRE con la voz de Ivi (mismo motor, mismo
// pitch y mismo rate que cualquier respuesta normal).
const cachePorTexto = new Map<string, Buffer>();
// Tope de seguridad: si alguien mandara a cachear texto ilimitado (no debería:
// solo van las frases de emergencia) no crecemos sin fin en memoria.
const MAX_CACHE = 24;
const cachear = (clave: string, buf: Buffer) => {
  if (cachePorTexto.size >= MAX_CACHE) cachePorTexto.clear();
  cachePorTexto.set(clave, buf);
};

export function setFallbackAudio(buf: Buffer) { fallbackAudio = buf; }
export function setFallbackNoAudio(buf: Buffer) { fallbackNoAudio = buf; }

/**
 * Sintetiza desde el cache por texto. Si ya está, no llama a Edge: es la vía
 * normal cuando el texto es una frase de emergencia precargada.
 */
export async function generarAudioMP3Cacheado(
  texto: string,
  deadlineMs?: number
): Promise<Buffer> {
  const clave = texto.trim();
  const hit = cachePorTexto.get(clave);
  if (hit) return hit;
  const buf = await generarAudioMP3(texto, undefined, undefined, deadlineMs);
  cachear(clave, buf);
  return buf;
}

/**
 * Precalienta frases UNA POR UNA en segundo plano, con una pausa entre cada una:
 * al arrancar no le aterrizan las 6 de golpe a Edge (que de por sí ya nos
 * limita) y ninguna compite con un turno real. Los fallos se ignoran: si Edge
 * no está listo, la frase se sintetiza en el momento en que se necesite.
 */
export function precachearFrases(frases: string[]): void {
  void (async () => {
    for (const frase of frases) {
      const clave = frase.trim();
      if (cachePorTexto.has(clave)) continue;
      try {
        cachear(clave, await sintetizarMP3(frase, undefined, TIMEOUT_MS, false));
      } catch {
        /* sin precache: se sintetiza en el turno */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
}

/** Devuelve el MP3 de "no te escuché bien" (´STT vacío), o null si no cargó. */
export function obtenerFallbackNoAudio(): Buffer | null {
  return fallbackNoAudio;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Síntesis HUÉRFANAS. Cuando el timeout gana el race, `tts.toFile` sigue
// vivo: no hay forma de cancelarlo, así que termina de escribir audio.mp3
// más tarde. Como msedge-tts SIEMPRE usa ese nombre fijo (ver enSerializar),
// una huérfana que aterrice durante el reintento puede pisar el archivo — y
// entonces leeríamos los bytes de OTRO texto y se lo diríamos al niño como si
// fuera su respuesta. Contamos las que quedan en vuelo y esperamos a que
// terminen antes de empezar otra síntesis.
let huerfanasEnVuelo = 0;
async function esperarHuerfanas(timeoutMs: number): Promise<void> {
  if (!huerfanasEnVuelo) return;
  // Tope corto (2s): solo necesitamos que la escritura huérfana aterrice. Si
  // en 2s no bajó, el intento que viene seguro está fallando y lo cubren el
  // reintento y el MP3 de emergencia.
  const limite = Date.now() + Math.min(2_000, timeoutMs);
  console.warn(`[TTS] esperando ${huerfanasEnVuelo} síntesis(es) huérfana(s)`);
  while (huerfanasEnVuelo > 0 && Date.now() < limite) await dormir(50);
}

// Otras voces en español que puedes probar cambiando EDGE_TTS_VOICE en .env:
// es-MX-DaliaNeural   (femenina, México)
// es-MX-JorgeNeural   (masculina, México)
// es-US-AlonsoNeural  (masculina, español latino neutro)
// es-ES-AlvaroNeural  (masculina, España)

/**
 * Elimina emojis del texto antes de enviarlo a Edge-TTS.
 * Safety net por si el modelo los ignora la instrucción del prompt.
 */
function sanitizeForTTS(text: string): string {
  return text
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * msedge-tts SIEMPRE escribe en `<carpeta>/audio.mp3` (no acepta nombre), así
 * que dos síntesis simultáneas se pisan: una lee el archivo después de que la
 * otra lo borró y truena con ENOENT. Serializamos TODAS las síntesis.
 *
 * La cola tiene dos prioridades: un turno real NUNCA espera a la precarga de
 * arranque. Sin esto, si Edge TTS va lento al boot, la primera pregunta del
 * niño esperaba detrás de las 6 frases de emergencia (medido: 90s de cuelgue).
 */
type Job = {
  fn: () => Promise<Buffer>;
  resolve: (b: Buffer) => void;
  reject: (e: unknown) => void;
  fg: boolean;
};
const pendientes: Job[] = [];
let ocupada = false;

function enSerializar<T>(fn: () => Promise<T>, fg = true): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pendientes.push({ fn: fn as () => Promise<Buffer>, resolve: resolve as any, reject, fg });
    void drenar();
  });
}

async function drenar() {
  if (ocupada) return;
  ocupada = true;
  try {
    while (pendientes.length) {
      // Primero lo del turno en curso; si no hay, seguimos con la precarga.
      const i = pendientes.findIndex((j) => j.fg);
      const job = pendientes.splice(i < 0 ? 0 : i, 1)[0];
      try {
        job.resolve(await job.fn());
      } catch (err) {
        job.reject(err);
      }
    }
  } finally {
    ocupada = false;
  }
}

/** Sintetiza el MP3 UNA vez (sin reintentos). Devuelve el buffer o tira. */
async function sintetizarMP3(
  texto: string,
  prosody?: ProsodyOptions,
  timeoutMs: number = TIMEOUT_MS,
  fg = true
): Promise<Buffer> {
  // Hook de prueba: TTS_FORCE_FAIL=1 simula que Edge falla siempre (para
  // verificar en local que el fallback de emergencia responde sin silencio).
  if (process.env.TTS_FORCE_FAIL === "1") {
    throw new Error("TTS_FORCE_FAIL (simulación de fallo Edge)");
  }
  return enSerializar(async () => {
    // Nadie debe sintetizar mientras una huérfana del intento anterior pueda
    // pisarnos el audio.mp3.
    await esperarHuerfanas(timeoutMs);

    const tts = new MsEdgeTTS();
    await tts.setMetadata(VOZ, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

    const textoLimpio = sanitizeForTTS(texto);
    fs.mkdirSync(CARPETA_TEMP, { recursive: true });

    const operation = tts.toFile(
      CARPETA_TEMP,
      textoLimpio,
      { pitch: PITCH, rate: RATE, ...prosody }
    );

    let ganoTimeout = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ganoTimeout = true;
        reject(new Error(`TTS timeout (${timeoutMs}ms)`));
      }, timeoutMs);
    });

    try {
      const { audioFilePath } = await Promise.race([operation, timeout]);
      // Copiamos el buffer ANTES de borrar: otra síntesis encolada puede
      // sobrescribir el nombre en cuanto terminamos.
      const mp3Buffer = fs.readFileSync(audioFilePath);
      try { fs.unlinkSync(audioFilePath); } catch { /* ignore */ }
      return mp3Buffer;
    } finally {
      // El timer se limpia siempre: si lo dejáramos vivo, cada síntesis
      // exitosa mantendría el event loop prendido timeoutMs después.
      if (timer) clearTimeout(timer);
      if (ganoTimeout) {
        // La operación perdió el race pero sigue corriendo. La marcamos para
        // que la próxima síntesis la espere y borramos lo que deje.
        huerfanasEnVuelo++;
        void operation
          .then(({ audioFilePath }) => {
            try { fs.unlinkSync(audioFilePath); } catch { /* ignore */ }
          })
          .catch(() => { /* ya falló sola: no dejó archivo */ })
          .finally(() => { huerfanasEnVuelo--; });
      }
    }
  }, fg);
}

/**
 * Genera audio MP3 (24kHz, mono) listo para enviar al ESP32.
 * Reintenta errores transitorios de Edge con backoff; si TODOS fallan,
 * devuelve el MP3 de emergencia cacheado en vez de tirar — Ivi nunca se
 * queda muda.
 *
 * `deadlineMs` es el instante absoluto en que el dispositivo cierra la conexión:
 * cada intento se recorta para no pasarse, garantiza que el audio llegue.
 */
export async function generarAudioMP3(
  texto: string,
  prosody?: ProsodyOptions,
  onFallback?: (motivo: string) => void,
  deadlineMs?: number
): Promise<Buffer> {
  let ultimoError: unknown = null;
  for (let intento = 1; intento <= RETRIES + 1; intento++) {
    const restante = deadlineMs ? deadlineMs - Date.now() : TIMEOUT_MS;
    if (restante <= 0) {
      ultimoError = new Error("TTS: sin tiempo restante antes del deadline del turno");
      break;
    }
    try {
      const buf = await sintetizarMP3(texto, prosody, Math.min(TIMEOUT_MS, restante));
      ultimoMp3Valido = buf;
      console.log(
        `[TTS] ok intento ${intento}/${RETRIES + 1}: ${texto.length} chars, ${buf.length} bytes`
      );
      return buf;
    } catch (err: any) {
      ultimoError = err;
      console.error(`[TTS] intento ${intento}/${RETRIES + 1} falló: ${err.message}`);
      if (intento <= RETRIES) {
        const espera = BACKOFF_BASE_MS * intento;
        // No dormimos si ya no queda tiempo: el backoff se comería el deadline
        // del turno y el reintento fallaría de antemano sin intentarlo.
        if (!deadlineMs || deadlineMs - Date.now() > espera) await dormir(espera);
      }
    }
  }
  console.error("[TTS] sin reintentos — audio de emergencia:", (ultimoError as Error)?.message);
  // Cascada de emergencia: preferimos el MP3 cacheado de los assets; si no
  // cargó al boot, reusamos el último MP3 bueno; solo si no hay NADA se tira.
  if (fallbackAudio) {
    console.log("[TTS] -> MP3 de emergencia de assets");
    onFallback?.("Edge TTS caído: MP3 de emergencia de assets");
    return fallbackAudio;
  }
  if (ultimoMp3Valido) {
    console.log("[TTS] -> último MP3 válido cacheado");
    onFallback?.("Edge TTS caído: último MP3 válido");
    return ultimoMp3Valido;
  }
  throw ultimoError as Error;
}

/**
 * Genera audio y lo guarda en disco (chat interactivo por terminal).
 */
export async function generarAudio(
  texto: string,
  carpetaSalida: string = "./audio-temp",
  prosody?: ProsodyOptions
): Promise<string> {
  const buffer = await generarAudioMP3(texto, prosody);
  const archivo = path.join(carpetaSalida, `respuesta_${Date.now()}.mp3`);
  fs.mkdirSync(carpetaSalida, { recursive: true });
  fs.writeFileSync(archivo, buffer);
  return archivo;
}
