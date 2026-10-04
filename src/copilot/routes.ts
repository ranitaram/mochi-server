// routes.ts — Endpoint que recibe el estado del copiloto.
//
// POST /api/copilot/state
//   Header: Authorization: Bearer <COPILOT_TOKEN>   (token SOLO del copiloto,
//           separado de ADMIN_SECRET y de las claves del LLM)
//
// Por qué NO reusar requireAdmin: el token del copiloto vive en la PC dentro de
// ~/.config/opencode/ivi.env, no en el navegador. Si compartieran secreto,
// cualquier acceso al panel expondría tambien la capacidad de inyectar estado
// falso a Ivi.
//
// Tres capas de protección en esta ruta:
//   1. Token propio, comparado en tiempo constante.
//   2. Allowlist de proyectos (COPILOT_PROJECTS): aunque el token se fugue,
//      no puede inyectar estado de un proyecto ajeno.
//   3. Rate limit por token.

import express, { Request, Response } from "express";
import crypto from "crypto";
import { validarEstado, MAX_PAYLOAD_BYTES, EstadoCopilot } from "./state";
import { guardarEstado } from "./store";

const COPILOT_TOKEN = process.env.COPILOT_TOKEN ?? "";

// Allowlist de proyectos. OBLIGATORIA por diseño: si está vacía el endpoint se
// cierra en vez de aceptar cualquier nombre de proyecto.
//
// El caso real que motivó esto: en producción faltaba COPILOT_PROJECTS y el
// endpoint aceptaba "otro-proyecto" sin problema. Con la allowlist opcional,
// un deploy mal configurado abre el endpoint a cualquier proyecto que mande
// el token. Cerrar por defecto es lo correcto para algo que escribe en el
// contexto de Ivi: que falle el deploy, no la privacidad.
const PROYECTOS = String(process.env.COPILOT_PROJECTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RATE_MAX = Number(process.env.COPILOT_RATE_MAX ?? 60); // peticiones
const RATE_MS = Number(process.env.COPILOT_RATE_MS ?? 60_000); // por ventana

// Ventana deslizante por token. En RAM: si Render reinicia, se reinicia el
// rate limit. Aceptable para el MVP.
const golpes = new Map<string, number[]>();

function rateLimiteAcepta(id: string): boolean {
  const ahora = Date.now();
  const lista = (golpes.get(id) ?? []).filter((t) => ahora - t < RATE_MS);
  if (lista.length >= RATE_MAX) {
    golpes.set(id, lista);
    return false;
  }
  lista.push(ahora);
  golpes.set(id, lista);
  return true;
}

/** Comparación en tiempo constante: no filtra información por temporización. */
function tokenValido(recibido: string): boolean {
  if (!COPILOT_TOKEN || !recibido) return false;
  const a = Buffer.from(recibido);
  const b = Buffer.from(COPILOT_TOKEN);
  // hash both to fixed length so timingSafeEqual never throws on length mismatch
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(a).digest(),
    crypto.createHash("sha256").update(b).digest()
  );
}

function tokenDe(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return m ? m[1].trim() : null;
}

const router = express.Router();

router.post("/state", async (req: Request, res: Response) => {
  if (!COPILOT_TOKEN) {
    console.warn("[copilot] COPILOT_TOKEN no configurado → endpoint cerrado");
    return res.status(503).json({ error: "Endpoint deshabilitado" });
  }
  if (PROYECTOS.length === 0) {
    console.warn("[copilot] COPILOT_PROJECTS vacío → endpoint cerrado");
    return res.status(503).json({ error: "Endpoint deshabilitado" });
  }

  const token = tokenDe(req);
  if (!tokenValido(token!)) {
    // No distinguimos "token mal" de "sin token" para no dar información.
    return res.status(401).json({ error: "No autorizado" });
  }

  if (!rateLimiteAcepta("copilot")) {
    return res.status(429).json({ error: "Demasiadas peticiones" });
  }

  const crudo = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : req.body;
  if (typeof crudo === "string" && Buffer.byteLength(crudo, "utf8") > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({ error: "Payload demasiado grande" });
  }

  let cuerpo: unknown = crudo;
  if (typeof crudo === "string") {
    try {
      cuerpo = JSON.parse(crudo);
    } catch {
      return res.status(400).json({ error: "JSON invalido" });
    }
  }

  const resultado = validarEstado(cuerpo);
  if (!resultado.ok) {
    return res.status(400).json({ error: resultado.error });
  }
  const estado: EstadoCopilot = resultado.state;

  // Allowlist: el token es de un proyecto, no de todos. Comparación exacta,
  // sin normalizar mayúsculas: "MOCHI-SERVER" no es "mochi-server".
  if (!PROYECTOS.includes(estado.project)) {
    console.warn("[copilot] Proyecto no permitido:", estado.project);
    return res.status(403).json({ error: "Proyecto no permitido" });
  }

  const guardado = await guardarEstado(estado);

  // Log sin secretos: ni el token, ni el cuerpo.
  console.log(
    `[copilot] estado recibido proyecto=${estado.project} sesion=${estado.session_id.slice(0, 12)}… ` +
      `status=${estado.status} pasos=${estado.metrics.steps} fallos=${estado.failures.length} ` +
      `archivos=${estado.files_changed.length} guardado=${guardado}`
  );

  return res.json({ ok: true, guardado });
});

export const copilotRouter = router;