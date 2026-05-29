const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// CACHÉ
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

// FETCH ESPN
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
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Error parsing ESPN')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('ESPN timeout')); });
    req.end();
  });
}

// PARSE - Filtra eventos de próximos 7 días
function parseEvents(espnData, sport) {
  const events = [];
  if (!espnData || !espnData.events) return events;

  const ahora = Date.now();
  const dentro7dias = ahora + (14 * 24 * 60 * 60 * 1000);

  for (const ev of espnData.events) {
    try {
      const competition = ev.competitions?.[0];
      if (!competition) continue;
      const competitors = competition.competitors || [];
      
      // Para MMA/Boxing: atletas individuales, no equipos
      if (sport === 'mma' || sport === 'boxing') {
        if (competitors.length < 2) continue;
        
        const home = competitors[0];
        const away = competitors[1];
        
        const status = ev.status?.type;
        const isLive = status?.state === 'in';
        const isScheduled = status?.state === 'pre';
        if (!isLive && !isScheduled) continue;

        const eventTime = new Date(ev.date || 0).getTime();
        if (eventTime < ahora || eventTime > dentro7dias) continue;

        const homeScore = home.score || '0';
        const awayScore = away.score || '0';
        const minute = ev.status?.displayClock || '';

        events.push({
          id: ev.id,
          sport,
          liga: espnData.leagues?.[0]?.name || sport,
          ligaLogo: espnData.leagues?.[0]?.logos?.[0]?.href || null,
          local: home.athlete?.displayName || 'Peleador 1',
          visitante: away.athlete?.displayName || 'Peleador 2',
          homeLogo: null,
          awayLogo: null,
          marcador: isLive ? `${homeScore}-${awayScore}` : null,
          minuto: isLive ? minute : null,
          periodo: ev.status?.period || 0,
          estado: isLive ? 'live' : 'scheduled',
          horaInicio: ev.date || null,
          cuota_local: null,
          cuota_empate: null,
          cuota_visitante: null
        });
      } else {
        // Para soccer/basketball/baseball: equipos
        const home = competitors.find(c => c.homeAway === 'home');
        const away = competitors.find(c => c.homeAway === 'away');
        if (!home || !away) continue;

        const status = ev.status?.type;
        const isLive = status?.state === 'in';
        const isScheduled = status?.state === 'pre';
        if (!isLive && !isScheduled) continue;

        const eventTime = new Date(ev.date || 0).getTime();
        if (eventTime < ahora || eventTime > dentro7dias) continue;

        const homeScore = home.score || '0';
        const awayScore = away.score || '0';
        const minute = ev.status?.displayClock || '';

        events.push({
          id: ev.id,
          sport,
          liga: espnData.leagues?.[0]?.name || sport,
          ligaLogo: espnData.leagues?.[0]?.logos?.[0]?.href || null,
          local: home.team?.displayName || 'Local',
          visitante: away.team?.displayName || 'Visitante',
          homeLogo: home.team?.logo || null,
          awayLogo: away.team?.logo || null,
          marcador: isLive ? `${homeScore}-${awayScore}` : null,
          minuto: isLive ? minute : null,
          periodo: ev.status?.period || 0,
          estado: isLive ? 'live' : 'scheduled',
          horaInicio: ev.date || null,
          cuota_local: null,
          cuota_empate: null,
          cuota_visitante: null
        });
      }
    } catch(e) { }
  }
  return events;
}

// ENDPOINTS
app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API — ESPN Cartelera (próximos 7 días)' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', uptime: process.uptime() });
});

app.get('/api/fixtures', async (req, res) => {
  const cached = getCache('fixtures');
  if (cached) return res.json(cached);

  const deportes = [
    { path: 'soccer/esp.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/eng.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/ger.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/ita.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/fra.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/uefa.champions/scoreboard', sport: 'soccer' },
    { path: 'soccer/conmebol.libertadores/scoreboard', sport: 'soccer' },
    { path: 'soccer/usa.1/scoreboard', sport: 'soccer' },
    { path: 'basketball/nba/scoreboard', sport: 'basketball' },
    { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
    { path: 'mma/ufc/scoreboard', sport: 'mma' }
  ];

  const todos = [];

  await Promise.allSettled(
    deportes.map(async ({ path, sport }) => {
      try {
        const data = await fetchESPN(path);
        const events = parseEvents(data, sport);
        todos.push(...events);
      } catch(e) { }
    })
  );

  todos.sort((a, b) => {
    if (a.estado === 'live' && b.estado !== 'live') return -1;
    if (a.estado !== 'live' && b.estado === 'live') return 1;
    return new Date(a.horaInicio || 0) - new Date(b.horaInicio || 0);
  });

  const response = {
    status: 'online',
    timestamp: new Date().toISOString(),
    total: todos.length,
    en_vivo: todos.filter(e => e.estado === 'live').length,
    proximos: todos.filter(e => e.estado === 'scheduled').length,
    data: todos
  };

  setCache('fixtures', response);
  res.json(response);
});

app.listen(PORT, () => {
  console.log(`✅ BetGroup Cartelera ESPN (próximos 7 días) en puerto ${PORT}`);
});
