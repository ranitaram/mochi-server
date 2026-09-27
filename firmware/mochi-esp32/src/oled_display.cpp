#include "oled_display.h"
#include <Arduino.h>
#include <Wire.h>
#include <string.h>
#include <math.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "freertos/FreeRTOS.h"
#include "freertos/timers.h"
#include "config.h"
#include "battery.h"

#define DEBUG_TALK 1   // log [talk] 1x/s mientras se anima el habla

#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_ADDR     0x3C

// Cara unica (ojos + boca) procedura: se dibuja entera cada frame.
#define EYE_LX 49
#define EYE_RX 79
#define EYE_Y  24
#define EYE_R  6
#define MOUTH_X 64
#define MOUTH_Y 44

static Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

static IviFace currentFace = IviFace::NEUTRAL;
static bool processing = false;
static unsigned long lastBlink = 0;
static bool blinkState = false;
static int dotFrame = 0;
static unsigned long lastDot = 0;
static bool showTextBox = false;
static char txt1[24] = {0};
static char txt2[24] = {0};
static bool textVisible = true;

static bool wireReady = false;
static bool panelReady = false;

// --- animacion de habla ---
static bool talking = false;
static uint8_t speechLevel = 0;     // 0..10 inyectado por el decoder
static float mouthF = 0;            // apertura suavizada (0..10)
static uint8_t mouthOpen = 0;
static unsigned long lastTalkTick = 0;
static uint16_t talkPhase = 0;

// --- balanceo lateral del grupo ojos+boca ---
static double swayPhase = 0.0;
static int swayX = 0;

// --- mirada (desplazamiento de la pupila dentro del ojo) ---
static float gazeX = 0, gazeY = 0;
static int gazeTargetX = 0, gazeTargetY = 0;
static unsigned long nextGaze = 0;
static int lastPx = 0, lastPy = 0;

static unsigned long lastBattPoll = 0;
static bool bootMode = false;
static int bootCountdown = -1;   // >=0: modo "esperando al server" con numero

// xorshift barata para parpadeo/mirada (sin bloquear milis).
static uint32_t animRng() {
    static uint32_t x = 0xA3E1A7C5;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return x;
}

static int rnd(float v) { return v >= 0 ? (int)(v + 0.5f) : (int)(v - 0.5f); }

void oledInit() {
    if (!wireReady) {
        // Reactiva pull-ups internos del ESP32-S3 en SDA/SCL ANTES de Wire.begin:
        // muchos modulos clon 0.96" no traen pull-ups propios y el bus I2C queda
        // inestable (ACK intermitente, i2c_master_transmit falla con INVALID_STATE).
        pinMode(PIN_OLED_SDA, INPUT_PULLUP);
        pinMode(PIN_OLED_SCL, INPUT_PULLUP);
        Wire.begin(PIN_OLED_SDA, PIN_OLED_SCL);
        wireReady = true;
    }
    // Confirmado por el usuario: las pantallas del kit son SSD1306 (0.96").
    // begin() con SWITCHCAPVCC habilita el charge-pump interno (0x8D 0x14),
    // que es lo que ilumina el panel; con la libreria SH110X eso nunca pasaba.
    if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
        Serial.println("[oled] FAIL: display.begin(SSD1306) no inicio el display.");
        return;
    }
    panelReady = true;
    // Animaciones continuas re-dibujan el frame a ~10fps;
    // subir I2C a 400kHz baja cada display() de ~90ms a ~25ms.
    Wire.setClock(400000);
    // Algunos clones vienen con contraste 0 o estado heredado; forzamos
    // modo normal para asegurar que el panel encienda.
    display.invertDisplay(false);
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.clearDisplay();
    display.display();
    delay(20);
    display.clearDisplay();
    display.display();
    nextGaze = millis() + 1500;
    lastPx = lastPy = 0;
}

// Elige un nuevo objetivo de pupila (mas viaje y mas frecuente al hablar) y
// programa cuando volver a moverse.
static void gazeRetarget() {
    uint32_t r = animRng();
    int amp = talking ? 3 : 2;                    // al hablar se mueve mas
    int vx = ((int)(r & 63)) - 31;                // -31..32
    int vy = ((int)((r >> 6) & 63)) - 31;
    gazeTargetX = vx < -amp ? -amp : (vx > amp ? amp : vx);
    gazeTargetY = vy < -amp ? -amp : (vy > amp ? amp : vy);
    uint32_t base = talking ? 600 : 900;
    uint32_t span = talking ? 1023 : 2047;
    nextGaze = millis() + base + (unsigned)((r >> 12) & span);
}

