// test-sesion.ts
// Prueba unitaria de las sesiones de conversación (src/session.ts).
// Corre con: ts-node scripts/test-sesion.ts
// Usa un idle corto (100ms) para ejercitar el reseteo sin esperar 15 min.

process.env.SESSION_IDLE_MS = process.env.SESSION_IDLE_MS || "100";

import {
  obtenerSesion,
  agregarMensaje,
  resetearSesion,
  limpiarSesiones,
} from "../src/session";

async function main() {
  const a = obtenerSesion("cliente-A");
  agregarMensaje(a, { role: "user", content: "hola, me llamo Pedro" });
  agregarMensaje(a, { role: "assistant", content: "¡Hola Pedro!" });

  if (a.historial.length !== 2) throw new Error("deberia tener 2 mensajes");
  if (a.historial[0].content !== "hola, me llamo Pedro") throw new Error("orden incorrecto");
  console.log("OK 1: la sesión guarda el historial", JSON.stringify(a.historial));

  const b = obtenerSesion("cliente-B");
  if (b.historial.length !== 0) throw new Error("las sesiones deben ser independientes");
  console.log("OK 2: sesiones independientes por cliente");

  // Idle: vuelve a pedir A tras 300ms (> idle 100ms) → historial reseteado
  await new Promise((r) => setTimeout(r, 300));
  const a2 = obtenerSesion("cliente-A");
  if (a2.historial.length !== 0) throw new Error("deberia resetear tras idle");
  if (a2 === a) throw new Error("deberia ser una sesión nueva");
  console.log("OK 3: reseteo por idle (espera 300ms > idle 100ms)");

  // Mismo cliente dentro del idle → misma sesión (no resetea)
  agregarMensaje(a2, { role: "user", content: "oye" });
  const a3 = obtenerSesion("cliente-A");
  if (a3 !== a2) throw new Error("no deberia resetar dentro del idle");
  if (a3.historial.length !== 1) throw new Error("deberia conservar el mensaje");
  console.log("OK 4: misma sesión si no pasó el idle");

  // Reset manual
  resetearSesion("cliente-B");
  const b2 = obtenerSesion("cliente-B");
  if (b2.historial.length !== 0) throw new Error("el reset manual debe vaciar");
  console.log("OK 5: reset manual");

  // limpiarSesiones no rompe nada con sesiones vivas
  const viva = obtenerSesion("cliente-V"); // actualiza timestamp
  agregarMensaje(viva, { role: "user", content: "hola" });
  await new Promise((r) => setTimeout(r, 50));
  limpiarSesiones();
  if (obtenerSesion("cliente-V").historial.length !== 1)
    throw new Error("limpiarSesiones no debe borrar sesiones vivas");
  console.log("OK 6: limpiarSesiones conserva las sesiones activas");

  console.log("TEST_SESION: PASS");
}

main().catch((e) => {
  console.error("TEST_SESION: FAIL —", e.message);
  process.exit(1);
});