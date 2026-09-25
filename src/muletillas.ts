// muletillas.ts
// Frases cortas que Ivi dice mientras procesa la respuesta real.
// Los audios se generan UNA SOLA VEZ con "npm run generar-muletillas"
// y se guardan en ./assets/muletillas/.
//
// FASE 2: Cuando exista el endpoint /touch y el firmware del ESP32, estos
// archivos de audio se copiarán al ESP32 para que los reproduzca localmente
// de forma instantánea al detectar el toque, mientras el servidor procesa la
// respuesta real de Groq + edge-tts en paralelo. Así el usuario nunca percibe
// silencio, incluso con mala señal de hotspot, porque la muletilla no depende
// de la red.

export const MULETILLAS = [
  "Mmm...",
  "Estoy pensando...",
  "Analizando...",
  "A ver, a ver...",
  "Esperaaa...",
  "Dame un tantito...",
  "Déjame ver...",
];
