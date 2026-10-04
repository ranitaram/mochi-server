// state.ts — Validación y normalización del estado v2 que manda el plugin.
//
// SEGURIDAD EN CAPAS. El plugin ya redacta en la PC, pero el backend NUNCA
// confía en eso: si mañana alguien agrega un campo al estado y olvida
// filtrarlo, esta capa lo atrapa antes de que llegue al LLM.
//
// REGLA: whitelist estricta. Todo campo que no esté en la lista se descarta.
// Así un payload inflado con campos raros no puede inyectar nada.

import { redactarTexto, redactarTail } from "./redact";

export const VERSION_ESTADO = 2;

const MAX_REQUEST_CHARS = 600;
const MAX_MESSAGE_CHARS = 800;
const MAX_TITULO_CHARS = 120;
const MAX_FALLOS = 5;
const MAX_ARCHIVOS = 50;
const MAX_TOOL_CHARS = 40;

// Tope duro del body. El estado rightful pesa ~3 KB; 64 KB es amplio para
// holgura pero corta cualquier intento de abusar el endpoint.
export const MAX_PAYLOAD_BYTES = 64 * 1024;

type Resultado<T> = { ok: true; state: T } | { ok: false; error: string };

/**
 * Quita los delimitadores del bloque de contexto.
 *
 * El texto que manda el plugin es TERCERO: puede venir de un archivo, de un
 * comando, de lo que escribió OpenCode. Si ese texto trae
 * "=== FIN DEL ESTADO ===", el bloque se cierra antes de tiempo y todo lo que
 * el atacante puso despues queda fuera de las comillas que lo protegen: se
 * leeria como instruccion para el modelo.
 *
 * Se ciega el delimitador en vez de rechazarlo. El texto sigue siendo legible
 * para la persona, pero ya no puede romper la estructura.
 */
export function cegarDelimitadores(texto: string): string {
  if (typeof texto !== "string") return "";
  return texto.replace(/={2,}\s*FIN DEL ESTADO\s*={2,}/gi, "[bloque cerrado]").replace(/={2,}\s*ESTADO DE OPENCODE\s*={2,}/gi, "[bloque abierto]");
}

function texto(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  return cegarDelimitadores(redactarTexto(v)).slice(0, max);
}

function entero(v: unknown, max = 1e9): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

function esIso(v: unknown): string {
  if (typeof v !== "string") return new Date().toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** Camino relativo y sin traversal. Cualquier cosa fuera se descarta. */
function caminoSeguro(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 400) return null;
  if (v.includes("..") || v.startsWith("/") || v.includes("\\")) return null;
  if (/^[A-Za-z]:/.test(v)) return null; // ruta absoluta de Windows
  return redactarTexto(v);
}

/**
 * Valida un payload crudo y devuelve el estado ya saneado.
 * Nunca lanza: devuelve {ok:false, error} para que la ruta responda 400 limpio.
 */
