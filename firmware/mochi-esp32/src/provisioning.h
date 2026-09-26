#ifndef PROVISIONING_H
#define PROVISIONING_H

#include <Arduino.h>

// Portal cautivo de aprovisionamiento local.
// Prende el AP "Ivi-Setup" + portal DHCP/DNS y BLOQUEA hasta que el usuario
// escribe una red (SSID + contraseña) que conecta. La red se guarda en NVS
// (wifi_store, como la más reciente) y se apaga el portal.
// Devuelve true si Ivi quedó conectada a una red.
bool startCaptivePortal();

#endif