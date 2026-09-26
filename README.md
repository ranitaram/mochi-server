# Mochi / Ivi — asistente de voz con ESP32-S3

Asistente de voz en español rioplatense que corre en un **ESP32-S3** (mic **INMP441** +
bocina I2S MAX98357, joystick de push-to-talk) y un backend **Node.js/TS en la nube**
que usa **Groq** para STT (Whisper) e IA (LLM) y **edge-tts** para generar la voz MP3.

**Estado HOY (26/09/2026): PRODUCCIÓN — backend en Render + Postgres (Neon) + Turso,
ESP32 flasheado y sincronizando sus redes WiFi desde la nube. Fases 1-4 cerradas.**

Este README documenta el estado REAL y las correcciones clave, para que nadie vuelva a
"arreglar" algo que ya está bien.

---

## Arquitectura (HOY, cloud)

```
[ESP32-S3]                          [RENDER https://mochi-server-tnwq.onrender.com]
 boot: WiFi → ping /health (despierta
       al server) → sync redes (NVS) ─────► POST /admin/login        (panel admin)
 PTT (joystick) → WAV ──POST /api/touch──► 1. valida energía (RMS <300 → "no te
       ◄───────── MP3 + X-Ivi-Texto ───────    escuché", no gasta Groq)
                                          2. Groq STT (Whisper)
                                          3. Groq LLM (emoción) con personalidad
                                          4. edge-tts → MP3 24kHz
                                          5. hechos → Turso (memoria) + sesión
                               ┌─────────────┐    ┌──────────┐    ┌──────────┐
                               │ Neon (Prisma ├───┤   Turso  │    │ admin.html│
                               │  PostgreSQL) │    │  hechos  │    │ redes WiFi│
                               └─────────────┘    └──────────┘    └──────────┘
```

- El server identifica al ESP32 por **`DEVICE_TOKEN`** (Bearer) para sincronizar sus
  redes WiFi; el admin (web) las gestiona desde `https://…/admin`.
- **Sesiones de conversación** en memoria: Ivi recuerda la charla mientras no pasen
  15 min sin hablar (`SESSION_IDLE_MS`); los hechos personales persisten en Turso y se
  inyectan al prompt en cada respuesta.

---

## Roadmap (fases cerradas)

| Fase | Qué | Estado |
|---|---|---|
| 1 | Audio end-to-end local (STT+LLM+TTS), gate de voz, personalidad, Turso | ✅ |
| 2 | Portal WiFi en la nube: Prisma+Postgres (Neon), admin, sync de redes al ESP32 | ✅ |
| 3 | Sesiones de conversación (historial por cliente, memoria larga en el prompt) | ✅ |
| 4 | Arranque inteligente: despierta al server (`/health`) + countdown OLED + sync | ✅ |

---

## Pines — PLACA DEFINITIVA (¡estos son los que están!)

```
MIC (INMP441)          Bocina (MAX98357)
  SCK  → GPIO41         BCLK → GPIO15
  WS   → GPIO21         WS   → GPIO16
  SD   → **GPIO48**     DIN(DAT) → GPIO17
           (antes 12: ese pin tiene la huella
            dañada en esta placa — dio ceros
            repetidos y "Gracias." alucinado)

Joystick: 2 ejes en ADC (A0/A1). El PTT dispara por nivel; al soltar
se valida un tramo de voz real (RMS) antes de llamar a Groq.
```

> **LO MÁS IMPORTANTE DEL PROYECTO:** el cable **SD del mic va al GPIO48** (largo y por
> fuera de la caja). Si algún día "no escucha tu voz": lo primero que falla es el
> **cable físico** (el GPIO12 quedó descartado por pista dañada). Rectificar el cable,
> no el firmware.

---

## Backend (nube)

- **Servicio**: Render free tier, `mochi-server-tnwq`, auto-deploy desde `main`
  (`npm install && npx prisma generate && npm run build` → `npm start`).
- **DB Fase 2**: PostgreSQL en **Neon** vía `@prisma/adapter-neon` (driver HTTP/SQL —
  evita el TCP IPv6-first del engine Rust que fallaba en Render).
