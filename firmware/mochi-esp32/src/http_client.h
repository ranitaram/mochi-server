#ifndef HTTP_CLIENT_H
#define HTTP_CLIENT_H

#include <Arduino.h>

struct IviReply {
    uint8_t* audio = nullptr;   // MP3 en memoria (PSRAM)
    size_t audioLen = 0;
    char texto[512] = {0};
    char emocion[32] = {0};
};

// Envia un WAV (body raw) al servidor y descarga el MP3 de respuesta.
// Devuelve el codigo HTTP recibido, o -1 si hubo error de conexion.
// El servidor responde 200 con MP3; 400/422 indican error de peticion
// (aun asi prueban que el transporte llego al servidor).
int httpSendAudio(const uint8_t* wav, size_t wavLen, IviReply& reply);

// GET /health — devuelve el codigo HTTP (200 = servidor arriba), -1 si no conecta.
int httpGetHealth();

void httpClientFree(IviReply& reply);

#endif
