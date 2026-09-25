#include "self_test.h"
#include "config.h"
#include "wifi_manager.h"
#include "http_client.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <esp_heap_caps.h>
#include <string.h>

static bool waitForWifi(unsigned long timeoutMs) {
    unsigned long t0 = millis();
    while (millis() - t0 < timeoutMs) {
        wifiLoop();
        if (wifiConnected()) return true;
        delay(100);
    }
    return false;
}

// Genera un WAV mono 16kHz/16bit de la duracion dada (muestras en silencio).
static uint8_t* makeSilentWav(size_t seconds, size_t* outLen) {
    uint32_t sampleRate = REC_SAMPLE_RATE;
    uint32_t pcmBytes = seconds * sampleRate * 2;
    uint32_t wavBytes = pcmBytes + 44;

    uint8_t* buf = (uint8_t*)heap_caps_malloc(wavBytes, MALLOC_CAP_SPIRAM);
    if (!buf) return nullptr;

    memcpy(buf, "RIFF", 4);
    uint32_t total = pcmBytes + 36;
    buf[4] = total & 0xFF; buf[5] = (total >> 8) & 0xFF;
    buf[6] = (total >> 16) & 0xFF; buf[7] = (total >> 24) & 0xFF;
    memcpy(buf + 8, "WAVEfmt ", 8);
    buf[16] = 16; buf[17] = 0; buf[18] = 0; buf[19] = 0;
    buf[20] = 1; buf[21] = 0;              // PCM
    buf[22] = 1; buf[23] = 0;              // mono
    buf[24] = sampleRate & 0xFF; buf[25] = (sampleRate >> 8) & 0xFF;
    buf[26] = (sampleRate >> 16) & 0xFF; buf[27] = (sampleRate >> 24) & 0xFF;
    uint32_t byteRate = sampleRate * 2;
    buf[28] = byteRate & 0xFF; buf[29] = (byteRate >> 8) & 0xFF;
    buf[30] = (byteRate >> 16) & 0xFF; buf[31] = (byteRate >> 24) & 0xFF;
    buf[32] = 2; buf[33] = 0;              // block align
    buf[34] = 16; buf[35] = 0;             // bits per sample
    memcpy(buf + 36, "data", 4);
    buf[40] = pcmBytes & 0xFF; buf[41] = (pcmBytes >> 8) & 0xFF;
    buf[42] = (pcmBytes >> 16) & 0xFF; buf[43] = (pcmBytes >> 24) & 0xFF;
    memset(buf + 44, 0, pcmBytes);         // silencio

    *outLen = wavBytes;
    return buf;
}

void selfTestRun() {
    Serial.println("\n===== SELF-TEST (validacion sin piezas) =====");

    // 1) WiFi
    if (!waitForWifi(45000)) {
        Serial.printf("[test] FALLO: no se conecto a WiFi en 45s (status=%d)\n",
                      WiFi.status());
        // Escaneo para diagnosticar: la red objetivo esta visible? con que fuerza?
        Serial.println("[test] Escaneo sincrono de redes visibles...");
        WiFi.disconnect();
        int n = WiFi.scanNetworks(true);   // true = sincrono (bloquea hasta terminar)
        if (n < 0) {
            Serial.printf("[test] Escaneo fallo (codigo %d): radio WiFi sin respuesta del clon.\n", n);
        } else {
            for (int i = 0; i < n && i < 15; i++) {
                Serial.printf("[test]   %s  RSSI=%d dBm  ch=%d\n",
                              WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i));
            }
            Serial.printf("[test] Escaneo: %d redes visibles.\n", n);
        }
        WiFi.scanDelete();
        return;
    }
    Serial.printf("[test] OK  WiFi conectado: IP=%s RSSI=%d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());

    // 2) Health check
    int health = httpGetHealth();
    if (health == 200) {
        Serial.println("[test] OK  GET /health -> 200 (servidor arriba)");
    } else {
        Serial.printf("[test] AVISO GET /health -> %d (revisa server/IP/puerto)\n", health);
    }

    // 3) POST con WAV de silencio
    size_t wavLen = 0;
    uint8_t* wav = makeSilentWav(1, &wavLen);
    if (!wav) {
        Serial.println("[test] FALLO: no hay PSRAM para el WAV de prueba");
        return;
    }
    Serial.printf("[test] Enviando WAV de silencio (%u bytes) a POST /api/touch...\n",
                  (unsigned)wavLen);

    IviReply reply;
    int code = httpSendAudio(wav, wavLen, reply);
    httpClientFree(reply);
    free(wav);

    if (code > 0) {
        // 200 = transcribio y respondio; 400/422 = el servidor proceso pero no
        // hubo voz. Cualquiera confirma el transporte end-to-end.
        Serial.printf("[test] OK  POST /api/touch -> HTTP %d (transporte end-to-end OK)\n", code);
        if (code == HTTP_CODE_OK) {
            Serial.printf("[test]      Respuesta MP3 de %u bytes, emocion=%s\n",
                          (unsigned)reply.audioLen, reply.emocion);
        }
    } else {
        Serial.printf("[test] FALLO POST /api/touch -> HTTP %d (conexion al servidor fallo)\n", code);
    }

    Serial.println("===== SELF-TEST FIN =====");
}
