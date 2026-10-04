#!/usr/bin/env node
// test-redactor.mjs — corre los fixtures de redact.fixtures.json contra las DOS
// implementaciones (plugin JS y backend TS) y falla si divergen.
//
// Uso: node scripts/test-redactor.mjs
// Salida: una linea por caso + un veredicto. Codigo de salida 1 si algo falla.
//
// No necesita ts-node: el TS se importa via el compilado en dist/, o se hace
// un require directo si no existe todavia.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(aqui, "..");
const FIXTURES = resolve(raiz, "src/copilot/redact.fixtures.json");

const fx = JSON.parse(readFileSync(FIXTURES, "utf8"));

// --- Cargar las dos implementaciones -----------------------------------------
const jsMod = await import(
  resolve(process.env.HOME, ".config/opencode/plugins/ivi-redact.js")
);

let tsMod;
try {
  tsMod = await import(resolve(raiz, "dist/copilot/redact.js"));
} catch {
  try {
    tsMod = await import(resolve(raiz, "src/copilot/redact.ts"));
  } catch (e) {
    console.error("  ERROR: no pude cargar la implementacion TypeScript.");
    console.error("  Compila primero:  npm run build");
    console.error("  detalle:", e.message.split("\n")[0]);
    process.exit(2);
  }
}

const IMPLS = [
  ["plugin", jsMod],
  ["backend", tsMod],
];

// --- Correr ------------------------------------------------------------------
let fallos = 0;
let total = 0;
const divergencias = [];

function checar(impl, nombre, obtenido, esperado, contexto = "") {
  total++;
  const ok = obtenido === esperado;
  if (!ok) {
    fallos++;
    if (contexto) divergencias.push(`${impl} / ${contexto} / ${nombre}`);
  }
  return ok;
}

console.log("");
console.log(`  fixtures: ${FIXTURES}`);
console.log(`  implementaciones: ${IMPLS.map((i) => i[0]).join(" vs ")}`);
console.log("");

for (const [impl, mod] of IMPLS) {
  console.log(`  --- ${impl} ---`);

  for (const c of fx.cases) {
    const got = mod.redactarTexto(c.input);
    const ok = checar(impl, c.name, got, c.expect);
    console.log(
      `    ${ok ? "PASA" : "FALLA"}  ${c.name}` +
        (ok ? "" : `\n            esperado: ${JSON.stringify(c.expect)}\n            obtenido: ${JSON.stringify(got)}`)
    );
  }

  for (const c of fx.tail_cases) {
    const got = mod.redactarTail(c.input, c.lines);
    const ok = checar(impl, c.name, got, c.expect);
    console.log(
      `    ${ok ? "PASA" : "FALLA"}  ${c.name}` +
        (ok ? "" : `\n            esperado: ${JSON.stringify(c.expect)}\n            obtenido: ${JSON.stringify(got)}`)
    );
  }

  for (const c of fx.char_cases) {
    const got = mod.redactarTailChars(c.input, c.max_chars);
    const ok = checar(impl, c.name, got, c.expect);
    console.log(
      `    ${ok ? "PASA" : "FALLA"}  ${c.name}` +
        (ok ? "" : `\n            esperado: ${JSON.stringify(c.expect)}\n            obtenido: ${JSON.stringify(got)}`)
    );
  }

  for (const c of fx.idempotence_cases) {
    const uno = mod.redactarTexto(c.input);
    const dos = mod.redactarTexto(uno);
    const ok = checar(impl, c.name, dos, uno);
    console.log(`    ${ok ? "PASA" : "FALLA"}  ${c.name}`);
  }
  console.log("");
}

// --- Veredicto ---------------------------------------------------------------
const lineas = `  ${total} verificaciones en ${IMPLS.length} implementaciones`;
if (fallos === 0) {
  console.log(`${lineas}: TODAS PASAN. Las dos implementaciones coinciden.`);
  console.log("");
  process.exit(0);
} else {
  console.log(`${lineas}: ${fallos} FALLAN.`);
  console.log("  fallas:");
  for (const d of [...new Set(divergencias)]) console.log(`    - ${d}`);
  console.log("");
  process.exit(1);
}