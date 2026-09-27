#include "audio_play.h"
#include "config.h"
#include "oled_display.h"
#include <driver/i2s_std.h>
#include <driver/i2s_common.h>
#include <driver/gpio.h>
#include <string.h>
#include <stdio.h>

#include "esp8266audio/AudioOutput.h"
#include "esp8266audio/AudioFileSource.h"
#include "esp8266audio/AudioGeneratorMP3.h"

// ------------------------------------------------------------------
//  Envolvente del nivel de voz: la boca del OLED sigue el audio REAL que se
//  decodifica. ConsumeSample() actualiza una envolvente aca (attack rapido /
//  release lento) y la inyecta via oledSetSpeechLevel() solamente cuando
//  cambia. Es barato (~44k llamadas/s, una suma y dos mul), no toca el I2S.
// ------------------------------------------------------------------
static float speechEnv = 0.0f;
static uint8_t speechEnvLevel = 0;

static void speechEnvUpdate(int16_t l, int16_t r) {
    int32_t a = l; if (a < 0) a = -a;
    int32_t b = r; if (b < 0) b = -b;
    float m = (float)(a + b) * (10.0f / 65536.0f);   // 0..10 aprox
    if (m > speechEnv) speechEnv += (m - speechEnv) * 0.35f;
    else               speechEnv += (m - speechEnv) * 0.08f;
    uint8_t lvl = (uint8_t)speechEnv;
    if (lvl > 10) lvl = 10;
    if (lvl != speechEnvLevel) { speechEnvLevel = lvl; oledSetSpeechLevel(lvl); }
}

// UN solo periferico I2S (I2S_NUM_0) y UN solo driver (i2s_std - nuevo).
// RECONCILIACION: antes la bocina TX usaba el driver LEGACY (i2s_driver_install
// + AudioOutputI2S de ESP8266Audio), lo que abortaba al arrancar ("new i2s
// driver can't work along with the legacy") si el mic ya habia creado su canal
// std. Ahora todo TX va tambien por el driver nuevo i2s_std, igual que el RX
// del mic. La ruta MP3 usa AudioOutputI2SStd (subclase de AudioOutput que
// escribe por i2s_channel_write, NUNCA por el driver legacy).
#define I2S_PORT I2S_NUM_0

static i2s_chan_handle_t spkTxChan = nullptr;

// Abre el canal TX std con la tasa y modalidad pedidas. Reabre sin duplicar.
static bool pcmTxOpen(uint32_t rate, bool stereo) {
    if (spkTxChan) return true;

    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT,
                                                            I2S_ROLE_MASTER);
    if (i2s_new_channel(&chan_cfg, &spkTxChan, NULL) != ESP_OK) {
        Serial.println("[spk] TX new_channel FAIL");
        return false;
    }

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(rate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_16BIT,
            stereo ? I2S_SLOT_MODE_STEREO : I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)SPK_BCK,
            .ws = (gpio_num_t)SPK_WS,
            .dout = (gpio_num_t)SPK_DOUT,
            .din = I2S_GPIO_UNUSED,
            .invert_flags = {
                .mclk_inv = false, .bclk_inv = false, .ws_inv = false,
            },
        },
    };

    esp_err_t ei = i2s_channel_init_std_mode(spkTxChan, &std_cfg);
    if (ei != ESP_OK) {
        Serial.printf("[spk] TX init_std err=%d %s\n", ei, esp_err_to_name(ei));
        return false;
    }
    esp_err_t es = i2s_channel_enable(spkTxChan);
    if (es != ESP_OK) {
        Serial.printf("[spk] TX enable err=%d %s\n", es, esp_err_to_name(es));
        return false;
    }
    Serial.printf("[spk] i2s_std TX listo (bclk=%d ws=%d dout=%d) @%uHz %s\n",
                  SPK_BCK, SPK_WS, SPK_DOUT, (unsigned)rate,
                  stereo ? "stereo" : "mono");
    return true;
}

static void pcmTxClose() {
    if (spkTxChan) {
        i2s_channel_disable(spkTxChan);
        i2s_del_channel(spkTxChan);
        spkTxChan = nullptr;
    }
}

