#include "audio_record.h"
#include "config.h"
#include <driver/i2s_std.h>
#include <driver/i2s_common.h>
#include <driver/gpio.h>
#include <esp_heap_caps.h>
#include <string.h>

// UN solo periferico I2S, reconfigurado segun la fase (RX mic / TX bocina).
// Durante el diagnostico TEST_MIC, la lectura RX usa el driver NUEVO i2s_std,
// que en ESP32-S3 si genera el reloj BCLK/WS del MASTER hacia el INMP441
// (el legacy no lo hace en RX -> el mic quedaba mudo). La bocina TX (que usa
// legacy/ESP8266Audio) esta temporalmente excluida del build (src_filter) para
// evitar el conflicto entre drivers. Se reconcilian al volver a NORMAL.
#define I2S_PORT I2S_NUM_0

static const int sampleRate = REC_SAMPLE_RATE;

static i2s_chan_handle_t micRxChan = nullptr;

static uint8_t* recordBuffer = nullptr;
static uint32_t recordCapacity = 0;

static bool micRxInit() {
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT,
                                                            I2S_ROLE_MASTER);
    if (i2s_new_channel(&chan_cfg, NULL, &micRxChan) != ESP_OK) {
        printf("[mic] new_channel FAIL\n");
        return false;
    }

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate),
        // IMPORTANTE (INMP441): trama I2S de 32 bits por canal en modo
        // STEREO -> 64 pulsos BCLK por frame (BCLK = 16k*64 = 1.024MHz).
        // Con 16-bit el BCLK es 512kHz y el mic queda desincronizado
        // (nunca emite datos utiles en SD). El modo MONO del driver solo
        // hara 32 BCLK/frame, tambien insuficiente.
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)MIC_BCK,
            .ws = (gpio_num_t)MIC_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = (gpio_num_t)MIC_DIN,
            .invert_flags = {
                .mclk_inv = false, .bclk_inv = false, .ws_inv = false,
            },
        },
    };

    esp_err_t ei = i2s_channel_init_std_mode(micRxChan, &std_cfg);
    if (ei != ESP_OK) {
        printf("[mic] init_std err=%d %s\n", ei, esp_err_to_name(ei));
        return false;
    }

    // L/R a GND = canal izquierdo (dato en slot L del frame stereo 32-bit).
    esp_err_t es = i2s_channel_enable(micRxChan);
    if (es != ESP_OK) {
        printf("[mic] enable err=%d %s\n", es, esp_err_to_name(es));
        return false;
    }
    // Fija el tri-state del pin SD (cuando el mic no maneja su slot) para
    // matar la oscilacion de acoplamiento que aparece en lecturas continuas.
    gpio_set_pull_mode((gpio_num_t)MIC_DIN, GPIO_PULLDOWN_ONLY);
    printf("[mic] i2s_std RX listo\n");
    return true;
}

static void micRxDeinit() {
    if (micRxChan) {
        i2s_channel_disable(micRxChan);
        i2s_del_channel(micRxChan);
        micRxChan = nullptr;
    }
}

// lectura de N bytes desde el canal std RX (bloqueante con timeout)
static bool micRead(void* dst, size_t bytes, size_t* got) {
    size_t read = 0;
    esp_err_t err = i2s_channel_read(micRxChan, dst, bytes, &read,
                                     pdMS_TO_TICKS(200));
    if (err != ESP_OK) return false;
    if (got) *got = read;
    return read > 0;
}

// Escribe la cabecera WAV (mono 16kHz 16bit) en buf a partir de pcmLen.
static void writeWavHeader(uint8_t* buf, uint32_t pcmLen) {
    memcpy(buf, "RIFF", 4);
    uint32_t total = pcmLen + 36;
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
    buf[40] = pcmLen & 0xFF; buf[41] = (pcmLen >> 8) & 0xFF;
    buf[42] = (pcmLen >> 16) & 0xFF; buf[43] = (pcmLen >> 24) & 0xFF;
}

static bool ensureRecordBuffer() {
    if (recordBuffer) return true;
    size_t maxBytes = REC_MAX_SECONDS * sampleRate * 2;
#if USE_PSRAM
    recordBuffer = (uint8_t*)heap_caps_malloc(maxBytes, MALLOC_CAP_SPIRAM);
#else
    recordBuffer = (uint8_t*)malloc(maxBytes);
#endif
    if (!recordBuffer) return false;
    recordCapacity = maxBytes;
    return true;
}

static uint8_t rawTmp[2048];   // buffer de conversion stereo32 -> mono16

// Convierte UN slot de frames stereo 32bit a mono 16bit. El INMP441 entrega
// 24 bits alineados a la izquierda dentro del word 32; desplazando 16
// obtenemos el top 16-bit con escala completa. El slot (0=L, 1=R) se elige
// por energia tras habilitar, porque la fase de WS respecto al primer frame
// que samplea el driver puede caer en L o R segun cuando se habilito.
static void convSlotToMono(const int32_t* src, int16_t* dst, size_t frames, int slot) {
    for (size_t i = 0; i < frames; i++)
        dst[i] = (int16_t)(src[i * 2 + slot] >> 16);
}

// Filtro pasa-alto de 1er orden (~120Hz @16kHz) para eliminar la deriva DC
// sub-sonica que produce el mic/cadena. El audio util (300Hz+) no se toca.
static void dcBlockMono(int16_t* p, size_t n) {
    const float alpha = 0.954f;
    long yPrev = 0, xPrev = 0;
    for (size_t i = 0; i < n; i++) {
        long x = p[i];
        long y = (long)(alpha * (float)(yPrev + x - xPrev));
        p[i] = (int16_t)y;
        yPrev = y;
        xPrev = x;
    }
}

// Devuelve el slot donde esta el audio real del mic. El INMP441 con L/R
// soldado a GND transmite siempre en el slot IZQUIERDO (slot 0). El slot R
// flota (tri-state del mic) y acumula acoplamiento del BCLK, con energia que
// engañaria a cualquier detector por energia. => fijo slot 0.
static int pickAudioSlot(const int32_t* s, size_t frames) {
    (void)s; (void)frames;
    return 0;
}

