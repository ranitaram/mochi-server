# Alimentación: LiPo → TP4056 → MT3608 → ESP32

> Esquema actual de energía de Ivi. NO es power-bank: el MT3608 es un boost
> puro, **siempre activo** en cuanto tiene voltaje de entrada.

## Esquema

```
USB 5V ──► TP4056 (IN) ──► B+ / B- ──► LiPo (1S, 3.0–4.2V)
                                         │
                          MT3608 (IN) ◄──┤  (boost puro, siempre activo)
                          MT3608 (OUT)──► 5Vin ESP32-S3
                          MT3608 (GND) ──► GND común
```

- USB solo carga la batería vía TP4056.
- El ESP32 se alimenta **solo** desde el OUT del MT3608 (`5Vin`). No unir USB
  con el 5Vin directo (compiten y pueden voltear corriente al USB del host).

## MT3608 — setpoint IMPORTANTE

- Con el **potenciómetro azul**, ajustar el OUT a **~5.0–5.2V** usando un
  multímetro **ANTES** de conectarlo al ESP (proteger la placa).
- Rango de entrada del MT3608: ≥2V → cubre LiPo de 3.0 a 4.2V.

## Medición de batería (sin fuel gauge digital)

El % del ícono del OLED se estima **por voltaje** con un divisor:

```
LiPo+ ── R1 100kΩ ──┬── GPIO4 (ADC1_CH3)
                    │
                    R2 47kΩ
                    │
                   GND
```

- Factor del divisor: `VBATT = V_nodo × (R1+R2)/R2 ≈ ×3.13`.
- Máx. nodo ≈ 4.2×47/147 ≈ **1.34V** (dentro del rango ADC).
- Curva en `config.h`: `BATTERY_V_FULL_MV=4200` (100%) → `BATTERY_V_EMPTY_MV=3000`
  (0%), lineal. Es una estimación; **calibrar** comparando con el multímetro
  (puede ajustarse compensando el sag bajo carga del amp con el filtro 80/20
  que ya está en `battery.cpp`).
- Si la lectura baja de `BATTERY_V_MIN_PRESENT_MV=2600mV` → icono muestra `USB`
  (sin batería).

## Sin deep sleep (decisión)

No se usa el modo de sleep: dormir solo el ESP ahorra
poco contra el drenaje constante del boost/reguladores, y sin BMS/fuel gauge
una LiPo podría descargarse bajo el mínimo seguro. Hasta que haya BMS o módulo
con fuel gauge, **usar un switch físico de encendido** para cortar la batería
(sobre todo en reposo prolongado de un día).

## Corriente de reposo

El MT3608 + TP4056 + ESP (WiFi on) tienen drenaje en reposo; desenchufar o
cortar con switch si no se usará en horas.