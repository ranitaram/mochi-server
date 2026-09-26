# Despliegue en Render (free tier)

Cómo llevar el backend que hoy corre en la red local a un dominio público
HTTPS para que el ESP32 le hable desde cualquier red (sin depender de la IP
de la Mac). Paso 1 de la migración a producción.

---

## Pre-requisitos

- Cuenta en [Render](https://render.com) (plan free).
- El repo subido a GitHub (Render construye desde el repo).
- Opcional: tus variables hoy en `.env`. En Render se cargan igual, pero en
  el dashboard del servicio (Settings -> Environment).

## Opción A — Blueprint (`render.yaml`)

1. Push a GitHub: `git push origin fase/1-backend-render` (y de ahí a `main`
   cuando mergees).
2. En Render: *New* → *Blueprint* → conectá el repo.
3. Render lee `render.yaml` y crea el servicio `ivi-backend`. Te va a pedir
   los valores de las variables marcadas con `sync: false`:
   - `GROQ_API_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SERVER_URL`
     (las que no pidió ya tienen su default en el yaml).
4. *Apply* → despliega.

## Opción B — Web Service manual (equivalente)

- *New* → *Web Service* → elegí el repo.
- Runtime: **Node** (Render lo detecta solo).
- **Build command:** `npm install && npm run build`
- **Start command:** `npm start`
- **Health check path:** `/health`
- Plan: **Free** (región oregon).
- Cargá las mismas variables en Settings -> Environment (ver `render.yaml`).
  `PORT` NO hay que cargarla: Render la asigna.

## Verificación

```bash
curl -s -w "\nHTTP %{http_code}\n" https://ivi-backend.onrender.com/health
# esperá: "ok" + HTTP 200
```

Ya despierta el servicio cada vez que alguien lo llama (free tier duerme
tras ~15 min de inactividad). Ese mismo `GET /health` es el que el ESP32
usa en su secuencia de arranque para despertarlo (fire-and-forget).

## Hardware → producción

En `firmware/mochi-esp32/src/config.h` (gitignored, tus secrets):

```c
#define BACKEND_URL "https://ivi-backend.onrender.com"
```

y el firmware usa HTTPS con `WiFiClientSecure` (ver `http_client.cpp`),
así que el endpoint real del servicio es el dominio de Render, no la IP
local `192.168.x.x`.

## Notas

- El endpoint `/health` NO toca base de datos ni IA: responde `200 "ok"`
  apenas el proceso levanta, aunque Turso tarde o no esté.
- La memoria (Turso) arranca en background; si la DB no existe, el server
  sigue vivo con memoria deshabilitada (log por consola).
- `/tmp/last_ptt.wav` (diagnóstico del PTT) sigue funcionando: en Render
  `/tmp` es efímero, suficiente para diagnóstico.