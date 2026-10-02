// Prueba de la Etapa 9: más partidos con cuota.
// - Partidos a 5 días también reciben cuota (antes solo 48 h antes).
// - Emparejamiento más fuerte con la hora ("Central Córdoba (Santiago del Estero)").
// - Ligas pequeñas: solo 1X2 (1 crédito en vez de 3).
// - Respaldo gratuito con API-Football cuando The Odds API no tiene el partido.
// Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { get, set, arrancar, ok } = require('./simulador');

const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
set('credenciales_acceso/ceo-x-com', { email: 'ceo@x.com', uid: 'BG_ceo', salt: '0a0b0c0d', hash: legado('ceo-clave-1', '0a0b0c0d') });
set('users/BG_ceo', { uid: 'BG_ceo', email: 'ceo@x.com', activo: true, nombre: 'Jefe', rol: 'superadmin', rolLevel: 3 });

const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hoy = Date.now() + 6 * 3600000;
const en5dias = Date.now() + 5 * 86400000;
const partido = (id, cuando, local, visitante, liga) => ({ leagues: [{ name: liga }], events: [{ id, date: iso(cuando), status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
  { homeAway: 'home', team: { displayName: local } }, { homeAway: 'away', team: { displayName: visitante } }] }] }] });
const ESPN = {
  'soccer/ita.1': partido('ITA9', en5dias, 'Genoa', 'Fiorentina', 'Italian Serie A'),
  'soccer/arg.1': partido('ARG9', hoy, 'Central Córdoba (Santiago del Estero)', 'Boca Juniors', 'Argentine Liga Profesional de Fútbol'),
  'soccer/nor.1': partido('NOR9', hoy, 'SK Brann', 'Viking FK', 'Norwegian Eliteserien'),
  'soccer/bra.1': partido('BRA9', en5dias, 'Fluminense', 'Palmeiras', 'Brazilian Serie A')
};
const h2h = (l, v, a, x, b) => ({ key: 'h2h', outcomes: [{ name: l, price: a }, { name: 'Draw', price: x }, { name: v, price: b }] });
const ODDS = {
  soccer_italy_serie_a: [{ home_team: 'Genoa', away_team: 'Fiorentina', commence_time: iso(en5dias), bookmakers: [{ markets: [h2h('Genoa', 'Fiorentina', 3.1, 3.3, 2.3)] }] }],
  soccer_argentina_primera_division: [{ home_team: 'Central Cordoba SdE', away_team: 'Boca Juniors', commence_time: iso(hoy), bookmakers: [{ markets: [h2h('Central Cordoba SdE', 'Boca Juniors', 4.2, 3.1, 1.9)] }] }],
  soccer_norway_eliteserien: [{ home_team: 'Brann', away_team: 'Viking', commence_time: iso(hoy), bookmakers: [{ markets: [h2h('Brann', 'Viking', 2.0, 3.6, 3.4)] }] }],
  soccer_brazil_campeonato: [] // The Odds API no lo tiene → respaldo
};

const pedidas = [];
const fetchReal = global.fetch;
arrancar({
  puerto: 3990,
  env: { ODDS_API_KEYS: 'k1', API_FOOTBALL_KEY: '' },
  espn: (p) => { const k = Object.keys(ESPN).find(r => p.includes(r + '/')); return k ? JSON.stringify(ESPN[k]) : null; },
  axiosGet: async (url) => {
    if (!url.includes('the-odds-api')) throw new Error('sin red');
    pedidas.push(url);
    const clave = Object.keys(ODDS).find(k => url.includes(`/${k}/`));
    return { data: clave ? ODDS[clave] : [], headers: { 'x-requests-remaining': '400' } };
  }
});

// API-Football simulado (formato de su documentación v3).
const pedidasAF = [];
global.fetch = async (url, op = {}) => {
  url = String(url);
  if (!url.startsWith('https://v3.football.api-sports.io')) throw new Error('sin red en pruebas');
  pedidasAF.push(url);
  const cab = new Map([['x-ratelimit-requests-remaining', '97'], ['x-ratelimit-requests-limit', '100']]);
  const resp = (j) => ({ ok: true, status: 200, headers: { get: (k) => cab.get(k) }, json: async () => j });
  if ((op.headers || {})['x-apisports-key'] !== 'af0123456789abcdef0123456789abcd') return resp({ errors: { token: 'Error/Missing application key.' }, response: [] });
  if (url.includes('/status')) return resp({ errors: [], response: { subscription: { plan: 'Free' }, requests: { current: 3, limit_day: 100 } } });
  if (url.includes('/fixtures?league=71')) return resp({ errors: [], response: [{ fixture: { id: 5551, date: iso(en5dias) }, teams: { home: { name: 'Fluminense' }, away: { name: 'Palmeiras' } } }] });
  if (url.includes('/odds?league=71')) return resp({ errors: [], paging: { current: 1, total: 1 }, response: [{ fixture: { id: 5551 }, bookmakers: [{ id: 8, name: 'Bet365', bets: [
    { id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: '2.40' }, { value: 'Draw', odd: '3.20' }, { value: 'Away', odd: '2.90' }] },
    { id: 5, name: 'Goals Over/Under', values: [{ value: 'Over 1.5', odd: '1.30' }, { value: 'Under 1.5', odd: '3.40' }, { value: 'Over 2.5', odd: '2.05' }, { value: 'Under 2.5', odd: '1.75' }] }] }] }] });
  return resp({ errors: [], response: [] });
};