size_t audioRecordWav(uint8_t** outBuffer, bool (*shouldStop)(void)) {
    if (!ensureRecordBuffer()) return 0;
    if (!micRxInit()) return 0;

    uint8_t* pcmStart = recordBuffer + 44;
    uint32_t pcmLen = 0;
    uint32_t target = recordCapacity - 44;   // capacidad en bytes mono16

    // ==================================================================
    // FIX STALE (audio congelado): al re-inicializar el canal I2S RX, el DMA
    // conserva frames residuales de la sesion ANTERIOR y micRead los devuelve
    // por delante. Eso provoca que Groq oiga SIEMPRE el mismo clip viejo
    // ("Gracias.") en cada PTT. Aqui:
    //  1) zero-fill del PCM fresco para que un DMA seco no reenvie basura.
    //  2) DESCARTE de ~1.2s de DMA residual (4x lo que quepa en un read).
    //  3) warmup corto + deteccion de slot con datos ya limpios.
    // ==================================================================
    memset(pcmStart, 0, target);
    {
        uint8_t flush[2048];
        size_t got = 0;
        uint32_t tFlush = 0;
        // Flush ACOTADO: descarta solo lo que puede haber en el anillo DMA
        // (el 45-read completo se comia ~0.7-1.2s del arranque y cortaba la
        // primera palabra si coincidia con el inicio de tu voz).
        while (tFlush < REC_FLUSH_READS) {
            if (!micRead(flush, sizeof(flush), &got)) break;
            if (got == 0) { vTaskDelay(pdMS_TO_TICKS(2)); continue; }
            tFlush++;
        }
    }
    int slot = 0;
    {
        uint8_t pad[512];
        size_t got = 0;
        vTaskDelay(pdMS_TO_TICKS(40));
        micRead(pad, sizeof(pad), &got);
        if (got >= 8) slot = pickAudioSlot((const int32_t*)pad, got / 8);
    }

    while (pcmLen < target) {
        size_t framesWant = (target - pcmLen) / 2;
        if (framesWant > sizeof(rawTmp) / 8) framesWant = sizeof(rawTmp) / 8;
        size_t read = 0;
        if (!micRead(rawTmp, framesWant * 8, &read)) break;
        size_t nf = read / 8;
        convSlotToMono((const int32_t*)rawTmp, (int16_t*)(pcmStart + pcmLen), nf, slot);
        pcmLen += (uint32_t)(nf * 2);
        if (shouldStop && shouldStop()) break;
    }

    micRxDeinit();

    if (pcmLen < 16000) {   // menos de ~0.5s: descartar como click/ruido
        *outBuffer = recordBuffer;
        return 0;
    }

    dcBlockMono((int16_t*)(pcmStart), pcmLen / 2);

    // ==================================================================
    // PUERTA DE RUIDO ADAPTATIVA + GANANCIA 0.6x (fijada para la placa
    // definitiva): el mic del la placa nueva queda junto a la bocina y
    // cerca de la TV, de modo que Groq oia el AMBIENTE ("¡Suscribete al
    // canal!", el eco de la propia respuesta "Gracias.") en vez de tu voz
    // cercana. Aqui:
    //   1) red nativa 0.6x -> ruido distante baja, tu voz de pecho no.
    //   2) piso adaptativo = energia RMS de los primeros ~40ms (ambiente);
    //      se recorta TODO lo de los bordes que este por debajo de ese
    //      piso, dejando SOLO el tramo con tu voz (mas 30ms de pre/post).
    // ==================================================================
    {
        int16_t* s16 = (int16_t*)pcmStart;
        size_t ns = pcmLen / 2;
        for (size_t i = 0; i < ns; i++) s16[i] = (int16_t)((int32_t)s16[i] * 10 / 10);

        // Piso de ruido = energia del tramo MAS SILENCIOSO de los primeros
        // 300ms. Antes se usaban los primeros 40ms a secas: si la persona
        // empezaba a hablar justo al apretar, el piso quedaba en nivel de voz,
        // la puerta nunca se abria y el recorte de ambiente no hacia nada.
        size_t floorN = sampleRate / 25;          // 40ms
        if (floorN > ns) floorN = ns;
        size_t scanN = sampleRate * 3 / 10;      // 300ms candidatos
        if (scanN > ns) scanN = ns;
        size_t stepN = floorN / 2 ? floorN / 2 : 1;
        int64_t floorSq = -1;
        for (size_t off = 0; off + floorN <= scanN; off += stepN) {
            int64_t acc = 0;
            for (size_t i = off; i < off + floorN; i++) acc += (int64_t)s16[i] * s16[i];
            int64_t e = acc / (floorN ? floorN : 1);
            if (floorSq < 0 || e < floorSq) floorSq = e;
        }
        if (floorSq < 0) floorSq = 0;
        int64_t thresh = (floorSq > 4) ? (floorSq * 3) : 800;

        size_t win = sampleRate / 100;             // 10ms
        if (win < 1) win = 1;
        size_t prePost = (size_t)((uint64_t)sampleRate * REC_PRE_MS / 1000);   // preroll de arranque
        size_t postTail = (size_t)((uint64_t)sampleRate * REC_POST_MS / 1000); // cola final
        size_t start = 0, end = ns;
        bool found = false;
        for (size_t i = 0; i + win <= ns; i += win) {
            int64_t e = 0;
            for (size_t k = i; k < i + win; k++) e += (int64_t)s16[k] * s16[k];
            if (e > thresh * (int64_t)win) { start = (i >= prePost) ? i - prePost : 0; found = true; break; }
        }
        size_t last = 0;
        if (found) {
            for (size_t i = 0; i + win <= ns; i += win) {
                int64_t e = 0;
                for (size_t k = i; k < i + win; k++) e += (int64_t)s16[k] * s16[k];
                if (e > thresh * (int64_t)win) last = i;
            }
            if (last + win + postTail < ns) end = last + win + postTail;
            size_t keep = end - start;
            if (keep >= sampleRate / 4) {          // >=250ms utiles
                // Calibracion: nivel de voz en el arranque del tramo guardado
                // (si headPeak es bajo, el comienzo de la frase se sigue cortando).
                long headPeak = 0;
                size_t hwin = (keep > (size_t)sampleRate / 10) ? (size_t)sampleRate / 10 : keep;
                for (size_t i = 0; i < hwin; i++) {
                    long v = s16[start + i];
                    if (v < 0) v = -v;
                    if (v > headPeak) headPeak = v;
                }
                Serial.printf("[rec] flush=%d recorte keep=%ums head_peak=%ld pcmLen=%u\n",
                              REC_FLUSH_READS, (unsigned)(keep * 1000 / sampleRate),
                              (long)headPeak, (unsigned)(keep * 2));
                memmove(s16, s16 + start, keep * 2);
                pcmLen = (uint32_t)(keep * 2);
            }
        } else {
            // No se encontro tramo por encima del umbral (p. ej. la persona
            // empezo a hablar dentro de la ventana usada como piso de ruido).
            // Se envia TODO: es preferible un poco de ambiente a perder el
            // comienzo de la frase.
            long headPeak = 0;
            size_t hwin = (ns > (size_t)sampleRate / 10) ? (size_t)sampleRate / 10 : ns;
            for (size_t i = 0; i < hwin; i++) {
                long v = s16[i];
                if (v < 0) v = -v;
                if (v > headPeak) headPeak = v;
            }
            Serial.printf("[rec] flush=%d sin_recorte pcmLen=%u head_peak=%ld\n",
                          REC_FLUSH_READS, (unsigned)pcmLen, (long)headPeak);
        }
    }

    writeWavHeader(recordBuffer, pcmLen);
    *outBuffer = recordBuffer;
    return pcmLen + 44;
}

