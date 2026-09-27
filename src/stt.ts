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
      return texto;
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
