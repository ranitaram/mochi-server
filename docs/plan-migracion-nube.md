# ⚠️ PLAN DE MIGRACIÓN A LA NUBE — NO EJECUTAR TODAVÍA

> **!!! IMPORTANTE / NO EJECUTAR !!!**
> Este plan es SOLO PARA REFERENCIA. **NO comiences ningún cambio de esto todavía.**
> Se activa ÚNICAMENTE cuando el usuario **confirme explícitamente** que el hardware
> está **completamente validado**, es decir: **micrófono reemplazado y funcionando,
> TEST_AMP, TEST_JOY, TEST_ALL, SELF_TEST y flujo NORMAL** corriendo de punta a punta
> contra el servidor local. Hasta entonces, no tocar `config.h` de red ni el servidor.

---

## POR QUÉ MIGRAMOS

Ahora mismo el ESP32 solo puede hablar con el servidor si ambos están en la misma red
WiFi. Eso significa que, para usar a Ivi fuera de casa (portátil, con el hotspot del
celular), habría que llevar también la Mac y conectarla al mismo hotspot — lo que rompe
el objetivo de portabilidad del proyecto.

Migrar a la nube le da al servidor una **URL fija y accesible desde cualquier red**, sin
depender de estar en la misma LAN.

## DÓNDE SE VA A ALOJAR

- **Railway** (opción preferida desde el inicio del proyecto): free tier generoso y
  deploy simple para un proyecto Node/TypeScript pequeño como este.
- Si al momento de migrar Railway ya no tiene un free tier viable, evaluar **Fly.io**
  como alternativa equivalente. Railway es la primera opción.

## QUÉ CAMBIA EN EL CÓDIGO

### 1. Firmware del ESP32 (`config.h`)
- `SERVER_HOST` deja de ser una IP local (`192.168.100.20`) y pasa a ser la URL fija
  que asigne Railway (algo como `https://ivi-server.up.railway.app` o el dominio que
  genere).
- `SERVER_PORT` probablemente ya no aplica igual (Railway maneja HTTPS en el puerto
  estándar 443): ajustar `SERVER_USE_HTTPS` a `1`.
- Revisar si `http_client.cpp` necesita cambios para manejar TLS: el ESP32-S3 sí soporta
  HTTPS, pero puede requerir el certificado raíz, o usar `WiFiClientSecure` con
  `setInsecure()` como paso intermedio si los certificados dan problemas. Evaluarlo en
  su momento.

### 2. Servidor (Node/TypeScript)
- Revisar que las variables de entorno (`.env`: `GROQ_API_KEY`, `TURSO_DATABASE_URL`,
  `TURSO_AUTH_TOKEN`, etc.) se configuren como variables de entorno del proyecto en el
  dashboard de Railway.
- **NUNCA** subir el archivo `.env` al repositorio.

### 3. WiFiMulti
- Ya no se usan las 3 redes pensando en "encontrar la Mac en la misma red".
- **SÍ se mantiene** WiFiMulti para que el ESP32 elija entre casa/familiar/hotspot como
  fuente de **INTERNET**; eso no cambia. Solo cambia a qué servidor le habla una vez que
  ya tiene internet.

### 4. IP local
- Con el servidor en la nube, el problema de "la IP local cambió" desaparece por
  completo: no hace falta reserva DHCP ni revisar IPs cada día, la URL de Railway es
  permanente.

## QUÉ NO CAMBIA

- La arquitectura del pipeline (STT → LLM → TTS → respuesta).
- La personalidad de Ivi.
- La memoria con Turso.
- El endpoint `/api/touch` con headers `X-Ivi-Texto` / `X-Ivi-Emocion` + body de audio.

Nada de eso se toca: solo cambia la **ubicación** donde corre el servidor y **cómo lo
alcanza el ESP32**.

## CUÁNDO EJECUTARLO

**NO ahora.** Solo cuando el usuario confirme explícitamente que el hardware está
completamente validado y listo: mic + amp + joystick + flujo NORMAL funcionando de punta
a punta en local.