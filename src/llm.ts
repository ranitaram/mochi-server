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
//       (BACKOFF_BASE_MS * (intento+1)). Solo se considera "fallo" tras
//       agotar los reintentos O si el error es permanente (400/401/403).
//       Nuestro propio timeout (AbortError) NO se reintenta: reintentarlo
//       solo le daría 10s más a Groq para lo mismo.
//   (D) PRESERVAR EL HILO DE CONVERSACIÓN: cuando usamos fallback, Ivi
//       dice "se me fue la señal" en UNA de las frases del pool — el server
//       ya agrega esa respuesta al historial (historial.push), así el hilo
//       sigue vivo y no se pierde el contexto de la charla.
// ===========================================================================

import Groq from "groq-sdk";
import { SYSTEM_PROMPT } from "./personality";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL || "qwen/qwen3-27b";

const TIMEOUT_MS = 10_000;      // timeout de CADA llamada a Groq
const RETRIES = 3;               // reintentos para errores transitorios
const BACKOFF_BASE_MS = 800;     // backoff base entre reintentos

// (A) Pool rotativo: emociones variadas, se rotan con fallbackIdx.
const FRASES_EMERGENCIA = [
  "Se me fue la señal, dime otra vez",
  "Uy, se me cortó justo ahí — repite, va",
  "No me llegó eso, decímelo otra vez",
  "Se me fue la señal de nuevo, la neta",
  "Ay, se me cortó — repite, va",
  "Me quedé en blanco, dime otra vez",
];
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
 * Indica si un error es TRANSITORIO (vale la pena reintentar) o permanente.
 * Transitorios: timeout del SDK (AbortError), reset de conexión, 429, 5xx,
 * DNS. Permanentes: 400/401/403, etc.
 */
function esTransitorio(err: any): boolean {
  const name = err?.name ?? "";
  const msg = (err?.message ?? "").toString();
  const code = err?.code ?? "";
  const status = err?.status ?? "";
  return (
    name === "AbortError" ||
    /ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fget|fetch failed|socket hang up|429|5\d\d/.test(
      `${code} ${msg} ${status}`
    )
  );
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
function sanitizeLanguage(text: string): string {
  return text
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uac00-\ud7af\u0600-\u06ff\u0590-\u05ff\u0e00-\u0e7f\u3040-\u309f\u30a0-\u30ff\u1100-\u11ff\ua960-\ua97f]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentReply {
  texto: string;
  emocion: "feliz" | "neutral" | "sorprendido" | "burlon" | "pensativo" | "enojado";
}

/**
 * Manda el historial de conversación + la personalidad a Groq y devuelve
 * la respuesta ya parseada como { texto, emocion }.
 * Reintenta con backoff en errores transitorios; si agota, usa fallback rotativo.
 */
export async function generarRespuesta(
  historial: ConversationMessage[]
): Promise<AgentReply> {
  // (B) Reintentos con backoff + (A) pool rotativo de fallback.
  // Cada intento usa SU PROPIO timeout; SOLO se reintentan errores
  // transitorios (red, 429, 5xx) — nunca nuestro propio timeout ni
  // errores permanentes. Al agotar → frase del pool rotativo (nunca
  // la misma dos veces seguidas).
  for (let intento = 0; intento <= RETRIES; intento++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const completion = await groq.chat.completions.create(
        {
          model: MODEL,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...historial],
          temperature: 0.9,
          max_tokens: 800,
          reasoning_effort: "none" as any,
          response_format: { type: "json_object" },
        },
        { signal: controller.signal }
      );

      const contenido = completion.choices[0]?.message?.content ?? "{}";

      try {
        const cleaned = extractJSON(contenido);
        const parsed = JSON.parse(cleaned);
        return {
          texto: sanitizeLanguage(parsed.texto ?? "No supe qué decir, la neta."),
          emocion: parsed.emocion ?? "neutral",
        };
      } catch (err) {
        // Fallback: el modelo devolvió texto plano, envolverlo en JSON
        const texto = sanitizeLanguage(contenido);
        if (texto.length > 0) {
          console.warn("Modelo no devolvió JSON, usando texto plano como respuesta");
          return { texto, emocion: "neutral" };
        }
        return { texto: "No supe qué decir, la neta.", emocion: "neutral" };
      }
    } catch (err: any) {
      const abortado =
        err.name === "AbortError" || (err instanceof Error && err.name === "AbortError");
      if (abortado) {
        console.error("Groq timeout después de", TIMEOUT_MS, "ms");
      } else {
        console.error("Error de Groq:", err.message ?? err);
      }

      // Reintentar SOLO errores transitorios (no nuestro propio timeout).
      // Espera creciente 800ms → 1600ms → 2400ms (backoff).
      if (!abortado && esTransitorio(err) && intento < RETRIES) {
        const espera = BACKOFF_BASE_MS * (intento + 1);
        console.warn(
          `Groq transitorio (${err.code ?? err.name}), reintento ${intento + 1}/${RETRIES} en ${espera}ms`
        );
        await dormir(espera);
        continue;
      }

      // (A) Fallback rotativo — cada caída sonó distinta.
      return siguienteFallback();
    } finally {
      clearTimeout(timeout);
    }
  }

  // Nunca debería llegar acá, pero por si acaso: fallback rotativo.
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const EXTRACCION_MODEL = "openai/gpt-oss-20b";

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
        model: EXTRACCION_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
      },
      { signal: controller.signal }
    );

    const contenido = completion.choices[0]?.message?.content ?? '{"hechos":[]}';
    const parsed = JSON.parse(contenido);
    return Array.isArray(parsed.hechos) ? parsed.hechos : [];
  } catch (err: any) {
    console.error("Error extrayendo hechos:", err.message ?? err);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
