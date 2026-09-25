#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <Arduino.h>

void wifiConnect();
bool wifiConnected();
void wifiLoop();   // reconexion automatica

#endif
