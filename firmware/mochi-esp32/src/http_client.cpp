#include "http_client.h"
#include "config.h"
#include <HTTPClient.h>
#include <esp_heap_caps.h>
#include <string.h>

static String baseUrl() {
    return String(SERVER_USE_HTTPS ? "https://" : "http://") +
           SERVER_HOST + ":" + SERVER_PORT;
}

int httpGetHealth() {
    HTTPClient http;
    http.setTimeout(15000);
    String url = baseUrl() + "/health";
    http.begin(url);
    int code = http.GET();
    if (code > 0) {
        http.end();
        return code;
    }
    http.end();
    return -1;
}

int httpSendAudio(const uint8_t* wav, size_t wavLen, IviReply& reply) {
    HTTPClient http;
    http.setTimeout(60000);   // la respuesta tarda (STT + LLM + TTS)
    String url = baseUrl() + SERVER_PATH;

    http.begin(url);
    http.addHeader("Content-Type", "audio/wav");

    int code = http.POST(const_cast<uint8_t*>(wav), wavLen);

    if (code == HTTP_CODE_OK) {
        // headers
        String texto = http.header("X-Ivi-Texto");
        String emocion = http.header("X-Ivi-Emocion");
        strncpy(reply.texto, texto.c_str(), sizeof(reply.texto) - 1);
        strncpy(reply.emocion, emocion.c_str(), sizeof(reply.emocion) - 1);

        // MP3 body directo
        Stream* stream = http.getStreamPtr();
        size_t avail = http.getSize();
        if (avail > 0) {
#if USE_PSRAM
            reply.audio = (uint8_t*)heap_caps_malloc(avail + 1, MALLOC_CAP_SPIRAM);
#else
            reply.audio = (uint8_t*)malloc(avail + 1);
#endif
            if (reply.audio) {
                size_t got = 0;
                while (stream->available() && got < avail) {
                    got += stream->readBytes(reply.audio + got, (avail - got));
                }
                reply.audio[got] = 0;
                reply.audioLen = got;
            }
        }
    }

    http.end();
    return code;
}

void httpClientFree(IviReply& reply) {
    if (reply.audio) {
        free(reply.audio);
        reply.audio = nullptr;
    }
    reply.audioLen = 0;
}
