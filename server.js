const express = require('express');
const cors = require('cors');
const https = require('https');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ════════════════════════════════════════════════════════════════
// FIREBASE SETUP
// ════════════════════════════════════════════════════════════════

let db;

if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
  try {
    const serviceAccountJSON = Buffer.from(
      process.env.FIREBASE_SERVICE_ACCOUNT_B64,
      'base64'
    ).toString('utf8');
    
    const serviceAccount = JSON.parse(serviceAccountJSON);
    
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
      });
    }
    
    db = admin.database();
  } catch (err) {
    console.error('Firebase init error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════
// CACHE SYSTEM
// ════════════════════════════════════════════════════════════════

const cache = {};
const CACHE_TTL = 3 * 60 * 1000; // 3 minutos

function getCache(key) {
  const entry = cache[key];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data;
  }
  return null;
}

function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
}

// ════════════════════════════════════════════════════════════════
// THE ODDS API - ROTACIÓN DE KEYS
// ════════════════════════════════════════════════════════════════

const ODDS_API_KEY_1 = process.env.ODDS_API_KEY_1 || '';
const ODDS_API_KEY_2 = process.env.ODDS_API_KEY_2 || '';

function getApiKey() {
  const hour = new Date().getHours();
  // Rotar cada 12 horas: 00-11 = KEY1, 12-23 = KEY2
  return hour < 12 ? ODDS_API_KEY_1 : ODDS_API_KEY_2;
}

// ════════════════════════════════════════════════════════════════
// ESPN FETCH
// ════════════════════════════════════════════════════════════════

