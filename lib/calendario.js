'use strict';

// ==================== EQUIPOS FAVORITOS Y CALENDARIO SINCRONIZABLE ====================
// Decisión de Yoel (3 oct 2026): cada persona elige sus equipos favoritos; la app le muestra sus
// próximos partidos, le avisa antes y puede sincronizarlos con el calendario de su teléfono.
// El calendario es un archivo iCalendar (RFC 5545) que Google Calendar / iPhone vuelven a leer
// solos cada pocas horas, así los partidos nuevos aparecen sin hacer nada y los avisos del propio
// calendario suenan aunque BetGroup esté cerrado.
//
// La dirección del calendario lleva un token HMAC-SHA256 (no adivinable) atado a la persona: quien
// no tenga el enlace no puede ver los equipos de nadie. Si se cambia el secreto, todos caducan.

const crypto = require('crypto');

const MAX_EQUIPOS = 5;
const DURACION_MIN = Object.freeze({ soccer: 120, basketball: 150, baseball: 180, mma: 240, tennis: 150 });

const sinAcentos = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function normalizar(nombre) {
  return sinAcentos(nombre).toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(fc|cf|sc|ac|club|de|the)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ¿El equipo del partido es uno de los favoritos? Igual, o uno contiene al otro (Inter ↔ Internazionale).
function coincide(equipoPartido, favorito) {
  const a = normalizar(equipoPartido), b = normalizar(favorito);
  if (!a || !b) return false;
  if (a === b) return true;
  const corto = a.length < b.length ? a : b, largo = a.length < b.length ? b : a;
  return corto.length >= 4 && (` ${largo} `).includes(` ${corto} `) || (corto.length >= 5 && largo.startsWith(corto));
}

// Valida la lista que manda la persona. Devuelve la lista limpia o lanza un Error con mensaje claro.
function limpiarEquipos(lista) {
  if (!Array.isArray(lista)) throw new Error('Formato de equipos no válido');
  const vistos = new Set(), res = [];
  for (const e of lista) {
    if (typeof e !== 'string') throw new Error('Formato de equipos no válido');
    const nombre = e.replace(/[\u0000-\u001F\u007F<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (nombre.length < 2) continue;
    const k = normalizar(nombre);
    if (!k || vistos.has(k)) continue;
    vistos.add(k); res.push(nombre);
  }
  if (res.length > MAX_EQUIPOS) throw new Error(`Puedes elegir hasta ${MAX_EQUIPOS} equipos`);
  return res;
}

function tokenCalendario(uid, secreto) {
  return crypto.createHmac('sha256', secreto).update('calendario:' + uid).digest('hex').slice(0, 32);
}
function tokenValido(uid, token, secreto) {
  const esperado = Buffer.from(tokenCalendario(uid, secreto));
  const dado = Buffer.from(String(token || ''));
  return dado.length === esperado.length && crypto.timingSafeEqual(dado, esperado);
}

// Partidos próximos (o en juego) de los equipos favoritos, ordenados por hora.
function partidosDe(eventos, equipos, ahora = Date.now()) {
  if (!equipos || !equipos.length) return [];
  return (eventos || []).filter(e => {
    const t = Date.parse(e && e.horaInicio);
    if (!Number.isFinite(t) || t < ahora - 3 * 3600000) return false;
    return equipos.some(f => coincide(e.local, f) || coincide(e.visitante, f));
  }).sort((a, b) => Date.parse(a.horaInicio) - Date.parse(b.horaInicio));
}

// ---------- iCalendar (RFC 5545) ----------
const fechaIcs = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const textoIcs = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// Líneas de máx. 75 octetos (las largas siguen en la línea siguiente empezando con un espacio).
function plegar(linea) {
  const bytes = Buffer.from(linea, 'utf8');
  if (bytes.length <= 75) return linea;
  const partes = []; let actual = '';
  for (const ch of linea) {
    if (Buffer.byteLength(actual + ch, 'utf8') > (partes.length ? 74 : 75)) { partes.push(actual); actual = ''; }
    actual += ch;
  }
  partes.push(actual);
  return partes.join('\r\n ');
}

function generarIcs(partidos, { nombre = 'BetGroup · Mis equipos', web = 'https://betgroup-cuba-2024.web.app', ahora = Date.now() } = {}) {
  const l = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BetGroup//Mis equipos//ES', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + textoIcs(nombre), 'X-WR-TIMEZONE:America/Havana',
    'X-PUBLISHED-TTL:PT6H', 'REFRESH-INTERVAL;VALUE=DURATION:PT6H'
  ];
  for (const p of partidos) {
    const ini = Date.parse(p.horaInicio);
    const fin = ini + (DURACION_MIN[p.sport] || 120) * 60000;
    const titulo = `${p.local} vs ${p.visitante}`;
    l.push('BEGIN:VEVENT',
      'UID:' + textoIcs(`${p.id}@betgroup`),
      'DTSTAMP:' + fechaIcs(ahora),
      'DTSTART:' + fechaIcs(ini), 'DTEND:' + fechaIcs(fin),
      'SUMMARY:' + textoIcs(titulo),
      'DESCRIPTION:' + textoIcs(`${p.liga || ''}\nMira las cuotas en BetGroup: ${web}`),
      'URL:' + web, 'CATEGORIES:' + textoIcs(p.liga || 'Deportes'),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + textoIcs(`En 1 hora: ${titulo}`), 'TRIGGER:-PT1H', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + textoIcs(`En 15 minutos: ${titulo}`), 'TRIGGER:-PT15M', 'END:VALARM',
      'END:VEVENT');
  }
  l.push('END:VCALENDAR');
  return l.map(plegar).join('\r\n') + '\r\n';
}

module.exports = { MAX_EQUIPOS, normalizar, coincide, limpiarEquipos, tokenCalendario, tokenValido, partidosDe, generarIcs };
