// prisma.ts
// Cliente de Prisma (PostgreSQL) con instanciación LAZY: el constructor de
// PrismaClient valida DATABASE_URL y podría tirar al boot si la env var aún
// no está. Como /health no debe depender de la DB (fase 1), solo creamos el
// cliente cuando se toca por primera vez una ruta que sí lo necesita.
//
// Conectamos con el ADAPTER HTTP DE NEON (@prisma/adapter-neon + serverless
// driver): va por HTTPS/fetch, sin TCP al puerto 5432 ni resolver propio del
// engine Rust. En Render el engine de Prisma resuelve el host por IPv6
// (ENETUNREACH, P1001) aunque IPv4 funcione; el driver HTTP no padece eso
// (verificado en /debug/net y con una query local).

import { PrismaClient } from "@prisma/client";
import { PrismaNeonHTTP } from "@prisma/adapter-neon";

let _prisma: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!_prisma) {
    const adapter = new PrismaNeonHTTP(process.env.DATABASE_URL!, {
      arrayMode: true,
      fullResults: true,
    } as any);
    _prisma = new PrismaClient({ adapter });
  }
  return _prisma;
}