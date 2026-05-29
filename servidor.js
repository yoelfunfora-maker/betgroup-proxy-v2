const express = require('express');
const cors = require('cors');
const https = require('https');
const axios = require('axios');

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

// PARSE
function parseEvents(espnData, sport) {
  const events = [];
  if (!espnData || !espnData.events) return events;

  const ahora = Date.now();
  const dentro14dias = ahora + (14 * 24 * 60 * 60 * 1000);

  for (const ev of espnData.events) {
    try {
      const competition = ev.competitions?.[0];
      if (!competition) continue;
      const competitors = competition.competitors || [];
      
      if (sport === 'mma') {
        if (competitors.length < 2) continue;
        const home = competitors[0];
        const away = competitors[1];
        const status = ev.status?.type;
        const isLive = status?.state === 'in';
        const isScheduled = status?.state === 'pre';
        if (!isLive && !isScheduled) continue;

        const eventTime = new Date(ev.date || 0).getTime();
        if (eventTime < ahora || eventTime > dentro14dias) continue;

        events.push({
          id: ev.id,
          sport,
          liga: espnData.leagues?.[0]?.name || 'UFC',
          ligaLogo: espnData.leagues?.[0]?.logos?.[0]?.href || null,
          local: home.athlete?.displayName || 'Peleador 1',
          visitante: away.athlete?.displayName || 'Peleador 2',
          homeLogo: null,
          awayLogo: null,
          marcador: isLive ? `${home.score || 0}-${away.score || 0}` : null,
          minuto: isLive ? ev.status?.displayClock || '' : null,
          estado: isLive ? 'live' : 'scheduled',
          horaInicio: ev.date || null
        });
      } else {
        const home = competitors.find(c => c.homeAway === 'home');
        const away = competitors.find(c => c.homeAway === 'away');
        if (!home || !away) continue;

        const status = ev.status?.type;
        const isLive = status?.state === 'in';
        const isScheduled = status?.state === 'pre';
        if (!isLive && !isScheduled) continue;

        const eventTime = new Date(ev.date || 0).getTime();
        if (eventTime < ahora || eventTime > dentro14dias) continue;

        events.push({
          id: ev.id,
          sport,
          liga: espnData.leagues?.[0]?.name || sport,
          ligaLogo: espnData.leagues?.[0]?.logos?.[0]?.href || null,
          local: home.team?.displayName || 'Local',
          visitante: away.team?.displayName || 'Visitante',
          homeLogo: home.team?.logo || null,
          awayLogo: away.team?.logo || null,
          marcador: isLive ? `${home.score || 0}-${away.score || 0}` : null,
          minuto: isLive ? ev.status?.displayClock || '' : null,
          estado: isLive ? 'live' : 'scheduled',
          horaInicio: ev.date || null
        });
      }
    } catch(e) { }
  }
  return events;
}

// SYNC THE ODDS API A FIREBASE
async function syncOddsToFirebase() {
  try {
    console.log('🔄 Sincronizando The Odds API a Firebase...');
    
    const admin = require('firebase-admin');
    const fs = require('fs');
    
    // Firebase
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (!serviceAccountBase64) {
      console.error('❌ FIREBASE_SERVICE_ACCOUNT_B64 no definida');
      return;
    }
    
    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
    
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
      });
    }
    
    const db = admin.database();
    const apiKey = process.env.ODDS_API_KEY_1 || '2c550803a9a95dd28f551e2aba532676';
    
    const sports = [
      { odds: 'soccer_epl', name: 'Premier League' },
      { odds: 'soccer_la_liga', name: 'La Liga' },
      { odds: 'soccer_champions_league', name: 'Champions' },
      { odds: 'basketball_nba', name: 'NBA' },
      { odds: 'baseball_mlb', name: 'MLB' }
    ];
    
    let count = 0;
    
    for (const sport of sports) {
      try {
        const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport.odds}/odds`, {
          params: { apiKey, regions: 'us', markets: '1x2' },
          timeout: 10000
        });
        
        if (response.data && Array.isArray(response.data)) {
          for (const evento of response.data) {
            const bookmaker = evento.bookmakers?.[0];
            if (!bookmaker) continue;
            
            const market = bookmaker.markets?.find(m => m.key === '1x2' || m.key === 'h2h');
            if (!market) continue;
            
            const outcomes = market.outcomes || [];
            const local = outcomes.find(o => o.name === evento.home_team);
            const visitante = outcomes.find(o => o.name === evento.away_team);
            const empate = outcomes.find(o => o.name === 'Draw');
            
            if (!local || !visitante) continue;
            
            const mercado = {
              id: evento.id,
              sport: sport.odds.split('_')[0],
              homeTeam: evento.home_team,
              awayTeam: evento.away_team,
              commenceTime: evento.commence_time,
              cuotas: {
                local: local.price,
                visitante: visitante.price,
                empate: empate ? empate.price : null
              },
              expiraEn: new Date(evento.commence_time).getTime() + 7200000,
              ligaOdds: sport.name
            };
            
            await db.ref(`mercados/${evento.id}`).set(mercado);
            count++;
          }
        }
      } catch(e) {
        console.error(`Error en ${sport.odds}:`, e.message);
      }
    }
    
    console.log(`✅ ${count} mercados sincronizados a Firebase`);
    
  } catch(e) {
    console.error('Error sincronización:', e.message);
  }
}

// ENDPOINTS
app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API' });
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
  console.log(`✅ BetGroup API en puerto ${PORT}`);
  
  // Sync inmediatamente al iniciar
  syncOddsToFirebase();
  
  // Sync cada 6 horas
  setInterval(syncOddsToFirebase, 6 * 60 * 60 * 1000);
});
