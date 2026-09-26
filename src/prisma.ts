// prisma.ts
// Cliente de Prisma (PostgreSQL) con instanciación LAZY: el constructor de
// PrismaClient valida DATABASE_URL y podría tirar al boot si la env var aún
// no está. Como /health no debe depender de la DB (fase 1), solo creamos el
// cliente cuando se toca por primera vez una ruta que sí lo necesita.

import { PrismaClient } from "@prisma/client";

let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient();
  }
  return _prisma;
}