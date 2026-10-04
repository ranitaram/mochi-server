// llm.ts
// ===========================================================================
// MEJORA DE ROBUSTEZ DEL DÍA (fix definitivo):
//   (A) POOL ROTATIVO DE FALLBACK: si Groq falla y ya no hay reintento
//       posible, respondemos con una frase de UNA POOL con emociones
//       variadas, rotando con fallbackIdx — NUNCA la misma frase repetida
//       ("Se me fue la señal, dime otra vez" x N). Así Ivi no suena a disco
//       rayado y la cara reacciona distinto cada vez que se corta la señal.
//   (B) REINTENTO CON BACKOFF: si Groq falla por un error TRANSITORIO
//       (red cortada, reset de conexión, 429 de rate-limit, 5xx, DNS) se
//       reintenta hasta RETRIES veces con espera creciente
//       (BACKOFF_BASE_MS * (intento+1)). NUESTRO propio timeout (AbortError)
//       también se reintenta un par de veces (RETRIES_TIMEOUT): preguntas
//       difíciles a veces solo necesitan un intento más lento. Solo se
//       considera "fallo" tras agotar los reintentos O si el error es
//       permanente (400/401/403).
//   (D) PRESERVAR EL HILO DE CONVERSACIÓN: cuando usamos fallback, Ivi
//       dice "se me fue la señal" en UNA de las frases del pool — el server
//       ya agrega esa respuesta al historial (historial.push), así el hilo
//       sigue vivo y no se pierde el contexto de la charla.
// ===========================================================================

import Groq from "groq-sdk";
import { SYSTEM_PROMPT } from "./personality";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
  // Solo para pruebas locales: permite apuntar a un Groq falso que simula la
  // cuota agotada sin gastar tokens reales.
  ...(process.env.GROQ_BASE_URL ? { baseURL: process.env.GROQ_BASE_URL } : {}),
});

// gpt-oss-120b medido en producción: 0.7-0.8s de respuesta y 150-216 tokens de
// salida (el más rápido y el más barato de los disponibles). NO lleva
// reasoning_effort: solo lo aceptan low/medium/high y con "none" devolvía 400.
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// Groq da 200k tokens/día POR MODELO: un segundo modelo de respaldo duplica la
// cuota real sin costo. También lo saltamos directo cuando ya está en cooldown.
const MODEL_FALLBACK = process.env.GROQ_MODEL_FALLBACK || "openai/gpt-oss-20b";
const MODEL_EXTRACCION = process.env.GROQ_MODEL_EXTRACCION || "openai/gpt-oss-20b";

const num = (v: string | undefined, def: number) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const TIMEOUT_MS = num(process.env.GROQ_TIMEOUT_MS, 8_000);
const RETRIES = num(process.env.GROQ_RETRIES, 1);
const BACKOFF_BASE_MS = num(process.env.GROQ_BACKOFF_MS, 400);
// El ESP32 aborta el POST a los 65s. El peor caso anterior (LLM 40s + TTS 78s)
// lo dejaba muda y el catch guardaba un falso "error de audio". Con 12s de LLM
// sobra tiempo para el TTS siempre.
const BUDGET_MS = num(process.env.GROQ_BUDGET_MS, 12_000);
// Cuánto esperamos antes de volver a probar un modelo sin cuota. Si el error
// dice "try again in 5m35s" usamos ese tiempo exacto; si no, 5 minutos.
const COOLDOWN_MS = num(process.env.GROQ_MODEL_COOLDOWN_MS, 300_000);

// (A) Pool rotativo: emociones variadas, se rotan con fallbackIdx.
const FRASES_EMERGENCIA = [
  "Se me fue la señal, dime otra vez",
  // Sin raya (—): este texto viaja en un header HTTP y Node rechaza los
  // caracteres fuera de Latin-1. Ver sanitizeLanguage().
  "Uy, se me cortó justo ahí, repite va",
  "No me llegó eso, decímelo otra vez",
  "Se me fue la señal de nuevo, la neta",
  "Ay, se me cortó, repite va",
  "Me quedé en blanco, dime otra vez",
];
// El TTS las precalienta al arrancar: cuando no hay cuota son la respuesta más
// frecuente, y así salen al instante y con la misma voz que cualquier otra.
export { FRASES_EMERGENCIA };
export const esFraseEmergencia = (t: string) =>
  FRASES_EMERGENCIA.includes(t.trim());
