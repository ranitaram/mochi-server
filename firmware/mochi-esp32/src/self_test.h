#ifndef SELF_TEST_H
#define SELF_TEST_H

// Auto-test de arranque para validar la cadena sin piezas externas:
//  1. Conecta a WiFi y loguea IP + RSSI.
//  2. GET /health al servidor.
//  3. Genera un WAV de silencio en PSRAM y lo envia a POST /api/touch,
//     logueando el codigo HTTP devuelto.
// No dispara la FSM; deja la placa inactiva al terminar.
void selfTestRun();

#endif
