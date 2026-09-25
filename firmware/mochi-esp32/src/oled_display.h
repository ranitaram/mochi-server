#ifndef OLED_DISPLAY_H
#define OLED_DISPLAY_H

#include <Arduino.h>

enum class IviFace {
    NEUTRAL,
    HAPPY,
    SORPRENDIDO,
    BURLON,
    PENSATIVO,
    ENOJADO,
    PROCESSING   // pensativo + puntos animados
};

void oledInit();
void oledShowFace(IviFace face);
void oledShowProcessing(bool on);
void oledShowText(const char* line1, const char* line2 = nullptr);
void oledShowBoot(const char* line1, const char* line2 = nullptr);
void oledBootTick();
void oledTestScreen(bool on);   // pantalla completa blanca (on) o negra (off)
void oledLoop();   // llama periodicamente para animar parpadeo/puntos

// Animacion de "hablando": oledShowTalking(true) antes de reproducir audio y
// oledTalkTick() cada ~120ms durante la reproduccion para mover la boca y
// parpadear de forma natural. oledShowTalking(false) al terminar.
void oledShowTalking(bool on);
void oledTalkTick();

#endif
