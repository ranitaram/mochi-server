// session.ts
// Sesiones de conversación EN MEMORIA. Cada "cliente" (IP del ESP32) tiene su
// propio historial; si no se habla durante SESSION_IDLE_MS la sesión se abre
// de cero (historial nuevo) y las sesiones viejas se barren en background.
//
// Env:
//   SESSION_IDLE_MS  (default 900000 = 15 min) — pausa que reinicia la charla
//   SESSION_MAX_MSGS (default 12) — tope de mensajes para no inflar el prompt

import type { ConversationMessage } from "./llm";

const IDLE_MS = parseInt(process.env.SESSION_IDLE_MS || "900000", 10);
const MAX_MSGS = parseInt(process.env.SESSION_MAX_MSGS || "12", 10);

export interface Session {
  historial: ConversationMessage[];
  updatedAt: number;
}

const sesiones = new Map<string, Session>();

/**
 * Devuelve la sesión del cliente. Si no existía o ya pasó IDLE_MS desde el
 * último mensaje, abre una nueva (historial vacío). Refresca updatedAt.
 */
export function obtenerSesion(clave: string): Session {
  const ahora = Date.now();
  let s = sesiones.get(clave);
  if (!s || ahora - s.updatedAt > IDLE_MS) {
    s = { historial: [], updatedAt: ahora };
    sesiones.set(clave, s);
  } else {
    s.updatedAt = ahora;
  }
  return s;
}

/** Descarta la sesión de un cliente (p. ej. al reiniciar el ESP32). */
export function resetearSesion(clave: string): void {
  sesiones.delete(clave);
}

/** Agrega un mensaje y recorta el historial al tope MAX_MSGS. */
export function agregarMensaje(sesion: Session, msg: ConversationMessage): void {
  sesion.historial.push(msg);
  if (sesion.historial.length > MAX_MSGS) {
    sesion.historial = sesion.historial.slice(-MAX_MSGS);
  }
}

/** Borra sesiones que pasaron IDLE_MS sin actividad. */
export function limpiarSesiones(): void {
  const ahora = Date.now();
  for (const [k, v] of sesiones) {
    if (ahora - v.updatedAt > IDLE_MS) sesiones.delete(k);
  }
}

// Barrido periódico en background (unref: no bloquea el exit del proceso).
setInterval(limpiarSesiones, Math.max(IDLE_MS, 60_000)).unref();