const EMOCIONES_AGENTE: AgentReply["emocion"][] = [
  "feliz","neutral","sorprendido","burlon","pensativo","enojado",
];
let ultimaFraseEmergencia = "";

function siguienteFallback(): AgentReply {
  let frase = "";
  for (let i = 0; i < 5; i++) {
    const candidata = FRASES_EMERGENCIA[Math.floor(Math.random() * FRASES_EMERGENCIA.length)];
    if (candidata !== ultimaFraseEmergencia) { frase = candidata; break; }
  }
  if (!frase) frase = FRASES_EMERGENCIA[Math.floor(Math.random() * FRASES_EMERGENCIA.length)];
  ultimaFraseEmergencia = frase;
  const emocion = EMOCIONES_AGENTE[Math.floor(Math.random() * EMOCIONES_AGENTE.length)];
  return { texto: frase, emocion };
}

/**
 * ¿El 429 es de CUOTA DIARIA (tokens per day) o de rate-limit por minuto?
 * Solo el primero es irrecuperable: reintentar un TPD agotado no puede
 * funcionar, quema ~3,000 tokens por intento y añade 800-2400ms de backoff
 * (medido: 4.8s de espera en un turno que fallaba en 0.3s). Un 429 de
 * requests-per-minute, en cambio, sí vale la pena reintentarlo.
 */
function esCuotaDiaria(err: any): boolean {
  const s = `${err?.code ?? ""} ${err?.status ?? ""} ${err?.message ?? ""}`;
  return (
    /tokens per day|\bTPD\b|"type"\s*:\s*"tokens"|quota|daily limit/i.test(s) ||
    (/rate_limit_exceeded/.test(s) && /token/i.test(s) && !/request/i.test(s))
  );
}

/** Cuánto falta según el propio mensaje de Groq ("try again in 5m35.232s"). */
function esperaSugerida(err: any): number | null {
  const m = /try again in ([\d.]+)m([\d.]+)?s/i.exec(err?.message ?? "");
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * 60_000 + parseFloat(m[2] ?? "0") * 1000);
}

// Modelos que ya quemaron su cuota: los saltamos sin gastar una petición.
const cooldownHasta = new Map<string, number>();
const modeloUtil = (m: string) => (cooldownHasta.get(m) ?? 0) <= Date.now();
function marcarCooldown(modelo: string, err: any) {
  const espera = esperaSugerida(err);
  const hasta = Date.now() + (espera != null ? Math.min(espera, COOLDOWN_MS * 4) : COOLDOWN_MS);
  cooldownHasta.set(modelo, hasta);
  console.warn(
    `Groq: ${modelo} sin cuota (${err?.code ?? "429"}). No se reintenta; ` +
      `libre en ${Math.round((hasta - Date.now()) / 1000)}s.`
  );
}

/** Resumen de la configuración Groq efectiva, para verlo al arrancar. */
export function resumenModelos(): string {
  const estado = (m: string) => (modeloUtil(m) ? "listo" : "SIN CUOTA");
  return `${MODEL} (${estado(MODEL)}) | respaldo ${MODEL_FALLBACK} (${estado(MODEL_FALLBACK)})`;
}

/**
 * Indica si un error es TRANSITORIO (vale la pena reintentar) o permanente.
 * Transitorios: timeout del SDK (AbortError), reset de conexión, 429 de
 * rate-limit POR MINUTO, 5xx, DNS. Permanentes: 400/401/403, cuota diaria.
 *
 * EXCEPCIÓN importante: 400 con code "json_validate_failed" SÍ es reintentable.
 * Ocurre cuando el modelo emite un JSON casi válido (típico: una comilla de
 * más antes de la coma, tipo {"texto": "...". "emocion": "burlon"}). Como
 * pedimos response_format json_object, Groq RECHAZA el 400 entero y el turno
 * terminaba en la frase de emergencia ("Se me fue la señal") aunque el texto
 * que generó el modelo estaba perfecto. Reintentando, el modelo acierta.
 */
