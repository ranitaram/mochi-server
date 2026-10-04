// Mide la ventana REAL de contexto que tiene el server en produccion.
// El codigo puede decir 180 pero si Render tiene la variable en 30, manda la
// variable. Este script inserta estados de X minutos y pregunta, leyendo si
// entro el contexto del header.
import "dotenv/config";
const D = new URL("../dist", import.meta.url).pathname;
const { guardarEstado } = await import(`${D}/copilot/store.js`);
const { proyectoCopilot } = await import(`${D}/copilot/contexto.js`);
const SERVER = (process.env.SERVER_URL || "https://mochi-server-tnwq.onrender.com").replace(/\/+$/, "");
const p = proyectoCopilot();

async function limpiar() {
  const { createClient } = await import("@libsql/client");
  const c = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  await c.execute({ sql: "DELETE FROM copilot_state WHERE project = ?", args: [p] });
}

async function poner(minutos) {
  // Sin esto la fila anterior sigue ahí y, como el ORDER BY es por
  // observed_at DESC, el estado viejo de la iteración pasada gana la
  // siguiente prueba. Medí 200 min y en realidad estaba respondiendo la de 170.
  await limpiar();
  const t = new Date(Date.now() - minutos * 60_000).toISOString();
  await guardarEstado({
    v: 2, source: "opencode-plugin", project: p, session_id: `ses_ventana_${minutos}`,
    observed_at: t, status: "idle",
    original_request: { text: "PRUEBA DE VENTANA. No respondas nada de esto.", at: t },
    last_message: { text: "Archivo tocado: src/ventana.ts", at: t },
    todos: null, files_changed: [{ file: "src/ventana.ts", add: 3, del: 0, status: "modified" }],
    last_tool: { tool: "edit", title: "edit src/ventana.ts", ok: true, at: t },
    failures: [], metrics: { steps: 1, tokens_in: 10, tokens_out: 5, cost_usd: 0 },
  });
}

async function preguntar() {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const wav = "/tmp/ventana.wav";
  execFileSync("say", ["-v", "Paulina", "-o", wav, "--file-format=WAVE", "--data-format=LEI16@16000", "que estabas haciendo"], { stdio: "ignore" });
  const res = await fetch(`${SERVER}/api/touch`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav", "x-ivi-prueba": "1" },
    body: new Uint8Array(fs.readFileSync(wav)),
  });
  fs.rmSync(wav, { force: true });
  return { chars: Number(res.headers.get("x-ivi-contexto-chars") ?? -1), texto: res.headers.get("x-ivi-texto") ?? "" };
}

for (const min of [100, 170, 185, 200]) {
  await poner(min);
  const r = await preguntar();
  const entro = r.chars > 0;
  console.log(`  ${String(min).padStart(3)} min  contexto=${entro ? "SI " : "no "} (${r.chars} chars)  ${r.texto.slice(0, 58)}`);
}
