# Mochi / Ivi — asistente de voz con ESP32-S3

Asistente de voz local (español, castellano rioplatense) que corre en un ESP32-S3
definitivo con mic **INMP441** + bocina I2S, y un server en Node.js/TS que usa
**Groq** para STT (Whisper) e IA (LLM), y síntesis **edge-tts** → MP3 → I2S.

**Estado HOY (20/09/2026): FUNCIONA — conversación larga y fluida confirmada.**
Este README documenta el estado REAL y todas las correcciones que se aplicaron
durante el desarrollo, para que nadie vuelva a "arreglar" algo que ya está bien.

---

## Arquitectura

```
[ESP32-S3 definitivo]                    [server Node.js / TS]
 ┌─────────────────────┐      HTTP      ┌───────────────────────────┐
 │ Joystick = PTT       │  POST /api/   │ 1. valida energía del clip │
 │ (presionar→grabar,   │  touch        │    (RMS < 300 → "no te     │
 │  soltar→enviar)      ├──────────────►│      escuché" — NO llama)  │
 │ INMP441 → I2S → DIN48│  WAV crudo    │ 2. Groq STT (Whisper)      │
 │ ____________________│               │ 3. Groq LLM (emoción)      │
 │ I2S → MAX98357 →    │◄──────────────┤ 4. edge-tts → MP3 24kHz     │
 │  bocina              │  MP3 + headers│                              │
 └─────────────────────┘               └───────────────────────────┘
```

- ESP32: Grapadora/PulltoTalk → publica el **último** PTT solo (no acumula).
- Server: transcribe → piensa → contesta EN VOZ y con emoción perceptible.
- El ESP32 interpreta la respuesta MP3 por I2S mientras el mic queda apagado
  (evita que la propia respuesta regrese como "eco" y lo mande en el PTT).

---

## Pines — PLACA DEFINITIVA (¡estos son los que están!)

Estos son los valores **flasheados y verificados**. Cambiarlos rompe el audio.

```
MIC (INMP441)          Bocina (MAX98357)
  SCK  → GPIO41         BCLK → GPIO15
  WS   → GPIO21         WS   → GPIO16
  SD   → **GPIO48**     DIN(DAT) → GPIO17
           (antes 12: ese pin tiene la huella
            dañada en esta placa — dió ceros
            repetidos y "Gracias." alucinado)

Joystick: 2 ejes en ADC (A0/A1). El PTT dispara por nivel; al soltar
se valida un tramo de voz real (RMS) antes de llamar a Groq.
```

> **LO MÁS IMPORTANTE DEL PROYECTO:** el cable **SD del mic va al GPIO48**
> (MUY largo y por fuera de la caja). Si algún día "no escucha tu voz" otra
> vez: **lo primero que falla es siempre este cable físico** (el GPIO12
> original quedó descartado por pista dañada). Rectificar el pin equivocado,
> no el firmware.

---

## Fixes de firmware ya aplicados (NO deshacer)

| Fix | Dónde | Qué hace |
|---|---|---|
| **Gate de ruido adaptativo** | `audio_record.cpp` | piso = primer ~40ms de energía (ambiente/TV); recorta eco de bordes dejando solo tu voz (+30ms). |
| **Ganancia 1.0x** | `audio_record.cpp` | la voz fresca cercana entra; no se "apaga" junto con el ambiente (bajar a 0.4x fue un error de diagnóstico: mata también tu voz). |
| **SD reubicado 12→48** | `config.h MIC_DIN` | el 12 era la causa física del "Gracias." fabricado (ceros → Groq alucina). |

## Fixes de server ya aplicados (NO deshacer)

| Fix | Dónde | Qué hace |
|---|---|---|
| **Validación de VOZ real (RMS)** | `server.ts` `energiaAudio()` + `/api/touch` | si el clip llega con RMS <300 (silencio/click/eco sin tu voz), **NO se llama a Groq** y responde "No te escuché, acerca el micrófono y repite." — acaba la alucinación "Gracias." para siempre. |
| **Diagnóstico en disco** | `server.ts` | cada PTT se guarda en `/tmp/last_ptt.wav` y el RMS se loguea; se envía a Groq solo con voz fresca. |
| Log de transcripción | `server.ts` | imprime `[touch] Transcripción: "…"` solo cuando hay audio con voz. |

---

## Cómo levantar (desarrollo)

```bash
# server
cd mochi-server
npm install
npm run build && npm start      # escucha en :3001 (after build)
```

```bash
# firmware (ESP32-S3 — NORMAL, placa definitiva)
cd firmware/mochi-esp32
~/.platformio/penv/bin/pio run -t upload     # flashea por USB
```

Variables de entorno en `.env`: `GROQ_API_KEY`, `GROQ_MODEL=grok/…`,
`PORT=3001`. El 3288-... etc.

## Prueba rápida de diagnóstico

```bash
# 1. En una terminal, vivís el server:
tail -f /tmp/mochi-server.log | grep --line-buffered "Transcripción:\|sin VOZ"

# 2. PTT con la boca a 2-5cm del mic ("¿qué día es hoy?").
#    El RMS del clip se loguea; si <300 no llama a Groq (no te escuché).
```

---

© ramses 2026 · mochi-server · **Ivi — ya escucha de verdad.**
