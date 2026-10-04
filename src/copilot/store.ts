// store.ts — Persistencia del estado del copiloto en libsql.
//
// Sigue el mismo patrón que memoria.ts: cliente LAZY y no-op con log si falta
// TURSO_DATABASE_URL, para que /health nunca dependa de la DB.
//
// Diseño: una fila por proyecto+sesión, sobrescrita. El estado es una FOTO del
// momento, no un historial: si Ivi pregunta "¿qué estabas haciendo?", necesita
// el último estado, no 200 filas que filtrar.

import { createClient, Client } from "@libsql/client";
import type { EstadoCopilot } from "./state";

const url = process.env.TURSO_DATABASE_URL;
let client: Client | null = null;

if (url) {
  try {
    client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  } catch (err: any) {
    console.warn("[copilot] No se pudo crear el cliente Turso:", err?.message);
    client = null;
  }
}

function deshabilitado(nombre: string): boolean {
  if (!url) {
    console.warn(`[copilot] TURSO_DATABASE_URL no definida → "${nombre}" deshabilitado`);
    return true;
  }
  if (!client) {
    console.warn(`[copilot] Cliente Turso no iniciado → "${nombre}" deshabilitado`);
    return true;
  }
  return false;
}

export async function inicializarCopilotDB() {
  if (deshabilitado("inicializarCopilotDB")) return;
  await client!.execute(`
    CREATE TABLE IF NOT EXISTS copilot_state (
      project      TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      observed_at  TEXT NOT NULL,
      status       TEXT NOT NULL,
      payload      TEXT NOT NULL,
      PRIMARY KEY (project, session_id)
    )
  `);
  await client!.execute(`
    CREATE INDEX IF NOT EXISTS idx_copilot_observed
      ON copilot_state (observed_at DESC)
  `);
}

export async function guardarEstado(estado: EstadoCopilot): Promise<boolean> {
  if (deshabilitado("guardarEstado")) return false;
  try {
    await client!.execute({
      sql: `
        INSERT INTO copilot_state (project, session_id, observed_at, status, payload)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (project, session_id) DO UPDATE SET
          observed_at = excluded.observed_at,
          status      = excluded.status,
          payload     = excluded.payload
      `,
      args: [
        estado.project,
        estado.session_id,
        estado.observed_at,
        estado.status,
        JSON.stringify(estado),
      ],
    });
    return true;
  } catch (err: any) {
    console.warn("[copilot] Error al guardar estado:", err?.message);
    return false;
  }
}

export async function obtenerUltimoEstado(
  project: string,
  maxAgeMin = 30
): Promise<EstadoCopilot | null> {
  if (deshabilitado("obtenerUltimoEstado")) return null;
  try {
    const desde = new Date(Date.now() - maxAgeMin * 60_000).toISOString();
    const res = await client!.execute({
      sql: `
        SELECT payload FROM copilot_state
        WHERE project = ? AND observed_at >= ?
        ORDER BY observed_at DESC
        LIMIT 1
      `,
      args: [project, desde],
    });
    if (res.rows.length === 0) return null;
    return JSON.parse(res.rows[0].payload as string) as EstadoCopilot;
  } catch (err: any) {
    console.warn("[copilot] Error al leer estado:", err?.message);
    return null;
  }
}