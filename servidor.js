const express = require('express');
const cors = require('cors');
const https = require('https');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Cache simple
const cache = {};
const CACHE_TTL = 3 * 60 * 1000;

function getCache(key) {
  const entry = cache[key];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.data;
  return null;
}

function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
}

function fetchESPN(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'site.api.espn.com',
      path: `/apis/site/v2/sports/${path}`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error('ESPN parse error'));
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('ESPN timeout')); });
    req.end();
  });
}

app.get('/api/fixtures', async (req, res) => {
  try {
    const cached = getCache('fixtures');
    if (cached) {
      return res.json(cached);
    }

    const deportes = [
      { path: 'soccer/esp.1/scoreboard', sport: 'soccer' },
      { path: 'soccer/eng.1/scoreboard', sport: 'soccer' },
      { path: 'soccer/ger.1/scoreboard', sport: 'soccer' },
      { path: 'soccer/ita.1/scoreboard', sport: 'soccer' },
      { path: 'soccer/fra.1/scoreboard', sport: 'soccer' },
      { path: 'soccer/uefa.champions/scoreboard', sport: 'soccer' },
      { path: 'basketball/nba/scoreboard', sport: 'basketball' },
      { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
      { path: 'mma/ufc/scoreboard', sport: 'mma' }
    ];

    let allEvents = [];
    const ahora = Date.now();
    const dentro14dias = ahora + (14 * 24 * 60 * 60 * 1000);

    for (const deporte of deportes) {
      try {
        const data = await fetchESPN(deporte.path);
        if (!data.events) continue;

        for (const ev of data.events) {
          const competition = ev.competitions?.[0];
          if (!competition) continue;
          
          const competitors = competition.competitors || [];
          const eventTime = new Date(ev.date || 0).getTime();
          
          if (eventTime < ahora || eventTime > dentro14dias) continue;

          const status = ev.status?.type;
          const isLive = status?.state === 'in';
          const isScheduled = status?.state === 'pre';
          
          if (!isLive && !isScheduled) continue;

          if (deporte.sport === 'mma') {
            if (competitors.length < 2) continue;
            allEvents.push({
              id: ev.id,
              sport: 'mma',
              local: competitors[0].athlete?.displayName || 'Fighter 1',
              visitante: competitors[1].athlete?.displayName || 'Fighter 2',
              liga: data.leagues?.[0]?.name || 'UFC',
              estado: isLive ? 'live' : 'scheduled',
              horaInicio: ev.date
            });
          } else {
            const home = competitors.find(c => c.homeAway === 'home');
            const away = competitors.find(c => c.homeAway === 'away');
            if (!home || !away) continue;

            allEvents.push({
              id: ev.id,
              sport: deporte.sport,
              local: home.team?.displayName || 'Local',
              visitante: away.team?.displayName || 'Away',
              liga: data.leagues?.[0]?.name || deporte.sport,
              estado: isLive ? 'live' : 'scheduled',
              horaInicio: ev.date
            });
          }
        }
      } catch(e) {
        console.error(`Error fetching ${deporte.path}:`, e.message);
      }
    }

    const response = {
      total: allEvents.length,
      data: allEvents
    };

    setCache('fixtures', response);
    res.json(response);

  } catch(err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy escuchando en puerto ${PORT}`);
});