// Escribe `n` muestras int16 (mono o interleaved) al canal TX. Bloquea hasta
// completar o error. Devuelve cuantas muestras logro escribir.
static size_t pcmWriteAll(const int16_t* pcm, size_t n) {
    size_t written = 0;
    while (written < n) {
        size_t w = 0;
        esp_err_t err = i2s_channel_write(spkTxChan, pcm + written,
                                          (n - written) * 2, &w,
                                          pdMS_TO_TICKS(200));
        if (err != ESP_OK) {
            Serial.printf("[spk] TX write err=%d %s\n", err, esp_err_to_name(err));
            break;
        }
        written += w / 2;
    }
    return written;
}

// ------------------------------------------------------------------
//  AudioOutputI2SStd: salida estandar de ESP8266Audio -> i2s_std (nuevo driver).
//  El decoder llama begin()/ConsumeSample()/stop(). Bufferea pares estéreo y
//  los vacia con pcmWriteAll. SetRate() reabre el canal si cambia la tasa
//  (p.ej. al descubrir el primer frame MP3).
// ------------------------------------------------------------------
class AudioOutputI2SStd : public AudioOutput {
  public:
    AudioOutputI2SStd() {
        hertz = 44100;
        bps = 16;
        channels = 2;
        gainF2P6 = 64;   // ganancia 1.0
        nBuf = 0;
    }

    bool SetRate(int hz) override {
        if (hz <= 0) return false;
        if (hz != hertz) {
            hertz = hz;
            pcmTxClose();          // fuerza reapertura a la nueva tasa
        }
        return true;
    }

    bool begin() override {
        return pcmTxOpen(hertz, true);
    }

    bool ConsumeSample(int16_t sample[2]) override {
        speechEnvUpdate(sample[0], sample[1]);
        return ConsumeFrame(sample);
    }

    bool stop() override {
        flushBuf();
        pcmTxClose();
        return true;
    }

    void flush() override {
        flushBuf();
    }

  private:
    bool ConsumeFrame(int16_t sample[2]) {
        if (!spkTxChan) {
            if (!pcmTxOpen(hertz, true)) return false;
        }
        buf[nBuf++] = sample[0];
        buf[nBuf++] = sample[1];
        if (nBuf >= (int)sizeof(buf) / sizeof(buf[0])) flushBuf();
        return true;
    }

    void flushBuf() {
        if (nBuf > 0) {
            pcmWriteAll(buf, nBuf);
            nBuf = 0;
        }
    }

    int16_t buf[512];
    int nBuf;
};

// ------------------------------------------------------------------
//  MemAudioSource: fuente de audio en RAM para audioPlayBytes (la respuesta
//  HTTP vive en RAM/PSRAM; el decoder solo la lee).
// ------------------------------------------------------------------
class MemAudioSource : public AudioFileSource {
  public:
    MemAudioSource(const uint8_t* d, uint32_t sz)
        : data(d), size(sz), pos(0) {}

    uint32_t read(void* target, uint32_t len) override {
        if (pos >= size) return 0;
        uint32_t avail = (uint32_t)(size - pos);
        if (len < avail) avail = len;
        memcpy(target, data + pos, avail);
        pos += avail;
        return avail;
    }

    bool seek(int32_t off, int dir) override {
        int32_t np = (dir == SEEK_SET) ? off
                   : (dir == SEEK_CUR) ? (int32_t)pos + off
                                       : (int32_t)size + off;
        if (np < 0) np = 0;
        if ((uint32_t)np > size) np = (int32_t)size;
        pos = (uint32_t)np;
        return true;
    }

    bool isOpen() override { return true; }
    uint32_t getSize() override { return size; }
    uint32_t getPos() override { return pos; }
    bool close() override { return true; }

  private:
    const uint8_t* data;
    uint32_t size;
    uint32_t pos;
};