function esTransitorio(err: any): boolean {
  const name = err?.name ?? "";
  const msg = (err?.message ?? "").toString();
  const code = err?.code ?? "";
  const status = err?.status ?? "";
  if (code === "json_validate_failed" || /json_validate_failed/.test(msg)) {
    return true;
  }
  if (esCuotaDiaria(err)) return false; // ni un reintento más
  return (
    name === "AbortError" ||
    /ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fget|fetch failed|socket hang up|429|5\d\d/.test(
      `${code} ${msg} ${status}`
    )
  );
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Heurística ligera para el gating de extracción de hechos: ¿la frase del
 * usuario tiene pinta de contener datos personales suyos (familia, gustos,
 * trabajo, mascotas...)? Si no, el server se ahorra la llamada a Groq de
 * extracción (menos rate-limits acumulados para Whisper y el LLM principal,
 * que son los que generan los silencios y el fallback "se me fue la señal").
 */
export function sugiereExtraerHechos(texto: string): boolean {
  // Normalizar a mayúsculas→minúsculas SIN tildes: \w/\b en JS no reconocen
  // é á í ó ú como letras, así que un \b tras "compré" o "mamá" no cuadra.
  const t =
    " " +
    texto
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[.,;:!?¡¿()]/g, " ") +
    " ";
  const patrones = [
    /\bme (llamo|dicen|compre|regalaron|regalo|dio)\b/, /\bte cuento\b/, /\bmi\b/, /\b mis\b/,
    /\b(trabajo|trabaje|trabaja)\b/, /\bestudio\b/, /\b(vivo|vivimos)\b/,
    /\b(novia|novio|esposa|esposo|marido|mujer|pareja)\b/,
    /\b(hija|hijo|hijos|abuel[oa]|abuelos)\b/, /\b(mama|papa|madre|padre|mami)\b/,
    /\b(hermana|hermano|hermanos)\b/, /\b(tia|tio|tia|tio|primo|prima|primos)\b/,
    /\bfamilia\b/, /\b(cumpleanos|cumples|cumpli)\b/, /\b(perro|gato|mascota|perrita|gatito)\b/,
    /\b(amo|amo a|quiere)\b/, /\bme (encanta|gusta|molesta|preocupa|asusta)\b/,
    /\b(tengo|tenia|tuve)\b/,
  ];
  return patrones.some((re) => re.test(t));
}

/**
 * Intenta extraer un JSON válido de un string que puede contener
 * texto adicional (thinking, razonamiento, etc.).
 */
function extractJSON(raw: string): string {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    // Buscar el primer { y el último } para reconstruir
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = raw.substring(firstBrace, lastBrace + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // no-op, continuar
      }
    }
    return raw;
  }
}

/**
 * Filtra caracteres de alfabetos no latinos (chino, coreano, árabe, etc.)
 * que a veces se cuelan en respuestas en español.
 */
