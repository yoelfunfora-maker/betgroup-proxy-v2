'use strict';

// ==================== VIGILANTE DE LA CONEXIÓN CON FIREBASE ====================
// Problema real (registros del 3 oct 2026): cada cierto tiempo la conexión del servidor con
// Firebase se queda "muerta" sin avisar y TODA lectura espera ~60 s hasta que el SDK lo detecta
// y reconecta. Mientras tanto el login se quedaba en "Verificando…" y la web parecía paralizada.
//
// Solución: cada 15 s se hace una lectura diminuta. Si no responde en 5 s, se fuerza la
// reconexión al momento (goOffline → goOnline). Las lecturas que estaban esperando se reenvían
// solas al reconectar. Así un corte dura segundos en vez de un minuto.

function crearVigilanteFirebase({ db, ruta = 'config/minBet', cadaMs = 15000, limiteMs = 5000, pausaMinMs = 30000, log = console, ahora = () => Date.now() }) {
  const estado = { ultimaLatenciaMs: null, ultimaComprobacion: null, reconexiones: 0, ultimaReconexion: null, fallosSeguidos: 0 };
  let temporizador = null;
  let comprobando = false;

  function reconectar() {
    if (estado.ultimaReconexion && ahora() - estado.ultimaReconexion < pausaMinMs) return false;
    estado.ultimaReconexion = ahora();
    estado.reconexiones++;
    try { db.goOffline(); } catch (e) { /* nada */ }
    setTimeout(() => { try { db.goOnline(); } catch (e) { /* nada */ } }, 300);
    return true;
  }

  async function comprobar() {
    if (comprobando) return null;
    comprobando = true;
    const t0 = ahora();
    let reloj;
    try {
      const respondio = await Promise.race([
        db.ref(ruta).once('value').then(() => true, () => true),
        new Promise((ok) => { reloj = setTimeout(() => ok(false), limiteMs); })
      ]);
      estado.ultimaComprobacion = new Date(ahora()).toISOString();
      if (respondio) {
        estado.ultimaLatenciaMs = ahora() - t0;
        if (estado.fallosSeguidos) log.log(`✅ Firebase vuelve a responder (${estado.ultimaLatenciaMs} ms)`);
        else if (estado.ultimaLatenciaMs > 1500) log.warn(`⚠️ Firebase lento: ${estado.ultimaLatenciaMs} ms`);
        estado.fallosSeguidos = 0;
        return true;
      }
      estado.fallosSeguidos++;
      const hecho = reconectar();
      log.warn(`⚠️ Firebase no respondió en ${limiteMs / 1000} s${hecho ? ': reconectando ya' : ' (reconexión reciente, se espera)'}`);
      return false;
    } finally {
      clearTimeout(reloj);
      comprobando = false;
    }
  }

  function iniciar() {
    if (!temporizador) {
      temporizador = setInterval(() => { comprobar().catch(() => {}); }, cadaMs);
      if (temporizador.unref) temporizador.unref();
    }
  }
  function parar() { clearInterval(temporizador); temporizador = null; }

  return { iniciar, parar, comprobar, estado };
}

module.exports = { crearVigilanteFirebase };
