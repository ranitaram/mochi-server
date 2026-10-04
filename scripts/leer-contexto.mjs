// Utilidad: leer el estado que tiene guardado el servidor y mostrar EXACTAMENTE
// el bloque de contexto que se inyectaría al system prompt. Sirve para revisar
// fugas antes de que un turno real pase por el LLM.
//
//   node scripts/leer-contexto.mjs [proyecto]
import "dotenv/config";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
req("dotenv").config();

const { obtenerUltimoEstado } = await import("../dist/copilot/store.js");
const { construirContextoCopilot, proyectoCopilot } = await import("../dist/copilot/contexto.js");

const proyecto = process.argv[2] || proyectoCopilot();
const estado = await obtenerUltimoEstado(proyecto);
console.log("  proyecto:", proyecto);
console.log("  estado:", estado ? "OK  sesion=" + estado.session_id : "NULL (sin estado o muy viejo)");
console.log();
console.log("=== EXACTAMENTE lo que se inyecta al system prompt ===");
const ctx = construirContextoCopilot(estado);
console.log(ctx ?? "(nada: Ivi responderá sin contexto de OpenCode)");
console.log();
console.log(`(${ctx ? ctx.length : 0} caracteres)`);
