'use strict';

// ==================== RESPALDO DE CUOTAS: API-FOOTBALL (api-sports.io) ====================
// Plan gratuito legal (una sola cuenta): 100 consultas al día, cuotas de fútbol incluidas.
// Se usa SOLO para los partidos de fútbol que The Odds API dejó sin cuota (por ejemplo,
// los que faltan más de 48 h o cuando sus créditos se acaban).
//
// Coste por liga y día: 1 consulta de partidos + 1-3 de cuotas. Se guarda 24 h (memoria +
// Firebase), así que con ~18 ligas se gastan como mucho ~50-70 consultas al día.
//
// Devuelve los partidos con la MISMA forma que The Odds API (home_team, away_team,
// commence_time, bookmakers[0].markets[h2h|totals]) para reutilizar el emparejamiento.

const BASE = 'https://v3.football.api-sports.io';
const VIDA_CACHE_MS = 24 * 60 * 60 * 1000;
const DIAS_ADELANTE = 8;
const PAGINAS_MAXIMAS = 3;
const CASAS_PREFERIDAS = [8, 6, 11]; // Bet365, Bwin, 1xBet (si no, la primera que venga)

// Competición de ESPN → { id de liga en API-Football, temporada por año natural o europea }.
const LIGAS = Object.freeze({
  'soccer/eng.1': { id: 39, europea: true },
  'soccer/esp.1': { id: 140, europea: true },
  'soccer/ita.1': { id: 135, europea: true },
  'soccer/ger.1': { id: 78, europea: true },
  'soccer/fra.1': { id: 61, europea: true },
  'soccer/ned.1': { id: 88, europea: true },
  'soccer/por.1': { id: 94, europea: true },
  'soccer/den.1': { id: 119, europea: true },
  'soccer/pol.1': { id: 106, europea: true },
  'soccer/rus.1': { id: 235, europea: true },
  'soccer/mex.1': { id: 262, europea: true },
  'soccer/arg.1': { id: 128, europea: false },
  'soccer/bra.1': { id: 71, europea: false },
  'soccer/usa.1': { id: 253, europea: false },
  'soccer/nor.1': { id: 103, europea: false },
  'soccer/swe.1': { id: 113, europea: false },
  'soccer/chi.1': { id: 265, europea: false },
  'soccer/conmebol.libertadores': { id: 13, europea: false },
  // Selecciones (3 oct 2026): The Odds API no publica amistosos ni la Liga de Naciones de CONCACAF.
  'soccer/fifa.friendly': { id: 10, europea: false },
  'soccer/concacaf.nations.league': { id: 536, europea: false }
});

// Temporada: las ligas europeas (y Liga MX) cuentan desde el verano; las demás, por año.
function temporada(liga, ahora = new Date()) {
  const y = ahora.getUTCFullYear();
  return liga.europea && ahora.getUTCMonth() < 6 ? y - 1 : y;
}
const fecha = (d) => d.toISOString().slice(0, 10);

function aCuota(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 1 && n < 1000 ? Math.round(n * 100) / 100 : null;
}

// Convierte la respuesta de cuotas de un partido al formato de The Odds API.
function convertir(fix, oddsFix) {
  const casas = oddsFix.bookmakers || [];
  const casa = CASAS_PREFERIDAS.map(id => casas.find(c => c.id === id)).find(Boolean) || casas[0];
  if (!casa) return null;
  const local = fix.teams.home.name;
  const visitante = fix.teams.away.name;
  const markets = [];
  const ganador = (casa.bets || []).find(b => b.id === 1 || /match winner/i.test(b.name || ''));
  if (ganador) {
    const v = (k) => aCuota((ganador.values || []).find(x => x.value === k)?.odd);
    const [h, d, a] = [v('Home'), v('Draw'), v('Away')];
    if (h && a) markets.push({ key: 'h2h', outcomes: [{ name: local, price: h }, ...(d ? [{ name: 'Draw', price: d }] : []), { name: visitante, price: a }] });
  }
  const goles = (casa.bets || []).find(b => b.id === 5 || /goals over\/under/i.test(b.name || ''));
  if (goles) {
    const valores = goles.values || [];
    const lineas = [...new Set(valores.map(x => String(x.value).split(' ')[1]).filter(Boolean))];
    const linea = lineas.includes('2.5') ? '2.5' : lineas[0];
    const over = aCuota(valores.find(x => x.value === `Over ${linea}`)?.odd);
    const under = aCuota(valores.find(x => x.value === `Under ${linea}`)?.odd);
    if (linea && over && under) markets.push({ key: 'totals', outcomes: [{ name: 'Over', point: Number(linea), price: over }, { name: 'Under', point: Number(linea), price: under }] });
  }
  if (!markets.length) return null;
  return {
    home_team: local, away_team: visitante, commence_time: fix.fixture.date,
    casas: casas.length, bookmakers: [{ key: `apifootball-${casa.id}`, title: casa.name, markets }]
  };
}

