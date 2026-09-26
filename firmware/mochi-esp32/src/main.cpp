#include <Arduino.h>
#include <Wire.h>
#include <math.h>
#include "config.h"
#include "wifi_manager.h"
#include "wifi_store.h"
#include "audio_record.h"
#include "audio_play.h"
#include "http_client.h"
#include "oled_display.h"
#include "battery.h"
#include "self_test.h"

enum class State {
    IDLE,
    WORKING   // graba -> envia -> reproduce (bloqueante), luego vuelve a IDLE
};

static State state = State::IDLE;

// ---- Joystick analogico (push-to-talk) ----
static int joyCenterX = 2048;
static int joyCenterY = 2048;
static unsigned long joyCenteredSince = 0;

static void joyCalibrate() {
    long sumX = 0, sumY = 0;
    for (int i = 0; i < JOYSTICK_CAL_SAMPLES; i++) {
        sumX += analogRead(JOYSTICK_VRX_PIN);
        sumY += analogRead(JOYSTICK_VRY_PIN);
        delay(2);
    }
    joyCenterX = sumX / JOYSTICK_CAL_SAMPLES;
    joyCenterY = sumY / JOYSTICK_CAL_SAMPLES;
    Serial.printf("[joy] Centro calibrado: X=%d Y=%d\n", joyCenterX, joyCenterY);
}

static bool joyAxisCentered(int value, int center) {
    return abs(value - center) <= JOYSTICK_DEADZONE;
}

static bool joyAnyAxisOut() {
    int x = analogRead(JOYSTICK_VRX_PIN);
    int y = analogRead(JOYSTICK_VRY_PIN);
    return !joyAxisCentered(x, joyCenterX) || !joyAxisCentered(y, joyCenterY);
}

static bool joyBothCentered() {
    int x = analogRead(JOYSTICK_VRX_PIN);
    int y = analogRead(JOYSTICK_VRY_PIN);
    return joyAxisCentered(x, joyCenterX) && joyAxisCentered(y, joyCenterY);
}

// Callback de grabacion: detener cuando AMBOS ejes vuelvan al centro y se
// mantengan ahi durante JOYSTICK_CENTER_MS (histéresis anti-vibracion).
static bool shouldStopRecording() {
    if (joyBothCentered()) {
        if (joyCenteredSince == 0) joyCenteredSince = millis();
        return (millis() - joyCenteredSince) >= (unsigned long)JOYSTICK_CENTER_MS;
    }
    joyCenteredSince = 0;
    return false;
}

static IviFace emotionToFace(const char* emocion) {
    if (emocion == nullptr) return IviFace::NEUTRAL;
    if (strncmp(emocion, "feliz", 5) == 0) return IviFace::HAPPY;
    if (strncmp(emocion, "sorprendido", 11) == 0) return IviFace::SORPRENDIDO;
    if (strncmp(emocion, "burlon", 6) == 0) return IviFace::BURLON;
    if (strncmp(emocion, "pensativo", 9) == 0) return IviFace::PENSATIVO;
    if (strncmp(emocion, "enojado", 7) == 0) return IviFace::ENOJADO;
    return IviFace::NEUTRAL;
}

// ------------------------------------------------------------------
//  Modo TEST_OLED: pantalla blanca/negra alterna + re-escaneo I2C,
//  para determinar si el panel enciende (y de que controlador es).
// ------------------------------------------------------------------
//  Modo TEST_OLED: cicla las caras de Ivi + diagnostico I2C periodico.
//  Confirma dibujo/orientacion de las caras en pantalla SSD1306.
// ------------------------------------------------------------------
#if TEST_OLED
static const IviFace testFaces[] = {
    IviFace::NEUTRAL, IviFace::HAPPY, IviFace::SORPRENDIDO,
    IviFace::BURLON,  IviFace::PENSATIVO, IviFace::ENOJADO
};
static unsigned char testFaceIdx = 0;
static unsigned long testOledLast = 0;
static unsigned long testScanLast = 0;

static void oledDiagLog() {
    Wire.beginTransmission(0x3C);
    bool at3C = (Wire.endTransmission() == 0);
    Wire.beginTransmission(0x3D);
    bool at3D = (Wire.endTransmission() == 0);
    Serial.printf("[test-oled] I2C: 0x3C=%s  0x3D=%s\n",
                  at3C ? "SI" : "no", at3D ? "SI" : "no");
    if (!at3C && !at3D) Serial.println("[test-oled] NADA responde: SDA/SCL al aire o mal.");
}

