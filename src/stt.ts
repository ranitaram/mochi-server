// stt.ts
// Transcribe audio a texto usando Groq Whisper (gratuito en free tier).
// Reintenta 1 vez errores transitorios: preguntas largas pueden tardar más
// de lo que daba el antiguo timeout de 10s (cortaba -> silencio).

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WHISPER_MODEL = "whisper-large-v3-turbo";
const TIMEOUT_MS = 15_000;
const RETRIES = 1;
const BACKOFF_BASE_MS = 600;

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * El prompt de Whisper mejora la ortografía del nombre, pero no la garantiza:
 * igual oye "Vivi"/"Ibi" y salía el típico "no soy Vivi, soy Ivi".
 *
 * Este normalizador solo corrige la palabra en posición de VOCATIVO (como te
 * están llamando): al inicio del mensaje, o tras "hola"/"oye"/"gracias", o
 * antes de una coma. Es deliberadamente conservador: NO toca "viví", "vivimos",
 * "vivienda" ni nada dentro de una frase, porque ahí la palabra es real y
 * cambiarla sería inventar texto.
 */
const NOMBRES_EQUIVOCADOS = /^(vivi|iby|ibi|ibí|ivy|vibi|viby|eve|evy)\b/i;

export function normalizarNombreIvi(texto: string): string {
  if (!texto) return texto;
  const t = texto.trim();

  // Caso 1: el mensaje EMPIEZA con el nombre equivocado ("Vivi, ¿qué día es?").
  const inicio = t.match(NOMBRES_EQUIVOCADOS);
  if (inicio) {
    return "Ivi" + t.slice(inicio[0].length);
  }

  // Caso 2: vocativo tras un saludo o agradecimiento ("gracias Ibi por todo").
  return t.replace(
    /\b(hola|oye|hey|gracias|buenas|qu[eé] tal|holis|thanks)\b([,!¡.\s]+)(vivi|iby|ibi|ibí|ivy|vibi|viby|eve|evy)\b/gi,
    (_m, saludo: string, sep: string) => `${saludo}${sep}Ivi`
  );
}

function transcribirUnaVez(audioBuffer: Buffer, controller: AbortController): Promise<string> {
  return (async () => {
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      // Construir multipart/form-data manualmente (sin multer)
      const boundary = "----IviBoundary" + Date.now();
      const parts: Buffer[] = [];

      // Campo: model
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${WHISPER_MODEL}\r\n`
        )
      );

      // Campo: file (audio)
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
        )
      );
      parts.push(audioBuffer);
      parts.push(Buffer.from("\r\n"));

      // Campo: language (forzar español para mejor precisión)
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nes\r\n`
        )
      );

      // Campo: prompt (sesgo de vocabulario). Whisper solo transcribe y no sabe
      // que existimos: sin esto "Ivi" salía como "Vivi"/"Ibi" y había que
      // corregirle el nombre cada rato. El prompt le da el nombre y el contexto.
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n` +
            `Ivi es un robot de escritorio con cara animada. Ramsés le habla a Ivi.\r\n`
        )
      );

      // Cerrar boundary
      parts.push(Buffer.from(`--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const response = await fetch(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body,
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq Whisper error ${response.status}: ${errText}`);
      }

      const result = (await response.json()) as { text: string };
      return result.text?.trim() ?? "";
    } finally {
      clearTimeout(timeout);
    }
  })();
}

/**
 * Transcribe un buffer de audio (WAV) a texto usando Groq Whisper.
 * Reintenta una vez en errores transitorios o timeout; si falla todo,
 * devuelve "" (el server responde con un MP3 de emergencia audible).
 */
export async function transcribirAudio(audioBuffer: Buffer): Promise<string> {
  for (let intento = 1; intento <= RETRIES + 1; intento++) {
    const controller = new AbortController();
    try {
      const texto = await transcribirUnaVez(audioBuffer, controller);
      return normalizarNombreIvi(texto);
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.error(`[STT] timeout después de ${TIMEOUT_MS}ms (intento ${intento})`);
      } else {
        console.error(`[STT] error intento ${intento}:`, err.message ?? err);
      }
      if (intento <= RETRIES) await dormir(BACKOFF_BASE_MS * intento);
    }
  }
  return "";
}
