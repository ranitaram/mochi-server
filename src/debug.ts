// debug.ts — diagnóstico de red (temporal, se puede borrar).
// /debug/net?host=H&port=P   reporta resolución DNS y TCP reachability
// (IPv4 e IPv6 por separado) desde donde corre el server. Sirvió para ver
// que el runtime de Render no alcanzaba el endpoint de Neon por la ruta
// que Prisma elige (P1001) aunque el host esté vivo.

import dns from "dns/promises";
import net from "net";
import { Router } from "express";

async function tcpProbe(ip: string, port: number, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port, timeout: ms });
    const done = (v: string) => { s.destroy(); resolve(v); };
    s.once("connect", () => done("OK"));
    s.once("timeout", () => done("TIMEOUT"));
    s.once("error", (e) => done(String((e as any).code || e.message)));
  });
}

export const debugRouter = Router();

debugRouter.get("/net", async (req, res) => {
  const host = String(req.query.h || "ep-little-sea-b5g3837a.c-7.us-east-2.aws.neon.tech");
  const port = parseInt(String(req.query.p || "5432"), 10);
  const ms = parseInt(String(req.query.ms || "5000"), 10);

  const a: string[] | null = await dns.resolve4(host).catch(() => null);
  const aaaa: string[] | null = await dns.resolve6(host).catch(() => null);

  const tcp4 = a ? await Promise.all(a.slice(0, 3).map((ip: string) => tcpProbe(ip, port, ms))) : [];
  const tcp6 = aaaa ? await Promise.all(aaaa.slice(0, 3).map((ip: string) => tcpProbe(ip, port, ms))) : [];

  res.json({ host, port, ipv4: a, ipv6: aaaa, tcp4, tcp6, node: process.version });
});