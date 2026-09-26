// scripts/migrate-deploy.cjs
// Prisma migrate deploy con reintentos para el build de Render.
// Neon suspende el compute tras inactividad y el primer intento de conexión
// puede fallar mientras despierta (~0-15s). Sin esto, un P1001 puntual
// tumba todo el deploy aunque la DB esté sana.

const { execSync } = require("child_process");

const MAX_ATTEMPTS = 6;
const RETRY_DELAY_S = 8;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    execSync("npx prisma migrate deploy", { stdio: "inherit" });
    console.log("[migrate] Migración aplicada.");
    process.exit(0);
  } catch (err) {
    if (attempt === MAX_ATTEMPTS) {
      console.error("[migrate] Falló tras " + MAX_ATTEMPTS + " intentos.");
      process.exit(1);
    }
    console.warn(
      `[migrate] Intento ${attempt}/${MAX_ATTEMPTS} falló (probable cold start de Neon). Reintentando en ${RETRY_DELAY_S}s...`
    );
    execSync("sleep " + RETRY_DELAY_S);
  }
}