// memoria.ts
// Memoria persistente de Ivi usando Turso (SQLite en la nube).
// Guarda hechos que la persona comparte en la conversación para que Ivi
// los recuerde entre sesiones.

import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export async function inicializarDB() {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS hechos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contenido TEXT NOT NULL,
      fecha TEXT NOT NULL
    )
  `);
}

export async function guardarHecho(texto: string) {
  await client.execute({
    sql: "INSERT INTO hechos (contenido, fecha) VALUES (?, datetime('now'))",
    args: [texto],
  });
}

export async function obtenerHechos(): Promise<string[]> {
  const result = await client.execute({
    sql: "SELECT contenido FROM hechos ORDER BY fecha DESC LIMIT 30",
    args: [],
  });
  return result.rows.map((r) => r.contenido as string);
}
