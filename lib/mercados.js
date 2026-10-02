'use strict';

// ==================== TIPOS DE APUESTA (MERCADOS) ====================
// Un solo sitio que sabe: qué significa cada tipo de apuesta, qué cuota le
// corresponde según el servidor y cómo se resuelve con el marcador final.
//
//   'Local' | 'Visitante' | 'Empate'          → 1X2
//   'Handicap <equipo> (+1.5)'                → hándicap (el equipo suma la línea)
//   'Over 2.5' | 'Under 2.5'                  → total de goles/puntos
//
// Resultado: 'ganada' | 'perdida' | 'anulada' (empate exacto con la línea = se devuelve).

const BASICOS = Object.freeze(['Local', 'Visitante', 'Empate']);
const HANDICAP_RE = /^Handicap (.{1,120}) \(([+-]?\d{1,3}(?:\.\d{1,2})?)\)$/;
const TOTAL_RE = /^(Over|Under) (\d{1,3}(?:\.\d{1,2})?)$/;

function iguales(a, b) {
  return Math.abs(Number(a) - Number(b)) < 1e-9;
}

// Convierte el texto del tipo en una descripción. ev (opcional) sirve para saber
// si el equipo del hándicap es el local o el visitante.
function interpretar(tipo, ev) {
  if (typeof tipo !== 'string' || tipo.length > 160) return null;
  if (BASICOS.includes(tipo)) return { clase: '1x2', seleccion: tipo };
  let m = TOTAL_RE.exec(tipo);
  if (m) return { clase: 'total', lado: m[1] === 'Over' ? 'over' : 'under', linea: Number(m[2]) };
  m = HANDICAP_RE.exec(tipo);
  if (m) {
    const equipo = m[1];
    const linea = Number(m[2]);
    if (!ev) return { clase: 'handicap', equipo, linea };
    if (equipo === ev.local) return { clase: 'handicap', lado: 'local', equipo, linea };
    if (equipo === ev.visitante) return { clase: 'handicap', lado: 'visitante', equipo, linea };
    return null;
  }
  return null;
}

function cuotaValida(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 1 ? n : null;
}

// Cuota que el servidor tiene para ese mercado (null = no se puede apostar).
function cuotaPara(ev, mercado) {
  if (!ev || !mercado) return null;
  if (mercado.clase === '1x2') {
    if (mercado.seleccion === 'Empate' && ev.sport !== 'soccer') return null;
    return cuotaValida({ Local: ev.cuota_local, Visitante: ev.cuota_visitante, Empate: ev.cuota_empate }[mercado.seleccion]);
  }
  if (mercado.clase === 'total') {
    const punto = mercado.lado === 'over' ? ev.total_over_point : ev.total_under_point;
    const precio = mercado.lado === 'over' ? ev.total_over_price : ev.total_under_price;
    return punto !== undefined && punto !== null && iguales(punto, mercado.linea) ? cuotaValida(precio) : null;
  }
  if (mercado.clase === 'handicap' && mercado.lado) {
    const punto = mercado.lado === 'local' ? ev.handicap_local : ev.handicap_visitante;
    const precio = mercado.lado === 'local' ? ev.handicap_local_cuota : ev.handicap_visitante_cuota;
    return punto !== undefined && punto !== null && iguales(punto, mercado.linea) ? cuotaValida(precio) : null;
  }
  return null;
}

// Decide la apuesta. marcador = { local, visitante } (números) o null.
// ganador = 'Local' | 'Visitante' | 'Empate' cuando solo se sabe quién ganó (tenis, UFC).
function resolver(mercado, { marcador = null, ganador = null } = {}) {
  if (!mercado) return null;
  if (mercado.clase === '1x2') {
    let g = ganador;
    if (!g && marcador) g = marcador.local > marcador.visitante ? 'Local' : marcador.local < marcador.visitante ? 'Visitante' : 'Empate';
    if (!g) return null;
    return mercado.seleccion === g ? 'ganada' : 'perdida';
  }
  if (!marcador) return null; // hándicap y totales necesitan el marcador
  if (mercado.clase === 'total') {
    const suma = marcador.local + marcador.visitante;
    if (iguales(suma, mercado.linea)) return 'anulada';
    const gana = mercado.lado === 'over' ? suma > mercado.linea : suma < mercado.linea;
    return gana ? 'ganada' : 'perdida';
  }
  if (mercado.clase === 'handicap' && mercado.lado) {
    const propio = mercado.lado === 'local' ? marcador.local : marcador.visitante;
    const rival = mercado.lado === 'local' ? marcador.visitante : marcador.local;
    const ajustado = propio + mercado.linea;
    if (iguales(ajustado, rival)) return 'anulada';
    return ajustado > rival ? 'ganada' : 'perdida';
  }
  return null;
}

// Marcador "2-1" → { local: 2, visitante: 1 }
function leerMarcador(texto) {
  const m = /^\s*(\d{1,3})\s*-\s*(\d{1,3})\s*$/.exec(String(texto || ''));
  return m ? { local: Number(m[1]), visitante: Number(m[2]) } : null;
}

module.exports = { interpretar, cuotaPara, resolver, leerMarcador, BASICOS };
