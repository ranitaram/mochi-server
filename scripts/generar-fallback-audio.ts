// scripts/generar-fallback-audio.ts
// Genera los MP3 de EMERGENCIA que Ivi reproduce cuando el TTS (Microsoft Edge)
// o el STT (Groq Whisper) fallan, para que NUNCA se quede muda. Se sintetiza
// UNA vez con Edge TTS y se commitea en src/assets (el server los carga en
// memoria al arrancar). No dependen de ningún servicio en runtime.
//
// Uso: npm run generar-fallback-audio

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import fs from "fs";
import path from "path";

const VOZ = process.env.EDGE_TTS_VOICE || "es-MX-JorgeNeural";
const PITCH = process.env.TTS_PITCH || "+20Hz";
const RATE = process.env.TTS_RATE || "1.1";

const FRASES: Record<string, string> = {
  // TTS (Microsoft Edge) agotó reintentos
  fallback_audio: "Se me cortó el audio, repetí lo que me dijiste, va.",
  // STT (Whisper) no transcribió nada
  fallback_noaudio: "No te escuché bien, repetí lo que me dijiste, porfa.",
};

async function main() {
  const outDir = path.join(__dirname, "..", "src", "assets");
  fs.mkdirSync(outDir, { recursive: true });

  for (const [nombre, texto] of Object.entries(FRASES)) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(VOZ, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const tmp = path.join(outDir, `_${nombre}_tmp.mp3`);
    const { audioFilePath } = await tts.toFile(
      path.dirname(tmp),
      texto,
      { pitch: PITCH, rate: RATE }
    );
    const dest = path.join(outDir, `${nombre}.mp3`);
    fs.copyFileSync(audioFilePath, dest);
    try { fs.unlinkSync(audioFilePath); } catch {}
    const size = fs.statSync(dest).size;
    console.log(`Generado: ${dest} (${size} bytes) para "${texto}"`);
  }
}

main().catch((err) => {
  console.error("Error generando fallbacks:", err);
  process.exit(1);
});