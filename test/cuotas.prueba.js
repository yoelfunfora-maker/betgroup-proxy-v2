// Prueba de la Etapa 7: cuotas de la liga argentina (y otras ligas con nombres "raros" en ESPN).
// Caso real: "Independiente vs Instituto" salía bloqueado. Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { get, set, arrancar, ok } = require('./simulador');

const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
set('credenciales_acceso/ceo-x-com', { email: 'ceo@x.com', uid: 'BG_ceo', salt: '0a0b0c0d', hash: legado('ceo-clave-1', '0a0b0c0d') });
set('users/BG_ceo', { uid: 'BG_ceo', email: 'ceo@x.com', activo: true, nombre: 'Jefe', rol: 'superadmin', rolLevel: 3 });

const hoy = new Date(Date.now() + 6 * 3600000);
const semanaQueViene = new Date(hoy.getTime() + 7 * 86400000);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// ESPN, tal como escribe la liga argentina (con "Argentine", no "Argentina").
const espnArg = {
  leagues: [{ name: 'Argentine Liga Profesional de Fútbol' }],
  events: [{ id: 'ARG1', date: iso(hoy), status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
    { homeAway: 'home', team: { displayName: 'Independiente' } }, { homeAway: 'away', team: { displayName: 'Instituto' } }] }] }]
};
const espnEsp = {
  leagues: [{ name: 'Spanish LALIGA' }],
  events: [{ id: 'ESP1', date: iso(hoy), status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
    { homeAway: 'home', team: { displayName: 'Real Madrid' } }, { homeAway: 'away', team: { displayName: 'Getafe' } }] }] }]
};

const h2h = (local, visitante, a, x, b) => ({ key: 'h2h', outcomes: [{ name: local, price: a }, { name: 'Draw', price: x }, { name: visitante, price: b }] });
// The Odds API con los nombres largos que usa para Argentina, y una trampa:
// "Independiente Rivadavia vs Instituto de Córdoba" la semana que viene.
const oddsArg = [
  { home_team: 'Independiente Rivadavia', away_team: 'Instituto de Córdoba', commence_time: iso(semanaQueViene), bookmakers: [{ markets: [h2h('Independiente Rivadavia', 'Instituto de Córdoba', 9.9, 9.9, 9.9)] }] },
  { home_team: 'CA Independiente', away_team: 'Instituto de Córdoba', commence_time: iso(hoy), bookmakers: [{ markets: [h2h('CA Independiente', 'Instituto de Córdoba', 1.85, 3.2, 4.5)] }] }
];
const oddsEsp = [
  { home_team: 'Real Madrid', away_team: 'Getafe', commence_time: iso(hoy), bookmakers: [{ markets: [h2h('Real Madrid', 'Getafe', 1.3, 5.5, 9.0)] }] }
];

// Serie A y Portugal: nombres que ESPN y The Odds API escriben distinto.
const espnIta = { leagues: [{ name: 'Italian Serie A' }], events: [{ id: 'ITA1', date: iso(hoy), status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
  { homeAway: 'home', team: { displayName: 'Internazionale' } }, { homeAway: 'away', team: { displayName: 'Hellas Verona' } }] }] }] };
const espnPor = { leagues: [{ name: 'Portuguese Primeira Liga' }], events: [{ id: 'POR1', date: iso(hoy), status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
  { homeAway: 'home', team: { displayName: 'Sporting CP' } }, { homeAway: 'away', team: { displayName: 'Vitória de Guimarães' } }] }] }] };
const espnDen = { leagues: [{ name: 'Danish Superliga' }], events: [{ id: 'DEN1', date: iso(hoy), status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
  { homeAway: 'home', team: { displayName: 'Brøndby IF' } }, { homeAway: 'away', team: { displayName: 'FC København' } }] }] }] };
const oddsIta = [{ home_team: 'Inter Milan', away_team: 'Hellas Verona FC', commence_time: iso(hoy), bookmakers: [{ markets: [h2h('Inter Milan', 'Hellas Verona FC', 1.25, 6.0, 11.0)] }] }];
const oddsPor = [{ home_team: 'Sporting Lisbon', away_team: 'Vitoria Guimaraes', commence_time: iso(hoy), bookmakers: [{ markets: [h2h('Sporting Lisbon', 'Vitoria Guimaraes', 1.4, 4.6, 7.5)] }] }];
const oddsDen = [{ home_team: 'Brondby IF', away_team: 'FC Copenhagen', commence_time: iso(hoy), bookmakers: [{ markets: [h2h('Brondby IF', 'FC Copenhagen', 2.9, 3.4, 2.3)] }] }];

