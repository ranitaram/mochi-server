#include "oled_display.h"
#include <Arduino.h>
#include <Wire.h>
#include <string.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "config.h"
#include "faces.h"
#include "battery.h"

#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
#define OLED_ADDR     0x3C

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
static bool talking = false;
static uint8_t mouthLevel = 0;
static unsigned long lastTalkTick = 0;
static uint16_t talkPhase = 0;
static unsigned long lastBattPoll = 0;
static bool bootMode = false;
static int bootCountdown = -1;   // >=0: modo "esperando al server" con numero

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
    // Animaciones continuas (boca/parpadeo) re-dibujan el frame a ~9fps;
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
}

static void putBitmap(const unsigned char* bmp, int offsetX = 0, int offsetY = 0) {
    // caras 64x48 centradas; el contenido real (ojos/boca) empieza ~5px
    // dentro del bitmap, asi que restamos 5 para subir la cara y centrarla.
    int x = (SCREEN_WIDTH - 64) / 2 + offsetX;
    int y = (SCREEN_HEIGHT - 48) / 2 - 5 + offsetY;
    display.drawBitmap(x, y, bmp, 64, 48, SSD1306_WHITE);
}

// Regiones de la boca en coordenadas de pantalla (cara centrada: x=32..95, y=3..50).
// HAPPY tiene la sonrisa ancha (bw=41), SORPRENDIDO la "o" vertical, PENSATIVO
// solo puntos: la caja sirve para borrar la boca estatica y re-dibujarla animada.
struct MouthBox { int x, y, w, h; };

static const MouthBox& currentMouthBox() {
    static const MouthBox mNeutral     = {54, 40, 21, 4};
    static const MouthBox mHappy       = {44, 41, 41, 8};
    static const MouthBox mSurprised   = {59, 37, 12, 12};
    static const MouthBox mBurla       = {52, 35, 31, 7};
    static const MouthBox mThink       = {56, 41, 17, 3};
    static const MouthBox mAngry       = {56, 41, 17, 4};
    switch (currentFace) {
        case IviFace::HAPPY:       return mHappy;
        case IviFace::SORPRENDIDO: return mSurprised;
        case IviFace::BURLON:      return mBurla;
        case IviFace::PENSATIVO:   return mThink;
        case IviFace::ENOJADO:     return mAngry;
        case IviFace::NEUTRAL:
        default:                   return mNeutral;  // incluye PROCESSING
    }
}

static void drawTalkingMouth() {
    if (!talking) return;
    const MouthBox& m = currentMouthBox();
    int cx = m.x + m.w / 2;
    int bot = m.y + m.h;
    display.fillRect(m.x, m.y, m.w, m.h, SSD1306_BLACK);
    switch (mouthLevel) {
        case 0: display.fillRect(cx - 3,  bot - 1, 7,  1, SSD1306_WHITE); break;
        case 1: display.fillRect(cx - 5,  bot - 2, 11, 2, SSD1306_WHITE); break;
        case 2: display.fillRoundRect(cx - 7,  bot - 3, 15, 3, 2, SSD1306_WHITE); break;
        case 3: display.fillRoundRect(cx - 9,  bot - 5, 19, 5, 3, SSD1306_WHITE); break;
        default: display.fillRoundRect(cx - 10, bot - 7, 21, 7, 4, SSD1306_WHITE); break;
    }
}

static void drawEyes() {
    // borra los ojos grandes del bitmap y los re-dibuja mas chicos
    display.fillRect(40, 16, 18, 16, SSD1306_BLACK);
    display.fillRect(70, 16, 18, 16, SSD1306_BLACK);
    if (blinkState) {
        display.drawLine(44, 26, 54, 26, SSD1306_WHITE);
        display.drawLine(74, 26, 84, 26, SSD1306_WHITE);
    } else {
        display.fillCircle(49, 24, 2, SSD1306_WHITE);
        display.fillCircle(79, 24, 2, SSD1306_WHITE);
        display.drawPixel(47, 22, SSD1306_WHITE);
        display.drawPixel(77, 22, SSD1306_WHITE);
    }
}

