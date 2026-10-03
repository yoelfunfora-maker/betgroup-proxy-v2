// Prueba de equipos favoritos y del calendario sincronizable (.ics). Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { get, set, arrancar, ok } = require('./simulador');
const cal = require('../lib/calendario');

const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, extra = {}) {
  const email = `${uid.toLowerCase()}@x.com`;
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, nombre: uid, apodo: 'Fan', rol: 'member', rolLevel: 1, creditoReal: 0, creditoPromo: 0, ...extra });
}
usuario('BG_fan'); usuario('BG_otro');

const manana = new Date(Date.now() + 26 * 3600000).toISOString();
const pasado = new Date(Date.now() + 50 * 3600000).toISOString();
const partido = (id, local, visit, fecha) => ({
  id, date: fecha, status: { type: { state: 'pre' } },
  competitions: [{ status: { type: { state: 'pre' } }, competitors: [
    { homeAway: 'home', team: { displayName: local, logo: 'https://x/l.png' } },
    { homeAway: 'away', team: { displayName: visit, logo: 'https://x/v.png' } }] }]
});
const espn = (ruta) => {
  if (/eng\.1/.test(ruta)) return JSON.stringify({ leagues: [{ name: 'Premier League' }], events: [partido('700001', 'Arsenal', 'Chelsea', manana)] });
  if (/esp\.1/.test(ruta)) return JSON.stringify({ leagues: [{ name: 'LaLiga' }], events: [partido('700002', 'Real Sociedad', 'Getafe', pasado)] });
  if (/ita\.1/.test(ruta)) return JSON.stringify({ leagues: [{ name: 'Serie A' }], events: [partido('700003', 'Internazionale', 'Parma', pasado)] });
  return null;
};
const fetchReal = global.fetch;
const { llamar } = arrancar({ puerto: 3979, env: { ODDS_API_KEYS: '' }, espn });
const entrar = async (uid) => (await llamar('POST', '/api/auth/login', { identificador: `${uid.toLowerCase()}@x.com`, password: 'clave-1234' }))[1]?.token;

(async () => {
  try {
    await new Promise(r => setTimeout(r, 500));
    // Funciones básicas
    ok(cal.coincide('Internazionale', 'Inter') && cal.coincide('Atlético de Madrid', 'atletico madrid') && !cal.coincide('Real Madrid', 'Real Sociedad'),
      'reconoce el equipo aunque esté escrito distinto (Inter = Internazionale, sin tildes) y no confunde Real Madrid con Real Sociedad');
    const ics0 = cal.generarIcs([{ id: '1', local: 'Club con un nombre larguísimo, de verdad muy largo', visitante: 'Otro; equipo', liga: 'Liga', sport: 'soccer', horaInicio: manana }]);
    ok(ics0.split('\r\n').every(l => Buffer.byteLength(l, 'utf8') <= 75) && /SUMMARY:Club con un nombre larguísimo\\, de/.test(ics0.replace(/\r\n /g, '')) && /Otro\\; equipo/.test(ics0.replace(/\r\n /g, '')),
      'el archivo de calendario cumple el estándar (líneas de máx. 75, comas y punto y coma escapados)');

    // Esperar a que el servidor cargue los partidos
    for (let i = 0; i < 30; i++) { const f = await (await fetchReal('http://127.0.0.1:3979/api/fixtures')).json(); if ((f.data || []).length) break; await new Promise(r => setTimeout(r, 300)); }

    const t = await entrar('BG_fan');
    let [s, j] = await llamar('POST', '/api/perfil/favoritos', { equipos: ['Arsenal', 'Chelsea', 'Barcelona', 'Boca Juniors', 'Napoli', 'Santos'] }, t);
    ok(s === 400 && /hasta 5/.test(j.error), 'máximo 5 equipos favoritos');
    [s, j] = await llamar('POST', '/api/perfil/favoritos', { equipos: ['Arsenal', 'arsenal', ' Inter ', '<b>x', 'Z'] }, t);
    ok(s === 200 && JSON.stringify(j.equipos) === JSON.stringify(['Arsenal', 'Inter', 'bx']) && JSON.stringify(get('users/BG_fan/equiposFavoritos')) === JSON.stringify(['Arsenal', 'Inter', 'bx']),
      'guarda los favoritos limpios (sin repetidos, sin < >, sin nombres de 1 letra) → ' + JSON.stringify(j.equipos));
    ok(/^https?:\/\/.+\/api\/calendario\/BG_fan\/[0-9a-f]{32}\.ics$/.test(j.calendario.https) && j.calendario.webcal.startsWith('webcal://') && j.calendario.google.startsWith('https://calendar.google.com/'),
      'devuelve los enlaces para sincronizar: Google Calendar, iPhone (webcal) y directo');
    [s] = await llamar('POST', '/api/db', { op: 'escribir', ruta: 'users/BG_fan/equiposFavoritos', valor: ['x'] }, t);
    ok(s === 403, 'los favoritos solo se cambian por su función (validada), no por la vía genérica');

    const ruta = j.calendario.https.replace(/^https?:\/\/[^/]+/, '');
    const r = await fetchReal('http://127.0.0.1:3979' + ruta);
    const ics = await r.text();
    ok(r.status === 200 && /text\/calendar/.test(r.headers.get('content-type')) && /BEGIN:VCALENDAR/.test(ics), 'el teléfono recibe un calendario válido');
    ok(/SUMMARY:Arsenal vs Chelsea/.test(ics) && /SUMMARY:Internazionale vs Parma/.test(ics) && !/Getafe/.test(ics),
      'solo trae los partidos de SUS equipos (Arsenal e Inter), no los demás');
    ok((ics.match(/TRIGGER:-PT1H/g) || []).length === 2 && (ics.match(/TRIGGER:-PT15M/g) || []).length === 2, 'cada partido trae avisos 1 hora y 15 minutos antes (los da el calendario aunque la app esté cerrada)');

    const r2 = await fetchReal('http://127.0.0.1:3979/api/calendario/BG_fan/' + '0'.repeat(32) + '.ics');
    ok(r2.status === 404, 'sin el token correcto no se ve el calendario de nadie');
    const r3 = await fetchReal('http://127.0.0.1:3979' + ruta.replace('BG_fan', 'BG_otro'));
    ok(r3.status === 404, 'el token de una persona no sirve para ver el de otra');
  } catch (e) {
    ok(false, 'error inesperado: ' + e.message);
  }
  process.exit(0);
})();
