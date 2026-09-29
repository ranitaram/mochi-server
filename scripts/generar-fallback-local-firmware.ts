// Regenera el MP3 local del firmware con el MISMO pipeline que usa el server
// (msedge-tts), para que la frase de emergencia suene idéntica a Ivi.
// La versión anterior venía de Python edge-tts: mismo tamaño y duración, pero
// bytes distintos, y sonaba como otra voz.
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import fs from "fs";
import path from "path";

const FRASE = "Se me cortó la señal, decímelo otra vez";
const VOZ = process.env.EDGE_TTS_VOICE || "es-MX-JorgeNeural";
const PITCH = process.env.TTS_PITCH || "+20Hz";
const RATE = process.env.TTS_RATE || "1.1";
const DESTINO = path.resolve("firmware/mochi-esp32/src/fallback_local_mp3.h");

const bytesC = (b: number) => "0x" + b.toString(16).padStart(2, "0");

(async () => {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOZ, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioFilePath } = await tts.toFile("/tmp", FRASE, { pitch: PITCH, rate: RATE });
  const mp3 = fs.readFileSync(audioFilePath);
  fs.unlinkSync(audioFilePath);

  const filas: string[] = [];
  for (let i = 0; i < mp3.length; i += 12) {
    filas.push("  " + [...mp3.subarray(i, i + 12)].map(bytesC).join(", "));
  }
  const h = `// fallback_local_mp3.h
// Frase local de emergencia ("${FRASE}").
// Generada con msedge-tts (${VOZ}, ${PITCH}, rate ${RATE}) — EXACTAMENTE el mismo
// pipeline que el server usa para cualquier respuesta, para que suene idéntica
// a Ivi (la anterior venía de Python edge-tts y se oía con otra voz).
// Embebida en flash para que Ivi NUNCA quede muda si el server no responde
// (transporte, timeout o 500): se reproduce con la misma ruta audioPlayBytes().
#ifndef FALLBACK_LOCAL_MP3_H
#define FALLBACK_LOCAL_MP3_H
#include <stdint.h>
const uint32_t FALLBACK_LOCAL_MP3_LEN = ${mp3.length};
const uint8_t FALLBACK_LOCAL_MP3[] = {
${filas.join(",\n")}
};
#endif
`;
  fs.writeFileSync(DESTINO, h);
  console.log(
    `MP3 regenerado con msedge-tts: ${mp3.length} bytes, ${((mp3.length * 8) / 48000).toFixed(2)}s\n` +
      `  voz=${VOZ} pitch=${PITCH} rate=${RATE}\n  -> ${DESTINO}`
  );
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
