#include "wifi_manager.h"
#include "wifi_store.h"
#include "provisioning.h"
#include "config.h"
#include <WiFi.h>
#include <string.h>

// Estrategia de conexion (Fase 2):
//   1) Lista de redes guardadas en NVS (wifi_store), en orden de prioridad:
//      la mas reciente/relevante primero (viene del backend o del portal).
//   2) Fallback a las redes fijas de config.h (WIFI_SSID_*), por si NVS esta
//      vacia en el primer boot.
//   3) Si nada conecta, se abre el portal cautivo "Ivi-Setup" (bloquea hasta
//      que el usuario da una red valida, que queda guardada en NVS).

#define CONNECT_TIMEOUT_MS 8000UL

static bool tryConnect(const char* ssid, const char* pass) {
    if (!ssid || strlen(ssid) == 0) return false;
    Serial.printf("[wifi]   probando \"%s\"...\n", ssid);
    WiFi.begin(ssid, pass);
    unsigned long t0 = millis();
    while (millis() - t0 < CONNECT_TIMEOUT_MS) {
        if (WiFi.status() == WL_CONNECTED) return true;
        delay(150);
    }
    WiFi.disconnect();
    delay(100);
    return false;
}

static void logConnected() {
    Serial.printf("[wifi] Conectado a %s, IP=%s RSSI=%d dBm\n",
                  WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
}

void wifiConnect() {
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    delay(200);

    // 1) NVS primero (orden: mas reciente primero).
    wifiStoreInit();
    int n = wifiStoreCount();
    int tried = 0;
    for (int i = 0; i < n; i++) {
        WifiEntry e;
        if (!wifiStoreGet(i, e)) continue;
        tried++;
        Serial.printf("[wifi] (%d/%d red guardada) ", i + 1, n);
        if (tryConnect(e.ssid, e.pass)) {
            logConnected();
            return;
        }
    }
    if (tried > 0) Serial.println("[wifi] Ninguna red guardada conecto.");

    // 2) Fallback config.h (boot inicial, sin NVS).
    if (tryConnect(WIFI_SSID_1, WIFI_PASSWORD_1)) { logConnected(); return; }
    if (strlen(WIFI_SSID_2) > 0 && tryConnect(WIFI_SSID_2, WIFI_PASSWORD_2)) { logConnected(); return; }
    if (strlen(WIFI_SSID_3) > 0 && tryConnect(WIFI_SSID_3, WIFI_PASSWORD_3)) { logConnected(); return; }

    // 3) Nada funciono: portal cautivo de aprovisionamiento.
    Serial.println("[wifi] Sin conexion: abriendo portal de configuracion.");
    startCaptivePortal();
    Serial.println("[wifi] Portal cerrado, quedando en la red elegida.");
}

bool wifiConnected() {
    bool ok = WiFi.status() == WL_CONNECTED;
    Serial.flush();
    return ok;
}

void wifiLoop() {
    if (wifiConnected()) return;
    static unsigned long lastAttempt = 0;
    unsigned long now = millis();
    if (now - lastAttempt > 5000) {
        lastAttempt = now;
        Serial.println("[wifi] Sin conexion, reintentando...");
        WiFi.reconnect();
    }
}