const pedidas = [];
const fetchReal = global.fetch;
arrancar({
  puerto: 3993,
  env: { ODDS_API_KEYS: 'k1' },
  espn: (p) => (p.includes('soccer/arg.1') ? JSON.stringify(espnArg) : p.includes('soccer/esp.1') ? JSON.stringify(espnEsp)
    : p.includes('soccer/ita.1') ? JSON.stringify(espnIta) : p.includes('soccer/por.1') ? JSON.stringify(espnPor) : p.includes('soccer/den.1') ? JSON.stringify(espnDen) : null),
  axiosGet: async (url) => {
    if (!url.includes('the-odds-api')) throw new Error('sin red');
    pedidas.push(url);
    const cab = { 'x-requests-remaining': '412', 'x-requests-used': '88' };
    if (url.includes('/soccer_argentina_primera_division/')) return { data: oddsArg, headers: cab };
    if (url.includes('/soccer_spain_la_liga/')) return { data: oddsEsp, headers: cab };
    if (url.includes('/soccer_italy_serie_a/')) return { data: oddsIta, headers: cab };
    if (url.includes('/soccer_portugal_primeira_liga/')) return { data: oddsPor, headers: cab };
    if (url.includes('/soccer_denmark_superliga/')) return { data: oddsDen, headers: cab };
    return { data: [], headers: cab };
  }
});

(async () => {
  try {
    let fx = null;
    for (let i = 0; i < 30; i++) {
      fx = await (await fetchReal('http://127.0.0.1:3993/api/fixtures')).json();
      if (fx.status === 'online') break;
      await new Promise(r => setTimeout(r, 300));
    }
    const ev = (fx.data || []).find(e => e.local === 'Independiente');
    ok(pedidas.some(u => u.includes('/soccer_argentina_primera_division/')), 'la liga argentina pide SUS cuotas (antes pedía las de la Premier inglesa)');
    ok(pedidas.some(u => u.includes('/soccer_argentina_primera_division/') && u.includes('regions=eu')), 'para Argentina se usan casas europeas (las de EE. UU. casi no la cubren)');
    ok(ev && ev.cuota_local === 1.85 && ev.cuota_empate === 3.2 && ev.cuota_visitante === 4.5,
      `Independiente vs Instituto recibe sus cuotas reales → ${ev && [ev.cuota_local, ev.cuota_empate, ev.cuota_visitante].join(' / ')}`);
    ok(ev && ev.cuota_local !== 9.9, 'no se confunde con "Independiente Rivadavia" de la semana que viene');
    const esp = (fx.data || []).find(e => e.local === 'Real Madrid');
    ok(esp && esp.cuota_local === 1.3, 'LaLiga ("Spanish LALIGA" en ESPN) también recibe sus cuotas');
    ok(!pedidas.some(u => u.includes('/soccer_epl/')), 'no se gastan créditos pidiendo la Premier para partidos de otras ligas');

    const cuota = (local) => ((fx.data || []).find(e => e.local === local) || {}).cuota_local;
    ok(cuota('Internazionale') === 1.25, 'Serie A: "Internazionale" (ESPN) = "Inter Milan" (cuotas) → ' + cuota('Internazionale'));
    ok(cuota('Sporting CP') === 1.4, 'Portugal: "Sporting CP" = "Sporting Lisbon" y "Vitória de Guimarães" = "Vitoria Guimaraes" → ' + cuota('Sporting CP'));
    ok(cuota('Brøndby IF') === 2.9, 'Superliga danesa: "Brøndby" = "Brondby" y "København" = "Copenhagen" → ' + cuota('Brøndby IF'));
    const copia = get('cacheCuotas/soccer_argentina_primera_division');
    ok(copia && copia.data.length === 2 && copia.data[0].bookmakers.length === 1, 'las cuotas se guardan en Firebase (al despertar Render no se vuelven a pagar)');
    // Diagnóstico del CEO
    const login = await (await fetchReal('http://127.0.0.1:3993/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identificador: 'ceo@x.com', password: 'ceo-clave-1' })
    })).json();
    const r = await fetchReal('http://127.0.0.1:3993/api/admin/diagnostico-cuotas?q=independiente', { headers: { authorization: `Bearer ${login.token}` } });
    const d = await r.json();
    const p = d.partidos && d.partidos[0];
    ok(r.status === 200 && p && p.competicionOddsApi === 'soccer_argentina_primera_division' && p.mejoresCandidatos[0].partidoOddsApi === 'CA Independiente vs Instituto de Córdoba',
      'el diagnóstico del CEO explica de dónde sale la cuota → ' + (p && p.mejoresCandidatos[0] && p.mejoresCandidatos[0].partidoOddsApi));
    ok(d.creditosOddsApi && d.creditosOddsApi.restantes === 412, 'el diagnóstico muestra los créditos que quedan en The Odds API → ' + (d.creditosOddsApi && d.creditosOddsApi.restantes));
    const sin = await fetchReal('http://127.0.0.1:3993/api/admin/diagnostico-cuotas?q=independiente');
    ok(sin.status === 401, 'el diagnóstico solo lo ve el CEO → ' + sin.status);
  } catch (e) {
    ok(false, 'error inesperado: ' + e.message);
  }
  process.exit(0);
})();