// PROBE STEREO (diagnostico TEST_MIC): lee el INMP441 en modo stereo 32bit y
// reporta el pico de cada uno de los 2 slots. Sirve para distinguir si el
// silencio (Pico=0 en ambos) es por cableado/reloj o por desalineacion.
size_t probeMicStereo(int seconds, long* outPeakL, long* outPeakR) {
    *outPeakL = 0; *outPeakR = 0;
    if (!ensureRecordBuffer()) return 0;

    if (micRxChan) { i2s_del_channel(micRxChan); micRxChan = nullptr; }
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT,
                                                            I2S_ROLE_MASTER);
    if (i2s_new_channel(&chan_cfg, NULL, &micRxChan) != ESP_OK) return 0;
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)MIC_BCK,
            .ws = (gpio_num_t)MIC_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = (gpio_num_t)MIC_DIN,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    if (i2s_channel_init_std_mode(micRxChan, &std_cfg) != ESP_OK) return 0;
    if (i2s_channel_enable(micRxChan) != ESP_OK) return 0;

    uint32_t frames = (seconds * sampleRate);
    uint32_t need = frames * 8;   // stereo, 32bit = 8 bytes/frame
    if (need > recordCapacity) need = recordCapacity & ~7u;
    uint8_t* pcmStart = recordBuffer + 44;

    {
        uint8_t pad[128];
        size_t got = 0;
        vTaskDelay(pdMS_TO_TICKS(40));
        micRead(pad, sizeof(pad), &got);
    }

    uint32_t gotBytes = 0;
    while (gotBytes < need) {
        size_t read = 0;
        if (!micRead(pcmStart + gotBytes, need - gotBytes, &read)) break;
        gotBytes += read;
    }

    i2s_channel_disable(micRxChan);
    i2s_del_channel(micRxChan);
    micRxChan = nullptr;

    const int32_t* s = (const int32_t*)pcmStart;
    size_t n = gotBytes / 4;
    long nBigL = 0, nBigR = 0, nTot = 0;
    for (size_t i = 0; i + 1 < n; i += 2) {
        int32_t l = s[i] < 0 ? -s[i] : s[i];
        int32_t r = s[i + 1] < 0 ? -s[i + 1] : s[i + 1];
        if (l > *outPeakL) *outPeakL = l;
        if (r > *outPeakR) *outPeakR = r;
        nTot++;
        if (l > 100000000) nBigL++;
        if (r > 100000000) nBigR++;
    }
    if (nTot) {
        // % de muestras con nivel alto -> distingue saturacion puntual (crosstalk)
        // de senal de voz continua (ambos dan pico alto, solo la voz da % grande)
        Serial.printf("[test-mic] %%alto (>100M): L=%0.2f%%  R=%0.2f%%  (voz real >2%%)\n",
                      100.0 * nBigL / nTot, 100.0 * nBigR / nTot);
    }
    return gotBytes;
}

