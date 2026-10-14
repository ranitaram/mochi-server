#!/usr/bin/env node
// test-tts.mjs — Pruebas offline del TTS (fallback y motivo)

(async () => {
  const { generarAudioMP3, setFallbackAudio } = await import("../dist/tts.js");
  let total = 0;
  let fallos = 0;
  const check = (ok, msg) => {
    total++;
    if (ok) console.log(`  OK  ${msg}`);
    else { fallos++; console.log(`  FALLA ${msg}`); }
  };
  process.env.TTS_FORCE_FAIL = "1";
  const dummy = Buffer.from("MP3DUMMY");
  setFallbackAudio(dummy);
  try {
    const buf = await generarAudioMP3("hola");
    check(buf.equals(dummy), "con TTS_FORCE_FAIL devuelve fallbackAudio");
  } catch (e) { fallos++; total++; console.error("FALLA", e); }
  try {
    let motivo = null;
    await generarAudioMP3("hola2", undefined, (m) => { motivo = m; });
    check(motivo !== null, "onFallback recibe motivo");
    const mstr = String(motivo).toLowerCase();
    check(mstr.includes("tts_force_fail") || mstr.includes("edge tts"), "motivo contiene causa (fallback)");
  } catch (e) { fallos++; total++; }
  if (fallos === 0) { console.log(`\n  ${total} pruebas: TODAS PASAN`); process.exit(0); }
  else { console.error(`\n  ${fallos}/${total} fallan`); process.exit(1); }
})();