// Acerca la pupila al objetivo (mas rapido al hablar); al amarrarse, espera
// nextGaze y re-elige.
static void gazeStep() {
    float k = talking ? 0.5f : 0.35f;
    gazeX += ((float)gazeTargetX - gazeX) * k;
    gazeY += ((float)gazeTargetY - gazeY) * k;
    if (fabsf((float)gazeTargetX - gazeX) < 0.15f &&
        fabsf((float)gazeTargetY - gazeY) < 0.15f &&
        (long)(millis() - nextGaze) >= 0) {
        gazeRetarget();
    }
}

// Ojos grandes: circulos blancos con pupila negra que sigue la mirada; al
// parpadear se tapan con una linea gruesa. En "pensando" miran arriba.
static void drawFaceFeatures(int ox) {
    bool think = (currentFace == IviFace::PROCESSING);
    int Lx = EYE_LX + ox;
    int Rx = EYE_RX + ox;
    int ey = EYE_Y + (talking ? (int)(talkPhase & 1) : 0);

    display.fillCircle(Lx, ey, EYE_R, SSD1306_WHITE);
    display.fillCircle(Rx, ey, EYE_R, SSD1306_WHITE);

    if (blinkState && !think) {
        display.fillRect(Lx - EYE_R, ey - 1, EYE_R * 2, 2, SSD1306_WHITE);
        display.fillRect(Rx - EYE_R, ey - 1, EYE_R * 2, 2, SSD1306_WHITE);
    } else {
        int px = rnd(gazeX);
        int py = think ? -3 : rnd(gazeY);
        if (py < -3) py = -3; else if (py > 3) py = 3;
        display.fillCircle(Lx + px, ey + py, 3, SSD1306_BLACK);
        display.fillCircle(Rx + px, ey + py, 3, SSD1306_BLACK);
        display.drawPixel(Lx + px - 1, ey + py - 1, SSD1306_WHITE);
        display.drawPixel(Rx + px - 1, ey + py - 1, SSD1306_WHITE);
    }
}

// Boca: en reposo una sonrisa suave; hablando, se abre siguiendo el audio y
// baja/crece con la ponderación `mouthOpen` (0..10). No existe en "pensando".
static void drawMouth(int ox) {
    if (currentFace == IviFace::PROCESSING) return;

    int mx = MOUTH_X + ox;
    int my = MOUTH_Y + (talking ? (int)(talkPhase & 1) : 0);
    int op = talking ? (int)mouthOpen : 0;

    if (op <= 1) {
        display.drawLine(mx - 5, my, mx - 3, my - 1, SSD1306_WHITE);
        display.drawLine(mx - 3, my - 1, mx + 3, my - 1, SSD1306_WHITE);
        display.drawLine(mx + 3, my - 1, mx + 5, my, SSD1306_WHITE);
        return;
    }

    int w = 8 + op * 2;          // 12..28
    int h = 2 + op;              // 4..12
    display.fillRoundRect(mx - w / 2, my - 2, w, h, 2, SSD1306_WHITE);
}

static void drawBatteryIcon() {
    // esquina superior derecha; fuera de la zona de la cara (x<=95). El
    // balanceo lateral maximo deja los ojos en x<=84, no pisa este icono.
    int bx = 92, by = 2, bw = 17, bh = 8;
    if (!batteryPresent()) {
        // sin modulo: contorno + texto "USB" (alimentando por cable, sin sensor)
        display.drawRect(bx, by, bw, bh, SSD1306_WHITE);
        display.fillRect(bx + bw, by + 2, 2, bh - 4, SSD1306_WHITE);   // terminal
        display.setCursor(bx - 26, by + 1);
        display.print("USB");
        return;
    }
    int pct = batteryPercent();
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;

    // numero a la izquierda del icono (ancho ~2 chars)
    char s[4];
    snprintf(s, sizeof(s), "%d", pct);
    display.setCursor(bx - 3 - 5 * (int)strlen(s), by + 1);
    display.print(s);

    // contorno de bateria
    display.drawRect(bx, by, bw, bh, SSD1306_WHITE);
    display.fillRect(bx + bw, by + 2, 2, bh - 4, SSD1306_WHITE);   // terminal

    // barras interiores de llenado
    int segs = 28;   // pasito fino del llenado
    int fill = pct * segs / 100;
    if (fill > segs) fill = segs;
    for (int i = 0; i < fill; i++) {
        int x = bx + 1 + (i * (bw - 2)) / segs;
        display.fillRect(x, by + 1, 1, bh - 2, SSD1306_WHITE);
    }

    if (batteryCharging()) {
        display.fillTriangle(bx + 4, by + 1, bx + 9, by + 1, bx + 6, by + 3, SSD1306_BLACK);
        display.fillTriangle(bx + 4, by + bh - 2, bx + 9, by + bh - 2, bx + 6, by + bh - 4, SSD1306_BLACK);
        display.drawLine(bx + 5, by + 3, bx + 7, by + 5, SSD1306_WHITE);
    }
}