// ============================================================
// PROBE CONFIGS DE SLOT (diagnostico TEST_MIC): prueba varias variantes de
// fase/alineacion (ws_pol, ws_inv, slot_bit_width) y reporta cual captura mas
// senal real en el slot L. Aislar si el problema es de fase WS y no de mapeo.
// ============================================================
void probeSlotConfigs() {
    static int32_t wbuf[2048];   // en .bss para no desbordar la pila
    static int32_t tempSt[256];  // en .bss
    const char* names[] = { "philips", "ws_pol", "ws_inv", "msb_noshift" };
    for (int variant = 0; variant < 4; variant++) {
        if (micRxChan) { i2s_del_channel(micRxChan); micRxChan = nullptr; }
        i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
        if (i2s_new_channel(&chan_cfg, NULL, &micRxChan) != ESP_OK) continue;

        i2s_std_config_t std_cfg = {
            .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate),
            .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
            .gpio_cfg = {
                .mclk = I2S_GPIO_UNUSED,
                .bclk = (gpio_num_t)MIC_BCK,
                .ws = (gpio_num_t)MIC_WS,
                .dout = I2S_GPIO_UNUSED,
                .din = (gpio_num_t)MIC_DIN,
                .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
            },
        };
        if (variant == 1) std_cfg.slot_cfg.ws_pol = true;
        if (variant == 2) std_cfg.gpio_cfg.invert_flags.ws_inv = true;
        if (variant == 3) std_cfg.slot_cfg.bit_shift = false;

        if (i2s_channel_init_std_mode(micRxChan, &std_cfg) != ESP_OK) continue;
        if (i2s_channel_enable(micRxChan) != ESP_OK) continue;

        uint32_t total = 0;
        for (int k = 0; k < (int)(sizeof(wbuf)/sizeof(wbuf[0]));) {
            size_t want = sizeof(wbuf)/sizeof(wbuf[0]) - k;
            if (want > sizeof(tempSt)/sizeof(tempSt[0])/2) want = sizeof(tempSt)/sizeof(tempSt[0])/2;
            size_t read = 0;
            if (!micRead(tempSt, want * 8, &read)) break;
            size_t nf = read / 8;
            for (size_t i = 0; i < nf && k < (int)(sizeof(wbuf)/sizeof(wbuf[0])); i++, k++)
                wbuf[k] = tempSt[i * 2];
            total = k;
        }
        i2s_channel_disable(micRxChan);
        i2s_del_channel(micRxChan);
        micRxChan = nullptr;

        // metricas slot L
        long nMid = 0, nFlip = 0, nZero = 0;
        {
            bool wasNeg = wbuf[0] < 0;
            for (uint32_t i = 0; i < total; i++) {
                long v = wbuf[i];
                long a = v < 0 ? -v : v;
                if (a > 20000000) nMid++;
                if (a < 1000) nZero++;
                bool neg = v < 0;
                if (neg != wasNeg && a > 5000000) nFlip++;
                wasNeg = neg;
            }
        }
        Serial.printf("[cfg] %-12s frames=%u  %%mid>20M=%0.2f  %%quiet<1k=%0.1f  flips=%u\n",
                      names[variant], total, 100.0 * nMid / total, 100.0 * nZero / total, nFlip);
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

// ============================================================
// VOLCADO CRUDO 32-BIT (diagnostico TEST_MIC): lee frames y vuelca el word
// int32 completo de los slots L/R en hex+binario + % de bits no-cero. Sirve
// para discriminar definitivamente entre:
//  - Word=0 en L/R   -> el pin no recibe dato (problema fisico/modulo)
//  - Bits 24-altos cambian al hablar -> dato SI llega, solo mal decodificado
//  - Word no-cero pero estatico      -> crosstalk electrico puro
// ============================================================
void dumpRawFrame() {
    static int32_t buf[64];   // en .bss
    if (micRxChan) { i2s_del_channel(micRxChan); micRxChan = nullptr; }
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
    if (i2s_new_channel(&chan_cfg, NULL, &micRxChan) != ESP_OK) { Serial.println("[raw] new FAIL"); return; }
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)MIC_BCK,
            .ws = (gpio_num_t)MIC_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = (gpio_num_t)MIC_DIN,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    if (i2s_channel_init_std_mode(micRxChan, &std_cfg) != ESP_OK) { Serial.println("[raw] init FAIL"); return; }
    if (i2s_channel_enable(micRxChan) != ESP_OK) { Serial.println("[raw] enable FAIL"); return; }

    Serial.println("[raw] Grabando... habla fuerte. Volcando word 32-bit de 16 frames.");
    {
        uint8_t pad[128];
        size_t got = 0;
        vTaskDelay(pdMS_TO_TICKS(40));
        micRead(pad, sizeof(pad), &got);
    }
    uint32_t n = 0;
    while (n < 32) {   // hasta 16 frames stereo
        size_t read = 0;
        if (!micRead(buf + n, (32 - n) * 4, &read)) break;
        n += read / 4;
    }
    i2s_channel_disable(micRxChan);
    i2s_del_channel(micRxChan);
    micRxChan = nullptr;

    uint32_t nzL = 0, nzR = 0;
    for (uint32_t i = 0; i + 1 < n; i += 2) {
        int32_t L = buf[i];
        int32_t R = buf[i + 1];
        if (L != 0) nzL++;
        if (R != 0) nzR++;
        if (i < 32) {
            Serial.printf("[raw][%02u] L=%08X  R=%08X\n", i / 2, (unsigned)L, (unsigned)R);
        }
    }
    Serial.printf("[raw] frames=%u  L no-cero=%u/%u  R no-cero=%u/%u\n",
                  n / 2, nzL, n / 2, nzR, n / 2);
    Serial.println("[raw] 0x00000000 fijo en L+R = pin sin dato (mic no emite).");
    Serial.println("[raw] bits altos que cambian al hablar = dato llega, falta decodificar.");
}

// ============================================================
// PROBE AMBOS SLOTS + L/R A VDD (diagnostico): cuenta bits no-cero y
// variacion entre muestras en L y R, comparando percepción con/sin sonido.
// Silencio_tapado == silencio_normal => crosstalk electrico (no audio).
// ============================================================
void probeSlotBoth() {
    static int32_t lbuf[4000], rbuf[4000];   // en .bss
    if (micRxChan) { i2s_del_channel(micRxChan); micRxChan = nullptr; }
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
    if (i2s_new_channel(&chan_cfg, NULL, &micRxChan) != ESP_OK) { Serial.println("[both] new FAIL"); return; }
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)MIC_BCK,
            .ws = (gpio_num_t)MIC_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = (gpio_num_t)MIC_DIN,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    if (i2s_channel_init_std_mode(micRxChan, &std_cfg) != ESP_OK) return;
    if (i2s_channel_enable(micRxChan) != ESP_OK) return;

    {
        uint8_t pad[128];
        size_t got = 0;
        vTaskDelay(pdMS_TO_TICKS(40));
        micRead(pad, sizeof(pad), &got);
    }
    uint32_t n = 0;
    int32_t tmp[256];
    while (n < 2048) {
        size_t read = 0;
        uint32_t want = (2048 - n) > (unsigned)(sizeof(tmp)/sizeof(tmp[0])/2)
                      ? (unsigned)(sizeof(tmp)/sizeof(tmp[0])/2) : (2048 - n);
        if (!micRead(tmp, want * 8, &read)) break;
        uint32_t frames = read / 8;
        for (uint32_t i = 0; i < frames && n < 2048; i++) {
            lbuf[n] = tmp[i * 2];
            rbuf[n] = tmp[i * 2 + 1];
            n++;
        }
    }
    i2s_channel_disable(micRxChan);
    i2s_del_channel(micRxChan);
    micRxChan = nullptr;

    // metricas por slot
    for (int ch = 0; ch < 2; ch++) {
        const int32_t* arr = (ch == 0) ? lbuf : rbuf;
        long sum = 0, maxv = 0, nNonZero = 0, nVaried = 0;
        for (uint32_t i = 0; i < n; i++) {
            long v = arr[i];
            sum += v;
            long a = v < 0 ? -v : v;
            if (a > maxv) maxv = a;
            if (v != 0) nNonZero++;
            if (i > 0 && arr[i] != arr[i - 1]) nVaried++;
        }
        long mean = n ? sum / (long)n : 0;
        Serial.printf("[both] slot %s: n=%u mean=%ld max=%ld  nz=%0.1f%%  varied=%0.1f%%\n",
                      ch == 0 ? "L" : "R", n, mean, maxv,
                      100.0 * nNonZero / n, 100.0 * nVaried / n);
    }
    Serial.println("[both] 'varied' alto+significativo = hay señal que cambia (audio).");
    Serial.println("[both] 'varied' ~0 con max alto = valor estatico (crosstalk).");
}