void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("[test-oled] Iniciando TEST_OLED (caras Ivi)...");
    Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);   // una sola vez
    delay(50);
    oledDiagLog();
    Serial.println("[test-oled] Inicializando display SSD1306 (0x3C)...");
    oledInit();
    oledShowFace(testFaces[testFaceIdx]);
    testOledLast = millis();
    testScanLast = millis();
}

void loop() {
    if (millis() - testOledLast >= 1500) {
        testOledLast = millis();
        testFaceIdx = (testFaceIdx + 1) % (sizeof(testFaces)/sizeof(testFaces[0]));
        oledShowFace(testFaces[testFaceIdx]);
        Serial.printf("[test-oled] Mostrando cara %d/%d\n",
                      testFaceIdx + 1, (int)(sizeof(testFaces)/sizeof(testFaces[0])));
    }
    if (millis() - testScanLast >= 6000) {
        testScanLast = millis();
        oledDiagLog();
    }
    delay(20);
}
#endif

// ------------------------------------------------------------------
//  Modo TEST_MIC: graba una rafaga fija de 2s y loguea nivel por Serial
// ------------------------------------------------------------------
#ifndef TOSTR
#define TOSTR_(x) #x
#define TOSTR(x) TOSTR_(x)
#endif
#if TEST_MIC
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("[test-mic] TEST_MIC: barrido configs slot. BCLK=" TOSTR(MIC_BCK) "/WS=" TOSTR(MIC_WS) "/SD=" TOSTR(MIC_DIN) ".");
    Serial.println("[test-mic] Habla fuerte y constante ~2s mientras barre.");
}

static int micStep = 0;
void loop() {
    switch (micStep++) {
        case 0: dumpRawFrame();     break;   // discrimina pin sin dato vs dato mal decodificado
        case 1: probeSlotBoth();    break;   // senal vs crosstalk en L/R
        case 2: probeDataShift();   break;   // prueba >>8/16/24
        case 3: probeDinDC();       break;   // nivel electrico del pin SD
        case 4: probeClockActivity(); break; // cuenta toggles reales de BCLK/WS por pin
        case 5: probeSlotConfigs(); break;   // barre ws_pol / ws_inv / bit_shift
        case 6: probeMonoRecord();  break;   // cadena real de grabacion mono 1s
        case 7: probeMonoWavDump(); break;   // emite el WAV completo por serial para analisis en PC
        default: micStep = 0;       break;
    }
    delay(3000);
}
#endif

// ------------------------------------------------------------------
//  Modo TEST_AMP: reproduce un tono PCM 16kHz por la bocina
// ------------------------------------------------------------------
#if TEST_AMP
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("[test-amp] Iniciando TEST_AMP (tono 440Hz 3s).");
    audioPlayToneMs(3000);
    Serial.println("[test-amp] TEST_AMP TERMINADO.");
}

void loop() { delay(1000); }
#endif

// ------------------------------------------------------------------
//  Modo TEST_JOY: loguea ejes ADC1 + calibracion en bucle hasta reset
// ------------------------------------------------------------------
#if TEST_JOY
void setup() {
    Serial.begin(115200);
    delay(300);
    joyCalibrate();
    Serial.println("[test-joy] Logeando ejes. Mueve el joystick. RESET para salir.");
}

void loop() {
    int x = analogRead(JOYSTICK_VRX_PIN);
    int y = analogRead(JOYSTICK_VRY_PIN);
    Serial.printf("[test-joy] X=%d Y=%d (centro X=%d Y=%d)\n", x, y, joyCenterX, joyCenterY);
    delay(200);
}
#endif

// ------------------------------------------------------------------
//  Modo TEST_ALL: FSM sin red, loop-back WAV 16kHz
// ------------------------------------------------------------------
#if TEST_ALL
void setup() {
    Serial.begin(115200);
    delay(300);
    joyCalibrate();
    oledInit();
    oledShowFace(IviFace::NEUTRAL);
    Serial.println("[test-all] FSM local SIN red: mueve joystick para grabar,");
    Serial.println("[test-all] suelta (centro 120ms) para reproducir loop-back 16kHz.");
    Serial.printf("[test-all] Centro cal: X=%d Y=%d deadzone=%d. MANTEN CENTRADO para arrancar.\n",
                  joyCenterX, joyCenterY, JOYSTICK_DEADZONE);
}

// Latch anti-ciclo: pide que el joystick parta del CENTRO y recien entonces
// mueva un eje para disparar UNA sola grabacion por pulsion. Sin esto, si el
// joystick queda "fuera de centro" (drift/flotacion), el TEST_ALL graba y
// reproduce en ciclo infinito solo.
static bool hadCenterWait = false;

