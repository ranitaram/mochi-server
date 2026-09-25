// scripts/test-api.ts
// Test del pipeline completo: genera un WAV de prueba, lo envía al server,
// y guarda la respuesta como WAV escuchable.
//
// Uso:
//   1. Abrir terminal 1: npm run server
//   2. Abrir terminal 2: npm run test-api

import "dotenv/config";
import fs from "fs";
import path from "path";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";

/**
 * Agrega un encabezado WAV válido (44 bytes) a un buffer de PCM crudo.
 * Para que el archivo se pueda abrir con cualquier reproductor de audio.
 */
function pcmToWav(pcmBuffer: Buffer, sampleRate = 24000, bitsPerSample = 16, channels = 1): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const wavBuffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  wavBuffer.write("RIFF", 0);
  wavBuffer.writeUInt32LE(36 + dataSize, 4);
  wavBuffer.write("WAVE", 8);

  // fmt sub-chunk
  wavBuffer.write("fmt ", 12);
  wavBuffer.writeUInt32LE(16, 16);          // Sub-chunk size
  wavBuffer.writeUInt16LE(1, 20);           // PCM format
  wavBuffer.writeUInt16LE(channels, 22);
  wavBuffer.writeUInt32LE(sampleRate, 24);
  wavBuffer.writeUInt32LE(byteRate, 28);
  wavBuffer.writeUInt16LE(blockAlign, 32);
  wavBuffer.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  wavBuffer.write("data", 36);
  wavBuffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wavBuffer, headerSize);

  return wavBuffer;
}

/**
 * Genera un WAV de prueba usando Edge TTS.
 * Esto simula lo que el ESP32 haría con el INMP441.
 */
async function generarWAVPrueba(): Promise<Buffer> {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import("msedge-tts");
  const tts = new MsEdgeTTS();
  await tts.setMetadata(
    process.env.EDGE_TTS_VOICE || "es-MX-DaliaNeural",
    OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS
  );

  const tempDir = "./audio-temp";
  fs.mkdirSync(tempDir, { recursive: true });

  const { audioFilePath } = await tts.toFile(
    tempDir,
    "Hola Ivi, ¿cómo estás? Esto es una prueba del pipeline de audio.",
    { pitch: process.env.TTS_PITCH || "+20Hz", rate: process.env.TTS_RATE || "1.1" }
  );

  const audioBuffer = fs.readFileSync(audioFilePath);
  try { fs.unlinkSync(audioFilePath); } catch { /* ignore */ }
  return audioBuffer;
}

async function main() {
  console.log("=== Test del pipeline audio → audio ===\n");

  // 1. Generar WAV de prueba
  console.log("1. Generando audio de prueba...");
  const wavPrueba = await generarWAVPrueba();
  console.log(`   Audio generado: ${wavPrueba.length} bytes\n`);

  // 2. Enviar al servidor
  console.log(`2. Enviando a ${SERVER_URL}/api/touch ...`);
  const inicio = Date.now();

  try {
    const response = await fetch(`${SERVER_URL}/api/touch`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(wavPrueba),
    });

    const latencia = Date.now() - inicio;
    console.log(`   Respuesta: ${response.status} (${latencia}ms)\n`);

    if (!response.ok) {
      const errText = await response.text();
      console.error("   Error:", errText);
      return;
    }

    // 3. Leer headers de respuesta
    const texto = response.headers.get("X-Ivi-Texto") ?? "(sin texto)";
    const emocion = response.headers.get("X-Ivi-Emocion") ?? "(sin emoción)";
    const audioLength = response.headers.get("X-Ivi-Audio-Length") ?? "?";

    console.log("3. Respuesta de Ivi:");
    console.log(`   Texto:    ${texto}`);
    console.log(`   Emoción:  ${emocion}`);
    console.log(`   Audio:    ${audioLength} bytes PCM\n`);

    // 4. Recibir MP3 y guardar en disco
    const arrayBuffer = await response.arrayBuffer();
    const mp3Buffer = Buffer.from(arrayBuffer);

    // 5. Guardar MP3 en disco
    const outputFile = path.join("./audio-temp", "respuesta-ivi.mp3");
    fs.writeFileSync(outputFile, mp3Buffer);
    console.log(`4. Audio guardado en: ${outputFile}`);
    console.log(`   Tamaño MP3: ${mp3Buffer.length} bytes\n`);

    console.log("=== Test completado ===");
    console.log(`Abre ${outputFile} con un reproductor de audio para escuchar la respuesta.`);
  } catch (err: any) {
    console.error("Error conectando al servidor:", err.message);
    console.error("Asegúrate de que el servidor esté corriendo: npm run server");
  }
}

main();
