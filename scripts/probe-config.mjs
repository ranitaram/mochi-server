// Consulta qué configuración está viendo el server de PRODUCCIÓN, sin exponer
// secretos. Hace POST con tokensプロジェクト no permitidos y compara.
const BASE = process.argv[2] || "https://mochi-server-tnwq.onrender.com";
const token = process.argv[3];
const proyectos = ["mochi-server", "otro-proyecto", "", "../../etc", "MOCHI-SERVER"];

console.log("  proyecto              | resultado");
console.log("  ----------------------+----------");
for (const p of proyectos) {
  const r = await fetch(`${BASE}/api/copilot/state`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ v: 2, project: p, session_id: "ses_probe_allowlist" }),
  });
  const j = await r.json().catch(() => ({}));
  const marca = r.status === 200 ? "ACEPTADO" : `rechazado (${r.status})`;
  console.log(`  ${JSON.stringify(p).padEnd(22)} | ${marca}`);
}