void loop() {
    oledLoop();
    if (state == State::IDLE) {
        if (joyAnyAxisOut()) {
            if (hadCenterWait) {
                hadCenterWait = false;   // paso por el centro y ahora desviado -> dispara
                Serial.println("[test-all] -> GRABANDO");
                oledShowFace(IviFace::PENSATIVO);
                joyCenteredSince = 0;
                state = State::WORKING;
            }
        } else {
            hadCenterWait = true;        // vio el centro: habilita el proximo disparo
        }
    } else {
        uint8_t* wav = nullptr;
        size_t wavLen = audioRecordWav(&wav, shouldStopRecording);
        if (wavLen && wav) {
            const int16_t* pcm = (const int16_t*)(wav + 44);
            size_t n = (wavLen - 44) / 2;
            long peak = 0, nMid = 0, nFlip = 0;
            bool wasNeg = pcm[0] < 0;
            for (size_t i = 0; i < n; i++) {
                long v = pcm[i], a = v < 0 ? -v : v;
                if (a > peak) peak = a;
                if (a > 1000) nMid++;
                bool neg = v < 0;
                if (neg != wasNeg && a > 500) nFlip++;
                wasNeg = neg;
            }
            Serial.printf("[test-all] Grabo %u bytes pcm=%u peak=%ld %%mid=%.1f flips=%u\n",
                          (unsigned)wavLen, (unsigned)n, peak,
                          n ? 100.0 * nMid / n : 0.0, nFlip);
            oledShowFace(IviFace::HAPPY);
            audioPlayWavLoopback(wav, wavLen);
        } else {
            Serial.println("[test-all] Sin audio util.");
        }
        oledShowFace(IviFace::NEUTRAL);
        state = State::IDLE;
        hadCenterWait = false;   // exige re-centrar antes del siguiente trigger
    }
}
#endif

// ------------------------------------------------------------------
//  Modo TEST_MP3: decodifica y reproduce por bocina un MP3 embebido en flash
//  (ruta NORMAL reconciliada a i2s_std: AudioOutputI2SStd + AudioGeneratorMP3).
//  Se escucha: 4s de tonos 440+880Hz repetidos hasta reinicio.
// ------------------------------------------------------------------
#if TEST_MP3
#include "test_mp3_data.h"

void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.printf("[test-mp3] MP3 %u bytes en flash. Reproduciendo en bucle...\n",
                  (unsigned)test_mp3_len);
    audioPlayInit();
    while (true) {
        audioPlayBytes(test_mp3, test_mp3_len);
        delay(800);
    }
}

void loop() { delay(1000); }
#endif

// ------------------------------------------------------------------
//  Modo SELF_TEST / NORMAL (app completa)
// ------------------------------------------------------------------
#if !TEST_OLED && !TEST_MIC && !TEST_AMP && !TEST_JOY && !TEST_ALL && !TEST_MP3 && !TEST_BATTERY

// Trae del servidor la lista de redes WiFi de esta Ivi (si hay DEVICE_TOKEN
// configurado) y la deja guardada en NVS con el orden de prioridad.
static void syncNetworks() {
    wifiStoreInit();
    WifiEntry entries[WIFI_MAX_NETWORKS];
    int n = httpFetchNetworks(entries, WIFI_MAX_NETWORKS);
    if (n >= 0) {
        wifiStoreReplaceAll(entries, n);
        Serial.printf("[fsm] Redes sincronizadas desde servidor: %d\n", n);
    }
}

// Fase 4: despertado del server. Tras conectar al WiFi, el server puede estar
// dormido (Render free duerme tras ~15 min sin pedidos): hacemos ping corto a
// /health (que a la vez lo despierta) y esperamos hasta SERVER_WAKE_MAX_MS,
// mostrando en el OLED la cuenta regresiva. Vuelve 0 si el server respondio
// 200, -1 si expiro el tiempo o no hay WiFi.
static int waitServerWake() {
    if (!wifiConnected()) return -1;
    const unsigned long inicio = millis();
    int segsMostrado = -1;
    while ((unsigned long)(millis() - inicio) < SERVER_WAKE_MAX_MS) {
        int r = httpPingHealth(4000);
        if (r == 200) {
            Serial.println("[fsm] Servidor listo (health 200)");
            return 0;
        }
        unsigned long restante = SERVER_WAKE_MAX_MS - (unsigned long)(millis() - inicio);
        int segs = (int)((restante + 999) / 1000);
        if (segs != segsMostrado) {
            segsMostrado = segs;
            Serial.printf("[fsm] Esperando al server... %ds (health %d)\n", segs, r);
            oledShowCountdown(segs);
        }
        delay(restante < SERVER_WAKE_POLL_MS ? restante : SERVER_WAKE_POLL_MS);
    }
    Serial.println("[fsm] Server no respondio a tiempo; sigo con lo que haya.");
    return -1;
}

