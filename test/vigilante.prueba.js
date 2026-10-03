// Prueba del vigilante de Firebase: si una lectura no responde, fuerza la reconexión al momento.
'use strict';
const { crearVigilanteFirebase } = require('../lib/vigilanteFirebase');
const ok = (c, m) => console.log((c ? '✅ ' : '❌ ') + m);

(async () => {
  let colgado = true, offline = 0, online = 0;
  const db = {
    ref: () => ({ once: () => (colgado ? new Promise(() => {}) : Promise.resolve({ val: () => 100 })) }),
    goOffline: () => { offline++; colgado = false; }, // al reconectar, vuelve a responder
    goOnline: () => { online++; }
  };
  const silencio = { log() {}, warn() {} };
  const v = crearVigilanteFirebase({ db, limiteMs: 200, pausaMinMs: 1000, log: silencio });
  const t0 = Date.now();
  const r1 = await v.comprobar();
  ok(r1 === false && Date.now() - t0 < 1000, 'detecta en menos de 1 s que Firebase no responde (antes se esperaba ~60 s)');
  await new Promise(r => setTimeout(r, 400));
  ok(offline === 1 && online === 1, 'fuerza la reconexión (goOffline → goOnline)');
  ok(await v.comprobar() === true && v.estado.fallosSeguidos === 0, 'tras reconectar, vuelve a responder');
  colgado = true;
  await v.comprobar();
  ok(offline === 1, 'no reconecta en bucle: espera un mínimo entre reconexiones');
  ok(v.estado.reconexiones === 1 && typeof v.estado.ultimaLatenciaMs === 'number', 'deja constancia (reconexiones y latencia) para /api/health');
  process.exit(0);
})();
