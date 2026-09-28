// tts.ts
// Convierte texto a audio usando el motor de voces neuronales de Microsoft
// Edge (gratuito, sin API key).

import { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions } from "msedge-tts";
import fs from "fs";
import path from "path";

const VOZ = process.env.EDGE_TTS_VOICE || "es-MX-JorgeNeural";
const PITCH = process.env.TTS_PITCH || "+20Hz";
const RATE = process.env.TTS_RATE || "1.1";
// Respuestas largas (preguntas difíciles) tardan en sintetizarse: 10s era
// demasiado justo y cortaba el audio -> silencio. 25s por intento.
const TIMEOUT_MS = 25_000;
const RETRIES = 2;
const BACKOFF_BASE_MS = 800;
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

export function setFallbackAudio(buf: Buffer) { fallbackAudio = buf; }
export function setFallbackNoAudio(buf: Buffer) { fallbackNoAudio = buf; }

/** Devuelve el MP3 de "no te escuché bien" (´STT vacío), o null si no cargó. */
export function obtenerFallbackNoAudio(): Buffer | null {
  return fallbackNoAudio;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Sintetiza el MP3 UNA vez (sin reintentos). Devuelve el buffer o tira. */
async function sintetizarMP3(
  texto: string,
  prosody?: ProsodyOptions
): Promise<Buffer> {
  // Hook de prueba: TTS_FORCE_FAIL=1 simula que Edge falla siempre (para
  // verificar en local que el fallback de emergencia responde sin silencio).
  if (process.env.TTS_FORCE_FAIL === "1") {
    throw new Error("TTS_FORCE_FAIL (simulación de fallo Edge)");
  }
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOZ, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  const textoLimpio = sanitizeForTTS(texto);
  fs.mkdirSync(CARPETA_TEMP, { recursive: true });

  const operation = tts.toFile(
    CARPETA_TEMP,
    textoLimpio,
    { pitch: PITCH, rate: RATE, ...prosody }
  );
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("TTS timeout")), TIMEOUT_MS)
  );

  const { audioFilePath } = await Promise.race([operation, timeout]);
  const mp3Buffer = fs.readFileSync(audioFilePath);

  // Limpiar el archivo temporal
  try { fs.unlinkSync(audioFilePath); } catch { /* ignore */ }

  return mp3Buffer;
}

/**
 * Genera audio MP3 (24kHz, mono) listo para enviar al ESP32.
 * Reintenta errores transitorios de Edge con backoff; si TODOS fallan,
 * devuelve el MP3 de emergencia cacheado en vez de tirar — Ivi nunca se
 * queda muda.
 */
export async function generarAudioMP3(
  texto: string,
  prosody?: ProsodyOptions,
  onFallback?: (motivo: string) => void
): Promise<Buffer> {
  let ultimoError: unknown = null;
  for (let intento = 1; intento <= RETRIES + 1; intento++) {
    try {
      const buf = await sintetizarMP3(texto, prosody);
      ultimoMp3Valido = buf;
      console.log(
        `[TTS] ok intento ${intento}/${RETRIES + 1}: ${texto.length} chars, ${buf.length} bytes`
      );
      return buf;
    } catch (err: any) {
      ultimoError = err;
      console.error(`[TTS] intento ${intento}/${RETRIES + 1} falló: ${err.message}`);
      if (intento <= RETRIES) await dormir(BACKOFF_BASE_MS * intento);
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
