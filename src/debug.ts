// debug.ts — diagnóstico de red (temporal, se puede borrar).
// /debug/net?host=H&port=P   reporta resolución DNS y TCP reachability
// (IPv4 e IPv6 por separado) desde donde corre el server, MÁS:
//  - hostConnect : TCP usando el HOSTNAME (lo mismo que hace Prisma)
//  - etcHosts    : si /etc/hosts es escribible (para forzar IPv4 real)
//  - dbUrlHost   : host que Render está usando en DATABASE_URL
// Sirvió para ver que Render alcanzaba Neon por IPv4 pero Prisma resolvía
// IPv6 primero (P1001).

import dns from "dns/promises";
import net from "net";
import fs from "fs/promises";
import { Router } from "express";

async function tcpProbe(hostOrIp: string, port: number, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ host: hostOrIp, port, timeout: ms });
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
  const hostConnect = await tcpProbe(host, port, ms);

  // ¿/etc/hosts es escribible por el proceso?
  let etcHosts = "n/a";
  try {
    const line = "\n127.0.0.2 ivi-probe.test\n";
    await fs.appendFile("/etc/hosts", line);
    await fs.appendFile("/etc/hosts", "REMOVERESTA\n");
    const content = await fs.readFile("/etc/hosts", "utf8");
    const written = content.includes("ivi-probe.test");
    if (written) {
      // limpiar y restavurar
      const clean = content.replace("127.0.0.2  ivi-probe.test", "").replace("REMOVERESTA", "");
      await fs.writeFile("/etc/hosts", clean);
      etcHosts = "WRITABLE_OK";
    } else {
      etcHosts = "lectura no confirma escritura";
    }
  } catch (e2: any) {
    etcHosts = "NO_WRITABLE: " + String(e2.code || e2.message);
  }

  // host de la DATABASE_URL (enmascarado) en uso por Render
  const dm = process.env.DATABASE_URL?.match(/@([^:/\s]+):(\d+)/);
  const dbUrlHost = dm ? dm[1] : null;

  res.json({
    host, port,
    ipv4: a, ipv6: aaaa, tcp4, tcp6, hostConnect,
    etcHosts, dbUrlHost,
    node: process.version,
  });
});