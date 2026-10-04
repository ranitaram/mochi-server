# Mochi / Ivi — asistente de voz con ESP32-S3

Asistente de voz en español de México que corre en un **ESP32-S3** (mic **INMP441** +
bocina I2S MAX98357, joystick de push-to-talk) y un backend **Node.js/TS en la nube**
que usa **Groq** para STT (Whisper) e IA (LLM) y **edge-tts** para generar la voz MP3.

Ivi es además un **copiloto técnico**: mira lo que OpenCode está haciendo en el
proyecto y lo puede resumir por voz, sin inventar nada que no haya observado.

**Estado HOY (04/10/2026): PRODUCCIÓN — backend en Render + Postgres (Neon) + Turso,
ESP32 flasheado, y copiloto de OpenCode desplegado con ventana de contexto de 3 horas.
Fases 1-4 cerradas + copiloto.**

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
                                          2. Groq STT (Whisper, forzado a es)
                                          3. Groq LLM (emoción) con personalidad
                                             + estado de OpenCode si hay
                                          4. edge-tts → MP3 24kHz
                                          5. hechos → Turso (memoria) + sesión

[OpenCode]                           (flujo aparte, unidireccional)
 plugin ivi-copilot.js ──POST /api/copilot/state──►  valida + redacta + guarda
      ▲                                                   │
      └──── solo OBSERVA. Nunca escribe, nunca ejecuta ──┘
```

- El server identifica al ESP32 por **`DEVICE_TOKEN`** (Bearer) para sincronizar sus
  redes WiFi; el admin (web) las gestiona desde `https://…/admin`.
- **Sesiones de conversación** en memoria: Ivi recuerda la charla mientras no pasen
  15 min sin hablar (`SESSION_IDLE_MS`); los hechos personales persisten en Turso y se
  inyectan al prompt en cada respuesta.

---

## El copiloto: qué es y qué NO es

Responde "¿qué estabas haciendo?" sin que tengas que explicarlo. Para eso el plugin de
OpenCode publica un **estado estructurado** que el server reinyecta en el prompt.

**Es unidireccional a propósito.** El plugin usa hooks de `event`, `chat.message` y
`tool.execute.after`, y **todos devuelven `undefined`**. OpenCode no lee nada de lo que
Ivi responda, no hay tools ni mutaciones. Ivi observa y habla; la persona decide y
OpenCode ejecuta.

El estado v2 es una whitelist estricta. Solo viaja esto:

| Campo | Límite |
|---|---|
| `original_request` / `last_message` | 600 / 800 caracteres |
| `files_changed` | 50 archivos, rutas **relativas** |
| `failures` | 5, con `tool`, `title`, `exit`, `truncated` y la COLA de la salida |
| `last_tool` | título 120 chars |
| `metrics` | pasos, tokens, costo |
| payload entero | **64 KiB** |

Se rechaza el payload, no se trunca en silencio: si algo no cumple el whitelist se cae
la petición entera. Las rutas fuera del proyecto no viajan ni por error.

**Todo pasa por el redactor antes de guardarse** (`src/copilot/redact.ts` y
`~/.config/opencode/plugins/ivi-redact.js`, **las dos implementaciones idénticas y en
el mismo orden**): `NOMBRE=valor` con `KEY|SECRET|TOKEN|PASSWORD`, `Authorization:
Bearer`, JWT, credenciales en URL, y prefijos `gsk_` `sk-` `ghp_` `AKIA`. El
nombre de la variable se conserva (`API_KEY=[REDACTED]`) porque saber **que** hay un
secreto le sirve a Ivi; lo que no viaja es el valor.

> **El orden de las reglas importa.** Los tests comparan las dos implementaciones
> contra los mismos fixtures; cualquier reordenamiento cambia la salida y falla.