static void drawEyebrows() {
    int y = 17;
    if (talking) y += (talkPhase & 1);
    int x1L = 41, x2L = 57, y0L = y, y1L = y;
    int x1R = 71, x2R = 87, y0R = y, y1R = y;
    switch (currentFace) {
        case IviFace::HAPPY:       y0L -= 2; y1L -= 2; y0R -= 2; y1R -= 2; break;
        case IviFace::SORPRENDIDO: y0L -= 4; y1L -= 4; y0R -= 4; y1R -= 4; break;
        case IviFace::BURLON:      y0L -= 3; y1L -= 2; break;
        case IviFace::PENSATIVO:   y0R -= 2; y1R -= 2; break;
        case IviFace::ENOJADO:     y1L += 2; y0R += 2; break;
        default: break;
    }
    display.drawLine(x1L, y0L, x2L, y1L, SSD1306_WHITE);
    display.drawLine(x1R, y0R, x2R, y1R, SSD1306_WHITE);
}

static void drawEars() {
    // orejas a los lados (aprovechando los margenes de pantalla)
    int wig = talking ? (int)(talkPhase & 1) : (int)((millis() / 650) & 1);
    int y = 27 + (wig ? 2 : 0);
    display.fillCircle(36, y, 6, SSD1306_WHITE);
    display.fillCircle(90, y, 6, SSD1306_WHITE);
    display.drawPixel(35, y - 1, SSD1306_BLACK);
    display.drawPixel(89, y - 1, SSD1306_BLACK);
}

static void drawBatteryIcon() {
    // esquina superior derecha; fuera de la zona de la cara (x<=95) y de las
    // orejas (x<=96). Persiste en todas las animaciones (~10fps).
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
    // ultima barra (borde derecho) puede quedar a 1px del margen; normal.

    if (batteryCharging()) {
        // rayo de carga sobre la bateria
        display.fillTriangle(bx + 4, by + 1, bx + 9, by + 1, bx + 6, by + 3, SSD1306_BLACK);
        display.fillTriangle(bx + 4, by + bh - 2, bx + 9, by + bh - 2, bx + 6, by + bh - 4, SSD1306_BLACK);
        display.drawLine(bx + 5, by + 3, bx + 7, by + 5, SSD1306_WHITE);
    }
}

