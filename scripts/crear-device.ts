// scripts/crear-device.ts
// Crea un dispositivo Ivi en la DB (Postgres) y muestra el TOKEN que hay que
// pegar en el firmware (config.h → DEVICE_TOKEN). El token solo se ve acá.
//
// Uso: npm run crear-device -- "Nombre de la Ivi"
//      (si no pasás nombre, usa "Ivi")

import "dotenv/config";
import crypto from "crypto";
import { getPrisma } from "../src/prisma";

async function main() {
  const nombre = process.argv[2] ?? "Ivi";
  const token = crypto.randomBytes(24).toString("hex");

  const prisma = getPrisma();
  try {
    const device = await prisma.device.create({
      data: { nombre, token },
    });
    console.log("Dispositivo creado:");
    console.log("  nombre:", device.nombre);
    console.log("  token:", device.token);
    console.log("");
    console.log("> Pegá ese token en firmware/mochi-esp32/src/config.h como:");
    console.log(`>   #define DEVICE_TOKEN "${device.token}"`);
    console.log("> y flashea el ESP32.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Error creando dispositivo:", err.message);
  console.error("¿Está DATABASE_URL configurada en tu .env?");
  process.exit(1);
});