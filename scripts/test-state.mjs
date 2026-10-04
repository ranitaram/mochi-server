#!/usr/bin/env node
// test-state.mjs — Pruebas del validador de estado v2.
//
// Valida el contrato entre el plugin y el backend: que rechace lo que debe
// rechazar y que NUNCA deje pasar un secreto, aunque venga sin redactar.
//
// Uso: node scripts/test-state.mjs   (o npm test)

const { validarEstado, MAX_PAYLOAD_BYTES } = await import("../dist/copilot/state.js");
const { redactarTexto } = await import("../dist/copilot/redact.js");

let total = 0;
let fallos = 0;

function ok(nombre, condicion, detalle = "") {
  total++;
  if (condicion) {
    console.log(`    PASA  ${nombre}`);
  } else {
    fallos++;
    console.log(`    FALLA  ${nombre}${detalle ? "\n            " + detalle : ""}`);
  }
}

function base(extra = {}) {
  return {
    v: 2,
    source: "opencode",
    project: "mochi-server",
    session_id: "ses_abc123",
    observed_at: new Date().toISOString(),
    status: "busy",
    ...extra,
  };
}

console.log("\n  --- contrato basico ---");

ok("acepta un estado minimo", validarEstado(base()).ok);

ok(
  "rechaza version incorrecta",
  validarEstado(base({ v: 1 })).ok === false,
  "  debe exigir v:2"
);

ok("rechaza null", validarEstado(null).ok === false);
ok("rechaza array", validarEstado([]).ok === false);
ok("rechaza string", validarEstado("hola").ok === false);

ok(
  "rechaza sin session_id",
  validarEstado({ ...base(), session_id: undefined }).ok === false
);

ok(
  "rechaza project con ruta",
  validarEstado(base({ project: "/Users/algo/mochi-server" })).ok === false,
  "  debe ser nombre de carpeta, no ruta"
);

ok(
  "rechaza project con traversal",
  validarEstado(base({ project: "../../etc" })).ok === false
);

console.log("\n  --- campos desconhecidos ---");

{
  const r = validarEstado(base({ campo_malvado: "x", __proto__: "y" }));
  ok("acepta el estado pero descarta campos extra", r.ok && r.state.campo_malvado === undefined);
}

console.log("\n  --- redaccion en el servidor (defensa en profundidad) ---");

{
  const r = validarEstado(
    base({
      last_message: { text: "usa gsk_ABCdef123GHIjkl456MNOpqr789STUvw012xyzABCDE", at: "" },
    })
  );
  ok("acepta el estado", r.ok);
  ok(
    "redacta gsk_ aunque venga SIN redactar del plugin",
    r.ok && !r.state.last_message.text.includes("gsk_"),
    r.ok ? `  texto: ${JSON.stringify(r.state.last_message.text)}` : ""
  );
}

{
  const r = validarEstado(
    base({
      original_request: { text: "la clave es DB_PASSWORD=hunter2delgato", at: "" },
    })
  );
  ok(
    "redacta NOMBRE=valor aunque venga sin redactar",
    r.ok && !r.state.original_request.text.includes("hunter2")
  );
}

{
  const r = validarEstado(
    base({
      failures: [
        {
          tool: "bash",
          title: "npm i",
          exit: 1,
          tail: "error conectando a postgres://admin:s3cr3tP4ss@db:5432/app",
          at: "",
        },
      ],
    })
  );
  ok(
    "redacta credenciales en failures[].tail",
    r.ok && !r.state.failures[0].tail.includes("s3cr3t")
  );
}

console.log("\n  --- limites ---");

{
  const r = validarEstado(base({ last_message: { text: "a".repeat(5000), at: "" } }));
  ok("recorta last_message al maximo", r.ok && r.state.last_message.text.length <= 801);
}

{
  const r = validarEstado(
    base({
      failures: Array.from({ length: 50 }, () => ({
        tool: "bash",
        exit: 1,
        tail: "linea",
        at: "",
      })),
    })
  );
  ok("limita failures a 5", r.ok && r.state.failures.length === 5);
}

{
  const r = validarEstado(
    base({
      files_changed: Array.from({ length: 200 }, (_, i) => ({
        file: `src/archivo${i}.ts`,
        add: 1,
        del: 0,
      })),
    })
  );
  ok("limita files_changed a 50", r.ok && r.state.files_changed.length === 50);
}

{
  const r = validarEstado(
    base({
      files_changed: [{ file: "/etc/passwd", add: 1 }, { file: "../fuera.ts", add: 1 }],
    })
  );
  ok("descarta rutas absolutas y traversal en files_changed", r.ok && r.state.files_changed.length === 0);
}

{
  const r = validarEstado(
    base({
      files_changed: [{ file: "src/tts.ts", add: 1, patch: "todo el diff gigante" }],
    })
  );
  ok("descarta el campo patch (nunca debe viajar)", r.ok && r.state.files_changed[0].patch === undefined);
}

console.log("\n  --- coercion de numeros ---");

{
  const r = validarEstado(
    base({ metrics: { steps: "muchos", tokens_in: -50, tokens_out: 1e99, cost_usd: "0.0042" } })
  );
  ok("acepta metricas y las sanea", r.ok && r.state.metrics.steps === 0);
  ok("tokens negativos → 0", r.ok && r.state.metrics.tokens_in === 0);
  ok("tokens absurdos → topados", r.ok && r.state.metrics.tokens_out <= 1e12);
}

{
  const r = validarEstado(base({ todos: { current: "x", done: 9, total: 3 } }));
  ok("descarta todos con done > total", r.ok && r.state.todos === null);
}

console.log("\n  --- idempotencia del redactor ---");

{
  const x = "API_KEY=abc sk-1234567890abcdefghij Bearer zzzzzzzzzzzzzzzzzzzz";
  const uno = redactarTexto(x);
  ok("redactar dos veces no cambia mas", redactarTexto(uno) === uno);
}

console.log(`\n  ${total} pruebas: ${fallos === 0 ? "TODAS PASAN" : fallos + " FALLAN"}`);
console.log(`  (tope de payload: ${MAX_PAYLOAD_BYTES} bytes)\n`);
process.exit(fallos === 0 ? 0 : 1);