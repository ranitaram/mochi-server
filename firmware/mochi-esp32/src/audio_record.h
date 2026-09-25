#ifndef AUDIO_RECORD_H
#define AUDIO_RECORD_H

#include <Arduino.h>

// Graba en PSRAM un WAV mono 16kHz/16bit mientras "shouldStop" devuelva
// false. Al terminar devuelve la longitud total (con cabecera WAV) y
// llena *outBuffer. Devuelve 0 si no se grabo audio util.
//
// Usa UN periferico I2S (I2S_NUM_0) en modo RX via API legacy (driver/i2s.h),
// la misma que ESP8266Audio, para evitar abortos por coexistencia de drivers.
// El driver se instala aqui y se desinstala antes de reproducir.
size_t audioRecordWav(uint8_t** outBuffer, bool (*shouldStop)(void) = nullptr);

// TEST_MIC: graba una rafaga fija de N segundos (sin callback) y devuelve WAV en PSRAM.
size_t audioRecordFixed(uint8_t** outBuffer, int seconds);

// PROBE STEREO (diagnostico TEST_MIC): pico de cada slot (L/R). Para aislar
// si el silencio es por slot desalineado o por cableado/reloj.
size_t probeMicStereo(int seconds, long* outPeakL, long* outPeakR);

// ESCANEO DE PINES (diagnostico): barre GPIOs candidatos como DIN y reporta
// pico en cada uno, para localizar el pin fisico real del SD del INMP441.
void scanMicDins();

// PROBE ACTIVIDAD BCLK/WS (diagnostico): verifica que el reloj I2S realmente
// togglea en GPIO5/GPIO6 cuando el canal RX MASTER esta activo.
void probeClockActivity();

// DUMP FORMA DE ONDA (diagnostico): graba ~1.5s, extrae slot L y vuelca
// metricas + window del medio para distinguir voz real de crosstalk.
void dumpMicWaveform();

// PROBE CONFIGS DE SLOT (diagnostico): barre variantes de fase/alineacion
// (ws_pol, ws_inv, bit_shift) para aislar si el problema es de fase WS.
void probeSlotConfigs();

// VOLCADO CRUDO 32-BIT (diagnostico): vuelca el word int32 de los slots L/R
// en hex para discriminar 'pin sin dato' vs 'dato mal decodificado'.
void dumpRawFrame();

// PROBE AMBOS SLOTS (diagnostico): metricas L/R de senal vs crosstalk.
void probeSlotBoth();

// PROBE DATA SHIFT (diagnostico): prueba >>8/16/24 sobre slot L.
void probeDataShift();
void probeDinDC();
void probeMonoRecord();
void probeMonoWavDump();

#endif
