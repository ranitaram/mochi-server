// stt.ts
// Transcribe audio a texto usando Groq Whisper (gratuito en free tier).

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WHISPER_MODEL = "whisper-large-v3-turbo";
const TIMEOUT_MS = 10_000;

/**
 * Transcribe un buffer de audio (WAV) a texto usando Groq Whisper.
 * Devuelve el texto transcrito, o un fallback si falla.
 */
export async function transcribirAudio(audioBuffer: Buffer): Promise<string> {
  const controller = new AbortController();
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
  } catch (err: any) {
    if (err.name === "AbortError") {
      console.error("Whisper timeout después de", TIMEOUT_MS, "ms");
    } else {
      console.error("Error en Whisper STT:", err.message ?? err);
    }
    return "";
  } finally {
    clearTimeout(timeout);
  }
}