// ============================================================
// PROBE DATA SHIFT (diagnostico): prueba distintos desplazamientos del word
// 32-bit (>>8, >>16, >>24) sobre el slot L para hallar cual produce señal de
// voz coherente, por si el dato llega alineado a la izquierda pero se lee mal.
// ============================================================
void probeDataShift() {
    static int32_t lbuf[4000];   // en .bss
    if (micRxChan) { i2s_del_channel(micRxChan); micRxChan = nullptr; }
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
    if (i2s_new_channel(&chan_cfg, NULL, &micRxChan) != ESP_OK) { Serial.println("[shift] new FAIL"); return; }
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)MIC_BCK,
            .ws = (gpio_num_t)MIC_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = (gpio_num_t)MIC_DIN,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    if (i2s_channel_init_std_mode(micRxChan, &std_cfg) != ESP_OK) return;
    if (i2s_channel_enable(micRxChan) != ESP_OK) return;

    {
        uint8_t pad[128];
        size_t got = 0;
        vTaskDelay(pdMS_TO_TICKS(40));
        micRead(pad, sizeof(pad), &got);
    }
    uint32_t n = 0;
    int32_t tmp[256];
    while (n < 2048) {
        size_t read = 0;
        uint32_t want = (2048 - n) > (unsigned)(sizeof(tmp)/sizeof(tmp[0])/2)
                      ? (unsigned)(sizeof(tmp)/sizeof(tmp[0])/2) : (2048 - n);
        if (!micRead(tmp, want * 8, &read)) break;
        uint32_t frames = read / 8;
        for (uint32_t i = 0; i < frames && n < 2048; i++) {
            lbuf[n] = tmp[i * 2];
            n++;
        }
    }
    i2s_channel_disable(micRxChan);
    i2s_del_channel(micRxChan);
    micRxChan = nullptr;

    const int shifts[] = { 8, 16, 24 };
    for (int s = 0; s < 3; s++) {
        long nMid = 0, nFlip = 0, nVaried = 0;
        bool wasNeg = (int16_t)(lbuf[0] >> shifts[s]) < 0;
        for (uint32_t i = 0; i < n; i++) {
            long v = (long)(int16_t)(lbuf[i] >> shifts[s]);
            long a = v < 0 ? -v : v;
            if (a > 1000) nMid++;
            if (i > 0 && v != (long)(int16_t)(lbuf[i - 1] >> shifts[s])) nVaried++;
            bool neg = v < 0;
            if (neg != wasNeg && a > 500) nFlip++;
            wasNeg = neg;
        }
        Serial.printf("[shift] >>%2d: %%mid>1k=%0.2f%% varied=%0.1f%% flips=%u\n",
                      shifts[s], 100.0 * nMid / n, 100.0 * nVaried / n, nFlip);
    }
    Serial.println("[shift] flips alto en alguno = señal de voz decodificada correcta.");
    vTaskDelay(pdMS_TO_TICKS(20));
}

// ============================================================
// DUMP FORMA DE ONDA (diagnostico TEST_MIC): graba ~1.5s en stereo 32bit,
// extrae el slot L y vuelca un window del medio + metricas de amplitud para
// distinguir voz real (onda ciclica) de crosstalk (espigas aisladas).
// ============================================================
void dumpMicWaveform() {
    if (micRxChan) { i2s_del_channel(micRxChan); micRxChan = nullptr; }
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
    if (i2s_new_channel(&chan_cfg, NULL, &micRxChan) != ESP_OK) { Serial.println("[wav] new_channel FAIL"); return; }
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)MIC_BCK,
            .ws = (gpio_num_t)MIC_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = (gpio_num_t)MIC_DIN,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    i2s_std_config_t stdc = std_cfg;
    stdc.slot_cfg.slot_mask = (i2s_std_slot_mask_t)(I2S_STD_SLOT_RIGHT | I2S_STD_SLOT_LEFT);
    if (i2s_channel_init_std_mode(micRxChan, &stdc) != ESP_OK) { Serial.println("[wav] init FAIL"); return; }
    if (i2s_channel_enable(micRxChan) != ESP_OK) { Serial.println("[wav] enable FAIL"); return; }

    uint32_t total = 0;
    static int32_t frameBuf[25000];   // hasta ~1.5s mono @16k (en .bss)
    Serial.println("[wav] Grabando 1.5s...");
    {
        uint8_t pad[128];
        size_t got = 0;
        vTaskDelay(pdMS_TO_TICKS(40));
        micRead(pad, sizeof(pad), &got);
    }
    static int32_t temp[512];   // buffer de conversion temporal (pequeno)
    while (total < sizeof(frameBuf)/sizeof(frameBuf[0])) {
        uint32_t chunk = (sizeof(frameBuf)/sizeof(frameBuf[0]) - total) > (sizeof(temp)/sizeof(temp[0])/2)
                         ? (sizeof(temp)/sizeof(temp[0])/2) : (sizeof(frameBuf)/sizeof(frameBuf[0]) - total);
        size_t read = 0;
        if (!micRead(temp, chunk * 8, &read)) break;
        size_t nf = read / 8;
        for (size_t i = 0; i < nf && total + i < sizeof(frameBuf)/sizeof(frameBuf[0]); i++) {
            frameBuf[total + i] = temp[i * 2];   // slot L
        }
        total += nf;
    }
    // metricas del slot L completo
    long minv = 0, maxv = 0, sum = 0, nLarge = 0, nZero = 0, nMid = 0, nFlip = 0;
    {
        bool wasNeg = frameBuf[0] < 0;
        for (uint32_t i = 0; i < total; i++) {
            long v = frameBuf[i];
            if (v < minv) minv = v;
            if (v > maxv) maxv = v;
            sum += v;
            long a = v < 0 ? -v : v;
            if (a > 100000000) nLarge++;
            if (a > 20000000) nMid++;
            if (a < 1000) nZero++;
            bool neg = v < 0;
            if (neg != wasNeg && a > 1000000) nFlip++;   // cruce por cero real (no ruido)
            wasNeg = neg;
        }
    }
    long mean = total ? sum / (long)total : 0;
    Serial.printf("[wav] frames=%u  min=%ld max=%ld mean=%ld\n", total, minv, maxv, mean);
    Serial.printf("[wav]  %%large>100M=%0.2f  %%mid>20M=%0.2f  %%quiet<1k=%0.1f  flips>1M=%u\n",
                  100.0 * nLarge / total, 100.0 * nMid / total, 100.0 * nZero / total, nFlip);

    // dump window del medio (200 muestras) solo las que tengan nivel
    uint32_t base = total / 2;
    int shown = 0;
    Serial.println("[wav] window medio (slot L, muestras >10M):");
    for (uint32_t i = 0; i < 200 && base + i < total; i++) {
        long v = frameBuf[base + i];
        long a = v < 0 ? -v : v;
        if (a > 10000000) {
            Serial.printf("[wav][%u] %ld\n", i, v);
            shown++;
        }
    }
    Serial.printf("[wav] %d muestras >10M en window medio\n", shown);

    i2s_channel_disable(micRxChan);
    i2s_del_channel(micRxChan);
    micRxChan = nullptr;
}