function fetchESPN(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'site.api.espn.com',
      path: `/apis/site/v2/sports/${path}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('ESPN parse error'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('ESPN timeout'));
    });
    req.end();
  });
}

// ════════════════════════════════════════════════════════════════
// PARSE EVENTS
// ════════════════════════════════════════════════════════════════

function parseEvents(espnData, sport) {
  if (!espnData.events) return [];

  const ahora = Date.now();
  const dentro14dias = ahora + 14 * 24 * 60 * 60 * 1000;
  const eventos = [];

  for (const ev of espnData.events) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;

    const eventTime = new Date(ev.date || 0).getTime();
    if (eventTime > dentro14dias) continue;  // Permitir live (eventTime en el pasado)

    const status = ev.status?.type?.state;
    if (status !== 'in' && status !== 'pre') continue;

    const competitors = comp.competitors || [];

    if (sport === 'mma') {
      if (competitors.length < 2) continue;
      eventos.push({
        id: ev.id,
        sport: 'mma',
        local: competitors[0].athlete?.displayName || 'Fighter 1',
        visitante: competitors[1].athlete?.displayName || 'Fighter 2',
        liga: espnData.leagues?.[0]?.name || 'UFC',
        estado: status === 'in' ? 'live' : 'scheduled',
        horaInicio: ev.date,
        logo_local: competitors[0].athlete?.links?.[0]?.href || '',
        logo_visitante: competitors[1].athlete?.links?.[0]?.href || ''
      });
    } else {
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      eventos.push({
        id: ev.id,
        sport: sport,
        local: home.team?.displayName || 'Local',
        visitante: away.team?.displayName || 'Away',
        liga: espnData.leagues?.[0]?.name || sport,
        estado: status === 'in' ? 'live' : 'scheduled',
        horaInicio: ev.date,
        logo_local: home.team?.logo || '',
        logo_visitante: away.team?.logo || ''
      });
    }
  }

  return eventos;
}

// ════════════════════════════════════════════════════════════════
// ENRIQUECER CON CUOTAS (The Odds API)
// ════════════════════════════════════════════════════════════════

const DEPORTES_ODDS = {
  'soccer': ['soccer_epl', 'soccer_spain_la_liga', 'soccer_germany_bundesliga', 'soccer_italy_serie_a', 'soccer_france_ligue_one', 'soccer_uefa_champs_league'],
  'basketball': ['basketball_nba'],
  'baseball': ['baseball_mlb'],
  'mma': ['mma_mixed_martial_arts'],
  'tennis': ['tennis_atp', 'tennis_wta']
};

async function enriquecerConCuotas(eventos) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log('Sin The Odds API key');
    return eventos;
  }

  for (const ev of eventos) {
    try {
      const sportKeys = DEPORTES_ODDS[ev.sport] || [];
      for (const sportKey of sportKeys) {
        const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&markets=h2h,spreads,totals`;
        const response = await new Promise((resolve, reject) => {
          https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                reject(e);
              }
            });
          }).on('error', reject);
        });

        if (response.data) {
          for (const game of response.data) {
            // Match flexible: compara palabras clave del nombre
              function matchName(a, b) {
                if (!a || !b) return false;
                const normalize = s => s.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
                const na = normalize(a); const nb = normalize(b);
                if (na.includes(nb) || nb.includes(na)) return true;
                // Match por apellido (última palabra)
                const lastA = na.split(' ').pop();
                const lastB = nb.split(' ').pop();
                return lastA.length > 3 && lastA === lastB;
              }
              if (matchName(game.home_team, ev.local) && matchName(game.away_team, ev.visitante)) {
              const bookmakers = game.bookmakers?.[0];
              // Mercado h2h (cuotas 1x2)
              const mktH2h = bookmakers.markets?.find(m => m.key === 'h2h');
              if (mktH2h?.outcomes) {
                ev.cuota_local = mktH2h.outcomes.find(o => o.name === game.home_team)?.price || 0;
                ev.cuota_visitante = mktH2h.outcomes.find(o => o.name === game.away_team)?.price || 0;
                const draw = mktH2h.outcomes.find(o => o.name === 'Draw');
                if (draw) ev.cuota_empate = draw.price;
              }
              // Mercado spreads (handicap)
              const mktSpreads = bookmakers.markets?.find(m => m.key === 'spreads');
              if (mktSpreads?.outcomes) {
                const homeSpread = mktSpreads.outcomes.find(o => o.name === game.home_team);
                const awaySpread = mktSpreads.outcomes.find(o => o.name === game.away_team);
                if (homeSpread) { ev.handicap_local = homeSpread.point; ev.handicap_local_cuota = homeSpread.price; }
                if (awaySpread) { ev.handicap_visitante = awaySpread.point; ev.handicap_visitante_cuota = awaySpread.price; }
              }
              // Mercado totals (over/under)
              const mktTotals = bookmakers.markets?.find(m => m.key === 'totals');
              if (mktTotals?.outcomes) {
                const over = mktTotals.outcomes.find(o => o.name === 'Over');
                const under = mktTotals.outcomes.find(o => o.name === 'Under');
                if (over) { ev.total_over_point = over.point; ev.total_over_price = over.price; }
                if (under) { ev.total_under_point = under.point; ev.total_under_price = under.price; }
              }
              break;
            }
          }
        }
      }
    } catch (err) {
      console.error(`Error cuotas para ${ev.local} vs ${ev.visitante}:`, err.message);
    }
  }

  return eventos;
}

// ════════════════════════════════════════════════════════════════
// PRECALENTAR CACHE
// ════════════════════════════════════════════════════════════════

