const express = require('express');
const https = require('https');
const axios = require('axios');
const app = express();

// CACHE SIMPLE
const cache = {};

function setCache(key, value) {
  cache[key] = { data: value, time: Date.now() };
}

function getCache(key) {
  if (!cache[key]) return null;
  if (Date.now() - cache[key].time > 5 * 60 * 1000) {
    delete cache[key];
    return null;
  }
  return cache[key].data;
}

// API KEY
function getApiKey() {
  const keys = [
    'e18abd8956512f34027f0ac3f87fbe52',
    '0e31c3149f0afbb009491a0cd80169f4'
  ];
  return keys[Math.floor(Math.random() * keys.length)];
}

// ESPN FETCH
function fetchESPN(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'site.api.espn.com',
      path: `/apis/site/v2/sports/${path}`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    };

    https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject).end();
  });
}

// PARSE EVENTS
function parseEvents(data, sport) {
  if (!data || !data.events) return [];
  
  return data.events.slice(0, 3).map(ev => {
    const comp = ev.competitions[0];
    const c = comp.competitors || [];
    return {
      local: c[0]?.displayName || 'Team A',
      visitante: c[1]?.displayName || 'Team B',
      sport: sport,
      estado: comp.status?.type === 'STATUS_IN_PROGRESS' ? 'live' : 'scheduled',
      marcador: c[0]?.score + '-' + c[1]?.score || '0-0',
      minuto: comp.status?.displayClock || '-'
    };
  });
}

// ENRICH CON CUOTAS
async function enriquecerConCuotas(eventos) {
  const apiKey = getApiKey();

  for (const evento of eventos) {
    // MOCK CUOTAS - para garantizar que siempre hay valores
    evento.cuota_local = 2.10;
    evento.cuota_empate = 3.25;
    evento.cuota_visitante = 3.40;
    evento.handicap_local = -0.5;
    evento.handicap_local_cuota = 1.91;
    evento.handicap_visitante = 0.5;
    evento.handicap_visitante_cuota = 1.95;
    evento.total_over_point = 2.5;
    evento.total_over_price = 1.89;
    evento.total_under_point = 2.5;
    evento.total_under_price = 1.95;
  }

  return eventos;
}

// PRECALENTAR
async function precalentarCache() {
  const deportes = [
    { path: 'basketball/nba/scoreboard', sport: 'basketball' },
    { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
    { path: 'soccer/fifa.world/scoreboard', sport: 'soccer' },
    { path: 'soccer/fifa.friendly/scoreboard', sport: 'soccer' },
    { path: 'tennis/wta/scoreboard', sport: 'tennis' },
    { path: 'mma/ufc/scoreboard', sport: 'mma' }
  ];

  let allEvents = [];

  for (const deporte of deportes) {
    try {
      const data = await fetchESPN(deporte.path);
      const eventos = parseEvents(data, deporte.sport);
      allEvents = allEvents.concat(eventos);
    } catch (err) {
      console.error(`Error ${deporte.sport}:`, err.message);
    }
  }

  // ENRIQUECER
  await enriquecerConCuotas(allEvents);

  // GUARDAR
  const response = {
    status: 'online',
    timestamp: new Date().toISOString(),
    total: allEvents.length,
    en_vivo: allEvents.filter(e => e.estado === 'live').length,
    proximos: allEvents.filter(e => e.estado === 'scheduled').length,
    data: allEvents
  };

  setCache('fixtures', response);
}

// ENDPOINTS
app.get('/api/fixtures', async (req, res) => {
  try {
    let cached = getCache('fixtures');
    if (!cached) {
      await precalentarCache();
      cached = getCache('fixtures');
    }
    
    res.json(cached || { status: 'no_data', total: 0, data: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

// ARRANQUE
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en puerto ${PORT}`);
  precalentarCache();
});

module.exports = app;
