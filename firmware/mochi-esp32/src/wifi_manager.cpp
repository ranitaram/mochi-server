#include "wifi_manager.h"
#include "config.h"
#include <WiFi.h>
#include <WiFiMulti.h>
#include <string.h>

// WiFiMulti (incluida en el core de Arduino-ESP32): agrega todas las redes
// conocidas de config.h y conecta a la mejor disponible (por señal). Con
// wifiMulti.run() en cada reintento, el cambio de red es automatico.

static WiFiMulti wifiMulti;
static unsigned long lastAttempt = 0;
static bool connectedLogged = false;

void wifiConnect() {
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);

    wifiMulti.addAP(WIFI_SSID_1, WIFI_PASSWORD_1);
    if (strlen(WIFI_SSID_2) > 0) wifiMulti.addAP(WIFI_SSID_2, WIFI_PASSWORD_2);
    if (strlen(WIFI_SSID_3) > 0) wifiMulti.addAP(WIFI_SSID_3, WIFI_PASSWORD_3);

    lastAttempt = millis();
    Serial.print("[wifi] Conectando a ");
    Serial.print(WIFI_SSID_1);
    if (strlen(WIFI_SSID_2) > 0) { Serial.print(" / "); Serial.print(WIFI_SSID_2); }
    if (strlen(WIFI_SSID_3) > 0) { Serial.print(" / "); Serial.print(WIFI_SSID_3); }
    Serial.println(" (mejor red disponible)...");
    wifiMulti.run();
}

bool wifiConnected() {
    bool ok = WiFi.status() == WL_CONNECTED;
    if (ok && !connectedLogged) {
        connectedLogged = true;
        Serial.printf("[wifi] Conectado a %s, IP=%s RSSI=%d dBm\n",
                      WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(),
                      WiFi.RSSI());
    } else if (!ok) {
        connectedLogged = false;
    }
    return ok;
}

void wifiLoop() {
    if (wifiConnected()) {
        lastAttempt = 0;
        return;
    }
    unsigned long now = millis();
    if (now - lastAttempt > 5000) {
        lastAttempt = now;
        Serial.println("[wifi] Sin conexion, reintentando redes...");
        wifiMulti.run();
    }
}