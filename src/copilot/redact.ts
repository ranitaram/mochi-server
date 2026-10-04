// redact.ts — Filtro de secretos para el estado que Ivi envía a Render.
//
// Aplicar SIEMPRE antes de que algo salga de la PC. Se corre en dos capas:
//   1. En el plugin (~/.config/opencode/plugins/ivi-redact.js), antes del fetch.
//   2. Aquí, en Render, como defensa en profundidad. Si mañana alguien agrega un
//      campo al estado y olvida filtrarlo, esta capa lo atrapa antes del LLM.
//
// Las dos implementaciones se validan contra los MISMOS fixtures
// (./redact.fixtures.json). Si divergen, lo detectan los tests.

export const MARCA = "[REDACTED]";

// EL ORDEN IMPORTA. Se aplica en cascada:
//
//  1. NOMBRE=valor   — captura lineas cuyo nombre declara un secreto.
//  2. Bearer         — va ANTES que gsk_/sk- a proposito: "Bearer gsk_ABC..."
//                      debe quedar "Bearer [REDACTED]", no "Bearer gsk_[REDACTED]".
//  3. JWT            — tres segmentos base64url.
//  4. URL            —://user:clave@  ->  ://[REDACTED]@
//  5. Claves con prefijo — gsk_ (Groq), sk- (OpenAI), ghp_ (GitHub), AKIA (AWS).
//
// El nombre se conserva (ver "API_KEY=[REDACTED]") porque saber QUE se\Configuro
// un secreto le sirve a Ivi; lo que no puede viajar es el valor.

const REGLAS: Array<[string, RegExp, string]> = [
  // 1. NOMBRE=valor cuyo nombre contenga KEY, SECRET, TOKEN o PASSWORD.
  //    El valor se detiene en el primer espacio: "error: KEY=abc rejected" queda
  //    "error: KEY=[REDACTED] rejected" y no se come el resto de la frase.
  //    NO se ancla a ^ porque los secretos aparecen a mitad de linea con frecuencia
  //    (mensajes de error, logs) y con anclaje se escapaban.
  [
    "nombre-valor",
    /(^|[^A-Za-z0-9_])([A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)[ \t]*=[ \t]*[^\s\n]*/gim,
    `$1$2=${MARCA}`,
  ],
  // 2. Cabecera Authorization: Bearer <algo largo>.
  ["bearer", /\bBearer[ \t]+[A-Za-z0-9._~+/-]{20,}=*/g, `Bearer ${MARCA}`],
  // 3. JWT: header.payload.signature.
  ["jwt", /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/g, MARCA],
  // 4. Credenciales embebidas en una URL. Se conserva el host.
  [
    "url-credenciales",
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\/\s:@]+:[^\/\s@]+(?=@)/g,
    `$1${MARCA}`,
  ],
  // 5. Claves con prefijo conocido.
  ["gsk", /\bgsk_[A-Za-z0-9]{20,}/g, MARCA],
  ["sk", /\bsk-[A-Za-z0-9]{20,}/g, MARCA],
  ["ghp", /\bghp_[A-Za-z0-9]{20,}/g, MARCA],
  ["akia", /\bAKIA[0-9A-Z]{16}\b/g, MARCA],
];

/** Quita secretos de un texto. Idempotente. */
export function redactarTexto(entrada: string): string {
  if (typeof entrada !== "string" || entrada.length === 0) return "";
  let salida = entrada;
  for (const [, re, reemplaza] of REGLAS) {
    // Se reconstruye la RegExp: las globales con /g conservan lastIndex entre
    // llamadas, y eso hace que el segundo uso falle en silencio.
    salida = salida.replace(new RegExp(re.source, re.flags), reemplaza);
  }
  return salida;
}

/**
 * Ultimas N lineas de la salida de un comando, ya redactadas.
 *
 * El ORDEN ES REDACTAR ANTES DE TRUNCAR. Si se trunca primero, una clave cortada
 * a la mitad (gsk_ABCDEF) deja de cumplir el patron y se escapa sin que nada lo
 * note. Ver el caso "corte por caracteres" de redact.fixtures.json.
 */
export function redactarTail(entrada: string, lineas = 20): string {
  const limpio = redactarTexto(entrada ?? "");
  const filas = limpio.split("\n");
  if (filas.length <= lineas) return limpio;
  return filas.slice(-lineas).join("\n");
}

/** Igual que redactarTail, pero corta por caracteres en vez de lineas. */
export function redactarTailChars(entrada: string, maxChars = 1200): string {
  const limpio = redactarTexto(entrada ?? "");
  return limpio.length <= maxChars ? limpio : limpio.slice(0, maxChars);
}

/** Redaccion profunda: recorre cualquier objeto y limpia todo string que encuentre. */
export function redactarProfundo<T>(valor: T): T {
  if (typeof valor === "string") return redactarTexto(valor) as unknown as T;
  if (Array.isArray(valor)) return valor.map((v) => redactarProfundo(v)) as unknown as T;
  if (valor && typeof valor === "object") {
    const salida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      salida[k] = redactarProfundo(v);
    }
    return salida as T;
  }
  return valor;
}