static void drawFace() {
    display.clearDisplay();

    if (bootMode) {
        if (bootCountdown >= 0) {
            char s[4];
            snprintf(s, sizeof(s), "%d", bootCountdown < 0 ? 0 : bootCountdown);
            display.setTextSize(2);
            int16_t x1, y1;
            uint16_t w, h;
            display.getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
            display.setCursor((SCREEN_WIDTH - w) / 2, 16);
            display.print(s);
            display.setTextSize(1);
            if (txt1[0]) { display.setCursor(0, 44); display.print(txt1); }
            if (txt2[0]) { display.setCursor(0, 54); display.print(txt2); }
            drawBatteryIcon();
            display.display();
            return;
        }

        // Pantalla de "despertando de la siesta": ojos cerrados + zZz animado
        // auto-timed por millis() y dos lineas de texto al centro.
        display.drawLine(44, 26, 54, 26, SSD1306_WHITE);   // ojito izquierdo
        display.drawLine(74, 26, 84, 26, SSD1306_WHITE);   // ojito derecho

        int zf = (millis() / 450) % 3;
        if (zf == 0) {
            display.setCursor(12, 22); display.print('z');
        } else if (zf == 1) {
            display.setCursor(8, 14);  display.print('z');
            display.setCursor(20, 22); display.print('z');
        } else {
            display.setCursor(2, 6);   display.print('z');
            display.setCursor(14, 14); display.print('z');
            display.setCursor(26, 22); display.print('z');
        }

        if (!textVisible) { display.display(); return; }
        display.setCursor(0, 34);
        if (txt1[0]) display.print(txt1);
        display.setCursor(0, 44);
        if (txt2[0]) display.print(txt2);
        drawBatteryIcon();
        display.display();
        return;
    }

    int ox = talking ? swayX : 0;
    drawFaceFeatures(ox);
    drawMouth(ox);

    if (processing) {
        // puntos animados abajo a la derecha
        for (int i = 0; i < 3; i++) {
            int px = 96 + i * 8;
            if (i < dotFrame) display.fillCircle(px, 61, 2, SSD1306_WHITE);
        }
    }

    if (showTextBox && textVisible) {
        display.setCursor(0, 0);
        if (txt1[0]) display.print(txt1);
        display.setCursor(0, 10);
        if (txt2[0]) display.print(txt2);
    }
    drawBatteryIcon();
    display.display();
}

void oledShowFace(IviFace face) {
    bootMode = false;
    bootCountdown = -1;
    currentFace = face;
    if (face != IviFace::PROCESSING) processing = false;
    showTextBox = false;
    if (!talking) { swayX = 0; swayPhase = 0; }
    drawFace();
}

void oledShowProcessing(bool on) {
    bootMode = false;
    bootCountdown = -1;
    processing = on;
    if (on) { talking = false; blinkState = false; swayX = 0; }
    showTextBox = false;
    drawFace();
}

void oledShowText(const char* line1, const char* line2) {
    bootMode = false;
    snprintf(txt1, sizeof(txt1), "%s", line1 ? line1 : "");
    snprintf(txt2, sizeof(txt2), "%s", line2 ? line2 : "");
    showTextBox = true;
    textVisible = true;
    display.clearDisplay();
    display.setCursor(0, 0);
    if (txt1[0]) display.print(txt1);
    display.setCursor(0, 10);
    if (txt2[0]) display.print(txt2);
    display.display();
}

void oledShowBoot(const char* line1, const char* line2) {
    bootMode = true;
    bootCountdown = -1;   // vuelve al modo zZz (no countdown)
    processing = false;
    talking = false;
    showTextBox = true;
    textVisible = true;
    snprintf(txt1, sizeof(txt1), "%s", line1 ? line1 : "");
    snprintf(txt2, sizeof(txt2), "%s", line2 ? line2 : "");
    drawFace();
}

void oledShowCountdown(int segsLeft) {
    if (!panelReady) return;
    bootMode = true;
    processing = false;
    bootCountdown = segsLeft < 0 ? 0 : segsLeft;
    drawFace();
}

void oledBootTick() {
    if (!panelReady || !bootMode) return;
    drawFace();
}

static void oledSendCmd(uint8_t cmd) {
    Wire.beginTransmission(OLED_ADDR);
    Wire.write(0x00);
    Wire.write(cmd);
    Wire.endTransmission();
}

static void oledSendCmd2(uint8_t cmd, uint8_t arg) {
    Wire.beginTransmission(OLED_ADDR);
    Wire.write(0x00);
    Wire.write(cmd);
    Wire.write(arg);
    Wire.endTransmission();
}

