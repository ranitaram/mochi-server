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

function verificarToken(token: string | null): boolean {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  if (sig !== firmar(payload)) return false;
  return payload.split(":")[0] === ADMIN_USER;
}

// Token de sesión del request: primero el header Authorization: Bearer
// (fallback por si el navegador bloquea cookies), luego la cookie firmada.
export function tokenDe(req: Request): string | null {
  const auth = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return leerCookie(req);
}

export function isAdmin(req: Request): boolean {
  return verificarToken(tokenDe(req));
}

// Diagnóstico visible en el panel: ¿llegó el header, llegó la cookie, valida?
// Público a propósito (no filtra secretos, solo sí/no) para depurar el
// rebote de sesión desde el navegador sin entrar a los logs del server.
export function diagnosticoAuth(req: Request) {
  const auth = req.headers.authorization ?? "";
  return {
    bearer: /^Bearer\s+/i.test(auth),
    cookie: leerCookie(req) !== null,
    valid: isAdmin(req),
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  // Log de diagnóstico: distinguir "sin header", "sin cookie" e "token inválido"
  // para depurar el rebote de sesión en navegadores.
  const auth = req.headers.authorization ?? "";
  const cookie = leerCookie(req);
  console.log(
    "[auth] 401 " + req.path + " url=" + req.url +
    " bearer=" + (auth.startsWith("Bearer ") ? "si(" + auth.slice(7, 20) + "...)" : "no") +
    " cookie=" + (cookie ? "si(" + cookie.slice(0, 20) + "...)" : "no")
  );
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
      // Secure: el panel ya se sirve por HTTPS (Render); HttpOnly no deja leerla
      // a JS. El token se devuelve tambien en el body para el fallback Bearer
      // (navegadores que bloquean cookies/particionadas).
      `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; Path=/; Max-Age=${MAX_AGE_SEC}; SameSite=Lax`
    );
    return res.json({ ok: true, redirect: "/admin", token });
  }
  res.status(401).json({ error: "Credenciales inválidas" });
}

export function logoutAdmin(_req: Request, res: Response) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
}