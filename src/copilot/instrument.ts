// instrument.ts — Registro de cada turno para el experimento.
//
// El objetivo es COMPARAR Ivi con y sin estado de OpenCode, así que un log sin
// condición no sirve de nada: cada turno lleva la de su día.
//
// REGLA DE PRIVACIDAD: el log lleva la pregunta y la respuesta COMPLETAS porque
// sin eso no se puede evaluar si Ivi alucinó. Aun así, se redactan secretos
// antes de escribir (el mismo filtro del resto del sistema) y el archivo local
// tiene permisos 600.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactarTexto } from "./redact";

const DIR = path.join(os.homedir(), ".local", "state", "ivi");
const ARCHIVO = path.join(DIR, "turnos.log");

export interface RegistroTurno {
  ts: string;
  condicion: "ivi" | "agentes";
  sesion_ivi: string;
  pregunta: string;
  respuesta: string;
  emocion: string;
  latencia_ms: number;
  /** ms que tomó el LLM, separado del TTS. */
  llm_ms?: number;
  tokens_prompt?: number;
  tokens_completion?: number;
  modelo?: string;
  /** Si el contexto del copiloto se inyectó o no. */
  copilot: boolean;
  chars_contexto?: number;
  emergency?: boolean;
}

/**
 * El usuario exporta IVI_CONDICION=agentes|ivi para cambiar de día.
 * Si no está definida, todo se registra como "ivi".
 */
export function condicionActual(): "ivi" | "agentes" {
  const v = (process.env.IVI_CONDICION ?? "ivi").toLowerCase();
  return v === "agentes" ? "agentes" : "ivi";
}

export function registrarTurno(r: RegistroTurno): void {
  try {
    const linea =
      JSON.stringify({
        ...r,
        pregunta: redactarTexto(r.pregunta),
        respuesta: redactarTexto(r.respuesta),
      }) + "\n";
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(ARCHIVO, linea, { mode: 0o600 });
  } catch (err: any) {
    // El registro NUNCA puede romper el turno de voz.
    console.warn("[instrument] No se pudo registrar el turno:", err?.message);
  }
}

export function rutaLogTurnos(): string {
  return ARCHIVO;
}