// auth.ts
// Autenticación simple de UN administrador (dueño de Ivi) con cookie firmada
// por HMAC. Credenciales y secreto vienen de env (ADMIN_USER, ADMIN_PASSWORD,
// ADMIN_SECRET). Sin sesiones en DB: la cookie es lo suficientemente segura
// para un panel personal.

import crypto from "crypto";
import { NextFunction, Request, Response } from "express";

const ADMIN_USER = process.env.ADMIN_USER ?? "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const COOKIE = "ivi_admin_session";
const MAX_AGE_SEC = 7 * 24 * 3600; // 7 días

function firmar(payload: string): string {
  return crypto.createHmac("sha256", ADMIN_SECRET).update(payload).digest("hex");
}

export function leerCookie(req: Request): string | null {
  const raw = req.headers.cookie ?? "";
  const re = new RegExp(`${COOKIE}=([^;]+)`);
  const m = raw.match(re);
  return m ? decodeURIComponent(m[1]) : null;
}

export function isAdmin(req: Request): boolean {
  const token = leerCookie(req);
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  if (sig !== firmar(payload)) return false;
  return payload.split(":")[0] === ADMIN_USER;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: "No autorizado" });
}

export function loginAdmin(req: Request, res: Response) {
  if (!ADMIN_SECRET) {
    return res.status(500).json({ error: "ADMIN_SECRET no está configurado" });
  }
  const { user, password } = req.body ?? {};
  if (typeof user !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Faltan usuario/password" });
  }
  if (user === ADMIN_USER && password === ADMIN_PASSWORD) {
    const payload = `${ADMIN_USER}:${Date.now()}`;
    const token = `${payload}.${firmar(payload)}`;
    res.setHeader(
      "Set-Cookie",
      `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${MAX_AGE_SEC}; SameSite=Lax`
    );
    return res.json({ ok: true, redirect: "/admin" });
  }
  res.status(401).json({ error: "Credenciales inválidas" });
}

export function logoutAdmin(_req: Request, res: Response) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
}