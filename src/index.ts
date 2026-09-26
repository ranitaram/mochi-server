// index.ts
// V1 (actual): Chat interactivo por terminal con Ivi: texto → Groq → edge-tts → archivo de audio.
//
// V2 (futuro): Endpoint HTTP que recibe audio del ESP32-S3-Zero.
//   - El ESP32 graba audio mientras el joystick analógico (VRx/VRy) se sale de la zona muerta.
//   - Al volver ambos ejes al centro, envía el audio al servidor vía POST.
//   - El servidor hace STT → Groq → edge-tts y devuelve el audio procesado.
//   - Esta versión reemplazará el readline loop por un servidor Express/Hono.

import "dotenv/config";
import fs from "fs";
import readline from "readline/promises";
import { generarRespuesta, extraerHechos, ConversationMessage } from "./llm";
import { generarAudio } from "./tts";
import { inicializarDB, obtenerHechos, guardarHecho } from "./memoria";

async function main() {
  // --- Memoria persistente (solo se consulta una vez al arrancar) ---
  let contextoHechos = "";
  try {
    await inicializarDB();
    const hechos = await obtenerHechos();
    if (hechos.length > 0) {
      contextoHechos =
        "\n\nESTO ES LO QUE SABES DE LA PERSONA (úsalo con naturalidad, solo cuando venga al caso, nunca lo repitas como si fuera una lista):\n" +
        hechos.map((h) => `- ${h}`).join("\n");
    }
  } catch (err: any) {
    console.error("No se pudo conectar a Turso (memoria deshabilitada):", err.message);
  }

  // --- Chat loop ---
  const historial: ConversationMessage[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("Ivi lista. Escribe 'salir' para terminar.\n");

  rl.on("SIGINT", () => {
    console.log("\n\n¡Hasta luego!");
    rl.close();
    process.exit(0);
  });

  while (true) {
    const input = await rl.question("Tú> ");

    if (input.trim().toLowerCase() === "salir" || input.trim().toLowerCase() === "exit") {
      console.log("\n¡Hasta luego!");
      break;
    }

    if (!input.trim()) continue;

    historial.push({ role: "user", content: input });

    // 1. Generar respuesta (con contexto de hechos en el system prompt)
    const respuesta = await generarRespuesta(historial, contextoHechos);
    console.log(`\nIvi [${respuesta.emocion}]: ${respuesta.texto}\n`);

    // 2. Generar audio
    try {
      fs.mkdirSync("./audio-temp", { recursive: true });
      const rutaAudio = await generarAudio(respuesta.texto);
      console.log(`Audio: ${rutaAudio}\n`);
    } catch (err: any) {
      console.error("No se pudo generar el audio:", err.message);
    }

    historial.push({ role: "assistant", content: respuesta.texto });

    // 3. Extraer hechos en background (fire-and-forget)
    //    Se imprime antes del siguiente prompt para no mezclar con el input
    extraerHechos(historial)
      .then((nuevos) => {
        if (nuevos.length > 0) {
          console.log(`  [memoria] +${nuevos.length} hecho(s) guardado(s)\n`);
        }
        return Promise.all(nuevos.map(guardarHecho));
      })
      .catch((err) => console.error("Error guardando hechos:", err.message));
  }

  rl.close();
}

main().catch((err) => {
  console.error("Algo falló:", err);
  process.exit(1);
});