void setup() {
    Serial.begin(115200);
    delay(300);

#if SELF_TEST
    Serial.println("[fsm] Modo SELF-TEST activo");
    wifiConnect();
    syncNetworks();
    selfTestRun();
    Serial.println("[fsm] Self-test terminado. Esperando...");
#else
    oledInit();
    // Cubre los ~4s de boot con "despertando de la siesta" (zZz + ojos
    // cerrados) mientras el WiFi conecta; al quedar lista pasa a la cara.
    oledShowBoot("Despertando de", "mi siesta...");
    batteryInit();
    joyCalibrate();          // auto-calibra el centro del joystick en reposo
    oledShowBoot("Conectando a", "casa...");
    wifiConnect();
    if (wifiConnected()) {
        // Fase 4: despertar al server (Render duerme) con cuenta regresiva
        // en el OLED; SOLO cuando /health responda 200 sincronizamos redes.
        oledShowBoot("Ya estoy casi", "lista...");
        if (waitServerWake() == 0) {
            syncNetworks();
        }
    }
    oledShowText("Ya estoy", "lista!");
    delay(900);
    oledShowFace(IviFace::NEUTRAL);
    audioPlayInit();
#endif
}

void handleIdle() {
#if SELF_TEST
    // En self-test no disparamos la FSM (no hay piezas); solo bucle ocioso.
    delay(10);
    return;
#endif
    oledLoop();
    if (joyAnyAxisOut()) {
        Serial.println("[fsm] -> GRABANDO");
        oledShowFace(IviFace::PENSATIVO);
        joyCenteredSince = 0;
        state = State::WORKING;
    }
}

#if !SELF_TEST
void runTurn() {
    // 1) Grabar (push-to-talk)
    uint8_t* wav = nullptr;
    size_t wavLen = audioRecordWav(&wav, shouldStopRecording);

    if (wavLen == 0 || wav == nullptr) {
        Serial.println("[fsm] Sin audio util");
        oledShowFace(IviFace::NEUTRAL);
        return;
    }

    if (!wifiConnected()) {
        Serial.println("[fsm] Sin WiFi");
        oledShowFace(IviFace::NEUTRAL);
        return;
    }

    // 2) Procesar (enviar y recibir respuesta)
    oledShowProcessing(true);
    Serial.printf("[fsm] Enviando %u bytes...\n", (unsigned)wavLen);
    IviReply reply;
    bool ok = httpSendAudio(wav, wavLen, reply);

    if (!ok || reply.audioLen == 0) {
        Serial.println("[fsm] Error HTTP");
        httpClientFree(reply);
        oledShowFace(IviFace::NEUTRAL);
        return;
    }

    Serial.printf("[fsm] Respuesta: %u bytes, emocion=%s\n",
                  (unsigned)reply.audioLen, reply.emocion);

    // 3) Reproducir con la cara segun emocion
    oledShowFace(emotionToFace(reply.emocion));
    audioPlayBytes(reply.audio, reply.audioLen);
    httpClientFree(reply);

    oledShowFace(IviFace::NEUTRAL);
}

void handleWorking() {
    runTurn();
    state = State::IDLE;
}
#endif

void loop() {
    wifiLoop();

    switch (state) {
        case State::IDLE:   handleIdle(); break;
#if !SELF_TEST
        case State::WORKING: handleWorking(); break;
#endif
    }
}
#endif

// ------------------------------------------------------------------
//  Modo TEST_BATTERY: validacion alimentado SOLO por bateria (sin USB).
//  Sin USB no hay Serial; se valida por: OLED "BAT-OK" (visible) y
//  bocina con pitido 440Hz periodico (ESP + amp funcionando con LiPo).
// ------------------------------------------------------------------
#if TEST_BATTERY
static uint32_t lastBeep = 0;

void setup() {
    Serial.begin(115200);
    delay(100);
    oledInit();
    oledShowFace(IviFace::HAPPY);
    oledShowText("BAT-OK", "LiPo + TP4056");
    Serial.println("[batt] TEST_BATTERY: OLED + bocina alimentados por bateria.");
    lastBeep = millis();
}

void loop() {
    if (millis() - lastBeep >= 5000) {
        lastBeep = millis();
        audioPlayToneMs(900);   // pitido 440Hz ~0.9s por la bocina (valida amp)
    }
    delay(50);
}
#endif