- **Memoria**: Turso (SQLite) con `@libsql/client`, cliente lazy que no tira el boot.
- **Endpoints**: `GET /health` (rápido, sin DB), `POST /api/touch`, `POST /admin/login|logout`,
  `/admin` y `/login` (estático), API `api/devices` (redes WiFi por Bearer) + `api/admin/devices`.
- **Scripts**: `npm run crear-device`, `db:generate|migrate|deploy|push`, `test-sesion`,
  `test-api`.

### Variables de entorno (`config.h` / `.env` → env de Render)

Firmware (`firmware/mochi-esp32/src/config.h`, gitignored):

```
BACKEND_URL   "https://mochi-server-tnwq.onrender.com"
DEVICE_TOKEN  "b056fdb…"              // se crea con `npm run crear-device`
SERVER_WAKE_MAX_MS  40000UL           // aguanta al server durmiendo
SERVER_WAKE_POLL_MS 3000UL
WIFI_SSID_1..3 / WIFI_PASSWORD_1..3   // solo como red de INTERNET
```

Server (`.env`):

```
PORT=3000            GROQ_API_KEY / GROQ_MODEL (default qwen/qwen3-27b)
DATABASE_URL=…neon…  ADMIN_USER / ADMIN_PASSWORD / ADMIN_SECRET
WIFI_ENC_KEY=…       TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
SESSION_IDLE_MS=900000   SESSION_MAX_MSGS=12
```

---

## Cómo levantar (desarrollo)

```bash
# server
cd mochi-server
npm install
npm run build && npm start      # escucha en :3000 (o $PORT)
```

```bash
# firmware (ESP32-S3 — modo NORMAL)
cd firmware/mochi-esp32
~/.platformio/penv/bin/pio run -t upload    # flashea por USB
```

El ESP32 bootea: conecta WiFi → **despierta al server** (ping `/health`, countdown en el
OLED hasta 200) → sincroniza redes desde el panel → "Ya estoy lista!". Si no hay
`DEVICE_TOKEN` o el server no responde, igual levanta (solo no sincroniza redes).

---

## Fixes de firmware ya aplicados (NO deshacer)

| Fix | Dónde | Qué hace |
|---|---|---|
| Gate de ruido adaptativo | `audio_record.cpp` | piso = ~40 ms iniciales de energía; recorta eco dejando solo tu voz. |
| Ganancia 1.0x | `audio_record.cpp` | la voz cercana entra clara; no se "apaga" con el ambiente. |
| SD reubicado 12→48 | `config.h MIC_DIN` | el 12 era la causa física del "Gracias." alucinado. |
| Portal cautivo `Ivi-Setup` | `provisioning.*` | si no hay redes, el ESP32 se abre como AP con formulario y guarda en NVS. |
| Parsing de redes | `http_client.cpp` | lee `doc["redes"]` (objeto), no un array plano. |
| Wake del server | `main.cpp` `waitServerWake()` | espera a `/health` 200 antes de sincronizar (Render duerme). |

## Fixes de server ya aplicados (NO deshacer)

| Fix | Dónde | Qué hace |
|---|---|---|
| Validación de VOZ real (RMS) | `server.ts` `energiaAudio()` | RMS <300 → "No te escuché" sin gastar Groq; mata la alucinación "Gracias.". |
| Diagnóstico en disco | `server.ts` | cada PTT se guarda en `/tmp/last_ptt.wav` (para análisis del clip). |
| Sesiones por cliente | `session.ts` | historial vivo dentro de la conversación; idle 15 min la resetea. |
| Memoria en el prompt | `llm.ts` `generarRespuesta` | inyecta los hechos de Turso (`contextoHechos`) al system prompt. |
| Conexión a Neon | `prisma.ts` | adapter HTTP de Neon (evita el P1001/IPv6 del engine en Render). |

---

## Prueba rápida de diagnóstico

```bash
# server (TUI en vivo):
tail -f /tmp/mochi-server.log | grep --line-buffered "Transcripción:\|sin VOZ\|Sesión"
```

---

© ramses 2026 · mochi-server · **Ivi — ya escucha de verdad, y te recuerda.**