export function validarEstado(crudo: unknown): Resultado<EstadoCopilot> {
  if (typeof crudo !== "object" || crudo === null || Array.isArray(crudo)) {
    return { ok: false, error: "El cuerpo debe ser un objeto JSON" };
  }
  const p = crudo as Record<string, unknown>;

  const v = entero(p.v, 10);
  if (v !== VERSION_ESTADO) {
    return { ok: false, error: `Version de estado no soportada: ${v}. Se espera ${VERSION_ESTADO}.` };
  }

  const sessionID = texto(p.session_id, MAX_TOOL_CHARS * 2);
  if (!sessionID) return { ok: false, error: "Falta session_id" };

  // project debe ser solo un nombre de carpeta, no una ruta.
  const project = caminoSeguro(p.project);
  if (!project) return { ok: false, error: "Falta project (nombre de carpeta, no ruta)" };

  const statusBruto = texto(p.status, 16);
  const status: EstadoCopilot["status"] =
    statusBruto === "idle" || statusBruto === "busy" || statusBruto === "error"
      ? statusBruto
      : "idle";

  // --- original_request ---
  let original_request: EstadoCopilot["original_request"] = null;
  if (p.original_request && typeof p.original_request === "object") {
    const o = p.original_request as Record<string, unknown>;
    const t = texto(o.text, MAX_REQUEST_CHARS);
    if (t) original_request = { text: t, at: esIso(o.at) };
  }

  // --- last_message ---
  let last_message: EstadoCopilot["last_message"] = null;
  if (p.last_message && typeof p.last_message === "object") {
    const l = p.last_message as Record<string, unknown>;
    const t = texto(l.text, MAX_MESSAGE_CHARS);
    if (t) last_message = { text: t, at: esIso(l.at) };
  }

  // --- todos ---
  let todos: EstadoCopilot["todos"] = null;
  if (p.todos && typeof p.todos === "object") {
    const t = p.todos as Record<string, unknown>;
    const done = entero(t.done, 10_000);
    const total = entero(t.total, 10_000);
    // done > total solo puede venir de un payload manipulado.
    if (total >= done && total > 0) {
      todos = {
        current: texto(t.current, 200),
        done,
        total,
      };
    }
  }

  // --- files_changed (NUNCA el patch, solo rutas y conteos) ---
  const files_changed: EstadoCopilot["files_changed"] = [];
  if (Array.isArray(p.files_changed)) {
    for (const item of p.files_changed) {
      if (files_changed.length >= MAX_ARCHIVOS) break;
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      const file = caminoSeguro(f.file);
      if (!file) continue;
      const statusF = texto(f.status, 20) ?? "modified";
      files_changed.push({
        file,
        add: entero(f.add),
        del: entero(f.del),
        status: statusF,
      });
    }
  }

  // --- last_tool ---
  let last_tool: EstadoCopilot["last_tool"] = null;
  if (p.last_tool && typeof p.last_tool === "object") {
    const t = p.last_tool as Record<string, unknown>;
    const tool = texto(t.tool, MAX_TOOL_CHARS);
    if (tool) {
      last_tool = {
        tool,
        title: texto(t.title, MAX_TITULO_CHARS) ?? "",
        ok: t.ok !== false,
        at: esIso(t.at),
      };
    }
  }

  // --- failures ---
  const failures: EstadoCopilot["failures"] = [];
  if (Array.isArray(p.failures)) {
    for (const item of p.failures) {
      if (failures.length >= MAX_FALLOS) break;
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      const tool = texto(f.tool, MAX_TOOL_CHARS);
      if (!tool) continue;
      const tail =
        typeof f.tail === "string" ? cegarDelimitadores(redactarTail(f.tail, 20)) : "";
      failures.push({
        tool,
        title: texto(f.title, MAX_TITULO_CHARS) ?? "",
        exit: entero(f.exit, 65_535),
        truncated: f.truncated === true,
        tail,
        at: esIso(f.at),
      });
    }
  }

  // --- metrics ---
  let metrics: EstadoCopilot["metrics"] = {
    steps: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
  };
  if (p.metrics && typeof p.metrics === "object") {
    const m = p.metrics as Record<string, unknown>;
    metrics = {
      steps: entero(m.steps, 100_000),
      tokens_in: entero(m.tokens_in, 1e12),
      tokens_out: entero(m.tokens_out, 1e12),
      // costo: 6 decimales bastan y evita floats raros
      cost_usd: Math.round(entero(m.cost_usd, 1e6) * 1e6) / 1e6,
    };
  }

  return {
    ok: true,
    state: {
      v: VERSION_ESTADO,
      source: "opencode",
      project,
      session_id: sessionID,
      observed_at: esIso(p.observed_at),
      status,
      original_request,
      last_message,
      todos,
      files_changed,
      last_tool,
      failures,
      metrics,
    },
  };
}

export interface EstadoCopilot {
  v: number;
  source: string;
  project: string;
  session_id: string;
  observed_at: string;
  status: "idle" | "busy" | "error";
  original_request: { text: string; at: string } | null;
  last_message: { text: string; at: string } | null;
  todos: { current: string | null; done: number; total: number } | null;
  files_changed: Array<{ file: string; add: number; del: number; status: string }>;
  last_tool: { tool: string; title: string; ok: boolean; at: string } | null;
  failures: Array<{
    tool: string;
    title: string;
    exit: number;
    truncated: boolean;
    tail: string;
    at: string;
  }>;
  metrics: { steps: number; tokens_in: number; tokens_out: number; cost_usd: number };
}