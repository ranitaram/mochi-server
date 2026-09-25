#ifndef BATTERY_H
#define BATTERY_H

#include <Arduino.h>

void batteryInit();
void batteryPoll();
bool batteryPresent();
int  batteryPercent();
bool batteryCharging();

#endif