async function precalentarCache() {
  console.log('⏳ Precalentando caché...');

  const deportes = [
    { path: 'soccer/esp.1/scoreboard', sport: 'soccer', liga: 'LaLiga' },
    { path: 'soccer/eng.1/scoreboard', sport: 'soccer', liga: 'Premier League' },
    { path: 'soccer/ger.1/scoreboard', sport: 'soccer', liga: 'Bundesliga' },
    { path: 'soccer/ita.1/scoreboard', sport: 'soccer', liga: 'Serie A' },
    { path: 'soccer/fra.1/scoreboard', sport: 'soccer', liga: 'Ligue 1' },
    { path: 'soccer/uefa.champions/scoreboard', sport: 'soccer', liga: 'Champions League' },
    { path: 'basketball/nba/scoreboard', sport: 'basketball', liga: 'NBA' },
    { path: 'baseball/mlb/scoreboard', sport: 'baseball', liga: 'MLB' },
    { path: 'mma/ufc/scoreboard', sport: 'mma', liga: 'UFC' }
  ];

  let allEvents = [];

  for (const deporte of deportes) {
    try {
      const data = await fetchESPN(deporte.path);
      const eventos = parseEvents(data, deporte.sport);
      allEvents = allEvents.concat(eventos);
    } catch (err) {
      console.error(`Error ${deporte.path}:`, err.message);
    }
  }

  // Enriquecer con cuotas
  allEvents = await enriquecerConCuotas(allEvents);

  const response = {
    total: allEvents.length,
    data: allEvents,
    timestamp: Date.now()
  };

  setCache('fixtures', response);
  console.log(`✅ Caché precalentado: ${allEvents.length} eventos`);
}

// ════════════════════════════════════════════════════════════════
// ENDPOINTS
// ════════════════════════════════════════════════════════════════

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/api/fixtures', async (req, res) => {
  try {
    let cached = getCache('fixtures');
    if (cached) {
      return res.json(cached);
    }

    await precalentarCache();
    cached = getCache('fixtures');
    res.json(cached || { total: 0, data: [] });
  } catch (err) {
    console.error('Error /api/fixtures:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/apostar', async (req, res) => {
  const { uid, amount, evento, tipo, cuota } = req.body;

  if (!uid || !amount || !evento || !tipo || !cuota) {
    return res.status(400).json({ error: 'Parámetros faltantes' });
  }

  try {
    if (!db) {
      return res.status(500).json({ error: 'Firebase no configurado' });
    }

    // ONCE + SET (no transaction - bug en Termux)
    const snap = await db.ref(`users/${uid}/creditoReal`).once('value');
    const saldoActual = snap.val();

    if (saldoActual === null || saldoActual < amount) {
      return res.status(400).json({
        error: 'Saldo insuficiente',
        saldoActual: saldoActual || 0
      });
    }

    const saldoNuevo = saldoActual - amount;
    await db.ref(`users/${uid}/creditoReal`).set(saldoNuevo);

    // Registrar apuesta
    const betId = Date.now().toString();
    await db.ref(`apuestas/${uid}/${betId}`).set({
      eventoNombre: evento,
      tipo: tipo,
      monto: amount,
      cuota: cuota,
      ganancia: Math.floor(amount * cuota),
      estado: 'pendiente',
      fecha: Date.now()
    });

    res.json({
      success: true,
      saldoNuevo: saldoNuevo,
      betId: betId
    });
  } catch (err) {
    console.error('Error /api/apostar:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// INICIAR SERVIDOR
// ════════════════════════════════════════════════════════════════


// ════ ENDPOINT TEMPORAL DE DIAGNÓSTICO ════
app.get('/api/debug-espn', async (req, res) => {
  try {
    const data = await fetchESPN('baseball/mlb/scoreboard');
    const events = data.events || [];
    const ahora = Date.now();
    const dentro14dias = ahora + 14 * 24 * 60 * 60 * 1000;
    const resumen = events.slice(0,5).map(ev => ({
      name: ev.name,
      date: ev.date,
      state: ev.status?.type?.state,
      eventTime: new Date(ev.date||0).getTime(),
      pasaFiltro: new Date(ev.date||0).getTime() <= dentro14dias
    }));
    res.json({ total: events.length, ahora: new Date(ahora).toISOString(), resumen });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Proxy escuchando en puerto ${PORT}`);
  precalentarCache();
  setInterval(precalentarCache, 3 * 60 * 1000); // Cada 3 minutos
});