El bloque de contexto lleva la antigüedad del estado ("Observado hace 2 horas y
media"), y por diseño Ivi debe distinguir tres cosas con palabras naturales: **el dato,
lo que OpenCode AFIRMA** (no verificado) **y lo que Ivi infiere**.

---

## Roadmap (fases cerradas)

| Fase | Qué | Estado |
|---|---|---|
| 1 | Audio end-to-end local (STT+LLM+TTS), gate de voz, personalidad, Turso | ✅ |
| 2 | Portal WiFi en la nube: Prisma+Postgres (Neon), admin, sync de redes al ESP32 | ✅ |
| 3 | Sesiones de conversación (historial por cliente, memoria larga en el prompt) | ✅ |
| 4 | Arranque inteligente: despierta al server (`/health`) + countdown OLED + sync | ✅ |
| 5 | Copiloto de OpenCode: captura, redacción, estado, contexto, personalidad | ✅ |

Pendiente: experimento A/B de varios días para medir si el copiloto cambia el ritmo de
trabajo (instrumentación lista en `src/copilot/instrument.ts`).

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
  Aquí también vive la tabla `copilot_state`.
- **Endpoints**: `GET /health` (rápido, sin DB), `POST /api/touch`,
  `POST /api/copilot/state`, `POST /admin/login|logout`, `/admin` y `/login` (estático),
  API `api/devices` (redes WiFi por Bearer) + `api/admin/devices`.

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
PORT=3000            GROQ_API_KEY / GROQ_MODEL (default openai/gpt-oss-120b)
DATABASE_URL=…neon…  ADMIN_USER / ADMIN_PASSWORD / ADMIN_SECRET
WIFI_ENC_KEY=…       TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
SESSION_IDLE_MS=900000   SESSION_MAX_MSGS=12
TURNO_DEADLINE_MS=45000  EDGE_TTS_VOICE=es-MX-DaliaNeural  FECHA_TZ=America/Mazatlan
```

Del copiloto:

```
COPILOT_TOKEN         // EXACTAMENTE el mismo valor que IVI_TOKEN en ivi.env
COPILOT_PROJECTS=mochi-server
COPILOT_MAX_AGE_MIN=180     // ventana de contexto; 30 min se perdía en un café
COPILOT_RATE_MAX=60         COPILOT_RATE_MS=60000
```

> **`COPILOT_TOKEN` y `COPILOT_PROJECTS` son obligatorios, no opcionales.** Sin el
> token el endpoint da 503; sin la allowlist también, aunque el token sea válido. Es
> una allowlist explícita a propósito: una versión anterior aceptaba cualquier nombre
> de proyecto si faltaba la variable, y eso abría el endpoint a quien tuviera el token.

El plugin lee su configuración de `~/.config/opencode/ivi.env` (permisos `600`):

```
IVI_MODE=send       # off | capture | send   (send = publica al server)
IVI_TOKEN=…         # mismo valor que COPILOT_TOKEN
IVI_DEBUG=0
```

En Render **no hace falta** definir `COPILOT_MAX_AGE_MIN`: si no está, manda el default
del código. Verificado en producción: 170 min entra, 185 no.

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

### Probar el copiloto sin el ESP32

El plugin y los archivos del plugin están **fuera de este repo**, en
`~/.config/opencode/plugins/`. Se editan a mano y no hay git que los guarde.

```bash
node scripts/preguntar.mjs "¿Qué estabas haciendo?"   # una pregunta
node scripts/preguntar.mjs --lote                    # las 12 de prueba
node scripts/preguntar.mjs --lote mis-preguntas.txt  # una por línea
```

`preguntar.mjs` sintetiza la pregunta con `say` a WAV PCM 16-bit y lo POSTa a
`/api/touch`, o sea que se ejercita el **pipeline completo**: RMS → Whisper → Groq con
contexto → edge-tts. No es un atajo: si el STT no entiende, Ivi tampoco.

Los MP3 quedan en `audio-temp/preguntas/` para oírlos, y `resultados.json` con texto,
emoción, latencia y si entró contexto.

**Antes de una tanda larga, refresca el estado:**

```bash
node scripts/leer-contexto.mjs    # dice VIVO o VIEJO
```

La ventana es de 180 min. Si venció, Ivi responde con su personalidad pero **sin
contexto**: "no tengo esa info" a todo, y es diseño, no bug.

### Tests

```bash
npm test               # las tres suites: 50 + 23 + 25
npm run test:redactor  # 50 verificaciones (25 fixtures × 2 implementaciones)
npm run test:state     # 23 del validador
npm run test:contexto  # 25 del bloque de contexto e inyección
```

Sondas de diagnóstico:

```bash
node scripts/probe-ventana.mjs   # mide la ventana REAL de producción
node scripts/probe-edad.mjs      # comprueba si Ivi nombra la antigüedad
node scripts/gate-cinco-turnos.mjs  # 7 turnos contra Groq real, sin gastar TTS
```

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
| Deadline de turno | `server.ts` | 45 s para LLM+STT+TTS; si se pasa, MP3 de emergencia. El device corta a 65 s y el turno se pierde entero. |
| TTS huérfanos | `tts.ts` | el timeout no cancela `toFile`, que sigue escribiendo en `audio.mp3`; una huérfana podía pisar el archivo y devolver **otro** texto como respuesta. Se cuentan y se espera. |
| Pool rotativo de fallback | `llm.ts` | si Groq falla y no hay reintento, baja a `gpt-oss-20b` con cooldown de 5 min. |
| Allowlist del copiloto | `copilot/routes.ts` | sin `COPILOT_PROJECTS` responde 503. Antes aceptaba cualquier proyecto. |

## Fixes del plugin ya aplicados (NO deshacer)

Fuera del repo, en `~/.config/opencode/plugins/ivi-copilot.js`:

| Fix | Qué hace |
|---|---|
| `files_changed` acumula | `session.diff` **reemplazaba** el arreglo entero y `SnapshotFileDiff.file` es **opcional** en el SDK, así que un evento sin `file` borraba lo que `file.edited` había juntado. Resultado: "no cambió nada" después de editar de verdad. Ahora acumula. |
| `project` en el payload | sin el campo, el server recibía el proyecto vacío y la allowlist lo rechazaba. |
| Debounce de 15 s → 2 s | con 15 s, una sesión corta terminaba antes del envío y no se publicaba nada. |
| Sin comillas envolventes | `opencode run "..."` deja el prompt envuelto en comillas literales; Ivi las leía en voz alta. Solo se quita el par si no hay otra igual dentro. |
| `session.idle` sin await | se marca sin esperar el fetch, para no dejar la sesión colgada. |

---

## Prueba rápida de diagnóstico

```bash
# server (TUI en vivo):
tail -f /tmp/mochi-server.log | grep --line-buffered "Transcripción:\|sin VOZ\|Sesión"

# estado de OpenCode tal como lo ve Ivi:
node scripts/leer-contexto.mjs
```

---

© ramses 2026 · mochi-server · **Ivi — ya escucha de verdad, y te recuerda.**