// generar-muletillas.ts
// Genera los audios de las muletillas UNA SOLA VEZ.
// Corre: npm run generar-muletillas
// Los archivos se guardan en ./assets/muletillas/

import "dotenv/config";
import fs from "fs";
import { generarAudio } from "../src/tts";
import { MULETILLAS } from "../src/muletillas";

const CARPETA = "./assets/muletillas";

async function main() {
  fs.mkdirSync(CARPETA, { recursive: true });

  console.log(`Generando ${MULETILLAS.length} muletillas...\n`);

  for (let i = 0; i < MULETILLAS.length; i++) {
    const subdirectorio = `${CARPETA}/muletilla-${i}`;
    fs.mkdirSync(subdirectorio, { recursive: true });
    await generarAudio(MULETILLAS[i], subdirectorio);
    console.log(`  ✓ muletilla-${i}.webm — "${MULETILLAS[i]}"`);
  }

  console.log(`\n${MULETILLAS.length} audios generados en ${CARPETA}/`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
