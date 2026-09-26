# ✅ MIGRACIÓN A LA NUBE — REALIZADA

> Estado: **EJECUTADA y VIVIENDO EN PRODUCCIÓN** (fases 2-4).
> Antes de la migración, el ESP32 solo hablaba con el servidor si ambos estaban en la
> misma red WiFi (la Mac en casa / hotspot del celular). Hoy el backend corre en la
> nube con URL fija y accesible desde cualquier red.

## DÓNDE CORRE

- **Render** (free tier, servicio web `mochi-server-tnwq`): `https://mochi-server-tnwq.onrender.com`
  - Auto-deploy desde la rama `main` de GitHub.
  - El free tier **duerme tras ~15 min sin actividad**; el ESP32 lo despierta con
    `GET /health` al bootear (ver `SERVER_WAKE_MAX_MS` / `SERVER_WAKE_POLL_MS` en
    `config.h`).
- **PostgreSQL** en **Neon** (DB Fase 2, Prisma 6). El cliente usa `@prisma/adapter-neon`
  (driver HTTP): evita el TCP/IPv6-first que fallaba con el pooler 5432 desde Render.
- **Memoria de hechos** sigue en **Turso** (SQLite), sin cambios de diseño.

## QUE CAMBIÓ EN EL CÓDIGO

### 1. Firmware del ESP32 (`config.h`)
- `BACKEND_URL = "https://mochi-server-tnwq.onrender.com"` (HTTPS; `SERVER_HOST`/`SERVER_PORT`
  de la etapa local ya no existen).
- HTTPS con `WiFiClientSecure::setInsecure()` (canal cifrado, sin pin de certificado).
- `DEVICE_TOKEN` identifica a esta Ivi y sincroniza sus redes WiFi desde el server.
- `syncNetworks()` + `waitServerWake()`: al bootear despierta al server y, cuando
  `/health` responde 200, baja las redes configuradas en el panel.
- **WiFiMulti sí se mantiene**: el ESP32 elige casa/familiar/hotspot como fuente de
  INTERNET; solo cambió a qué servidor le habla una vez que tiene internet.

### 2. Servidor (Node/TypeScript)
- Variables de entorno (`.env`) replicadas como env vars de Render: `GROQ_API_KEY`,
  `DATABASE_URL`, `ADMIN_*`, `WIFI_ENC_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
  etc. `.env` NO se sube al repo.
- Nuevos endpoints de Fase 2: `/admin` + `/login` (panel de redes WiFi), API
  `api/devices/...` (Prisma + PostgreSQL) y sync de redes por Bearer token.

## QUÉ NO CAMBIÓ

- Arquitectura del pipeline (STT → LLM → TTS → respuesta) y el endpoint `/api/touch`.
- Personalidad de Ivi, fases de memoria (Turso) y las sesiones de conversación.
- Con la URL de la nube, el problema de "la IP local cambió" desapareció: la URL es
  permanente (no hace falta reserva DHCP ni revisar IPs).