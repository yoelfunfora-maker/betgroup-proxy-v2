'use strict';

// ==================== VALIDACIÓN DE ENTRADAS ====================
// Todo dato que llega del cliente pasa por aquí antes de tocar la base de datos.

// Un UID nunca puede contener caracteres que cambien la ruta en Firebase (/ . # $ [ ]).
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const TIPOS_APUESTA = Object.freeze(['Local', 'Visitante', 'Empate']);
const MONTO_MAXIMO = 1000000;

function esUid(valor) {
  return typeof valor === 'string' && UID_RE.test(valor);
}

// Texto limpio: sin caracteres de control, recortado y con longitud máxima.
function texto(valor, maximo) {
  if (typeof valor !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const limpio = valor.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  if (!limpio || limpio.length > maximo) return null;
  return limpio;
}

// Monto positivo, finito, con 2 decimales como máximo y por debajo del tope.
function monto(valor) {
  const n = typeof valor === 'string' ? Number(valor) : valor;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (n <= 0 || n > MONTO_MAXIMO) return null;
  if (Math.round(n * 100) !== n * 100) return null;
  return n;
}

function tipoApuesta(valor) {
  return TIPOS_APUESTA.includes(valor) ? valor : null;
}

// Solo URLs https (logos); cualquier otra cosa (javascript:, data:) se descarta.
function urlHttps(valor) {
  const t = texto(valor, 500);
  if (!t) return null;
  try {
    return new URL(t).protocol === 'https:' ? t : null;
  } catch {
    return null;
  }
}

// Copia solo los campos conocidos de un evento enviado por el cliente.
function eventoCliente(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const local = texto(ev.local, 120);
  const visitante = texto(ev.visitante, 120);
  const sport = texto(ev.sport, 30);
  if (!local || !visitante || !sport) return null;
  return {
    id: texto(String(ev.id ?? ''), 64) || null,
    sport,
    liga: texto(ev.liga, 120) || sport,
    local,
    visitante,
    horaInicio: texto(ev.horaInicio, 40) || null,
    estado: ev.estado === 'live' ? 'live' : 'scheduled',
    marcador: texto(ev.marcador, 20) || null,
    minuto: texto(ev.minuto, 20) || null,
    homeLogo: urlHttps(ev.homeLogo),
    awayLogo: urlHttps(ev.awayLogo),
    ligaLogo: urlHttps(ev.ligaLogo),
    cuota_local: null,
    cuota_empate: null,
    cuota_visitante: null
  };
}

module.exports = { esUid, texto, monto, tipoApuesta, eventoCliente, TIPOS_APUESTA, MONTO_MAXIMO };
