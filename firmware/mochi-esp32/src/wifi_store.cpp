#include "wifi_store.h"
#include <Preferences.h>

// Guarda la lista de redes WiFi conocidas en NVS (Preferences).
// Formato: keys "count", "ssid0..ssidN", "pass0..passN".
// Índice 0 = red más reciente / de mayor prioridad.

static Preferences prefs;
static bool ready = false;

void wifiStoreInit() {
    if (!ready) {
        prefs.begin("ivi_wifi", false);
        ready = true;
    }
}

static void ensureCount(int n) {
    int actual = wifiStoreCount();
    for (int i = actual; i > n; i--) {
        prefs.remove(("ssid" + String(i)).c_str());
        prefs.remove(("pass" + String(i)).c_str());
    }
    prefs.putUInt("count", n);
}

int wifiStoreCount() {
    if (!ready) wifiStoreInit();
    int n = prefs.getUInt("count", 0);
    if (n > WIFI_MAX_NETWORKS) n = WIFI_MAX_NETWORKS;
    return n;
}

bool wifiStoreGet(int idx, WifiEntry& out) {
    if (idx < 0 || idx >= wifiStoreCount()) return false;
    String s = prefs.getString(("ssid" + String(idx)).c_str(), "");
    String p = prefs.getString(("pass" + String(idx)).c_str(), "");
    if (s.length() == 0) return false;
    strncpy(out.ssid, s.c_str(), sizeof(out.ssid) - 1);
    strncpy(out.pass, p.c_str(), sizeof(out.pass) - 1);
    out.ssid[sizeof(out.ssid) - 1] = 0;
    out.pass[sizeof(out.pass) - 1] = 0;
    return true;
}

// Devuelve el índice donde ya existe ese ssid, o -1.
static int findSsid(const char* ssid) {
    int n = wifiStoreCount();
    for (int i = 0; i < n; i++) {
        WifiEntry e;
        if (wifiStoreGet(i, e) && strcmp(e.ssid, ssid) == 0) return i;
    }
    return -1;
}

bool wifiStorePush(const char* ssid, const char* pass) {
    if (!ssid || strlen(ssid) == 0) return false;

    int dup = findSsid(ssid);

    if (dup >= 0) {
        // Ya existe: moverlo al frente (reciente) sin duplicar.
        WifiEntry tmp;
        wifiStoreGet(dup, tmp);
        for (int i = dup; i > 0; i--) {
            WifiEntry prev;
            if (wifiStoreGet(i - 1, prev)) {
                prefs.putString(("ssid" + String(i)).c_str(), prev.ssid);
                prefs.putString(("pass" + String(i)).c_str(), prev.pass);
            }
        }
        prefs.putString("ssid0", ssid);
        prefs.putString("pass0", pass);
        return true;
    }

    int n = wifiStoreCount();
    if (n >= WIFI_MAX_NETWORKS) n = WIFI_MAX_NETWORKS - 1;
    for (int i = n - 1; i >= 0; i--) {
        WifiEntry e;
        if (wifiStoreGet(i, e)) {
            prefs.putString(("ssid" + String(i + 1)).c_str(), e.ssid);
            prefs.putString(("pass" + String(i + 1)).c_str(), e.pass);
        }
    }
    prefs.putString("ssid0", ssid);
    prefs.putString("pass0", pass);
    ensureCount(n + 1);
    return true;
}

void wifiStoreReplaceAll(const WifiEntry* entries, int n) {
    if (n > WIFI_MAX_NETWORKS) n = WIFI_MAX_NETWORKS;
    prefs.clear();
    int kept = 0;
    for (int i = 0; i < n; i++) {
        if (entries[i].ssid[0] == 0) continue;
        prefs.putString(("ssid" + String(kept)).c_str(), entries[i].ssid);
        prefs.putString(("pass" + String(kept)).c_str(), entries[i].pass);
        kept++;
    }
    ensureCount(kept);
}

void wifiStoreClear() {
    prefs.clear();
    ensureCount(0);
}