// Letras acentuadas que SÍ existen en español y se respetan tal cual:
// á é í ó ú ü Ñ ¿ ¡. Cualquier OTRO carácter no-ASCII (portugués, francés,
// cirílico…) se mapea a su equivalente latino, o se borra si no hay equivalente.
const EQUIVALENTE: Record<string, string> = {
  // Portugués / francés (los que más se cuelan). OJO: "ã" en portugués es
  // una "a" nasal, NO una "ñ" — por eso "são" va a "sao", no a "sño".
  "ã": "a", "â": "a", "ê": "e", "è": "e", "ë": "e",
  "ô": "o", "õ": "o", "ù": "u", "û": "u", "ï": "i", "ç": "c",
  "æ": "ae", "œ": "oe", "ß": "ss", "ð": "d", "þ": "th",
  // Europeos con diacríticos raros
  "ā": "a", "ă": "a", "ą": "a", "å": "a", "ä": "a", "ǎ": "a",
  "ć": "c", "č": "c", "ĉ": "c", "ċ": "c",
  "ď": "d", "đ": "d",
  "ē": "e", "ĕ": "e", "ė": "e", "ę": "e", "ě": "e", "ə": "e",
  "ĝ": "g", "ğ": "g", "ġ": "g", "ģ": "g",
  "ĥ": "h", "ħ": "h",
  "ĩ": "i", "ī": "i", "ĭ": "i", "į": "i", "ı": "i", "ĳ": "i", "ǐ": "i",
  "ĵ": "j",
  "ķ": "k",
  "ĺ": "l", "ļ": "l", "ľ": "l", "ŀ": "l", "ł": "l",
  "ń": "n", "ņ": "n", "ň": "n", "ŉ": "n", "ŋ": "n",
  "ō": "o", "ŏ": "o", "ő": "o", "ø": "o", "ǒ": "o",
  "ŕ": "r", "ŗ": "r", "ř": "r",
  "ś": "s", "ŝ": "s", "ş": "s", "š": "s", "ſ": "s", "ș": "s",
  "ţ": "t", "ť": "t", "ŧ": "t", "ț": "t",
  "ũ": "u", "ū": "u", "ŭ": "u", "ů": "u", "ű": "u", "ų": "u", "ǔ": "u",
  "ŵ": "w",
  "ŷ": "y", "ẏ": "y",
  "ź": "z", "ż": "z", "ž": "z",
  // Ligaduras tipográficas
  "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl",
  // Puntuación tipográfica. OJO: esto no es solo estética. El texto de Ivi
  // viaja en el header X-Ivi-Texto y Node RECHAZA con ERR_INVALID_CHAR todo
  // carácter fuera de Latin-1: una raya (—) o una comilla tipográfica (" ")
  // en la respuesta tumbaba el turno entero con 500. El guion largo es el
  // signo que más sale en español ("palabra — ejemplo").
  "—": "-", "–": "-", "―": "-", "−": "-",
  "…": "...",
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "′": "'", "″": '"',
  "•": "-", "·": "-", "‧": "-", "∙": "-",
  " ": " ", " ": " ", " ": " ", " ": " ",
  "‹": '"', "›": '"', "«": '"', "»": '"',
  "→": "->", "←": "<-", "⇒": "->", "▶": "-", "◀": "-",
  "★": "*", "☆": "*", "♥": "*", "✔": "ok", "✓": "ok", "✖": "x",
  "½": "1/2", "¼": "1/4", "¾": "3/4", "º": "", "ª": "",
  "™": "(tm)", "®": "(r)", "©": "(c)",
};

/**
 * Quita alfabetos no latinos y deja el texto en español correcto.
 * Orden importante: primero los CJK/árabe/etc (que se BORRAN), después los
 * diacríticos europeos (que se TRADUCEN a su equivalente latino).
 */
function sanitizeLanguage(text: string): string {
  return (
    text
      // Alfabetos que no tienen equivalente latino: se eliminan.
      .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u0600-\u06ff\u0590-\u05ff\u0e00-\u0e7f\u3040-\u309f\u30a0-\u30ff\u1100-\u11ff\ua960-\ua97f\uff00-\uffef]/g, "")
      // Diacrícios europeos: minúscula y mayúscula. OJO: á é í ó ú ü Ñ NO se
      // tocan (son válidos en español): cambiarlas rompería "café" o "niño".
      .replace(/[^\u0000-\u007f]/g, (c) => {
        const bajo = EQUIVALENTE[c.toLowerCase()];
        if (bajo == null) return c;
        // Si venía en mayúscula, devolvemos mayúscula.
        return c === c.toUpperCase() && c !== c.toLowerCase()
          ? bajo.charAt(0).toUpperCase() + bajo.slice(1)
          : bajo;
      })
      .replace(/\s{2,}/g, " ")
      .trim()
  );
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentReply {
  texto: string;
  emocion: "feliz" | "neutral" | "sorprendido" | "burlon" | "pensativo" | "enojado";
}

// Zona horaria para la fecha/hora que se le pasa a Groq. Render corre en UTC,
// así que sin esto Ivi respondería con la hora equivocada. Default: Mazatlán
// (UTC-7 todo el año, sin horario de verano) = Tepic, Nayarit.
const FECHA_TZ = process.env.FECHA_TZ || "America/Mazatlan";

