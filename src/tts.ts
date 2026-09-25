// tts.ts
// Convierte texto a audio usando el motor de voces neuronales de Microsoft
// Edge (gratuito, sin API key).

import { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions } from "msedge-tts";
import fs from "fs";
import path from "path";

const VOZ = process.env.EDGE_TTS_VOICE || "es-MX-JorgeNeural";
const PITCH = process.env.TTS_PITCH || "+20Hz";
const RATE = process.env.TTS_RATE || "1.1";
const TIMEOUT_MS = 10_000;

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
 * Genera el audio (formato webm/opus) para un texto y lo guarda en disco.
 * Devuelve la ruta del archivo generado.
 * Usado por el chat interactivo por terminal (npm run dev).
 */
export async function generarAudio(
  texto: string,
  carpetaSalida: string = "./audio-temp",
  prosody?: ProsodyOptions
): Promise<string> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOZ, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);

  const options: ProsodyOptions = {
    pitch: PITCH,
    rate: RATE,
    ...prosody,
  };

  const textoLimpio = sanitizeForTTS(texto);
  const operation = tts.toFile(carpetaSalida, textoLimpio, options);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("TTS timeout")), TIMEOUT_MS)
  );

  const { audioFilePath } = await Promise.race([operation, timeout]);
  return audioFilePath;
}

/**
 * Genera audio MP3 (24kHz, mono) listo para enviar al ESP32.
 * El ESP32 decodifica MP3 con ESP8266Audio y reproduce por I2S → MAX98357.
 * Usado por el endpoint HTTP /api/touch.
 *
 * Nota: Si ffmpeg está instalado en el servidor, se puede convertir a PCM crudo
 * para evitar la decodificación MP3 en el ESP32. Por ahora usamos MP3 porque
 * msedge-tts no soporta PCM directo y ffmpeg no siempre está disponible.
 */
export async function generarAudioMP3(
  texto: string,
  prosody?: ProsodyOptions
): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOZ, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  const options: ProsodyOptions = {
    pitch: PITCH,
    rate: RATE,
    ...prosody,
  };

  const textoLimpio = sanitizeForTTS(texto);
  const carpetaTemp = "./audio-temp";
  fs.mkdirSync(carpetaTemp, { recursive: true });

  const operation = tts.toFile(carpetaTemp, textoLimpio, options);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("TTS timeout")), TIMEOUT_MS)
  );

  const { audioFilePath } = await Promise.race([operation, timeout]);
  const mp3Buffer = fs.readFileSync(audioFilePath);

  // Limpiar el archivo temporal
  try { fs.unlinkSync(audioFilePath); } catch { /* ignore */ }

  return mp3Buffer;
}