// TEST_ALL: reproduce el WAV grabado (cabecera 44 bytes + PCM 16kHz mono) en
// loop-back. El mic INMP441 entrega niveles bajos al hablar normal (raw ~+-200
// de la escala int16), por eso se aplica una ganancia fija x8 con clamp; sin
// ella la voz es inaudible. Usa TX std; NO debe haber RX activo al llamarse
// (audioRecordWav ya hizo micRxDeinit).
void audioPlayWavLoopback(uint8_t* wav, size_t len) {
    if (len <= 44) return;
    if (!pcmTxOpen(REC_SAMPLE_RATE, false)) return;
    const int16_t* pcm = (const int16_t*)(wav + 44);
    size_t n = (len - 44) / 2;
    for (size_t i = 0; i < n; i++) {
        int32_t v = (int32_t)pcm[i] * 8;
        if (v > 32767) v = 32767;
        else if (v < -32768) v = -32768;
        ((int16_t*)wav)[44 / 2 + i] = (int16_t)v;
    }
    pcmWriteAll(pcm, n);
    Serial.printf("[spk] PLAY %u/%u samples\n", (unsigned)n, (unsigned)n);
    pcmTxClose();
}

// TEST_AMP: reproduce un tono PCM generado por codigo (440Hz, ~3s) por la bocina.
void audioPlayTone() {
    audioPlayToneMs(3000);
}

// Reproduce un tono de 440Hz durante `durationMs` por la bocina.
void audioPlayToneMs(uint32_t durationMs) {
    static int16_t chunk[512];
    if (!pcmTxOpen(REC_SAMPLE_RATE, false)) return;
    const double freq = 440.0;
    double phase = 0.0;
    const double twoPi = 2.0 * 3.14159265358979;
    const double inc = twoPi * freq / REC_SAMPLE_RATE;
    const size_t CHUNK = sizeof(chunk) / sizeof(chunk[0]);
    unsigned long t0 = millis();
    while (millis() - t0 < durationMs) {
        for (size_t i = 0; i < CHUNK; i++) {
            chunk[i] = (int16_t)(sin(phase) * 8000.0);
            phase += inc;
            if (phase > twoPi) phase -= twoPi;
        }
        pcmWriteAll(chunk, CHUNK);
    }
    pcmTxClose();
}

// ------------------------------------------------------------------
//  Ruta MP3 (NORMAL): decoder ESP8266Audio + salida i2s_std.
//  RECONCILIADO: el decoder apenas lee del buffer y alimenta
//  AudioOutputI2SStd, que escribe por i2s_channel_write (driver nuevo).
//  NO se toca el driver legacy (no se instancia AudioOutputI2S).
// ------------------------------------------------------------------
void audioPlayInit() {
    Serial.println("[audio] Ruta MP3 lista: AudioOutputI2SStd + i2s_std");
}

void audioPlayBytes(const uint8_t* data, size_t len) {
    if (!data || len == 0) {
        Serial.println("[audio] MP3 descartado: buffer vacio.");
        return;
    }
    Serial.printf("[audio] MP3 %u bytes. Decodificando...\n", (unsigned)len);
    MemAudioSource mem(data, len);
    AudioOutputI2SStd out;
    AudioGeneratorMP3 mp3;
    if (!mp3.begin(&mem, &out)) {
        Serial.println("[audio] MP3 begin FAIL.");
        return;
    }
    // Mientras suena el MP3, mueve la boca y parpadea en el OLED. audioPlayBytes
    // es bloqueante (loop() no corre), asi que la animacion se avanza aqui.
    oledShowTalking(true);
    uint32_t iterations = 0;
    uint32_t twas = 0;
    uint32_t t0 = millis();
    while (mp3.isRunning() && mp3.loop()) {
        iterations++;
        if ((iterations & 0x7FF) == 0) {
            Serial.printf("[audio] dec iter=%u t=%ums mem=%u/%u\n",
                          (unsigned)iterations, (unsigned)(millis() - t0),
                          (unsigned)mem.getPos(), (unsigned)mem.getSize());
            yield();
        }
        unsigned long nowT = millis();
        if (nowT - twas >= 120) {
            twas = nowT;
            oledTalkTick();
            yield();
        }
    }
    oledShowTalking(false);
    mp3.stop();
    out.stop();
    Serial.println("[audio] MP3 reproducido.");
}