// ============================================================
// ESCANEO DE PINES (diagnostico): barre GPIOs candidatos como DIN
// y reporta metricas que distinguen DC (pin clavado) de audio real.
// - Pico       : max |muestra|
// - Media      : promedio de la senal (DC si lejos de 0)
// - %cero      : % de muestras con |v| < 200 (silencio)
// - flips      : cantidad de cruces por cero (nunca pasan en pin DC)
// ============================================================
static const int kScanPins[] = {
    1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    21, 22, 23, 24, 25, 38, 39, 40, 41, 42, 45, 47, 48
};
#define kScanCount (sizeof(kScanPins)/sizeof(kScanPins[0]))

struct ScanResult { long peak = 0; long mean = 0; int zeroPct = 0; unsigned flips = 0; bool initOk = false; };

static ScanResult scanReadOnce(gpio_num_t dinPin, int ms) {
    ScanResult r;
    if (micRxChan) { i2s_del_channel(micRxChan); micRxChan = nullptr; }
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
    if (i2s_new_channel(&chan_cfg, NULL, &micRxChan) != ESP_OK) return r;
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)MIC_BCK,
            .ws = (gpio_num_t)MIC_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = dinPin,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    if (i2s_channel_init_std_mode(micRxChan, &std_cfg) != ESP_OK) return r;
    if (i2s_channel_enable(micRxChan) != ESP_OK) return r;
    r.initOk = true;

    uint32_t bytesWant = (sampleRate/1000) * ms * 8;   // stereo 32bit
    if (bytesWant > (uint32_t)(recordCapacity - 44)) bytesWant = recordCapacity - 44;
    uint8_t* buf = recordBuffer + 44;
    long sum = 0;
    unsigned nTotal = 0, nZero = 0, nFlip = 0;
    int prevSign = 0;   // 0 = sin dato previo
    bool first = true;
    long peak = 0;
    while (bytesWant > 0) {
        size_t got = 0;
        if (!micRead(buf, bytesWant > 4096 ? 4096 : bytesWant, &got)) break;
        bytesWant -= got;
        const int32_t* s = (const int32_t*)buf;
        size_t n = got / 4;
        for (size_t i = 0; i < n; i++) {
            long v = s[i];
            long a = v < 0 ? -v : v;
            if (a > peak) peak = a;
            sum += v;
            nTotal++;
            if (a < 200) nZero++;
            int sg = (v > 0) - (v < 0);
            if (first) { prevSign = sg; first = false; }
            else if (sg != 0 && sg != prevSign) nFlip++;
            if (sg != 0) prevSign = sg;
        }
    }

    i2s_channel_disable(micRxChan);
    i2s_del_channel(micRxChan);
    micRxChan = nullptr;

    r.peak = peak;
    r.mean = nTotal ? sum / (long)nTotal : 0;
    r.zeroPct = nTotal ? (int)((100 * nZero) / nTotal) : 100;
    r.flips = nFlip;
    return r;
}

void scanMicDins() {
    if (!ensureRecordBuffer()) {
        Serial.println("[scan] no hay buffer");
        return;
    }
    Serial.println("[scan] Barriendo pines DIN (haz SONIDO FUERTE continuo cerca del mic)...");
    for (int i = 0; i < (int)kScanCount; i++) {
        ScanResult r = scanReadOnce((gpio_num_t)kScanPins[i], 300);
        if (!r.initOk) {
            Serial.printf("[scan] GPIO%-3d init FAIL\n", kScanPins[i]);
            continue;
        }
        // UMBRAL de audio real: pico alto + flips (cruces) presentes + media cerca de 0
        bool audio = (r.peak > 3000) && (r.flips > 100) && (r.mean > -4000) && (r.mean < 4000);
        Serial.printf("[scan] GPIO%-3d Pico=%-6ld Media=%-6ld %%zero=%3d flips=%-6u%s\n",
                      kScanPins[i], r.peak, r.mean, r.zeroPct, r.flips,
                      audio ? "  <== AUDIO" : "");
    }
    Serial.println("[scan] termino.");
}

// ============================================================
// PROBE ACTIVIDAD BCLK/WS (diagnostico): con el canal RX activo
// en MASTER, mide cuantas veces togglea GPIO5 (BCLK) y GPIO6 (WS)
// durante ~200ms. Sirve para verificar que el reloj del I2S_std
// realmente se genera en los pines (si no, el mic nunca emite).
// ============================================================
static void countToggles(int bclkPin, int wsPin, unsigned* cBclk, unsigned* cWs) {
    *cBclk = 0; *cWs = 0;
    if (micRxChan) { i2s_del_channel(micRxChan); micRxChan = nullptr; }
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
    if (i2s_new_channel(&chan_cfg, NULL, &micRxChan) != ESP_OK) return;
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)bclkPin,
            .ws = (gpio_num_t)wsPin,
            .dout = I2S_GPIO_UNUSED,
            .din = (gpio_num_t)MIC_DIN,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    if (i2s_channel_init_std_mode(micRxChan, &std_cfg) != ESP_OK) return;
    if (i2s_channel_enable(micRxChan) != ESP_OK) return;

    vTaskDelay(pdMS_TO_TICKS(30));
    int lB = gpio_get_level((gpio_num_t)bclkPin);
    int lW = gpio_get_level((gpio_num_t)wsPin);
    unsigned long t0 = millis();
    while (millis() - t0 < 150) {
        for (int i = 0; i < 200; i++) {
            int nB = gpio_get_level((gpio_num_t)bclkPin);
            int nW = gpio_get_level((gpio_num_t)wsPin);
            if (nB != lB) { (*cBclk)++; lB = nB; }
            if (nW != lW) { (*cWs)++; lW = nW; }
        }
    }
    i2s_channel_disable(micRxChan);
    i2s_del_channel(micRxChan);
    micRxChan = nullptr;
}

