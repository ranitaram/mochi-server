#include "http_client.h"
#include "config.h"
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <esp_heap_caps.h>
#include <string.h>

// Cifrado TLS para producción: BACKEND_URL es https://dominio.onrender.com.
// usamos WiFiClientSecure con setInsecure() (sin fijar certificado raíz)
// porque Render sirve HTTPS con certs Let's Encrypt válidos y no queremos
// depender de que un certificado raíz quede embebido en el firmware.
// El canal ya es cifrado y autenticado por TLS.

static WiFiClientSecure secureClient;
static bool secureReady = false;

static String baseUrl() {
    return String(BACKEND_URL);
}

// Inicia una petición HTTP/HTTPS según el esquema de BACKEND_URL.
static void httpBegin(HTTPClient& http, const String& url) {
    if (url.startsWith("https://")) {
        if (!secureReady) {
            secureClient.setInsecure();
            secureReady = true;
        }
        http.begin(secureClient, url);
    } else {
        http.begin(url);
    }
}

int httpGetHealth() {
    HTTPClient http;
    http.setTimeout(15000);
    String url = baseUrl() + "/health";
    httpBegin(http, url);
    int code = http.GET();
    if (code > 0) {
        http.end();
        return code;
    }
    http.end();
    return -1;
}

// Sincroniza las redes WiFi de esta Ivi desde el servidor. Llamala con
// DEVICE_TOKEN seteado en config.h; con token vacio devuelve -1 (sin token).
int httpFetchNetworks(WifiEntry* out, int maxOut) {
    if (strlen(DEVICE_TOKEN) == 0) {
        Serial.println("[http] DEVICE_TOKEN vacio: sin sincronizacion de redes.");
        return -1;
    }

    HTTPClient http;
    http.setTimeout(20000);
    String url = baseUrl() + "/api/devices/" + DEVICE_TOKEN + "/networks";

    httpBegin(http, url);
    http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);

    int code = http.GET();
    int count = 0;
    if (code == HTTP_CODE_OK) {
        String body = http.getString();
        JsonDocument doc;
        DeserializationError err = deserializeJson(doc, body);
        JsonArray arr = doc["redes"];
        if (!err && !arr.isNull()) {
            size_t len = arr.size();
            for (size_t i = 0; i < len && count < maxOut; i++) {
                const char* ssid = arr[i]["ssid"] | "";
                const char* pass = arr[i]["password"] | "";
                if (ssid[0] == 0) continue;
                strncpy(out[count].ssid, ssid, sizeof(out[count].ssid) - 1);
                strncpy(out[count].pass, pass, sizeof(out[count].pass) - 1);
                out[count].ssid[sizeof(out[count].ssid) - 1] = 0;
                out[count].pass[sizeof(out[count].pass) - 1] = 0;
                count++;
            }
            Serial.printf("[http] Redes del servidor: %u\n", (unsigned)count);
        } else {
            Serial.println("[http] Respuesta /networks invalida (JSON).");
            count = -2;
        }
    } else if (code > 0) {
        Serial.printf("[http] /networks HTTP %d (dispositivo no registrado?)\n", code);
        count = -1;
    }

    http.end();
    return count;
}

int httpSendAudio(const uint8_t* wav, size_t wavLen, IviReply& reply) {
    HTTPClient http;
    http.setTimeout(60000);   // la respuesta tarda (STT + LLM + TTS)
    String url = baseUrl() + SERVER_PATH;

    httpBegin(http, url);
    http.addHeader("Content-Type", "audio/wav");

    int code = http.POST(const_cast<uint8_t*>(wav), wavLen);

    if (code == HTTP_CODE_OK) {
        // headers
        String texto = http.header("X-Ivi-Texto");
        String emocion = http.header("X-Ivi-Emocion");
        strncpy(reply.texto, texto.c_str(), sizeof(reply.texto) - 1);
        strncpy(reply.emocion, emocion.c_str(), sizeof(reply.emocion) - 1);

        // MP3 body directo. IMPORTANTE: leer hasta el FINAL del buffer SIN
        // depender de stream->available() (con HTTPS/red lentas available()
        // puede dar 0 en un instante y cortar la descarga truncando el MP3,
        // lo que se oye como una frase que se corta a ~1s).
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
                unsigned long dlStart = millis();
                while (got < avail) {
                    if (stream->available() > 0) {
                        size_t r = stream->readBytes(reply.audio + got, avail - got);
                        got += r;
                    } else if ((unsigned long)(millis() - dlStart) > 30000UL) {
                        Serial.printf("[http] Timeout descargando MP3 (%u/%u bytes)\n",
                                      (unsigned)got, (unsigned)avail);
                        break;
                    } else {
                        delay(5);
                    }
                }
                reply.audio[got] = 0;
                reply.audioLen = got;
                Serial.printf("[http] MP3 descargado: %u/%u bytes\n", (unsigned)got, (unsigned)avail);
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