function crearApiFootball({ db, obtenerClave, fetchImpl = (...a) => fetch(...a) }) {
  const memoria = {};
  const estado = { restantesHoy: null, limiteDia: null, actualizado: null, ultimoError: null, configurada: false };

  async function pedir(ruta, clave) {
    const r = await fetchImpl(`${BASE}${ruta}`, { headers: { 'x-apisports-key': clave }, signal: AbortSignal.timeout(15000) });
    const restantes = Number(r.headers?.get?.('x-ratelimit-requests-remaining'));
    const limite = Number(r.headers?.get?.('x-ratelimit-requests-limit'));
    if (Number.isFinite(restantes)) Object.assign(estado, { restantesHoy: restantes, limiteDia: Number.isFinite(limite) ? limite : null, actualizado: new Date().toISOString() });
    const j = await r.json().catch(() => ({}));
    const errores = j && j.errors && (Array.isArray(j.errors) ? j.errors : Object.values(j.errors));
    if (!r.ok || (errores && errores.length)) {
      const msg = `${ruta.split('?')[0]}: ${r.status} ${errores && errores.length ? String(errores[0]).slice(0, 120) : ''}`.trim();
      estado.ultimoError = `${msg} (${new Date().toISOString()})`;
      throw new Error(msg);
    }
    return j;
  }

  // Partidos con cuota de los próximos días para una competición (ruta de ESPN).
  async function partidos(ruta) {
    const liga = LIGAS[ruta];
    if (!liga) return null;
    const clave = await obtenerClave();
    estado.configurada = Boolean(clave);
    if (!clave) return null;

    const ahora = Date.now();
    let guardado = memoria[ruta];
    if (!guardado) {
      try { guardado = (await db.ref(`cacheCuotasAF/${liga.id}`).once('value')).val(); } catch { guardado = null; }
      if (guardado && Array.isArray(guardado.data)) memoria[ruta] = guardado;
    }
    if (guardado && Array.isArray(guardado.data) && ahora - Number(guardado.timestamp) < VIDA_CACHE_MS) return guardado.data;

    try {
      return await descargar(ruta, liga, clave, ahora);
    } catch (err) {
      // Si falla (cupo agotado, temporada no incluida en el plan...), no se reintenta hasta
      // dentro de 1 hora: si no, cada recálculo de 3 minutos gastaría el cupo del día.
      memoria[ruta] = { data: (guardado && guardado.data) || [], timestamp: ahora - VIDA_CACHE_MS + 60 * 60 * 1000 };
      throw err;
    }
  }

  async function descargar(ruta, liga, clave, ahora) {
    const season = temporada(liga);
    const hoy = new Date(ahora);
    const hasta = new Date(ahora + DIAS_ADELANTE * 86400000);
    const fx = await pedir(`/fixtures?league=${liga.id}&season=${season}&from=${fecha(hoy)}&to=${fecha(hasta)}`, clave);
    const porId = new Map((fx.response || []).filter(f => f?.fixture?.id && f?.teams?.home?.name && f?.teams?.away?.name).map(f => [f.fixture.id, f]));
    const juegos = [];
    if (porId.size) {
      for (let pagina = 1; pagina <= PAGINAS_MAXIMAS; pagina++) {
        const od = await pedir(`/odds?league=${liga.id}&season=${season}&page=${pagina}`, clave);
        for (const o of od.response || []) {
          const fix = porId.get(o?.fixture?.id);
          const g = fix && convertir(fix, o);
          if (g) juegos.push(g);
        }
        if (!(Number(od.paging?.total) > pagina)) break;
      }
    }
    const registro = { data: juegos, timestamp: ahora };
    memoria[ruta] = registro;
    db.ref(`cacheCuotasAF/${liga.id}`).set(registro).catch(() => {});
    return juegos;
  }

  // Comprueba una clave nueva antes de guardarla (consulta /status, que no gasta cupo).
  async function probarClave(clave) {
    const j = await pedir('/status', clave);
    const r = j.response || {};
    return { plan: r.subscription?.plan || null, consultasHoy: r.requests?.current ?? null, limiteDia: r.requests?.limit_day ?? null };
  }

  return { partidos, probarClave, estado, LIGAS };
}

module.exports = { crearApiFootball, LIGAS, temporada, convertir };
