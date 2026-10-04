// scripts/preguntar.mjs
// Habla CON Ivi por el mismo camino que el ESP32: sintetiza la pregunta como
// WAV PCM, lo manda a /api/touch y lee la respuesta del header X-Ivi-Texto.
//
// El pipeline que se ejercita es el real completo:
//   WAV -> energiaAudio (RMS) -> Whisper STT -> Groq (con contexto) -> Edge TTS
//
// No es un atajo: si el STT no entiende, Ivi no lo entiende. Por eso el audio
// se genera con `say` en vez de mandar texto.
//
// Uso:
//   node scripts/preguntar.mjs "¿Qué estabas haciendo?"
//   node scripts/preguntar.mjs --lote            # preguntas de prueba embutidas
//   node scripts/preguntar.mjs --lote mis.txt    # una pregunta por línea
//   node scripts/preguntar.mjs --sin-audio "..."  # no guarda los MP3
//
// Variables:
//   SERVER_URL     destino (default produccion)
//   IVI_TEST_VOZ   voz de `say` para las preguntas
//
// Por qué el header x-ivi-prueba: el server corre en otro proceso, asi que un
// IVI_CONDICION exportado aqui no llega ahi. Sin el header, estas preguntas
// caen en la condicion "ivi" del experimento A/B y contaminan el log.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER_URL = (process.env.SERVER_URL || "https://mochi-server-tnwq.onrender.com").replace(/\/+$/, "");
const VOZ = process.env.IVI_TEST_VOZ || "Paulina";
const GUARDAR_AUDIO = !process.argv.includes("--sin-audio");
const LOTE = process.argv.includes("--lote");

const PREGUNTAS_LOTE = [
  "¿Qué estabas haciendo en la computadora?",
  "¿En qué archivo andabas trabajando?",
  "¿Qué cambió exactamente en ese archivo?",
  "¿Tuviste algún fallo o algún error?",
  "¿Y ahora qué sigue, qué me recomiendas?",
  "¿Y la base de datos cómo quedó?",
  "¿Qué linter usa este proyecto?",
  "¿Cuántos archivos tiene el proyecto?",
  "¿Qué versión de Node usa?",
  "¿Puedes cambiar tú el archivo para arreglarlo?",
  "¿Podrías ejecutar tú las pruebas?",
  "Con lo que ya hiciste, hazlo tú mejor.",
];

const args = process.argv.slice(2).filter((a) => a !== "--lote" && a !== "--sin-audio");
const archivoLote = args.find((a) => fs.existsSync(a));
const preguntas = archivoLote
  ? fs.readFileSync(archivoLote, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
  : args.filter((a) => !fs.existsSync(a));

if (preguntas.length === 0) {
  console.error('Uso: node scripts/preguntar.mjs "¿Qué estabas haciendo?"');
  console.error("     node scripts/preguntar.mjs --lote");
  process.exit(1);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ivi-preg-"));
const SALIDA = path.resolve("audio-temp/preguntas");
if (GUARDAR_AUDIO) fs.mkdirSync(SALIDA, { recursive: true });

/** Sintetiza la pregunta como WAV PCM 16-bit LE mono, que es lo que energiaAudio
 *  y el STT esperan. El ESP32 manda exactamente este formato. */
function sintetizar(texto, destino) {
  execFileSync("say", [
    "-v", VOZ,
    "-r", "165",
    "-o", destino,
    "--file-format=WAVE",
    "--data-format=LEI16@16000",
    texto,
  ], { stdio: ["ignore", "ignore", "pipe"] });
}

/** Salida de `say` en algunos macOS trae cabecera WAV con campos extra; el
 *  server asume cabecera de 44 bytes, asi que normalizamos. */
function normalizarWav(buf) {
  if (buf.length > 44 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    return buf;
  }
  throw new Error("say no produjo un WAV valido");
}

async function preguntar(texto, i) {
  const wav = path.join(TMP, `p${i}.wav`);
  sintetizar(texto, wav);
  const audio = normalizarWav(fs.readFileSync(wav));

  const inicio = Date.now();
  const res = await fetch(`${SERVER_URL}/api/touch`, {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav",
      "x-ivi-prueba": "1",
    },
    body: new Uint8Array(audio),
  });
  const latencia = Date.now() - inicio;

  if (!res.ok) {
    return { ok: false, status: res.status, latencia, cuerpo: (await res.text()).slice(0, 200) };
  }

  let destino = null;
  if (GUARDAR_AUDIO) {
    destino = path.join(SALIDA, `p${String(i).padStart(2, "0")}.mp3`);
    fs.writeFileSync(destino, Buffer.from(await res.arrayBuffer()));
  }

  return {
    ok: true,
    latencia,
    transcripcion: res.headers.get("X-Ivi-STT") ?? null,
    texto: res.headers.get("X-Ivi-Texto") ?? "(sin texto)",
    emocion: res.headers.get("X-Ivi-Emocion") ?? "?",
    copilot: res.headers.get("X-Ivi-Copilot") ?? "?",
    charsContexto: res.headers.get("X-Ivi-Contexto-Chars") ?? "?",
    audio: destino,
  };
}

console.log(`\n  destino: ${SERVER_URL}`);
console.log(`  voz de las preguntas: ${VOZ}`);
console.log(`  ${preguntas.length} pregunta(s), historial compartido (como una charla)\n`);

const filas = [];
for (let i = 0; i < preguntas.length; i++) {
  process.stdout.write(`  ${String(i + 1).padStart(2)}/${preguntas.length}  ${preguntas[i]}\n`);
  let r;
  try {
    r = await preguntar(preguntas[i], i);
  } catch (err) {
    console.log(`      ERROR de red: ${err.message}\n`);
    continue;
  }
  if (!r.ok) {
    console.log(`      HTTP ${r.status} en ${r.latencia}ms: ${r.cuerpo}\n`);
    continue;
  }
  console.log(`      [${r.emocion}] ${r.texto}`);
  console.log(`      ${r.latencia}ms · contexto=${r.copilot} (${r.charsContexto} chars)\n`);
  filas.push({ pregunta: preguntas[i], ...r });
}

fs.rmSync(TMP, { recursive: true, force: true });

const fsSalida = path.join(SALIDA, "resultados.json");
if (GUARDAR_AUDIO) {
  fs.writeFileSync(
    fsSalida,
    JSON.stringify({ servidor: SERVER_URL, cuando: new Date().toISOString(), filas }, null, 2)
  );
  console.log(`  respuestas guardadas en ${path.relative(process.cwd(), SALIDA)}/`);
}
console.log(`  ${filas.length}/${preguntas.length} respondidas\n`);