// crypto.ts
// Cifrado simétrico AES-256-GCM para las contraseñas WiFi guardadas en la DB.
// La clave sale de WIFI_ENC_KEY (32 bytes en hex, p.ej. `openssl rand -hex 32`).
// Formato almacenado: "iv:tagname:cipher" en base64 (iv y tag de 12/16 bytes).
//
// La validación de la clave es LAZY: las funciones tiran error recién cuando
// se usan, así /health y el arranque no dependen de esta env var.

import crypto from "crypto";

function obtenerClave(): Buffer {
  const hex = process.env.WIFI_ENC_KEY ?? "";
  const key = Buffer.from(hex, "hex");
  if (hex.length !== 64 || key.length !== 32) {
    throw new Error(
      "WIFI_ENC_KEY debe ser 32 bytes en hex (generala con: openssl rand -hex 32)"
    );
  }
  return key;
}

export function encryptPassword(plano: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", obtenerClave(), iv);
  const enc = Buffer.concat([cipher.update(plano, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptPassword(guardado: string): string {
  const [ivB64, tagB64, dataB64] = guardado.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Password en DB con formato inválido");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    obtenerClave(),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}