void oledTestScreen(bool on) {
    if (on) {
        oledSendCmd2(0x8D, 0x14);
        oledSendCmd(0xAF);
        delay(5);
        display.clearDisplay();
        display.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, SSD1306_WHITE);
        display.display();
    } else {
        oledSendCmd(0xAE);
        display.clearDisplay();
        display.display();
    }
}

void oledLoop() {
    unsigned long now = millis();
    if (now - lastBattPoll >= BATTERY_POLL_MS) {
        lastBattPoll = now;
        batteryPoll();
        drawFace();
    }

    if (currentFace == IviFace::PROCESSING) {
        // pensando: solo los puntos; los ojos quedan mirando arriba.
        if (now - lastDot > 350) {
            lastDot = now;
            dotFrame = (dotFrame + 1) % 4;
            drawFace();
        }
        return;
    }

    if (talking) return;   // la animacion de habla la avanza audioPlayBytes

    // parpadeo natural de la cara unica: intervalo variable 2.0..3.7s
    uint32_t interval = 2000 + animRng() % 1700;
    if (!blinkState && now - lastBlink > interval) {
        blinkState = true;
        lastBlink = now;
        drawFace();
    } else if (blinkState && now - lastBlink > 150) {
        blinkState = false;
        drawFace();
    }

    // mirada que pasea en reposo: solo repinta si la pupila se movio >=1px
    gazeStep();
    int px = rnd(gazeX), py = rnd(gazeY);
    if (px != lastPx || py != lastPy) {
        lastPx = px; lastPy = py;
        drawFace();
    }
}

void oledShowTalking(bool on) {
    if (!panelReady) { talking = false; return; }
    talking = on;
    mouthF = 0; mouthOpen = 0;
    swayPhase = 0; swayX = 0;
    if (on) gazeRetarget();
    drawFace();
}

void oledTalkTick() {
    if (!panelReady || !talking) return;
    unsigned long now = millis();
    if (now - lastTalkTick < 95) return;
    lastTalkTick = now;
    talkPhase++;

#if DEBUG_TALK
    static uint32_t lastTalkLog = 0;
    if (now - lastTalkLog >= 500) {
        lastTalkLog = now;
        Serial.printf("[talk] it=%u mouth=%u sway=%d env=%d\n",
                      (unsigned)talkPhase, (unsigned)mouthOpen, swayX,
                      (int)speechLevel);
    }
#endif

    // 1) boca: sigue el nivel de voz real, pero con un PISO de ritmo silabico
    //    para que nunca quede quieta mientras habla (aun en micro-silencios).
    uint8_t rhythm = (uint8_t)(1 + (animRng() & 3));        // 1..4
    float target = speechLevel > rhythm ? (float)speechLevel : (float)rhythm;
    mouthF += (target - mouthF) * 0.6f;
    mouthOpen = (uint8_t)(mouthF + 0.5f);
    if (mouthOpen > 10) mouthOpen = 10;

    // 2) balanceo lateral: SIEMPRE >=2px al hablar; crece y acelera con la voz
    swayPhase += 0.5 + speechLevel * 0.04;
    double amp = 2.0 + speechLevel * 0.6;                   // 2..8 px
    swayX = (int)(sin(swayPhase) * amp);

    // 3) pupilas vivas mientras habla
    gazeStep();

    // 4) parpadeo natural
    if (!blinkState && now - lastBlink > (1400 + animRng() % 1600)) {
        blinkState = true;
        lastBlink = now;
    } else if (blinkState && now - lastBlink > 130) {
        blinkState = false;
    }

    drawFace();
}

void oledSetSpeechLevel(uint8_t level) {
    if (level > 10) level = 10;
    speechLevel = level;
}

// El timer maneja TODA la animacion de la fase de turno: pensando u ociosos
// -> oledLoop(); hablando -> oledTalkTick(). Un solo escritor de I2C a la vez
// (la tarea principal esta bloqueada en audio/red mientras corre).
static TimerHandle_t animTimer = nullptr;

static void animTimerCb(TimerHandle_t t) {
    (void)t;
    if (talking) oledTalkTick();
    else         oledLoop();
}

void oledAnimStart() {
    if (!panelReady) return;
    if (animTimer == nullptr) {
        animTimer = xTimerCreate("anim", pdMS_TO_TICKS(90), pdTRUE, (void*)0, animTimerCb);
    }
    if (animTimer && xTimerIsTimerActive(animTimer) != pdTRUE) {
        xTimerStart(animTimer, 0);
    }
}

void oledAnimStop() {
    if (animTimer && xTimerIsTimerActive(animTimer) == pdTRUE) {
        xTimerStop(animTimer, 0);
    }
}