void probeClockActivity() {
    static const int pins[] = { 5, 6, 7, 8, 9, 10, 11, 12, 15, 16, 17, 18, 21, 38, 39, 40, 41, 42, 47, 48 };
    Serial.println("[clk] Barriendo BCLK (WS fijo en GPIO6)...");
    unsigned bestB = 0, bestW = 0, bestPin = 0;
    for (unsigned i = 0; i < sizeof(pins)/sizeof(pins[0]); i++) {
        unsigned cB = 0, cW = 0;
        countToggles(pins[i], 6, &cB, &cW);
        char tag = ' ';
        if (cB > 5000 && cW > 20) tag = '*';   // par que si genera
        if (cB > bestB) { bestB = cB; bestPin = pins[i]; bestW = cW; }
        Serial.printf("[clk] BCLK=GPIO%-2d B(%u) WS=GPIO6 W(%u)%s\n", pins[i], cB, cW, tag == '*' ? "  <== OK" : "");
    }
    Serial.printf("[clk] Pico: BCLK=GPIO%u (B=%u, W=%u)\n", bestPin, bestB, bestW);
    // ademas barrido de WS con el mejor BCLK
    if (bestPin) {
        Serial.printf("[clk] Barriendo WS con BCLK=GPIO%u...\n", bestPin);
        for (unsigned i = 0; i < sizeof(pins)/sizeof(pins[0]); i++) {
            unsigned cB = 0, cW = 0;
            countToggles(bestPin, pins[i], &cB, &cW);
            if (cB > 5000 && cW > 20)
                Serial.printf("[clk]   WS=GPIO%-2d funciona (B=%u W=%u)\n", pins[i], cB, cW);
        }
    }
}

// TEST_MIC: graba una rafaga fija de N segundos (sin callback), sin exigir
// un minimo de audio. Reutiliza el buffer y el puerto I2S_NUM_0.
size_t audioRecordFixed(uint8_t** outBuffer, int seconds) {
    if (!ensureRecordBuffer()) return 0;
    if (!micRxInit()) return 0;

    uint8_t* pcmStart = recordBuffer + 44;
    uint32_t target = (seconds * sampleRate) * 2;   // mono16
    if (target > recordCapacity - 44) target = recordCapacity - 44;
    uint32_t pcmLen = 0;

    int slot = 0;
    {
        uint8_t pad[512];
        size_t got = 0;
        vTaskDelay(pdMS_TO_TICKS(40));
        micRead(pad, sizeof(pad), &got);
        if (got >= 8) slot = pickAudioSlot((const int32_t*)pad, got / 8);
    }

    while (pcmLen < target) {
        size_t framesWant = (target - pcmLen) / 2;
        if (framesWant > sizeof(rawTmp) / 8) framesWant = sizeof(rawTmp) / 8;
        size_t read = 0;
        if (!micRead(rawTmp, framesWant * 8, &read)) break;
        size_t nf = read / 8;
        convSlotToMono((const int32_t*)rawTmp, (int16_t*)(pcmStart + pcmLen), nf, slot);
        pcmLen += (uint32_t)(nf * 2);
    }

micRxDeinit();

        writeWavHeader(recordBuffer, pcmLen);
        dcBlockMono((int16_t*)(pcmStart), pcmLen / 2);
        *outBuffer = recordBuffer;
        return pcmLen + 44;
}

// ============================================================
// PROBE DC NIVEL PIN SD (diagnostico TEST_MIC): con BCLK/WS corriendo,
// muestrea GPIO12 (SD) directo con gpio_get_level para medir el % de tiempo
// en alto. Si SD está electricamente clavado a 0%->1 alto, no llega nada del
// mic al pin (pin sin señal). BCLK/WS se miden de referencia para confirmar
// que el reloj corre mientras se muestrea.
// ============================================================
void probeDinDC() {
    if (micRxChan) { i2s_del_channel(micRxChan); micRxChan = nullptr; }
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_PORT, I2S_ROLE_MASTER);
    if (i2s_new_channel(&chan_cfg, NULL, &micRxChan) != ESP_OK) { Serial.println("[din] new FAIL"); return; }
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sampleRate),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)MIC_BCK,
            .ws = (gpio_num_t)MIC_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = (gpio_num_t)MIC_DIN,
            .invert_flags = { .mclk_inv = false, .bclk_inv = false, .ws_inv = false },
        },
    };
    if (i2s_channel_init_std_mode(micRxChan, &std_cfg) != ESP_OK) { Serial.println("[din] init FAIL"); return; }
    if (i2s_channel_enable(micRxChan) != ESP_OK) { Serial.println("[din] enable FAIL"); return; }

    gpio_set_direction((gpio_num_t)MIC_DIN, GPIO_MODE_INPUT);
    gpio_set_direction((gpio_num_t)MIC_BCK, GPIO_MODE_INPUT);
    gpio_set_direction((gpio_num_t)MIC_WS, GPIO_MODE_INPUT);

    {
        uint8_t pad[128];
        size_t got = 0;
        vTaskDelay(pdMS_TO_TICKS(40));
        micRead(pad, sizeof(pad), &got);
    }

    const uint32_t n = 300000;
    uint32_t dinHi = 0, bckHi = 0, wsHi = 0;
    for (uint32_t i = 0; i < n; i++) {
        if (gpio_get_level((gpio_num_t)MIC_DIN)) dinHi++;
        if (gpio_get_level((gpio_num_t)MIC_BCK)) bckHi++;
        if (gpio_get_level((gpio_num_t)MIC_WS)) wsHi++;
    }
    i2s_channel_disable(micRxChan);
    i2s_del_channel(micRxChan);
    micRxChan = nullptr;

    Serial.printf("[din] GPIO%d(SD): 1=%0.2f%% 0=%0.2f%% (n=%u)\n",
                  MIC_DIN, 100.0 * dinHi / n, 100.0 * (n - dinHi) / n, n);
    Serial.printf("[din] GPIO%d(BCK): 1=%0.2f%% 0=%0.2f%%\n",
                  MIC_BCK, 100.0 * bckHi / n, 100.0 * (n - bckHi) / n);
    Serial.printf("[din] GPIO%d(WS) : 1=%0.2f%% 0=%0.2f%%\n",
                  MIC_WS, 100.0 * wsHi / n, 100.0 * (n - wsHi) / n);
    Serial.println("[din] SD clavado 1=~0% 0=~100% sin toggle = pin sin señal del mic.");
    vTaskDelay(pdMS_TO_TICKS(20));
}

