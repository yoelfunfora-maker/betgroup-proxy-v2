// Prueba del favorito elegido de un catálogo real: buscador letra a letra, guardado por id oficial
// (nunca lo que escribe el navegador) y partidos reconocidos por id. Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { get, set, arrancar, ok } = require('./simulador');
const { buscarEn, equiposDeEspn } = require('../lib/equipos');

const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
set('credenciales_acceso/fan-x-com', { email: 'fan@x.com', uid: 'BG_fan', salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
set('users/BG_fan', { uid: 'BG_fan', email: 'fan@x.com', activo: true, nombre: 'Fan', apodo: 'Fan', rol: 'member', rolLevel: 1, creditoReal: 0, creditoPromo: 0, equiposFavoritos: ['Industriales'] });

// Equipos "de ESPN" para el catálogo (más de 50, como el real).
const equipo = (id, nombre, extra = {}) => ({ team: { id: String(id), displayName: nombre, shortDisplayName: extra.corto || nombre, abbreviation: extra.abrev || nombre.slice(0, 3).toUpperCase(), logos: [{ href: `https://a.espncdn.com/i/teamlogos/soccer/500/${id}.png` }] } });
const ESP = [equipo(83, 'Barcelona'), equipo(86, 'Real Madrid'), equipo(244, 'Real Betis'), equipo(89, 'Real Sociedad'), equipo(1068, 'Atlético Madrid')];
const ECU = [equipo(4815, 'Barcelona SC')];
const RELLENO = Array.from({ length: 60 }, (_, i) => equipo(9000 + i, `Club Relleno ${i}`));
const teams = (lista) => JSON.stringify({ sports: [{ leagues: [{ teams: lista }] }] });
const manana = new Date(Date.now() + 26 * 3600000).toISOString();
const partido = (id, l, v) => ({ id, date: manana, status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
  { homeAway: 'home', team: { id: String(l[0]), displayName: l[1] } }, { homeAway: 'away', team: { id: String(v[0]), displayName: v[1] } }] }] });
const espn = (ruta) => {
  if (/esp\.1\/teams/.test(ruta)) return teams(ESP);
  if (/conmebol\.libertadores\/teams/.test(ruta)) return teams(ECU);
  if (/eng\.1\/teams/.test(ruta)) return teams(RELLENO);
  if (/\/teams/.test(ruta)) return teams([]);
  // Partidos: el Barcelona de España y el de Ecuador juegan mañana.
  if (/esp\.1\/scoreboard/.test(ruta)) return JSON.stringify({ leagues: [{ name: 'LaLiga' }], events: [partido('800001', [83, 'Barcelona'], [86, 'Real Madrid'])] });
  if (/conmebol\.libertadores\/scoreboard/.test(ruta)) return JSON.stringify({ leagues: [{ name: 'Libertadores' }], events: [partido('800002', [4815, 'Barcelona SC'], [9999, 'Otro'])] });
  return null;
};
const fetchReal = global.fetch;
const { llamar } = arrancar({ puerto: 3973, env: { ODDS_API_KEYS: '' }, espn });

(async () => {
  try {
    // ---- Funciones puras ----
    const cat = [...equiposDeEspn(JSON.parse(teams(ESP)), { sport: 'soccer', liga: 'LaLiga', pais: 'España', ruta: 'soccer/esp.1' }),
      ...equiposDeEspn(JSON.parse(teams(ECU)), { sport: 'soccer', liga: 'Copa Libertadores', pais: 'Sudamérica', ruta: 'x' })];
    ok(buscarEn(cat, 'b').map(e => e.nombre).join(', ') === 'Barcelona, Barcelona SC, Real Betis', 'con "b" salen todos los que empiezan por B (también "Real Betis" por su nombre) → ' + buscarEn(cat, 'b').map(e => e.nombre).join(', '));
    ok(buscarEn(cat, 'real s').map(e => e.nombre).join() === 'Real Sociedad', 'la lista se reduce al ir completando: "real s" → Real Sociedad');
    ok(buscarEn(cat, 'atletico').length === 1 && buscarEn(cat, 'ATLÉTICO').length === 1, 'sin importar tildes ni mayúsculas');
    const malo = equiposDeEspn({ sports: [{ leagues: [{ teams: [{ team: { id: '1', displayName: 'X<script>', logos: [{ href: 'javascript:alert(1)' }] } }] }] }] }, { sport: 'soccer' });
    ok(malo[0].nombre === 'Xscript' && malo[0].logo === null, 'datos raros de ESPN se limpian (sin < > ni enlaces que no sean de ESPN)');

    await new Promise(r => setTimeout(r, 800));
    const t = (await llamar('POST', '/api/auth/login', { identificador: 'fan@x.com', password: 'clave-1234' }))[1].token;

    // ---- Buscador ----
    let [s, j] = await llamar('GET', '/api/equipos/buscar?q=bar', null, t);
    ok(s === 200 && j.equipos.length === 2 && j.equipos[0].logo && j.equipos[0].liga === 'LaLiga' && j.equipos[0].pais === 'España',
      'el buscador devuelve los equipos reales con escudo, liga y país → ' + (j.equipos || []).map(e => `${e.nombre} (${e.liga} · ${e.pais})`).join(' | '));
    const barcaEsp = j.equipos.find(e => e.pais === 'España');
    [s] = await llamar('GET', '/api/equipos/buscar?q=bar');
    ok(s === 401, 'el buscador requiere sesión');

    // ---- Guardar por id (y conservar el favorito antiguo escrito a mano) ----
    [s, j] = await llamar('POST', '/api/perfil/favoritos', { ids: [barcaEsp.id], legado: ['Industriales'] }, t);
    const fav = get('users/BG_fan/equiposFavoritos');
    ok(s === 200 && fav.length === 2 && fav[0] === 'Industriales' && fav[1].espnId === '83' && fav[1].nombre === 'Barcelona' && fav[1].pais === 'España',
      'se guarda el equipo EXACTO elegido (id oficial de ESPN 83, Barcelona de España) y se conserva el antiguo');
    [s, j] = await llamar('POST', '/api/perfil/favoritos', { ids: ['soccer:123456789'] }, t);
    ok(s === 400 && /lista de sugerencias/.test(j.error), 'un id inventado (que no está en el catálogo) se rechaza');
    [s] = await llamar('POST', '/api/perfil/favoritos', { ids: [barcaEsp.id], legado: [] , nombre: 'Hackeado' }, t);
    ok(get('users/BG_fan/equiposFavoritos')[0].nombre === 'Barcelona', 'el nombre lo pone el catálogo, nunca el navegador');

    // ---- Partidos por id: el Barcelona de España, no el de Ecuador ----
    for (let i = 0; i < 30; i++) { const f = await (await fetchReal('http://127.0.0.1:3973/api/fixtures')).json(); if ((f.data || []).length) break; await new Promise(r => setTimeout(r, 300)); }
    [, j] = await llamar('GET', '/api/perfil/calendario', null, t);
    const ics = await (await fetchReal('http://127.0.0.1:3973' + j.calendario.https.replace(/^https?:\/\/[^/]+/, ''))).text();
    ok(/Barcelona vs Real Madrid/.test(ics) && !/Barcelona SC/.test(ics), 'su calendario trae el partido del Barcelona de España y NO el del Barcelona SC de Ecuador');
  } catch (e) {
    ok(false, 'excepción: ' + e.message);
  }
  process.exit(0);
})();