/**
 * Fecha y hora REALES del momento, en texto llano para el system prompt.
 * Se arma en CADA request (no al boot): el server de Render se duerme ~15 min
 * y una fecha cacheada en memoria quedaría vieja.
 */
function contextoAhora(): string {
  const fmt = new Intl.DateTimeFormat("es-MX", {
    timeZone: FECHA_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const p: Record<string, string> = {};
  for (const parte of fmt.formatToParts(new Date())) p[parte.type] = parte.value;
  const hora = `${p.hour}:${p.minute} ${p.dayPeriod ?? ""}`.trim();
  return (
    `\n\nAHORA ES: ${p.weekday} ${p.day} de ${p.month} de ${p.year}, ${hora}` +
    ` (hora de ${FECHA_TZ}). Esta es la fecha y hora reales: si te preguntan qué` +
    ` día es hoy, qué fecha es o qué hora es, usa EXACTAMENTE estos datos.`
  );
}

/** Una llamada a Groq. Lanza ante cualquier error para que el llamador decida. */
async function llamarGroq(
  modelo: string,
  system: string,
  historial: ConversationMessage[],
  timeoutMs: number
): Promise<AgentReply> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Solo se manda si está configurado: cada modelo acepta valores distintos y
  // mandar uno inválido hace que Groq rechace el request entero con 400.
  const extra: Record<string, string> = {};
  if (process.env.GROQ_REASONING_EFFORT) {
    extra.reasoning_effort = process.env.GROQ_REASONING_EFFORT;
  }
  const t0 = Date.now();
  try {
    const completion = await groq.chat.completions.create(
      {
        model: modelo,
        messages: [{ role: "system", content: system }, ...historial],
        temperature: 0.9,
        max_tokens: 800,
        response_format: { type: "json_object" },
        ...extra,
      },
      { signal: controller.signal }
    );
    const contenido = completion.choices[0]?.message?.content ?? "{}";
    console.log(
      `Groq ${modelo}: ${Date.now() - t0}ms | salida ${completion.usage?.completion_tokens ?? "?"} tok`
    );
    try {
      const parsed = JSON.parse(extractJSON(contenido));
      return {
        texto: sanitizeLanguage(parsed.texto ?? "No supe qué decir, la neta."),
        emocion: parsed.emocion ?? "neutral",
      };
    } catch {
      // El modelo devolvió texto plano: lo usamos tal cual.
      const texto = sanitizeLanguage(contenido);
      if (texto.length > 0) {
        console.warn("Modelo no devolvió JSON, usando texto plano como respuesta");
        return { texto, emocion: "neutral" };
      }
      return { texto: "No supe qué decir, la neta.", emocion: "neutral" };
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Manda el historial de conversación + la personalidad a Groq y devuelve
 * la respuesta ya parseada como { texto, emocion }.
 *
 * Estrategia: si el modelo principal no tiene cuota diaria (o falla), se
 * prueba el de respaldo; si ninguno sirve, se devuelve una frase del pool
 * rotativo. Los modelos sin cuota se recuerdan en cooldown para no gastar ni
 * una petición por turno en un 429 que ya sabemos que va a fallar.
 */
export async function generarRespuesta(
  historial: ConversationMessage[],
  contextoMemo?: string,
  deadlineMs?: number,
  contextoCopilot?: string | null
): Promise<AgentReply> {
  // El contexto del copiloto va DESPUÉS de la personalidad y la fecha: si fuera
  // antes, un texto inyectado en un archivo quedaría más cerca de las
  // instrucciones del sistema y podría weighs más que la personalidad de Ivi.
  const system =
    SYSTEM_PROMPT +
    contextoAhora() +
    (contextoMemo ? "\n" + contextoMemo : "") +
    (contextoCopilot ? contextoCopilot : "");
  const t0 = Date.now();
  const deadline = deadlineMs ?? t0 + BUDGET_MS;
  const modelos = [MODEL, MODEL_FALLBACK].filter((m, i, a) => m && a.indexOf(m) === i);
  const disponibles = modelos.filter(modeloUtil);

  if (disponibles.length === 0) {
    console.warn(
      `Groq: ${modelos.join(" y ")} sin cuota — frase de emergencia sin gastar tokens`
    );
    return siguienteFallback();
  }

  for (const modelo of disponibles) {
    for (let intento = 0; intento <= RETRIES; intento++) {
      const restante = deadline - Date.now();
      if (restante <= 0) break;
      try {
        return await llamarGroq(modelo, system, historial, Math.min(TIMEOUT_MS, restante));
      } catch (err: any) {
        const abortado = err?.name === "AbortError";
        if (abortado) {
          console.error(`Groq ${modelo} timeout después de ${TIMEOUT_MS}ms`);
        } else {
          console.error(`Error de Groq (${modelo}):`, err.message ?? err);
        }

        // Cuota diaria: ni un reintento más, de una vez al modelo de respaldo.
        if (esCuotaDiaria(err)) {
          marcarCooldown(modelo, err);
          break;
        }
        // Reintento extra solo si el tiempo restante alcanza para otro intento.
        const cabeOtro = deadline - Date.now() > TIMEOUT_MS;
        if (esTransitorio(err) && intento < RETRIES && cabeOtro) {
          const espera = BACKOFF_BASE_MS * (intento + 1);
          console.warn(
            `Groq ${abortado ? "timeout" : "transitorio (" + (err.code ?? err.name) + ")"}, reintento ${intento + 1} en ${espera}ms`
          );
          await dormir(espera);
          continue;
        }
        break; // permanente o sin tiempo: probar el siguiente modelo
      }
    }
  }

  console.warn(`Groq: sin respuesta de ningún modelo (${Date.now() - t0}ms) — frase de emergencia`);
  return siguienteFallback();
}

/**
 * Extrae hechos nuevos (datos personales que el usuario comparte) del
 * historial usando un modelo ligero de Groq. Devuelve un arreglo de strings.
 * Usa un modelo ligero (openai/gpt-oss-20b) para ser rápida y barata.
 */
export async function extraerHechos(
  historial: ConversationMessage[]
): Promise<string[]> {
  // Si este modelo ya quemó su cuota, no gastamos tokens en una extracción
  // opcional: es una mejora de memoria, nunca algo crítico.
  if (!modeloUtil(MODEL_EXTRACCION)) {
    console.warn(`Groq: ${MODEL_EXTRACCION} sin cuota, omito extracción de hechos`);
    return [];
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const prompt = `Del siguiente intercambio entre un usuario y un asistente, extrae ÚNICAMENTE datos nuevos que el usuario haya compartido espontáneamente sobre sí mismo: a qué se dedica, gustos, datos personales, familiares que mencione y a qué se dedican, preferencias, etc.

Reglas importantes:
- Solo guarda lo que el usuario comparta explícitamente, nunca infieras ni deduzcas.
- Si el usuario no compartió nada nuevo sobre sí mismo, devuelve { "hechos": [] }.
- No repitas hechos que ya existan en el contexto previo.

Devuelve ÚNICAMENTE un JSON con esta forma, sin texto antes ni después:
{ "hechos": ["hecho1", "hecho2"] }

CONTEXTO PREVIO (hechos ya conocidos):
${historial
  .filter((m) => m.role === "user")
  .slice(0, -1)
  .map((m) => m.content)
  .join("\n") || "(ninguno aún)"}

ÚLTIMO INTERCAMBIO:
${historial
  .slice(-2)
  .map((m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.content}`)
  .join("\n")}`;

  try {
    const completion = await groq.chat.completions.create(
      {
        model: MODEL_EXTRACCION,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      },
      { signal: controller.signal }
    );

    const contenido = completion.choices[0]?.message?.content ?? '{"hechos":[]}';
    const parsed = JSON.parse(extractJSON(contenido));
    return Array.isArray(parsed.hechos) ? parsed.hechos : [];
  } catch (err: any) {
    if (esCuotaDiaria(err)) marcarCooldown(MODEL_EXTRACCION, err);
    console.error("Error extrayendo hechos:", err.message ?? err);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
