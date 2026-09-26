// memoria.ts
// Memoria persistente de Ivi usando Turso (SQLite en la nube).
// Guarda hechos que la persona comparte en la conversación para que Ivi
// los recuerde entre sesiones.
//
// IMPORTANTE (producción/Render): la creación del cliente es LAZY y BINDEADA
// a que exista TURSO_DATABASE_URL. Si falta la env var (o la DB cae), las
// funciones pasan a ser no-op con log — así el server NUNCA se cae por la
// memoria y /health (que no toca la DB) sigue respondiendo al instante.

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
    console.warn("[memoria] No se pudo crear el cliente Turso:", err?.message);
    client = null;
  }
}

function memoriaDeshabilitada(nombre: string): boolean {
  if (!url) {
    console.warn(`[memoria] TURSO_DATABASE_URL no está definida → "${nombre}" deshabilitado`);
    return true;
  }
  if (!client) {
    console.warn(`[memoria] Cliente Turso no iniciado → "${nombre}" deshabilitado`);
    return true;
  }
  return false;
}

export async function inicializarDB() {
  if (memoriaDeshabilitada("inicializarDB")) return;
  await client!.execute(`
    CREATE TABLE IF NOT EXISTS hechos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contenido TEXT NOT NULL,
      fecha TEXT NOT NULL
    )
  `);
}

export async function guardarHecho(texto: string) {
  if (memoriaDeshabilitada("guardarHecho")) return;
  await client!.execute({
    sql: "INSERT INTO hechos (contenido, fecha) VALUES (?, datetime('now'))",
    args: [texto],
  });
}

export async function obtenerHechos(): Promise<string[]> {
  if (memoriaDeshabilitada("obtenerHechos")) return [];
  const result = await client!.execute({
    sql: "SELECT contenido FROM hechos ORDER BY fecha DESC LIMIT 30",
    args: [],
  });
  return result.rows.map((r) => r.contenido as string);
}