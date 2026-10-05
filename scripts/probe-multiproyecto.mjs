// Sonda: prueba la lectura multi-proyecto del copiloto contra la DB real.
//
//   node scripts/probe-multiproyecto.mjs
//
// El bug que atrapa: la allowlist de escritura aceptaba varios proyectos pero
// la lectura solo miraba COPILOT_PROJECTS[0]. Con dos proyectos dados de alta,
// el segundo publicaba estado, se guardaba, y NUNCA se inyectaba. Esto no se ve
// en los tests unitarios porque ahí no hay DB.
//
// Trabaja sobre la DB de producción (Turso), como probe-ventana.mjs. Solo
// escribe filas de proyectos "zz-probe-*", que no pueden chocar con nada real,
// y las borra al terminar. No toca filas de proyectos de verdad.
//
// Antes de correrlo, deja de usar OpenCode en otro proyecto o la fila real puede
// quedar como "la más reciente" y falsear el resultado.
import "dotenv/config";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
req("dotenv").config();

const { createClient } = await import("@libsql/client");
const { inicializarCopilotDB, guardarEstado, obtenerUltimoEstado, obtenerUltimoEstadoDe } = await import(
  "../dist/copilot/store.js"
);
const { construirContextoCopilot } = await import("../dist/copilot/contexto.js");

// Allowlist de la sonda: dos permitidos. El tercero NO va aquí a propósito:
// se escribe en la DB pero no se autoriza, que es el caso real que importa
// (un proyecto que quitaste de la lista y cuya fila quedó en la tabla).
const PERMITIDOS = ["zz-probe-antiguo", "zz-probe-reciente"];
const NO_PERMITIDO = "zz-probe-externo";
process.env.COPILOT_PROJECTS = PERMITIDOS.join(",");

const { proyectosCopilot } = await import("../dist/copilot/contexto.js");

const url = process.env.TURSO_DATABASE_URL;
if (!url) {
  console.error("  Falta TURSO_DATABASE_URL");
  process.exit(1);
}
const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

const mins = (n) => new Date(Date.now() - n * 60_000).toISOString();
const estado = (project, session, observedAt) => ({
  v: 1,
  source: "opencode",
  project,
  session_id: session,
  observed_at: observedAt,
  status: "busy",
  original_request: { text: `trabajando en ${project}`, at: observedAt },
  last_message: { text: `mensaje de ${project}`, at: observedAt },
  todos: { current: `tarea de ${project}`, done: 1, total: 3 },
  files_changed: [{ file: `${project}/archivo.ts`, add: 10, del: 2, status: "modified" }],
  last_tool: { tool: "edit", title: `edit en ${project}`, ok: true, at: observedAt },
  failures: [],
  metrics: { steps: 5, tokens_in: 100, tokens_out: 50, cost_usd: 0.001 },
});

const limpiar = async () => {
  await db.execute({
    sql: `DELETE FROM copilot_state WHERE project LIKE 'zz-probe-%'`,
    args: [],
  });
};

let fallas = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "OK  " : "FALLA"}  ${msg}`);
  if (!ok) fallas++;
};

await inicializarCopilotDB();
await limpiar();

try {
  console.log("\n=== 1. allowlist: parsea la lista completa ===");
  const leidos = proyectosCopilot();
  check(
    leidos.length === 2 && leidos[0] === PERMITIDOS[0] && leidos[1] === PERMITIDOS[1],
    `proyectosCopilot() devuelve los 2 en orden: ${JSON.stringify(leidos)}`
  );

  console.log("\n=== 2. gana el más reciente entre varios proyectos ===");
  // El más viejo va PRIMERO a propósito: si la consulta quedara con el orden
  // equivocado, el resultado sería determinista y falso.
  await guardarEstado(estado(PERMITIDOS[0], "s1", mins(40)));
  await guardarEstado(estado(PERMITIDOS[1], "s2", mins(5)));

  const r = await obtenerUltimoEstadoDe(proyectosCopilot());
  check(r !== null, "devuelve estado");
  check(r?.project === PERMITIDOS[1], `gana el más reciente (${PERMITIDOS[1]}), no el primero`);
  check(r?.session_id === "s2", "es la sesión correcta");

  // Contraste explícito: esto es lo que hacía el server antes del fix
  // (obtenerUltimoEstado(COPILOT_PROJECTS[0])). Devolvía el proyecto de la
  // lista, no el que estabas trabajando. Si alguien revierte el fix a leer un
  // solo proyecto, esta línea es la que se pone roja.
  const viejo = await obtenerUltimoEstado(PERMITIDOS[0]);
  check(
    viejo?.project === PERMITIDOS[0] && viejo.project !== r.project,
    `el modo viejo (leer solo ${PERMITIDOS[0]}) daría ${viejo?.project}, no ${r.project}`
  );

  console.log("\n=== 3. el bloque nombra el proyecto que ganó ===");
  const ctx = construirContextoCopilot(r);
  check(
    ctx?.includes(`proyecto ${PERMITIDOS[1]}`) === true,
    "el bloque dice de qué proyecto es la info"
  );
  check(
    ctx?.includes(PERMITIDOS[0]) === false,
    "no menciona el proyecto que NO ganó"
  );

  console.log("\n=== 4. un proyecto fuera de la allowlist NO se lee ===");
  // Lo más nuevo de todo, y NO está autorizado: simula una fila que quedó de
  // cuando el proyecto sí estaba en la lista. Si la lectura no filtra, gana.
  await guardarEstado(estado(NO_PERMITIDO, "s3", mins(1)));
  const r2 = await obtenerUltimoEstadoDe(proyectosCopilot());
  check(
    r2?.project !== NO_PERMITIDO,
    `ignora ${NO_PERMITIDO} aunque sea el más reciente (devolvió ${r2?.project})`
  );
  check(r2?.project === PERMITIDOS[1], "sigue ganando el permitido más reciente");

  console.log("\n=== 5. la ventana de 180 min sigue aplicando ===");
  await limpiar();
  // Misma sesión en los dos casos: el upsert replaces la fila, como en una
  // sesión real. Con sesiones distintas coexistirían y la más vieja dentro de
  // la ventana ganaría, que no es lo que queremos medir aquí.
  await guardarEstado(estado(PERMITIDOS[1], "s4", mins(179)));
  const dentro = await obtenerUltimoEstadoDe(proyectosCopilot());
  check(dentro !== null, "179 min: todavía entra");
  check(
    Date.parse(dentro.observed_at) > Date.now() - 180 * 60_000,
    "179 min: el que entró es el de 179, no uno viejo"
  );

  await guardarEstado(estado(PERMITIDOS[1], "s4", mins(181)));
  check(
    (await obtenerUltimoEstadoDe(proyectosCopilot())) === null,
    "181 min: la misma sesión ya no entra"
  );

  console.log("\n=== 6. lista vacía no rompe ===");
  // `IN ()` es SQL inválido y reventaría la consulta.
  check((await obtenerUltimoEstadoDe([])) === null, "allowlist vacía → null, sin error");
  check((await obtenerUltimoEstadoDe(["   ", ""])) === null, "solo espacios → null, sin error");
} finally {
  await limpiar();
  const quedan = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM copilot_state WHERE project LIKE 'zz-probe-%'`,
    args: [],
  });
  console.log(
    `\n  filas de prueba borradas (quedan ${Number(quedan.rows[0].n)})` +
      (fallas === 0 ? "" : "  OJO: revisar")
  );
}

console.log(fallas === 0 ? "\n  TODO OK" : `\n  ${fallas} FALLAS`);
process.exit(fallas === 0 ? 0 : 1);