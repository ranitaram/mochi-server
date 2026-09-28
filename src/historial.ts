// historial.ts
// Historial persistente de conversaciones usando Turso (SQLite en la nube).
// Guarda cada intercambio usuario<->Ivi para consultarlo luego en /historial.
//
// IMPORTANTE (producción/Render): el cliente es LAZY y BINDEADO a que exista
// TURSO_DATABASE_URL, igual que memoria.ts. Si falta la env var (o la DB cae)
// las funciones pasan a ser no-op con log — así el server NUNCA se cae por el
// historial y /health (que no toca la DB) sigue respondiendo al instante.

import { createClient, Client } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
let client: Client | null = null;

if (url) {
  try {
    client = createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  } catch (err: any) {
    console.warn("[historial] No se pudo crear el cliente Turso:", err?.message);
    client = null;
  }
}

function historialDeshabilitado(nombre: string): boolean {
  if (!url) {
    console.warn(`[historial] TURSO_DATABASE_URL no está definida → "${nombre}" deshabilitado`);
    return true;
  }
  if (!client) {
    console.warn(`[historial] Cliente Turso no iniciado → "${nombre}" deshabilitado`);
    return true;
  }
  return false;
}

export async function inicializarHistorial() {
  if (historialDeshabilitado("inicializarHistorial")) return;
  await client!.execute(`
    CREATE TABLE IF NOT EXISTS conversaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispositivo TEXT NOT NULL,
      inicio TEXT NOT NULL
    )
  `);
  await client!.execute(`
    CREATE TABLE IF NOT EXISTS mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversacion_id INTEGER NOT NULL REFERENCES conversaciones(id),
      rol TEXT NOT NULL,
      contenido TEXT NOT NULL,
      fecha TEXT NOT NULL
    )
  `);
  await client!.execute(
    `CREATE INDEX IF NOT EXISTS idx_mensajes_conv ON mensajes (conversacion_id, id)`
  );
}

/** Abre una conversación nueva y devuelve su id (o null si Turso no está). */
export async function abrirConversacion(dispositivo: string): Promise<number | null> {
  if (historialDeshabilitado("abrirConversacion")) return null;
  const r = await client!.execute({
    sql: "INSERT INTO conversaciones (dispositivo, inicio) VALUES (?, datetime('now'))",
    args: [dispositivo],
  });
  return r.lastInsertRowid === undefined || r.lastInsertRowid === null
    ? null
    : Number(r.lastInsertRowid);
}

export async function agregarMensajeHistorial(
  conversacionId: number,
  rol: "user" | "assistant",
  contenido: string
): Promise<void> {
  if (historialDeshabilitado("agregarMensajeHistorial")) return;
  await client!.execute({
    sql: "INSERT INTO mensajes (conversacion_id, rol, contenido, fecha) VALUES (?, ?, ?, datetime('now'))",
    args: [conversacionId, rol, contenido],
  });
}

export interface MensajeHistorial {
  rol: "user" | "assistant";
  contenido: string;
  fecha: string;
}

export interface ConversacionHistorial {
  id: number;
  dispositivo: string;
  inicio: string;
  mensajes: MensajeHistorial[];
}

/** Últimas `limite` conversaciones (fecha DESC) con sus mensajes (ASC). */
export async function listarHistorial(
  limite = 50
): Promise<ConversacionHistorial[] | null> {
  if (historialDeshabilitado("listarHistorial")) return null;
  const n = Math.max(1, Math.min(200, Math.trunc(limite)));

  const conv = await client!.execute({
    sql: "SELECT id, dispositivo, inicio FROM conversaciones ORDER BY id DESC LIMIT ?",
    args: [n],
  });

  const resultado: ConversacionHistorial[] = [];
  for (const fila of conv.rows) {
    const id = Number(fila.id);
    const msgs = await client!.execute({
      sql: "SELECT rol, contenido, fecha FROM mensajes WHERE conversacion_id = ? ORDER BY id ASC",
      args: [id],
    });
    resultado.push({
      id,
      dispositivo: String(fila.dispositivo ?? ""),
      inicio: String(fila.inicio ?? ""),
      mensajes: msgs.rows.map((m) => ({
        rol: String(m.rol) === "assistant" ? "assistant" : "user",
        contenido: String(m.contenido ?? ""),
        fecha: String(m.fecha ?? ""),
      })),
    });
  }
  return resultado;
}