#include "battery.h"
#include "config.h"

// Medición de batería por voltaje (divisor en BATTERY_ADC_PIN):
// esquema LiPo -> TP4056 -> MT3608, sin fuel gauge digital. El % del ícono
// del OLED se estima con una curva LiPo lineal (3.0V = 0% .. 4.2V = 100%).
// Sin batería conectada (lectura < BATTERY_V_MIN_PRESENT_MV) el ícono
// muestra "USB".

static bool battPresent = false;
static bool battCharging = false;
static unsigned long battLastProbe = 0;
static int battSmoothedMv = -1;   // mV reales de bateria, filtrados
static int battPercent = -1;

static int battMvToPercent(int mv) {
    if (mv <= BATTERY_V_EMPTY_MV) return 0;
    if (mv >= BATTERY_V_FULL_MV) return 100;
    return (int)((long)(mv - BATTERY_V_EMPTY_MV) * 100
                 / (BATTERY_V_FULL_MV - BATTERY_V_EMPTY_MV));
}

// Lectura del divisor: promedia 8 muestras y aplica el factor R1/R2 para
// devolver el voltaje real de la LiPo en mV.
static int battAdcRawMv() {
    long sum = 0;
    for (int i = 0; i < 8; i++) {
        sum += analogReadMilliVolts(BATTERY_ADC_PIN);
        delay(2);
    }
    int nodeMv = (int)(sum / 8);
    long factorNum = (long)BATTERY_ADC_R1_OHM + BATTERY_ADC_R2_OHM;
    return (int)((long)nodeMv * factorNum / BATTERY_ADC_R2_OHM);
}

static void battAdcSample() {
    if (!BATTERY_ADC_EN) return;
    int mv = battAdcRawMv();
    // filtro paso bajo (80/20) para que no brinque con el sag del amp
    battSmoothedMv = (battSmoothedMv < 0) ? mv : (battSmoothedMv * 4 + mv) / 5;
    if (battSmoothedMv < (int)BATTERY_V_MIN_PRESENT_MV) {
        battPresent = false;
        battPercent = -1;
        return;
    }
    if (!battPresent) battPresent = true;
    battPercent = battMvToPercent(battSmoothedMv);
    battCharging = false;
}

void batteryInit() {
    if (!BATTERY_ADC_EN) {
        Serial.println("[batt] Sin sensor de bateria: icono en modo USB.");
        return;
    }
    // primero un read registra el pin como ADC (periman); luego se puede
    // fijar la atenuacion por pin. Sin el read previo, el core loguea
    // "Pin is not configured as analog channel" y no aplica el atten.
    analogReadMilliVolts(BATTERY_ADC_PIN);
    analogSetPinAttenuation(BATTERY_ADC_PIN, ADC_11db);
    battAdcSample();
    Serial.printf("[batt] Sensor ADC: divisor R1=%d R2=%d en GPIO%d\n",
                  (int)BATTERY_ADC_R1_OHM, (int)BATTERY_ADC_R2_OHM,
                  BATTERY_ADC_PIN);
    if (battPresent)
        Serial.printf("[batt] Lectura inicial: %d mV = %d%%\n",
                      battSmoothedMv, battPercent);
    else
        Serial.println("[batt] Sin bateria (modo USB); icono mostrara USB.");
}

void batteryPoll() {
    unsigned long ts = millis();
    if (ts - battLastProbe < (unsigned long)BATTERY_POLL_MS) return;
    battLastProbe = ts;
    if (!BATTERY_ADC_EN) return;
    battAdcSample();
    if (battPresent)
        Serial.printf("[batt] nivel ADC: %d mV = %d%%\n",
                      battSmoothedMv, battPercent);
}

bool batteryPresent()  { return battPresent; }
int  batteryPercent()  { return battPercent; }
bool batteryCharging() { return battCharging; }