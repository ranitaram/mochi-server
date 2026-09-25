#ifndef AUDIO_PLAY_H
#define AUDIO_PLAY_H

#include <Arduino.h>

// Reproduce audio MP3 desde un buffer en memoria (PSRAM) hacia la
// bocina MAX98357 via I2S. Bloqueante hasta terminar.
void audioPlayInit();
void audioPlayBytes(const uint8_t* data, size_t len);

// TEST_ALL: reproduce un WAV grabado (PCM 16kHz mono) en loop-back, sin MP3.
void audioPlayWavLoopback(uint8_t* wav, size_t len);

// TEST_AMP: reproduce un tono de 440Hz por la bocina.
void audioPlayTone();
void audioPlayToneMs(uint32_t durationMs);   // tono 440Hz de duracion dada

#endif
