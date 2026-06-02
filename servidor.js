const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('ESPN parse error')); }
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
      // SOCCER - Todas las competiciones
      { path: 'soccer/esp.1/scoreboard', sport: 'soccer', liga: 'LaLiga' },
      { path: 'soccer/eng.1/scoreboard', sport: 'soccer', liga: 'Premier League' },
      { path: 'soccer/ger.1/scoreboard', sport: 'soccer', liga: 'Bundesliga' },
      { path: 'soccer/ita.1/scoreboard', sport: 'soccer', liga: 'Serie A' },
      { path: 'soccer/fra.1/scoreboard', sport: 'soccer', liga: 'Ligue 1' },
      { path: 'soccer/uefa.champions/scoreboard', sport: 'soccer', liga: 'Champions League' },
      { path: 'soccer/conmebol.libertadores/scoreboard', sport: 'soccer', liga: 'CONMEBOL Libertadores' },
      { path: 'soccer/fifa.world_cup/scoreboard', sport: 'soccer', liga: 'Mundial FIFA' },
      { path: 'soccer/usa.1/scoreboard', sport: 'soccer', liga: 'MLS' },
      // BASKETBALL
      { path: 'basketball/nba/scoreboard', sport: 'basketball', liga: 'NBA' },
      // BASEBALL
      { path: 'baseball/mlb/scoreboard', sport: 'baseball', liga: 'MLB' },
      // MMA
      { path: 'mma/ufc/scoreboard', sport: 'mma', liga: 'UFC' },
      // TENIS
      { path: 'tennis/atp/scoreboard', sport: 'tennis', liga: 'ATP' },
      { path: 'tennis/wta/scoreboard', sport: 'tennis', liga: 'WTA' }
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
              liga: deporte.liga,
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
              liga: deporte.liga,
              estado: isLive ? 'live' : 'scheduled',
              horaInicio: ev.date
            });
          }
        }
      } catch(e) {
        console.error(`Error ${deporte.path}:`, e.message);
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
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy ESPN escuchando en puerto ${PORT}`);
});

// ENDPOINT CRÍTICO: Procesar apuestas
app.post('/api/apostar', async (req, res) => {
  const { uid, amount, evento, tipo, cuota } = req.body;
  
  if (!uid || !amount || !evento || !tipo || !cuota) {
    return res.status(400).json({ error: 'Parámetros faltantes' });
  }

  try {
    const admin = require('firebase-admin');
    const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    
    if (!serviceAccountBase64) {
      return res.status(500).json({ error: 'Firebase no configurado' });
    }

    const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));
    
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
      });
    }

    const db = admin.database();

    // PASO 1: Descontar saldo (once + set, no transaction)
    const snap = await db.ref(`users/${uid}/creditoReal`).once('value');
    const saldoActual = snap.val();
    
    if (saldoActual === null || saldoActual < amount) {
      return res.status(400).json({ error: 'Saldo insuficiente', saldoActual });
    }

    const saldoNuevo = saldoActual - amount;
    await db.ref(`users/${uid}/creditoReal`).set(saldoNuevo);

    // PASO 2: Registrar apuesta
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
