// Aísla la regla de la antigüedad del historial compartido. Si la sesión
// acumula respuestas que no mencionan la edad, el modelo las imita y parece
// que la regla no funciona cuando en realidad sí.
import "dotenv/config";
const D = new URL("../dist", import.meta.url).pathname;
const { obtenerUltimoEstado } = await import(`${D}/copilot/store.js`);
const { construirContextoCopilot, proyectoCopilot } = await import(`${D}/copilot/contexto.js`);
const { generarRespuesta } = await import(`${D}/llm.js`);

const antiguedad = (iso) => {
  const m = (Date.now() - Date.parse(iso)) / 60000;
  if (m < 60) return `hace ${Math.round(m)} minutos`;
  return `hace ${Math.floor(m / 60)} hora(s)`;
};

const estado = await obtenerUltimoEstado(proyectoCopilot(), 100000);
if (!estado) { console.log("  SIN ESTADO"); process.exit(1); }
console.log(`  estado: ${antiguedad(estado.observed_at)}`);
const ctx = construirContextoCopilot(estado);

for (const q of ["¿Qué estabas haciendo?", "¿Y eso sigue igual ahorita?"]) {
  const r = await generarRespuesta([{ role: "user", content: q }], undefined, undefined, ctx);
  const menciona = /\b(hora|minuto|segundo|rato|antes|ayer|viejo|vencid)/i.test(r.texto);
  console.log(`  ${menciona ? "MENCIONA" : "no     "}  [${r.emocion}] ${r.texto}`);
}
