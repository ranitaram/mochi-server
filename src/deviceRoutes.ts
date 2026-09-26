// deviceRoutes.ts
// CRUD de dispositivos y sus redes WiFi.
//
// ¿Quién puede qué?
//  - GET /api/devices/:token/networks  → el ESP32 (Authorization: Bearer <token>)
//    O el admin (cookie de sesión). Devuelve ssid + password DESCIFRADA (va
//    por HTTPS hasta el ESP32).
//  - POST/PUT/DELETE → solo admin (cookie).
//  - /api/admin/devices → solo admin (listar y crear dispositivos).

import { Router } from "express";
import crypto from "crypto";
import { getPrisma } from "./prisma";
import { encryptPassword, decryptPassword } from "./crypto";
import { requireAdmin } from "./auth";

// Prisma se instancia acá (primera vez que se toca una ruta de dispositivo),
// ver src/prisma.ts — lazy para no romper /health si falta DATABASE_URL.
const prisma = getPrisma();

export const deviceRouter = Router();

function tokenDelHeader(req: { headers: { authorization?: string } }): string | null {
  const header = req.headers.authorization ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// GET /api/devices/:token/networks — lista de redes para el dispositivo
deviceRouter.get("/api/devices/:token/networks", async (req, res) => {
  const token = String(req.params.token);
  const bearer = tokenDelHeader(req);

  if (!bearer) {
    res.status(401).json({ error: "Falta token de dispositivo" });
    return;
  }

  const device = await prisma.device.findUnique({ where: { token } });
  if (!device) {
    res.status(404).json({ error: "Dispositivo no encontrado" });
    return;
  }

  if (bearer !== token) {
    res.status(401).json({ error: "Token inválido" });
    return;
  }

  const redes = await prisma.wifiNetwork.findMany({
    where: { deviceId: device.id },
    orderBy: { prioridad: "asc" },
  });

  res.json({
    dispositivo: device.nombre,
    redes: redes.map((r) => ({
      id: r.id,
      ssid: r.ssid,
      password: decryptPassword(r.password),
      prioridad: r.prioridad,
    })),
  });
});

// Crear dispositivo (admin)
deviceRouter.post("/api/admin/devices", requireAdmin, async (req, res) => {
  const nombre = (req.body?.nombre ?? "").trim();
  if (!nombre) {
    res.status(400).json({ error: "Falta el nombre del dispositivo" });
    return;
  }
  const token = crypto.randomBytes(24).toString("hex");
  const device = await prisma.device.create({
    data: { nombre, token },
  });
  res.status(201).json({ id: device.id, nombre: device.nombre, token: device.token });
});

// Listar dispositivos (admin)
deviceRouter.get("/api/admin/devices", requireAdmin, async (_req, res) => {
  const devices = await prisma.device.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { redes: true } } },
  });
  res.json({
    dispositivos: devices.map((d) => ({
      id: d.id,
      nombre: d.nombre,
      token: d.token,
      redes: d._count.redes,
    })),
  });
});

// Crear red WiFi en un dispositivo (admin)
deviceRouter.post("/api/devices/:token/networks", requireAdmin, async (req, res) => {
  const token = String(req.params.token);
  const { ssid, password, prioridad } = req.body ?? {};

  if (typeof ssid !== "string" || !ssid.trim()) {
    res.status(400).json({ error: "Falta el SSID" });
    return;
  }
  if (typeof password !== "string" || !password) {
    res.status(400).json({ error: "Falta la contraseña" });
    return;
  }

  const device = await prisma.device.findUnique({ where: { token } });
  if (!device) {
    res.status(404).json({ error: "Dispositivo no encontrado" });
    return;
  }

  const prioridadNum = Number(prioridad ?? 100);
  const red = await prisma.wifiNetwork.create({
    data: {
      deviceId: device.id,
      ssid: ssid.trim(),
      password: encryptPassword(password),
      prioridad: Number.isFinite(prioridadNum) ? Math.trunc(prioridadNum) : 100,
    },
  });

  res.status(201).json({ id: red.id, ssid: red.ssid, prioridad: red.prioridad });
});

// Actualizar red WiFi (admin)
deviceRouter.put("/api/devices/:token/networks/:id", requireAdmin, async (req, res) => {
  const token = String(req.params.token);
  const id = String(req.params.id);
  const { ssid, password, prioridad } = req.body ?? {};

  const device = await prisma.device.findUnique({ where: { token } });
  if (!device) {
    res.status(404).json({ error: "Dispositivo no encontrado" });
    return;
  }

  const red = await prisma.wifiNetwork.findFirst({ where: { id, deviceId: device.id } });
  if (!red) {
    res.status(404).json({ error: "Red no encontrada" });
    return;
  }

  const data: { ssid?: string; password?: string; prioridad?: number } = {};
  if (typeof ssid === "string" && ssid.trim()) data.ssid = ssid.trim();
  if (typeof password === "string" && password) {
    data.password = encryptPassword(password);
  }
  if (prioridad !== undefined) {
    const n = Number(prioridad);
    if (Number.isFinite(n)) data.prioridad = Math.trunc(n);
  }

  const actualizada = await prisma.wifiNetwork.update({
    where: { id },
    data,
  });
  res.json({ id: actualizada.id, ssid: actualizada.ssid, prioridad: actualizada.prioridad });
});

// Borrar red WiFi (admin)
deviceRouter.delete("/api/devices/:token/networks/:id", requireAdmin, async (req, res) => {
  const token = String(req.params.token);
  const id = String(req.params.id);

  const device = await prisma.device.findUnique({ where: { token } });
  if (!device) {
    res.status(404).json({ error: "Dispositivo no encontrado" });
    return;
  }

  const red = await prisma.wifiNetwork.findFirst({ where: { id, deviceId: device.id } });
  if (!red) {
    res.status(404).json({ error: "Red no encontrada" });
    return;
  }

  await prisma.wifiNetwork.delete({ where: { id } });
  res.json({ ok: true });
});