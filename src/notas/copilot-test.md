# TTS: timeout de 8s, reintentos y huérfanas

Fecha: 2026-10-04 · Archivo tocado: `src/tts.ts` (+ `.env.example`)

## Qué se pidió

Timeout de 8 segundos y manejo de error con reintentos en `src/tts.ts`.

## Qué ya existía (no se reimplementó)

El manejo de error con reintentos **ya estaba**: `RETRIES = 1`, backoff
progresivo (`BACKOFF_BASE_MS * intento`), cascada de emergencia y
`deadlineMs` por turno. Solo se ajustó el timeout y se taparon dos huecos
reales que quedaban sueltos.

## Cambios

### 1. Timeout por intento: 12s → 8s (`src/tts.ts:19`)

`TIMEOUT_MS = 12_000` → `num(process.env.TTS_TIMEOUT_MS, 8_000)`, con el mismo
helper `num()` que ya usa `src/llm.ts`. 8s es el valor que ya usa el LLM por
request (`GROQ_TIMEOUT_MS`), así que ambos budgetores quedan alineados.

Recalculado el peor caso: **~25s → ~16s** (8s + 400ms de backoff + 8s). Sigue
entrando en `TURNO_DEADLINE_MS` (45s) junto al LLM (12s) y el STT (2s), así que
el MP3 alcanza a llegar al parlante. Si se sube este número hay que recalcular
el deadline, o el ESP32 corta el POST a los 65s.

### 2. Timer del timeout ya no queda prendido (`src/tts.ts`)

`setTimeout` sin `clearTimeout` dejaba el handle vivo: cada síntesis exitosa
mantendría el event loop prendido `timeoutMs` después de responder.

### 3. Síntesis huérfanas ya no pisan el audio del reintento

Este era el hueco serio. Cuando el timeout ganaba el `Promise.race`, el
`tts.toFile` perdedor **seguía corriendo**: `msedge-tts` no se puede cancelar y
siempre escribe en `audio.mp3`. Esa escritura huérfana podía aterrizar durante
el reintento y, dado que `enSerializar` serializa solo los jobs encolados (no
contra una huérfana en vuelo), el reintento leía bytes del **texto anterior** y
se lo servía al niño como si fuera su respuesta.

Ahora se cuenta las huérfanas en vuelo, la siguiente síntesis las espera antes de
empezar, y al aterrizar se borra el archivo que dejaron. Riesgo residual: la
espera tiene tope de 2s, así que una huérfana más lenta que eso todavía puede
cabar en un archivo — para entonces el intento va fallando y lo cubren el
reintento y el MP3 de emergencia.

### 4. El backoff ya no se come el deadline (`src/tts.ts`)

Si ya no quedaba tiempo antes del backoff, el servidor dormía igual y el
reintento fallaba de antemano sin intentarlo. Ahora se saltea el `dormir` cuando
no hay margen.

## Verificación

- `npx tsc --noEmit`: limpio.
- `npm test`: **pasa, exit 0** — 3 suites: `test-redactor` (50 verificaciones en
  2 implementaciones), `test-state` (23) y `test-contexto` (26).

**Ojo: `npm test` no toca TTS.** Solo cubre la capa de prompts del copilot
(redactor de contexto, state machine, armado de contexto). Ninguna de esas
aserciones ejercita el timeout, los reintentos ni la cascada de emergencia, así
que el cambio pasó typecheck pero **no está cubierto por tests**.

## Cómo probarlo a mano

```bash
TTS_FORCE_FAIL=1 npm run server   # fallback de emergencia sinEdge
TTS_TIMEOUT_MS=1 npm run server   # fuerza el timeout y el reintento
```

Ambos logs por stderr: `[TTS] intento N/2 falló: ...` y
`[TTS] sin reintentos — audio de emergencia:`.

## Pendiente sugerido

Un `scripts/test-tts.mjs` con `TTS_FORCE_FAIL=1` para assertar que sale el MP3 de
emergencia en vez de tirar excepción, y agregarlo a la cadena de `npm test`.

---

# Corrida de `npm test` — 2026-10-04

Sin cambios de código: solo se ejecutó la suite.

## Qué pasó

Exit 0. Las 3 suites pasaron, **99 aserciones, 0 fallas**:

| Suite | Resultado |
| --- | --- |
| `scripts/test-redactor.mjs` | 50 verificaciones × 2 implementaciones (plugin y backend), todas pasan y coinciden entre sí |
| `scripts/test-state.mjs` | 23 pruebas, todas pasan |
| `scripts/test-contexto.mjs` | 26 pruebas, todas pasan |

## Qué cubre realmente

- **Redactor de secretos** (`gsk_`, `sk-`, `ghp_`, `AKIA`, Bearer, JWT,
  credenciales en URL, `NOMBRE=valor`, texto truncado por cola, idempotencia)
  verificado contra **las dos implementaciones** a la vez — plugin y backend
  tienen que dar el mismo resultado.
- **State machine**: contrato mínimo, rechazo de `version` incorrecta / `null` /
  array / string, `session_id` obligatorio, rechazo de rutas con traversal,
  segunda capa de redacción en el servidor (redacta aunque el plugin ya lo haya
  hecho), límites (`last_message`, `failures` a 5, `files_changed` a 50,drop de
  `patch`), coerción de métricas y tope de payload de 65536 bytes.
- **Armado de contexto**: ventana de 3 h, contenido esperado (tarea, archivos,
  error con código, último mensaje), defensa contra prompt injection (el texto
  hostil va entre comillas y el bloque se cierra después), singular en "1 paso" y
  límites de listado (primeros 8 archivos, resto resumido).

## Lo que sigue sin cubrir

Nada nuevo: `npm test` sigue siendo solo la capa de prompts del copilot.
TTS, STT, LLM y el ESP32 quedan fuera. El pendiente de `scripts/test-tts.mjs`
de la nota de arriba sigue abierto.

---

# Corrida de `npm test` — 2026-10-04 (segunda del día)

Sin cambios de código: solo se ejecutó la suite otra vez, para confirmar que
sigue verde después del trabajo de TTS.

## Qué pasó

`exit 0`, y las 3 suites volvieron a pasar: **99 aserciones, 0 fallas**
(50 × 2 en `test-redactor`, 23 en `test-state`, 26 en `test-contexto`).

Resultado **idéntico** al de la corrida de arriba, nombre por nombre: ninguna
aserción nueva, ninguna que cambiara de estado. Lo confirma el hecho de que
`test-redactor` siga reportando que las dos implementaciones (plugin y backend)
coinciden.

## Qué sigue sin cubrir

Sin cambios: TTS, STT, LLM y el ESP32 quedan fuera de `npm test`, así que el
timeout de 8s, los reintentos y las huérfanas de la nota de TTS **siguen sin
ninguna prueba que los cubra**. Passar la suite no dice nada sobre ellos. El
pendiente de `scripts/test-tts.mjs` sigue abierto.