// ============================================================
// PROBE CADENA MONO REAL (diagnostico TEST_MIC): usa la MISMA init de
// produccion (micRxInit) en una sola sesion de canal. Vuelca 16 frames raw,
// detecta el slot activo, graba ~1s mono16 y calcula metricas del PCM.
// ============================================================
void probeMonoRecord() {
    if (!micRxInit()) { Serial.println("[mono] init FAIL"); return; }

    {
        uint8_t pad[128];
        size_t got = 0;
        vTaskDelay(pdMS_TO_TICKS(40));
        micRead(pad, sizeof(pad), &got);
    }

    {
        uint8_t raw[128];
        size_t got = 0;
        micRead(raw, sizeof(raw), &got);
        size_t nf = got / 8;
        const int32_t* s = (const int32_t*)raw;
        Serial.printf("[mono] RAW %u frames (init=produccion):\n", (unsigned)nf);
        for (size_t i = 0; i < nf && i < 16; i++)
            Serial.printf("[mono]  [%02u] L=%08X R=%08X\n",
                          (unsigned)i, (unsigned)s[i * 2], (unsigned)s[i * 2 + 1]);
        int slot = pickAudioSlot(s, nf);
        Serial.printf("[mono] slot=%d\n", slot);
        uint8_t* wav = (uint8_t*)malloc(44 + 16000 * 2);
        if (!wav) { micRxDeinit(); Serial.println("[mono] sin RAM"); return; }
        writeWavHeader(wav, 16000 * 2);
        int16_t* pcm = (int16_t*)(wav + 44);
        size_t wrote = 0;
        while (wrote < 16000) {
            uint8_t rawTmp[1024];
            size_t read = 0;
            if (!micRead(rawTmp, sizeof(rawTmp), &read)) break;
            size_t nf2 = read / 8;
            if (nf2 > (16000 - wrote)) nf2 = 16000 - wrote;
            if (wrote < 16000 && wrote + nf2 >= 5000 && wrote < 5000) {
                const int32_t* sw = (const int32_t*)rawTmp;
                Serial.printf("[mid] raw a las %u (primeros 8 frames del buffer):\n", (unsigned)wrote);
                for (size_t i = 0; i < 8; i++)
                    Serial.printf("[mid]  [%02u] L=%08X R=%08X\n",
                                  (unsigned)i, (unsigned)sw[i * 2], (unsigned)sw[i * 2 + 1]);
            }
            convSlotToMono((const int32_t*)rawTmp, pcm + wrote, nf2, slot);
            wrote += nf2;
        }
        micRxDeinit();
        if (wrote < 100) { free(wav); Serial.println("[mono] sin audio util"); return; }

        dcBlockMono(pcm, wrote);

        size_t n = wrote;
        Serial.printf("[mono] muestreo temporal (1 cada ~800):\n");
        for (size_t i = 0; i < n; i += 800)
            Serial.printf("[mono]  %05u=%d\n", (unsigned)i, (int)pcm[i]);
        long nZero = 0, nLoud = 0;
        for (size_t i = 0; i < n; i++) {
            long v = pcm[i];
            long a = v < 0 ? -v : v;
            if (v == 0) nZero++;
            if (a > 20000) nLoud++;
        }
        Serial.printf("[mono] ceros=%ld loud>20k=%ld\n", nZero, nLoud);

        long peak = 0, sum = 0, nMid = 0, nFlip = 0;
        bool wasNeg = pcm[0] < 0;
        for (size_t i = 0; i < n; i++) {
            long v = pcm[i];
            long a = v < 0 ? -v : v;
            sum += v;
            if (a > peak) peak = a;
            if (a > 1000) nMid++;
            bool neg = v < 0;
            if (neg != wasNeg && a > 500) nFlip++;
            wasNeg = neg;
        }
        Serial.printf("[mono] len=%u peak=%ld mean=%ld %%mid>1k=%0.2f flips=%u\n",
                      (unsigned)n, peak, n ? sum / (long)n : 0,
                      n ? 100.0 * nMid / n : 0, nFlip);
        if (nFlip > 50 && peak > 3000)
            Serial.println("[mono] VOZ util: recorte listo para el servidor.");
        else
            Serial.println("[mono] sin confirmar: habla fuerte y repite.");
        free(wav);
    }
}

// ============================================================
// PROBE WAV COMPLETO: graba 1s mono16 (slot 0, misma cadena de produccion)
// y lo emite por serial como "WAVB" + header + 16000 muestras int16 LE, para
// analizarlo en la PC (FFT/RMS) sin depender de metricas de la MCU.
// ============================================================
void probeMonoWavDump() {
    if (!micRxInit()) { Serial.println("[wav] init FAIL"); return; }
    int slot = 0;
    {
        uint8_t pad[128];
        size_t got = 0;
        vTaskDelay(pdMS_TO_TICKS(40));
        micRead(pad, sizeof(pad), &got);
    }
    uint8_t* wav = (uint8_t*)malloc(44 + 16000 * 2);
    if (!wav) { micRxDeinit(); Serial.println("[wav] sin RAM"); return; }
    writeWavHeader(wav, 16000 * 2);
    int16_t* pcm = (int16_t*)(wav + 44);
    size_t wrote = 0;
    while (wrote < 16000) {
        uint8_t rawTmp[1024];
        size_t read = 0;
        if (!micRead(rawTmp, sizeof(rawTmp), &read)) break;
        size_t nf2 = read / 8;
        if (nf2 > (16000 - wrote)) nf2 = 16000 - wrote;
        convSlotToMono((const int32_t*)rawTmp, pcm + wrote, nf2, slot);
        wrote += nf2;
    }
    micRxDeinit();
    Serial.print("WAVB");
    Serial.write(wav, 44 + (size_t)wrote * 2);
    free(wav);
    Serial.println();
}
