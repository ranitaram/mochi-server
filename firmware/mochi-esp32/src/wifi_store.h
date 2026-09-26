#ifndef WIFI_STORE_H
#define WIFI_STORE_H

#include <Arduino.h>

// Límites de la lista de redes guardadas en NVS (Preferences, namespace "ivi_wifi").
#define WIFI_MAX_NETWORKS   8
#define WIFI_SSID_MAX_LEN   64
#define WIFI_PASS_MAX_LEN   64

struct WifiEntry {
    char ssid[WIFI_SSID_MAX_LEN];
    char pass[WIFI_PASS_MAX_LEN];
};

// Persistencia de redes WiFi en NVS.
// La lista está ORDENADA: índice 0 = la MÁS RECIENTE (se prueba primero),
// el resto en orden de prioridad que viene del backend.
void wifiStoreInit();
int  wifiStoreCount();
bool wifiStoreGet(int idx, WifiEntry& out);
// Inserta al frente (más reciente). Evita duplicados por ssid.
bool wifiStorePush(const char* ssid, const char* pass);
// Reemplaza TODA la lista con un arreglo ordenado (sync desde el backend).
void wifiStoreReplaceAll(const WifiEntry* entries, int n);
void wifiStoreClear();

#endif