// Utilidad: leer el estado que tiene guardado el servidor y mostrar EXACTAMENTE
// el bloque de contexto que se inyectaría al system prompt. Sirve para revisar
// fugas antes de que un turno real pase por el LLM, y para ver si un proyecto
// está publicando.
//
//   node scripts/leer-contexto.mjs                # el más reciente de todos
//   node scripts/leer-contexto.mjs mi-proyecto    # uno en concreto
//   node scripts/leer-contexto.mjs --todos        # qué proyectos tienen estado
//
// Sin argumento usa la allowlist completa, que es lo mismo que hace el server.
// Pedir uno en concreto es para depurar: si el bloque que sale es de otro
// proyecto del que esperabas, el que gana es el más reciente.
import "dotenv/config";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
req("dotenv").config();

const { obtenerUltimoEstado, obtenerUltimoEstadoDe } = await import("../dist/copilot/store.js");
const { construirContextoCopilot, proyectosCopilot } = await import("../dist/copilot/contexto.js");

const arg = process.argv[2];
const permitidos = proyectosCopilot();

/** Estado de cada proyecto de la allowlist, para ver quién publica y quién no. */
async function verTodos() {
  console.log(`  allowlist (COPILOT_PROJECTS): ${permitidos.join(", ") || "(vacía)"}`);
  console.log();
  for (const p of permitidos) {
    const e = await obtenerUltimoEstado(p);
    if (!e) {
      console.log(`  ${p.padEnd(20)} sin estado`);
      console.log(
        `  ${"".padEnd(20)} → revisa que "${p}" esté en IVI_PROJECTS en ~/.config/opencode/ivi.env`
      );
      continue;
    }
    const min = (Date.now() - Date.parse(e.observed_at)) / 60000;
    const vencido = min > 180;
    console.log(
      `  ${p.padEnd(20)} ${min.toFixed(0).padStart(4)} min ${vencido ? "(VIEJO, no se inyecta)" : ""}` +
        `  ${String(e.files_changed?.length ?? 0)} archivos`
    );
  }
  console.log();
}

if (arg === "--todos") {
  await verTodos();
} else {
  const proyecto = arg || null;
  const estado = proyecto
    ? await obtenerUltimoEstado(proyecto)
    : await obtenerUltimoEstadoDe(permitidos);
  console.log("  proyecto:", estado?.project ?? proyecto ?? "(ninguno)");
  console.log(
    "  estado:",
    estado ? "OK  sesion=" + estado.session_id : "NULL (sin estado o muy viejo)"
  );
  console.log();
  console.log("=== EXACTAMENTE lo que se inyecta al system prompt ===");
  const ctx = construirContextoCopilot(estado);
  console.log(ctx ?? "(nada: Ivi responderá sin contexto de OpenCode)");
  console.log();
  console.log(`(${ctx ? ctx.length : 0} caracteres)`);
}