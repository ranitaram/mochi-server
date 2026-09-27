#ifndef OLED_DISPLAY_H
#define OLED_DISPLAY_H

#include <Arduino.h>

// Cara unica procedural (ojos + boca), sin bitmaps por emocion: toda la vida
// sale de la animacion (boca sync al audio real, balanceo lateral y mirada).
enum class IviFace {
    NEUTRAL,      // la cara unica (reposo / hablando)
    PROCESSING    // pensando + puntos animados
};

void oledInit();
void oledShowFace(IviFace face);
void oledShowProcessing(bool on);
void oledShowText(const char* line1, const char* line2 = nullptr);
void oledShowBoot(const char* line1, const char* line2 = nullptr);
void oledShowCountdown(int segsLeft);   // numero grande + textos, para esperar al server
void oledBootTick();
void oledTestScreen(bool on);   // pantalla completa blanca (on) o negra (off)
void oledLoop();   // llama periodicamente para animar parpadeo, mirada y puntos

// Animacion de "hablando": oledShowTalking(true) antes de reproducir audio y
// oledTalkTick() cada ~100ms durante la reproduccion. La boca sigue el nivel
// real de la voz que inyecta el decoder via oledSetSpeechLevel(0..10), el
// grupo ojos+boca se balancea L-R con el habla y las pupilas se pasean.
// oledShowTalking(false) al terminar.
void oledShowTalking(bool on);
void oledTalkTick();

// Nivel 0..10 de la voz que se esta decodificando (audio_play.cpp lo calcula
// en ConsumeSample y lo inyecta aqui; barato, solo re-dibuja en oledTalkTick).
void oledSetSpeechLevel(uint8_t level);

#endif