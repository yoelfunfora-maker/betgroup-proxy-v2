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

// PARSE - SIN CALCULAR CUOTAS (dejar para The Odds API)
function parseEvents(espnData, sport) {
  const events = [];
  if (!espnData || !espnData.events) return events;

  for (const ev of espnData.events) {
    try {
      const competition = ev.competitions?.[0];
      if (!competition) continue;
      const competitors = competition.competitors || [];
      const home = competitors.find(c => c.homeAway === 'home');
      const away = competitors.find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      const status = ev.status?.type;
      const isLive = status?.state === 'in';
      const isScheduled = status?.state === 'pre';
      if (!isLive && !isScheduled) continue;

      const homeScore = home.score || '0';
      const awayScore = away.score || '0';
      const minute = ev.status?.displayClock || '';
      const period = ev.status?.period || 0;

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
        periodo: period,
        estado: isLive ? 'live' : 'scheduled',
        horaInicio: ev.date || null,
        cuota_local: null,
        cuota_empate: null,
        cuota_visitante: null
      });
    } catch(e) { }
  }
  return events;
}

// ENDPOINTS
app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API — ESPN Cartelera' });
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
    { path: 'baseball/mlb/scoreboard', sport: 'baseball' }
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
  console.log(`✅ BetGroup Cartelera ESPN en puerto ${PORT}`);
});

// SYNC: Obtener cuotas de The Odds API y guardarlas en Firebase
app.post('/api/sync-odds', async (req, res) => {
  try {
    console.log('📊 Sincronizando The Odds API...');
    
    const apiKey = process.env.ODDS_API_KEY_1;
    if (!apiKey) return res.status(400).json({ error: 'ODDS_API_KEY_1 no definida' });
    
    const sports = ['soccer_epl', 'soccer_champions_league', 'soccer_la_liga', 'baseball_mlb', 'basketball_nba'];
    const admin = require('firebase-admin');
    const db = admin.database();
    
    let count = 0;
    
    for (const sport of sports) {
      try {
        const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds`, {
          params: { apiKey: apiKey, regions: 'us' },
          timeout: 8000
        });
        
        if (response.data && Array.isArray(response.data)) {
          response.data.forEach(evento => {
            const mercado = {
              id: evento.id,
              sport: sport.split('_')[0],
              homeTeam: evento.home_team,
              awayTeam: evento.away_team,
              commenceTime: evento.commence_time,
              cuotas: {
                local: evento.bookmakers?.[0]?.markets?.[0]?.outcomes?.[0]?.price || null,
                visitante: evento.bookmakers?.[0]?.markets?.[0]?.outcomes?.[1]?.price || null,
                draw: evento.bookmakers?.[0]?.markets?.[0]?.outcomes?.[2]?.price || null
              },
              expiraEn: new Date(evento.commence_time).getTime() + 7200000
            };
            
            if (mercado.cuotas.local && mercado.cuotas.visitante) {
              db.ref(`mercados/${evento.id}`).set(mercado);
              count++;
            }
          });
        }
      } catch(e) {
        console.error(`Error en ${sport}:`, e.message);
      }
    }
    
    console.log(`✅ ${count} mercados sincronizados`);
    res.json({ status: 'sync_completed', mercados: count });
    
  } catch(e) {
    console.error('Error sync:', e);
    res.status(500).json({ error: e.message });
  }
});

// Sincronizar automáticamente cada 6 horas
setInterval(() => {
  console.log('🔄 Sincronización automática de The Odds API...');
  const axios = require('axios');
  const admin = require('firebase-admin');
  // (mismo código del endpoint)
}, 6 * 60 * 60 * 1000);
