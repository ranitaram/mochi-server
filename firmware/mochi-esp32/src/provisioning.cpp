#include "provisioning.h"
#include "wifi_store.h"
#include "config.h"
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>

// Portal cautivo "Ivi-Setup":
//  - WiFi en modo AP (red abierta "Ivi-Setup", IP 192.168.4.1).
//  - DNSServer responde CADA dominio con la IP del AP → el teléfono/notebook
//    abre el portal automáticamente (detección de captive portal).
//  - Un pequeño HTML pide SSID + contraseña; al enviarlos probamos la
//    conexión; si conecta, guardamos la red en NVS y cerramos el portal.

#define AP_SSID    "Ivi-Setup"
#define CONNECT_RETRY_MS 12000UL

static WebServer server(80);
static DNSServer dns;
static bool connected = false;
static String lastError = "";
static String lastSsid = "";

static const char HTML_FORM[] PROGMEM = R"HTML(
<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Configurar Ivi</title><style>
body{margin:0;background:#17181c;color:#e8e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:#23252b;padding:2rem 2.2rem;border-radius:14px;width:300px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
h1{font-size:1.2rem;color:#7ed3a0;margin:0 0 .4rem}
p.copy{margin:0 0 1.2rem;color:#9aa0b4;font-size:.85rem}
label{display:block;margin:.6rem 0 .25rem;font-size:.8rem;color:#9aa0b4}
input{width:100%;box-sizing:border-box;padding:.6rem;border:1px solid #3a3d46;border-radius:8px;background:#17181c;color:#fff}
button{margin-top:1rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#2f9e63;color:#fff;font-weight:600;cursor:pointer}
.err{color:#ff7b72;margin-top:.7rem;font-size:.85rem}
</style></head><body><div class="card">
<h1>Configurar red de Ivi</h1>
<p class="copy">Escribí la red WiFi que tenés cerca y la contraseña.</p>
%ERR%
<form method="post" action="/submit">
<label>SSID de la red</label>
<input name="ssid" value="%SSID%" placeholder="Nombre de tu WiFi" required>
<label>Contraseña</label>
<input name="pass" type="password" placeholder="Contraseña de la red" required>
<button type="submit">Conectar Ivi</button>
</form>
</div></body></html>
)HTML";

static void apOn() {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID);
    delay(200);
    dns.start(53, "*", WiFi.softAPIP());
}

static void serverBegin() {
    server.on("/", HTTP_GET, []() {
        String html = FPSTR(HTML_FORM);
        html.replace("%ERR%", lastError.length() ? "<p class=\"err\">" + lastError + "</p>" : "");
        html.replace("%SSID%", lastSsid);
        server.send(200, "text/html; charset=utf-8", html);
    });

    server.on("/submit", HTTP_POST, []() {
        String ssid = server.arg("ssid");
        String pass = server.arg("pass");
        ssid.trim();
        lastSsid = ssid;
        if (ssid.length() == 0 || pass.length() == 0) {
            lastError = "Faltan datos.";
            server.sendHeader("Location", "/");
            server.send(302, "", "");
            return;
        }

        Serial.printf("[prov] Probando red \"%s\"...\n", ssid.c_str());
        WiFi.mode(WIFI_STA);
        dns.stop();
        server.stop();

        WiFi.begin(ssid.c_str(), pass.c_str());
        unsigned long t0 = millis();
        while (millis() - t0 < CONNECT_RETRY_MS) {
            if (WiFi.status() == WL_CONNECTED) {
                wifiStorePush(ssid.c_str(), pass.c_str());
                connected = true;
                Serial.printf("[prov] Conectado a \"%s\". Portal cerrado.\n", ssid.c_str());
                return;
            }
            delay(150);
        }

        Serial.printf("[prov] No conectó a \"%s\" (pass inválida o sin señal).\n", ssid.c_str());
        lastError = "No pude conectar a esa red. Verificá el nombre y la contraseña.";
        WiFi.mode(WIFI_AP);
        // Re-montar AP + server con el ssid para que el form lo recorte
        apOn();
        serverBegin();
    });

    server.onNotFound([]() {
        server.sendHeader("Location", "/");
        server.send(302, "", "");
    });

    server.begin();
}

bool startCaptivePortal() {
    connected = false;
    lastError = "";
    Serial.println("[prov] Modo aprovisionamiento: AP 'Ivi-Setup' activo.");
    Serial.println("[prov] Conectate a la red 'Ivi-Setup' y abri http://192.168.4.1");
    apOn();
    serverBegin();

    while (!connected) {
        dns.processNextRequest();
        server.handleClient();
        delay(10);
    }

    WiFi.mode(WIFI_STA);   // asegura quedar en modo cliente
    return true;
}