async function llamar(metodo, ruta, cuerpo, token) {
  const r = await fetchReal('http://127.0.0.1:3990' + ruta, { method: metodo, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  return [r.status, await r.json().catch(() => null)];
}
async function partidos() {
  for (let i = 0; i < 30; i++) {
    const [, f] = await llamar('GET', '/api/fixtures');
    if (f && f.status === 'online') return f.data || [];
    await new Promise(r => setTimeout(r, 300));
  }
  return [];
}

(async () => {
  try {
    let evs = await partidos();
    const de = (local) => evs.find(e => e.local === local) || {};
    ok(de('Genoa').cuota_local === 3.1, 'partido a 5 días ya tiene cuota (antes: "las cuotas se abren 2 días antes") → ' + de('Genoa').cuota_local);
    ok(de('Central Córdoba (Santiago del Estero)').cuota_local === 4.2, 'nombre muy distinto ("Central Cordoba SdE") emparejado gracias a la hora y al rival → ' + de('Central Córdoba (Santiago del Estero)').cuota_local);
    ok(de('SK Brann').cuota_local === 2.0, 'Noruega: "SK Brann" = "Brann", "Viking FK" = "Viking"');
    ok(pedidas.some(u => u.includes('soccer_norway_eliteserien') && /markets=h2h&/.test(u)) && pedidas.some(u => u.includes('soccer_italy_serie_a') && u.includes('markets=h2h,spreads,totals')),
      'ahorro: liga pequeña pide solo 1X2 (1 crédito); Serie A pide todos los mercados');
    ok(!(Number(de('Fluminense').cuota_local) > 1) && pedidasAF.length === 0, 'sin clave de API-Football no se le consulta nada');

    // ---- El CEO guarda la clave de API-Football ----
    const [, login] = await llamar('POST', '/api/auth/login', { identificador: 'ceo@x.com', password: 'ceo-clave-1' });
    let [s, j] = await llamar('POST', '/api/admin/clave-api-football', { clave: 'clave-mala!' }, login.token);
    ok(s === 400, 'clave con formato raro rechazada');
    [s, j] = await llamar('POST', '/api/admin/clave-api-football', { clave: 'ffffffffffffffffffffffffffffffff' }, login.token);
    ok(s === 400 && /no aceptó/.test(j.error), 'clave que API-Football no reconoce: no se guarda → ' + (j && j.error));
    [s, j] = await llamar('POST', '/api/admin/clave-api-football', { clave: 'af0123456789abcdef0123456789abcd' }, login.token);
    ok(s === 200 && j.plan === 'Free' && j.limiteDia === 100 && get('secretos/apiFootball/clave') === 'af0123456789abcdef0123456789abcd', 'clave válida guardada en el servidor (plan Free, 100/día)');
    ok(!JSON.stringify(j).includes('af0123456789'), 'la respuesta nunca devuelve la clave');
    const [sDb] = await llamar('POST', '/api/db', { op: 'leer', ruta: 'secretos' }, login.token);
    ok(sDb === 403, 'ni el CEO puede leer la clave desde la web');

    // ---- Respaldo: el partido de Brasil recibe cuota de API-Football ----
    // Al guardar la clave el servidor recalcula los partidos enseguida.
    for (let i = 0; i < 40; i++) {
      const [, f] = await llamar('GET', '/api/fixtures');
      evs = (f && f.data) || [];
      if (Number(de('Fluminense').cuota_local) > 1) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const flu = de('Fluminense');
    ok(flu.cuota_local === 2.4 && flu.cuota_empate === 3.2 && flu.cuota_visitante === 2.9 && flu.fuenteCuotas === 'api-football',
      `Brasil sin cuota en The Odds API → cuota de API-Football (${flu.cuota_local}/${flu.cuota_empate}/${flu.cuota_visitante})`);
    ok(flu.total_over_point === 2.5 && flu.total_over_price === 2.05, 'API-Football también da más/menos 2.5 goles');
    ok(get('cacheCuotasAF/71/data/0/home_team') === 'Fluminense', 'su respuesta se guarda 24 h en Firebase (no gasta cupo al despertar Render)');
    const [, d] = await llamar('GET', '/api/admin/diagnostico-cuotas?q=sincuota', null, login.token);
    ok(d && d.apiFootball && d.apiFootball.restantesHoy === 97, 'el diagnóstico muestra las consultas de API-Football que quedan hoy → ' + (d && d.apiFootball && d.apiFootball.restantesHoy));
  } catch (e) {
    ok(false, 'error inesperado: ' + e.message);
  }
  process.exit(0);
})();