static void drawFace() {
    display.clearDisplay();

    if (bootMode) {
        // Modo countdown: la Ivi despierta al servidor (Render duerme a los
        // 15 min) y muestra los segundos que faltan en grande, con textos.
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

        // Pantalla de "despertando de la siesta": ojos cerrados (asustados de
        // dormir), animacion zZz auto-timed por millis() y dos lineas de texto
        // al centro. Reemplaza la cara normal durante el boot del WiFi.
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

    switch (currentFace) {
        case IviFace::HAPPY:       putBitmap(&faceHappy[0][0]); break;
        case IviFace::SORPRENDIDO: putBitmap(&faceSurprised[0][0]); break;
        case IviFace::BURLON:      putBitmap(&faceBurla[0][0]); break;
        case IviFace::PENSATIVO:   putBitmap(&faceThink[0][0]); break;
        case IviFace::ENOJADO:     putBitmap(&faceAngry[0][0]); break;
        case IviFace::NEUTRAL:
        default:
            putBitmap(&faceNeutral[0][0]);
            break;
    }

    drawEyes();
    drawEyebrows();
    drawTalkingMouth();
    drawEars();

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
    currentFace = face;
    processing = false;
    showTextBox = false;
    drawFace();
}

void oledShowProcessing(bool on) {
    bootMode = false;
    processing = on;
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

// Pantalla de boot "despertando de la siesta": ojos cerrados + zZz animado
// + textos. Se usa durante el arranque (espera de WiFi). Al terminar, pasar
// a oledShowFace() (o oledShowText()) sale del modo boot.
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

// Cuenta regresiva del despertado del server: numero grande + textos (los
// mismos que haya seteado oledShowBoot()). Solo repinta cuando cambia el
// valor, para que el OLED no flaquee en cada poll.
void oledShowCountdown(int segsLeft) {
    if (!panelReady) return;
    bootMode = true;
    processing = false;
    bootCountdown = segsLeft < 0 ? 0 : segsLeft;
    drawFace();
}

// Repinta el frame de boot (la animacion zZz es auto-timed por millis()).
void oledBootTick() {
    if (!panelReady || !bootMode) return;
    drawFace();
}

// Envia un comando individual del controlador por I2C (para test directo
// del panel sin depender del buffer/GFX). Commando = byte con Co=0, D/C#=0.
static void oledSendCmd(uint8_t cmd) {
    Wire.beginTransmission(OLED_ADDR);
    Wire.write(0x00);   // control byte: siguiente byte = comando
    Wire.write(cmd);
    Wire.endTransmission();
}

static void oledSendCmd2(uint8_t cmd, uint8_t arg) {
    Wire.beginTransmission(OLED_ADDR);
    Wire.write(0x00);   // comando
    Wire.write(cmd);
    Wire.write(arg);
    Wire.endTransmission();
}

void oledTestScreen(bool on) {
    if (on) {
        // Habilitar charge-pump interno del SSD1306 (`0x8D 0x14`) y encender
        // el panel (`0xAF`). Sin el charge-pump, el panel no recibe voltaje
        // y queda oscuro aunque el controlador responda por I2C.
        oledSendCmd2(0x8D, 0x14);   // Enable charge pump (SSD1306)
        oledSendCmd(0xAF);          // Display ON (ignora contenido RAM)
        delay(5);
        display.clearDisplay();
        display.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, SSD1306_WHITE);
        display.display();
    } else {
        oledSendCmd(0xAE);          // Display OFF
        display.clearDisplay();
        display.display();
    }
}

void oledLoop() {
    unsigned long now = millis();
    if (now - lastBattPoll >= BATTERY_POLL_MS) {
        lastBattPoll = now;
        batteryPoll();
        drawFace();   // refresca el icono con el nuevo nivel
    }
    if (currentFace != IviFace::PROCESSING) {
        // parpadeo natural de cualquier cara: intervalo variable 2.0..3.4s
        unsigned long interval = 2000 + ((now >> 6) % 5) * 320;
        if (!blinkState && now - lastBlink > interval) {
            lastBlink = now;
            blinkState = true;
            drawFace();
        } else if (blinkState && now - lastBlink > 150) {
            blinkState = false;
            drawFace();
        }
    }
    if (processing) {
        if (now - lastDot > 350) {
            lastDot = now;
            dotFrame = (dotFrame + 1) % 4;
            drawFace();
        }
    }
    if (showTextBox && now - lastBlink > 4000) {
        // simple: nada, texto permanente es mas util
    }
}

// Inicia/suspende la animacion de "hablando". Se activa desde audioPlayBytes
// alrededor de la reproduccion del MP3 para mover la boca de la cara actual.
void oledShowTalking(bool on) {
    if (!panelReady) { talking = false; return; }
    talking = on;
    mouthLevel = 0;
    drawFace();
}

// Llamado ~cada 120ms durante la reproduccion de audio. Mueve la boca con un
// patron pseudoaleatorio tipo habla y parpadea de forma natural.
void oledTalkTick() {
    if (!panelReady || !talking) return;
    unsigned long now = millis();
    if (now - lastTalkTick < 100) return;
    lastTalkTick = now;

    static uint32_t rng = 0xA341316C;
    rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5;
    uint32_t m = rng & 31;
    mouthLevel = (m < 10) ? 0 : (m < 19) ? 1 : (m < 26) ? 2 : (m < 30) ? 3 : 4;
    talkPhase++;

    if (!blinkState && now - lastBlink > (2200 + (rng % 1600))) {
        blinkState = true;
        lastBlink = now;
    } else if (blinkState && now - lastBlink > 130) {
        blinkState = false;
    }

    drawFace();
}
