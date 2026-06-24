const express = require('express');
const cors = require('cors');
const https = require('https');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==================== FIREBASE ====================

let db;

try {
  const serviceAccountB64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!serviceAccountB64) {
    throw new Error('La variable de entorno FIREBASE_SERVICE_ACCOUNT_B64 no está definida.');
  }

  const serviceAccountJson = Buffer.from(serviceAccountB64, 'base64').toString('utf8');
  const serviceAccount = JSON.parse(serviceAccountJson);
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
  });
  
  console.log('✅ Firebase Admin SDK inicializado');

// Claves de agentes (si no están en variables de entorno)


// ==================== NOTIFICACIÓN DE ERRORES A TELEGRAM ====================
const TELEGRAM_BOT_TOKEN = '8671464180:AAHhu_Ct9-3Q6Arjle-7Xy4DyUGuuNvraBs';
const TELEGRAM_CHAT_ID = '-5154764705';

function notifyTelegram(texto) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  require('https').get(`${url}?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(texto)}`).on('error', () => {});
}

process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err.message);
  notifyTelegram(`🚨 BetGroup Proxy ERROR: ${err.message}\n\nStack: ${err.stack?.substring(0, 300) || 'sin stack'}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada:', reason);
  notifyTelegram(`⚠️ BetGroup Proxy PROMESA RECHAZADA: ${reason?.message || reason}`);
});
// ==================== FIN NOTIFICACIÓN TELEGRAM ====================


  db = admin.database();
} catch(error) {
  console.error('Error al inicializar Firebase Admin SDK:', error.message);
  process.exit(1);
}

// ==================== CACHÉ ====================

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

// ==================== API KEYS ====================

const ODDS_API_KEY_1 = process.env.ODDS_API_KEY_1 || '';
const ODDS_API_KEY_2 = process.env.ODDS_API_KEY_2 || '';

function getApiKey() {
  const hour = new Date().getHours();
  // Claves por defecto siempre disponibles
  if (hour === 0 || hour === 8)  return 'e18abd8956512f34027f0ac3f87fbe52';
  if (hour === 14 || hour === 18) return '0e31c3149f0afbb009491a0cd80169f4';
  // Fuera de horario: devolver la clave más reciente para no parar el sistema
  return '0e31c3149f0afbb009491a0cd80169f4';
}

// ==================== ESPN FETCH ====================

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
        try { 
          resolve(JSON.parse(data)); 
        } catch(e) { 
          reject(new Error('Error parsing ESPN response')); 
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

// ==================== PARSE EVENTS ====================

function parseEvents(espnData, sport) {
  const events = [];
  if (!espnData || !espnData.events) return events;

  for (const ev of espnData.events) {
    try {
      let allCompetitors = [];
      let competitionStatus = ev.status?.type;

      if (ev.competitions?.length) {
        allCompetitors = ev.competitions[0].competitors || [];
        competitionStatus = ev.competitions[0].status?.type || competitionStatus;
      } else if (ev.groupings?.length) {
        for (const grouping of ev.groupings) {
          if (grouping.competitions?.length) {
            const latestComp = grouping.competitions[grouping.competitions.length - 1];
            allCompetitors = latestComp.competitors || [];
            competitionStatus = latestComp.status?.type || competitionStatus;
            if (allCompetitors.length >= 2) break;
          }
        }
      }
      
      if (allCompetitors.length < 2) continue;

      const isTeamSport = allCompetitors[0].homeAway !== undefined;
      let home, away;
      
      if (isTeamSport) {
        home = allCompetitors.find(c => c.homeAway === 'home');
        away = allCompetitors.find(c => c.homeAway === 'away');
        if (!home && !away) {
          home = allCompetitors[0];
          away = allCompetitors[1];
        }
      } else {
        home = allCompetitors[0];
        away = allCompetitors[1];
      }

      const getName = (c) => {
        const name = c?.athlete?.displayName || c?.team?.displayName || 'Desconocido';
        // Si el nombre es TBD o null, devolver null para filtrar el evento
        if (!name || name === 'TBD' || name === 'None') return null;
        return name;
      };
      
      const getLogo = (c) => {
    // Deportes de equipo: usar logo del equipo
    if (c?.team?.logo) return c.team.logo;
    // Deportes individuales: usar foto del atleta
    if (c?.athlete?.headshot) return c.athlete.headshot;
    return null;
  };

      const status = competitionStatus || ev.status?.type;
      if (!status) continue;
      
      const isLive = status.state === 'in';
      const isScheduled = status.state === 'pre';
      if (!isLive && !isScheduled) continue;

      const homeScore = home.score || '0';
      const awayScore = away.score || '0';

            const nombreLocal = getName(home);
      const nombreVisitante = getName(away);
      if (!nombreLocal || !nombreVisitante) continue; // Saltar eventos TBD

      events.push({
        id: ev.id,
        sport,
        liga: espnData.leagues?.[0]?.name || sport,
        ligaLogo: espnData.leagues?.[0]?.logos?.[0]?.href || null,
        local: getName(home),
        visitante: getName(away),
        homeLogo: getLogo(home),
        awayLogo: getLogo(away),
        marcador: isLive ? `${homeScore}-${awayScore}` : null,
        minuto: ev.status?.displayClock || null,
        estado: isLive ? 'live' : 'scheduled',
        horaInicio: ev.date || null,
        cuota_local: null,
        cuota_empate: null,
        cuota_visitante: null
      });
    } catch(e) { 
      /* evento inválido */ 
    }
  }
  
  return events;
}

// ==================== ENRIQUECER CON CUOTAS ====================



// ==================== ENRIQUECER CON CUOTAS ====================

function limpiarNombre(nombre) {
  if (!nombre) return '';
  return nombre
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/^ny\b|\bny$/g, 'new york')
    .replace(/^la\b|\bla$/g, 'los angeles')
    .replace(/^st\b|\bst\.?$/g, 'saint')
    .replace(/\b(fc|cf|sc|ac|united|city|club|deportivo|real|san|los|las|the|of)\b/g, '')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


// Cache de cuotas por sportKey (12h de vida)
const oddsCache = {};






// ==================== FUNCIONES DE SIMILITUD AVANZADAS ====================
function bigramas(str) {
  const s = str.toLowerCase();
  const bigrams = [];
  for (let i = 0; i < s.length - 1; i++) {
    bigrams.push(s.substring(i, i + 2));
  }
  return new Set(bigrams);
}

function sorensenDice(str1, str2) {
  const bigrams1 = bigramas(str1);
  const bigrams2 = bigramas(str2);
  const intersection = new Set([...bigrams1].filter(x => bigrams2.has(x)));
  return (2 * intersection.size) / (bigrams1.size + bigrams2.size);
}

function jaccardTokens(str1, str2) {
  const tokens1 = new Set(str1.split(' ').filter(t => t.length > 1));
  const tokens2 = new Set(str2.split(' ').filter(t => t.length > 1));
  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// Resolución de países por código ISO (sin diccionarios)
function tieneCodigoISO(nombre) {
  const isoMap = {
    'czechia': 'CZE', 'czech republic': 'CZE',
    'south korea': 'KOR', 'korea republic': 'KOR',
    'north korea': 'PRK',
    'united states': 'USA', 'usa': 'USA',
    'england': 'ENG', 'spain': 'ESP', 'france': 'FRA',
    'germany': 'DEU', 'italy': 'ITA', 'portugal': 'PRT',
    'argentina': 'ARG', 'brazil': 'BRA', 'mexico': 'MEX'
  };
  return isoMap[limpiarNombre(nombre)] || null;
}

function coincideEquipo(evento, game) {
  const localESPN = evento.local || '';
  const visitanteESPN = evento.visitante || '';
  const homeAPI = game.home_team || '';
  const awayAPI = game.away_team || '';

  // 1. Filtrar por deporte/liga
  if (evento.sport !== 'soccer' && evento.sport !== 'basketball' && evento.sport !== 'baseball' && evento.sport !== 'mma') {
    return { score: 0, esCruzado: false };
  }

  // 2. Verificar códigos ISO para selecciones
  const isoLocalESPN = tieneCodigoISO(localESPN);
  const isoVisitanteESPN = tieneCodigoISO(visitanteESPN);
  const isoHomeAPI = tieneCodigoISO(homeAPI);
  const isoAwayAPI = tieneCodigoISO(awayAPI);

  let scoreDirecto = 0, scoreCruzado = 0;

  if (isoLocalESPN && isoVisitanteESPN && isoHomeAPI && isoAwayAPI) {
    scoreDirecto = (isoLocalESPN === isoHomeAPI && isoVisitanteESPN === isoAwayAPI) ? 1.0 : 0;
    scoreCruzado = (isoLocalESPN === isoAwayAPI && isoVisitanteESPN === isoHomeAPI) ? 1.0 : 0;
  } else {
    const localL = limpiarNombre(localESPN);
    const visitL = limpiarNombre(visitanteESPN);
    const homeL = limpiarNombre(homeAPI);
    const awayL = limpiarNombre(awayAPI);

    scoreDirecto = Math.max(
      sorensenDice(localL, homeL) * 0.6 + jaccardTokens(localL, homeL) * 0.4,
      sorensenDice(visitL, awayL) * 0.6 + jaccardTokens(visitL, awayL) * 0.4
    );
    scoreCruzado = Math.max(
      sorensenDice(localL, awayL) * 0.6 + jaccardTokens(localL, awayL) * 0.4,
      sorensenDice(visitL, homeL) * 0.6 + jaccardTokens(visitL, homeL) * 0.4
    );
  }

  const score = Math.max(scoreDirecto, scoreCruzado);
  return { score, esCruzado: scoreCruzado > scoreDirecto };
}
// ==================== FIN FUNCIONES DE SIMILITUD ====================

async function enriquecerConCuotas(eventos) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('⚠️ Sin The Odds API Key - usando cuotas por defecto');
    return eventos;
  }

  const sportKeyMap = {
    'soccer': (liga) => {
    const l = (liga || '').toLowerCase();
    if (l.includes('world') || l.includes('copa') || l.includes('fifa')) return 'soccer_epl';
    if (l.includes('friendly') || l.includes('amistoso')) return 'soccer_spain_la_liga';
    return 'soccer_epl';
  },
    'basketball': 'basketball_nba',
    'baseball': 'baseball_mlb',
    'mma': 'mma_mixed_martial_arts',
    'tennis': 'tennis_atp_wimbledon'
  };

  // Agrupar eventos por sportKey
  const grupos = {};
  for (const evento of eventos) {
    const sportKey = typeof sportKeyMap[evento.sport] === 'function' 
      ? sportKeyMap[evento.sport](evento.liga) 
      : sportKeyMap[evento.sport];
    if (!grupos[sportKey]) grupos[sportKey] = [];
    grupos[sportKey].push(evento);
  }

  // Procesar cada grupo
  for (const [sportKey, eventosGrupo] of Object.entries(grupos)) {
    const cacheEntry = oddsCache[sportKey];
    let juegos = null;

    // Usar caché si es válido (menos de 12h)
    if (cacheEntry && (Date.now() - cacheEntry.timestamp) < 12 * 60 * 60 * 1000) {
      juegos = cacheEntry.data;
    } else {
      try {
        console.log(`📡 Consultando The Odds API para: ${sportKey}...`);
        if (sportKey === 'mma_mixed_martial_arts') {
          console.log('🔍 MMA: Buscando cuotas para eventos de artes marciales mixtas');
        }
        // MMA solo tiene h2h, los demás tienen spreads y totals también
        const mkts = sportKey === 'mma_mixed_martial_arts' ? 'h2h' : 'h2h,spreads,totals';
        // Intentar con múltiples claves si la primera falla (ej. 401 para MMA)
        const apiKeys = [
          'c56f6c464ebd4fb634c495a2c2488610',
          'e18abd8956512f34027f0ac3f87fbe52',
          '0e31c3149f0afbb009491a0cd80169f4'
        ];
        let success = false;
        for (const key of apiKeys) {
          try {
            const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${key}&markets=${mkts}&regions=us`;
            const response = await axios.get(url, { timeout: 5000 });
            if (response.data) {
              juegos = response.data.data || response.data;
              oddsCache[sportKey] = { data: juegos, timestamp: Date.now() };
              success = true;
              break;
            }
          } catch(innerErr) {
            console.warn(`  Clave falló: ${key.slice(0,10)}... (${innerErr.message})`);
            continue;
          }
        }
        if (!success) {
          console.error(`  No se pudo obtener cuotas para ${sportKey} con ninguna clave.`);
        }
      } catch(err) {
        console.error(`Error cuotas para ${sportKey}:`, err.message);
        continue; // seguir con el siguiente deporte
      }
    }

    if (!juegos) continue;

    // Ahora cruzar cada evento del grupo con los juegos obtenidos
    for (const evento of eventosGrupo) {
      for (const game of juegos) {
        const { score, esCruzado } = coincideEquipo(evento, game);
        if (score < 0.82) continue;

        const bookmakers = game.bookmakers?.[0];
        if (!bookmakers?.markets) continue;

        const homeApi = limpiarNombre(game.home_team || '');
        const awayApi = limpiarNombre(game.away_team || '');

        // Mercado H2H
        const mktH2h = bookmakers.markets.find(m => m.key === 'h2h');
        if (mktH2h?.outcomes) {
          if (esCruzado) {
            evento.cuota_local = mktH2h.outcomes.find(o => limpiarNombre(o.name) === awayApi)?.price || evento.cuota_local;
            evento.cuota_visitante = mktH2h.outcomes.find(o => limpiarNombre(o.name) === homeApi)?.price || evento.cuota_visitante;
          } else {
            evento.cuota_local = mktH2h.outcomes.find(o => limpiarNombre(o.name) === homeApi)?.price || evento.cuota_local;
            evento.cuota_visitante = mktH2h.outcomes.find(o => limpiarNombre(o.name) === awayApi)?.price || evento.cuota_visitante;
          }
          const draw = mktH2h.outcomes.find(o => o.name.toLowerCase() === 'draw');
          if (draw) evento.cuota_empate = draw.price;
        }

        // Mercado Spreads (handicap)
        const mktSpreads = bookmakers.markets.find(m => m.key === 'spreads');
        if (mktSpreads?.outcomes) {
          const homeSpread = mktSpreads.outcomes.find(o => limpiarNombre(o.name) === homeApi);
          const awaySpread = mktSpreads.outcomes.find(o => limpiarNombre(o.name) === awayApi);
          if (homeSpread) { evento.handicap_local = homeSpread.point; evento.handicap_local_cuota = homeSpread.price; }
          if (awaySpread) { evento.handicap_visitante = awaySpread.point; evento.handicap_visitante_cuota = awaySpread.price; }
        }

        // Mercado Totals (over/under)
        const mktTotals = bookmakers.markets.find(m => m.key === 'totals');
        if (mktTotals?.outcomes) {
          const over = mktTotals.outcomes.find(o => o.name === 'Over');
          const under = mktTotals.outcomes.find(o => o.name === 'Under');
          if (over) { evento.total_over_point = over.point; evento.total_over_price = over.price; }
          if (under) { evento.total_under_point = under.point; evento.total_under_price = under.price; }
        }

        console.log(`✅ Cuota asignada (score: ${(score*100).toFixed(0)}%, ${esCruzado ? 'cruzada' : 'directa'}) a ${evento.local} vs ${evento.visitante}`);
        break;
      }
    }
  }
  return eventos;
}


// ==================== PRECALENTAR CACHÉ ====================

async function precalentarCache() {
  console.log('⏳ Precalentando caché...');

  const deportes = [
    { path: 'basketball/nba/scoreboard', sport: 'basketball' },
    { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
    { path: 'soccer/eng.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/esp.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/ger.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/ita.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/fra.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/ned.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/por.1/scoreboard', sport: 'soccer' },
    { path: 'soccer/usa.1/scoreboard', sport: 'soccer' },
    { path: 'tennis/wta/scoreboard', sport: 'tennis' },
    { path: 'mma/ufc/scoreboard', sport: 'mma' }
  ];

  let allEvents = [];

  for (const deporte of deportes) {
    try {
      const data = await fetchESPN(deporte.path);
      const eventos = parseEvents(data, deporte.sport);
      allEvents = allEvents.concat(eventos);
    } catch(err) {
      console.error(`Error ${deporte.path}:`, err.message);
    }
  }

  await enriquecerConCuotas(allEvents);
// [HF]   // Si las cuotas no se obtuvieron, usar Athos
  const sinCuotas = allEvents.filter(e => !e.cuota_local || e.cuota_local <= 1.0);
  if (sinCuotas.length > 0) {
// [HF]     console.log(`Athos buscando cuotas para ${sinCuotas.length} eventos...`);
// [HF]     // Athos eliminado - el sistema usa solo The Odds API
  }

  const response = {
    status: 'online',
    timestamp: new Date().toISOString(),
    total: allEvents.length,
    en_vivo: allEvents.filter(e => e.estado === 'live').length,
    proximos: allEvents.filter(e => e.estado === 'scheduled').length,
    data: allEvents
  };

  setCache('fixtures', response);
  console.log(`✅ Caché precalentado: ${allEvents.length} eventos`);
}

// ==================== ENDPOINTS ====================

app.get('/', (req, res) => {
  res.json({ status: 'online', message: 'BetGroup Pro API v2.0' });
});

app.get('/api/ping', (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'online', 
    uptime: process.uptime(), 
    timestamp: new Date().toISOString() 
  });
});

app.get('/api/fixtures', async (req, res) => {
  try {
    const cached = getCache('fixtures');
    if (cached) {
      return res.json(cached);
    }

    const response = {
      status: 'loading',
      total: 0,
      en_vivo: 0,
      proximos: 0,
      data: []
    };
    
    res.json(response);

    await precalentarCache();
  } catch(err) {
    console.error('Error /api/fixtures:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/apostar', async (req, res) => {
  const { uid, amount, evento, tipo, cuota, tipoSaldo } = req.body;
  if (!uid || !amount || !evento || !tipo || !cuota) {
    return res.status(400).json({ error: 'Parámetros faltantes' });
  }
  const saldoCampo = (tipoSaldo === 'promo') ? 'creditoPromo' : 'creditoReal';
  try {
    const snap = await db.ref(`users/${uid}/${saldoCampo}`).once('value');
    const saldoActual = snap.val();
    if (saldoActual === null || saldoActual < amount) {
      return res.status(400).json({
        error: 'Saldo insuficiente',
        saldoActual: saldoActual || 0
      });
    }
    const saldoNuevo = saldoActual - amount;
    await db.ref(`users/${uid}/${saldoCampo}`).set(saldoNuevo);
    const betId = Date.now().toString();
    await db.ref(`apuestas/${uid}/${betId}`).set({
      eventoNombre: evento,
      tipo: tipo,
      monto: amount,
      cuota: cuota,
      ganancia: Math.floor(amount * cuota),
      estado: 'pendiente',
      fecha: Date.now(),
      tipoSaldo: tipoSaldo || 'real'
    });
    res.json({ success: true, saldoNuevo, betId });
  } catch(err) {
    console.error('Error /api/apostar:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== INICIAR ====================


// ==================== ENDPOINT SALDO REAL ====================

app.get('/api/saldo/:uid', async (req, res) => {
  const { uid } = req.params;

  if (!uid || uid.length < 10) {
    return res.status(400).json({ error: 'UID inválido' });
  }

  try {
    if (!db) {
      return res.status(500).json({ error: 'Firebase no configurado' });
    }

    const snap = await db.ref(`users/${uid}/creditoReal`).once('value');
    const saldo = snap.val();

    res.json({
      uid,
      creditoReal: saldo !== null && saldo !== undefined ? saldo : 0,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error /api/saldo:', err.message);
    res.status(500).json({ error: err.message });
  }
});







// ==================== ENDPOINT DE ESTADO DE AGENTES ====================






app.get('/api/agents-status', async (req, res) => {
  const GEMINI_B64 = 'QVEuQWI4Uk42SVNDbFk0WnNqSXRpZlNCaXZkeUppblBjMUdoNEljMUJGM2Nxc3RBVjRsa2c=';
  const GROQ_B64 = 'Z3NrX05rU01oNlBxdm9qdElnNTlrT1QyV0dkeWIzRlkwc3dDYVZHYzRGa055ZFV6OGZYcjl0SXc=';
  const geminiKey = Buffer.from(GEMINI_B64, 'base64').toString();
  const groqKey   = Buffer.from(GROQ_B64, 'base64').toString();
// [HF]   const status = { Geminis02: 'unknown', Agente_groc01: 'unknown', Athos_Tavily: 'unknown' };

  if (geminiKey) {
    try {
      const resp = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
        { contents: [{ parts: [{ text: 'OK' }] }] },
        { headers: { 'X-goog-api-key': geminiKey, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      status.Geminis02 = resp.data?.candidates ? 'online' : 'error';
    } catch(e) { status.Geminis02 = 'error: ' + e.message; }
  } else { status.Geminis02 = 'no_key'; }

  if (groqKey) {
    try {
      const resp = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'OK' }] },
        { headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      status.Agente_groc01 = resp.data?.choices ? 'online' : 'error';
    } catch(e) { status.Agente_groc01 = 'error: ' + e.message; }
  } else { status.Agente_groc01 = 'no_key'; }

// [HF]   const tavilyKey = process.env.TAVILY_API_KEY;
// [HF]   status.Athos_Tavily = tavilyKey ? 'configured' : 'no_key';
  res.json({ success: true, agents: status, timestamp: new Date().toISOString() });
});


// ==================== CHATBOT AGENTE_GROC01 ====================

app.post('/api/chat', async (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length === 0) {
    return res.status(400).json({ error: 'Mensaje vacío o inválido' });
  }
  const GROQ_B64 = 'Z3NrX05rU01oNlBxdm9qdElnNTlrT1QyV0dkeWIzRlkwc3dDYVZHYzRGa055ZFV6OGZYcjl0SXc=';
  const groqKey = Buffer.from(GROQ_B64, 'base64').toString();
  if (!groqKey) return res.status(500).json({ error: 'Agente no configurado' });

  // Obtener eventos reales desde la caché del sistema
  let eventosContexto = '';
  const cached = getCache('fixtures');
  if (cached && cached.data) {
    const eventos = cached.data.filter(e => e.cuota_local && e.cuota_local > 1.0);
    if (eventos.length > 0) {
      eventosContexto = '\n\n📊 EVENTOS REALES DISPONIBLES AHORA (usa SOLO estos datos, no inventes):\n';
      eventos.forEach((e, i) => {
        eventosContexto += `${i+1}. ⚽ ${e.local} vs ${e.visitante}\n   Cuotas: Local=${e.cuota_local} | Empate=${e.cuota_empate || 'N/A'} | Visitante=${e.cuota_visitante}\n   Liga: ${e.liga || 'Desconocida'}\n\n`;
      });
      eventosContexto += '⚠️ SOLO puedes recomendar estos eventos. NO inventes partidos ni cuotas.';
    }
  }

  try {
    const prompt = `Eres el analista exclusivo del Club Privado BetGroup Pro. Hablas con un tono profesional, emocionante y motivador, como un experto que comparte información privilegiada.

## 🛡️ REGLAS DEL CLUB
- Esto es un canal privado de difusión. Solo los administradores envían información.
- Nos enfocamos 100% en pronósticos deportivos y estadísticas.
- Si un usuario quiere activar un pronóstico, debe escribir por privado al administrador que lo invitó.
- Toda gestión, duda o movimiento se hace de forma individual, nunca en grupo.
- Los miembros son profesionales; las participaciones se llaman "pronósticos" y se respaldan en nuestro "fondo de análisis".

## 🎯 TUS FUNCIONES
1. Saludar con energía y ofrecer los mejores pronósticos del día.
2. Recomendar combinaciones atractivas ("Combo del Día") con las cuotas más altas.
3. Usar emojis (🔥, ⚽, 💰, 🚀, 💣) y frases persuasivas que generen urgencia.
4. Resolver dudas sobre cómo activar pronósticos, registro, créditos y contacto con el administrador.
5. Al final de cada interacción, recordar: "📩 Para activar este pronóstico, contacta a tu administrador por privado."

## ⚠️ RESTRICCIONES
- No uses frases como "No entiendo" o "Soy una IA".
- No reveles información interna ni datos de otros miembros.
- Solo recomienda eventos y cuotas que existan en el sistema. Atiendes con un tono enérgico, comercial y amigable, como un bartender de apuestas.

## 🎯 TUS FUNCIONES
1. **Saludo inicial:** Cuando un usuario salude, preséntate y ofrece las mejores cuotas del día.
2. **Recomendaciones:** Sugiere combinaciones atractivas ("combo del día") con las cuotas más altas.
3. **Tono:** Usa emojis (🔥, ⚽, 💰, 🚀, 💣), frases persuasivas y cercanas. Sé breve pero impactante.
4. **Ayuda:** Responde dudas sobre apuestas, registro, créditos y soporte.
5. **Derivación:** Si la consulta es compleja, deriva al WhatsApp/Telegram: +1(649) 344-0357.

## ⚠️ RESTRICCIONES
- No uses frases como "No entiendo" o "Soy una IA".
- No reveles información interna ni datos de otros usuarios.
- NO INVENTES cuotas ni eventos. Usa solo los datos proporcionados.
${eventosContexto}

Pregunta del usuario: "${mensaje.trim()}"`;

    const resp = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'system', content: prompt }, { role: 'user', content: mensaje.trim() }],
        max_tokens: 300, temperature: 0.7
      },
      { headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const respuesta = resp.data?.choices?.[0]?.message?.content || 'Lo siento, no puedo responder en este momento.';
    res.json({ success: true, respuesta });
  } catch(e) { console.error('Error /api/chat:', e.message); res.status(500).json({ error: 'Error al procesar la consulta' }); }
});



// ==================== VERIFICADOR GEMINIS02 ====================

async function obtenerEstadoSistema() {
  const estado = { proxy: 'ok', agentes: {}, eventos: 0, chatbot: false, saldo_firebase: null, saldo_endpoint: null };
  try {
    const agents = await axios.get('https://betgroup-proxy-v2.onrender.com/api/agents-status', { timeout: 5000 });
    estado.agentes = agents.data?.agents || {};
  } catch(e) { estado.agentes = { error: e.message }; }

  try {
    const fixtures = await axios.get('https://betgroup-proxy-v2.onrender.com/api/fixtures', { timeout: 5000 });
    estado.eventos = fixtures.data?.total || 0;
  } catch(e) { estado.eventos = -1; }

  try {
    const chat = await axios.post('https://betgroup-proxy-v2.onrender.com/api/chat',
      { mensaje: 'Test' }, { timeout: 5000 });
    estado.chatbot = chat.data?.success || false;
  } catch(e) { estado.chatbot = false; }

  // Leer saldo de usuario de prueba directamente desde Firebase
  try {
    const snap = await db.ref('users/BG_mq7rch3t_h6sjfs1h/creditoReal').once('value');
    estado.saldo_firebase = snap.val();
  } catch(e) { estado.saldo_firebase = 'error'; }

  // Leer saldo desde el endpoint /api/saldo
  try {
    const resp = await axios.get('https://betgroup-proxy-v2.onrender.com/api/saldo/BG_mq7rch3t_h6sjfs1h', { timeout: 5000 });
    estado.saldo_endpoint = resp.data?.creditoReal;
  } catch(e) { estado.saldo_endpoint = 'error'; }

  return estado;
}

async function notificarTelegram(texto) {
  try {
    await axios.post('https://api.telegram.org/bot8671464180:AAHhu_Ct9-3Q6Arjle-7Xy4DyUGuuNvraBs/sendMessage', {
      chat_id: '-5154764705',
      text: texto,
      parse_mode: 'HTML'
    }, { timeout: 5000 });
  } catch(e) { console.error('Error notificando a Telegram:', e.message); }
}

app.get('/api/verificacion-geminis', async (req, res) => {
  try {
    const estado = { proxy: 'ok', agentes: {}, eventos: 0, chatbot: false, saldo_firebase: null, saldo_endpoint: null };
    
    const [agentsResp, fixturesResp, chatResp, saldoFB, saldoEP] = await Promise.allSettled([
      axios.get('https://betgroup-proxy-v2.onrender.com/api/agents-status', { timeout: 3000 }),
      axios.get('https://betgroup-proxy-v2.onrender.com/api/fixtures', { timeout: 3000 }),
      axios.post('https://betgroup-proxy-v2.onrender.com/api/chat', { mensaje: 'Test' }, { timeout: 3000 }),
      db.ref('users/BG_mq7rch3t_h6sjfs1h/creditoReal').once('value'),
      axios.get('https://betgroup-proxy-v2.onrender.com/api/saldo/BG_mq7rch3t_h6sjfs1h', { timeout: 3000 })
    ]);

    if (agentsResp.status === 'fulfilled') estado.agentes = agentsResp.value.data?.agents || {};
    if (fixturesResp.status === 'fulfilled') estado.eventos = fixturesResp.value.data?.total || 0;
    if (chatResp.status === 'fulfilled') estado.chatbot = chatResp.value.data?.success || false;
    if (saldoFB.status === 'fulfilled') estado.saldo_firebase = saldoFB.value.val();
    if (saldoEP.status === 'fulfilled') estado.saldo_endpoint = saldoEP.value.data?.creditoReal;

    // Formato exacto del curl funcional
    const geminiKey = 'AQ.Ab8RN6ISClY4ZsjItifSBivdyJinPc1Gh4Ic1BF3cqstAV4lkg';
    let informe = 'Sistema operativo. Saldo Firebase: ' + estado.saldo_firebase + ' | Saldo endpoint: ' + estado.saldo_endpoint;
    
    try {
      const resp = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
        { contents: [{ parts: [{ text: 'Eres el verificador de BetGroup Pro. Datos del sistema: ' + JSON.stringify(estado) + '. Genera un informe breve en 2 frases.' }] }] },
        { headers: { 'X-goog-api-key': geminiKey, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      if (resp.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        informe = resp.data.candidates[0].content.parts[0].text;
      }
    } catch(e) { console.log('Gemini no disponible para el informe, usando resumen básico'); }

    await axios.post('https://api.telegram.org/bot8671464180:AAHhu_Ct9-3Q6Arjle-7Xy4DyUGuuNvraBs/sendMessage', {
      chat_id: '-5154764705',
      text: '📊 <b>INFORME DE GEMINIS02</b>\n\n' + informe,
      parse_mode: 'HTML'
    }, { timeout: 5000 });

    res.json({ success: true, estado, informe });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ==================== LIQUIDACIÓN DE APUESTAS (TRANSACCIONAL) ====================
app.post('/api/apuestas/liquidar', async (req, res) => {
  const { partidoId, resultadoGanador } = req.body;
  if (!partidoId || !resultadoGanador) {
    return res.status(400).json({ error: 'partidoId y resultadoGanador requeridos' });
  }
  try {
    const snapshot = await db.ref('apuestas').once('value');
    if (!snapshot.exists()) {
      return res.status(200).json({ message: 'No hay apuestas para liquidar.' });
    }
    const todosUsuarios = snapshot.val();
    let liquidadas = 0;

    for (const uid of Object.keys(todosUsuarios)) {
      const apuestasUsuario = todosUsuarios[uid];
      for (const betId of Object.keys(apuestasUsuario)) {
        const apuesta = apuestasUsuario[betId];
        if (apuesta.estado !== 'pendiente') continue;
        if (apuesta.eventoNombre !== partidoId) continue;

        const gano = (apuesta.tipo === resultadoGanador);
        const nuevoEstado = gano ? 'ganada' : 'perdida';

        await db.ref(`apuestas/${uid}/${betId}`).update({ estado: nuevoEstado });

        if (gano) {
          const premio = parseFloat(apuesta.monto) * parseFloat(apuesta.cuota);
          const userRef = db.ref(`users/${uid}/creditoReal`);
          await userRef.transaction(current => (current || 0) + premio);

          await db.ref('auditLog').push().set({
            tipo: 'pago_premio',
            uid,
            betId,
            montoPagado: premio,
            fecha: Date.now()
          });
        }
        liquidadas++;
      }
    }
    res.json({ success: true, liquidadas, message: `${liquidadas} apuestas liquidadas.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ==================== FIN LIQUIDACIÓN ====================



// ==================== REINICIO DEL SISTEMA (MULTI-NODO) ====================
app.post('/api/admin/reiniciar', async (req, res) => {
  try {
    const updates = {
      'apuestas': null,
      'historial': null,
      'auditLog': null,
      'transacciones': null
    };
    await db.ref().update(updates);
    // Restaurar CEO por defecto
    await db.ref('users/ceo_root').set({
      uid: 'ceo_root',
      nombre: 'CEO Principal',
      rol: 'CEO',
      creditoReal: 1000000,
      creditoPromo: 0,
      creadoPor: 'sistema'
    });
    res.status(200).json({ success: true, message: 'Sistema reiniciado. Auditoría e historial limpios.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
// ==================== FIN REINICIO ====================



// ==================== REFERIDOS FILTRADOS POR SUBADMIN ====================
app.get('/api/usuarios/mis-referidos', async (req, res) => {
  const subadminUid = req.query.subadminUid;
  if (!subadminUid) return res.status(400).json({ error: 'subadminUid requerido' });
  try {
    const snapshot = await db.ref('users')
      .orderByChild('creadoPor')
      .equalTo(subadminUid)
      .once('value');
    const referidos = snapshot.val() ? Object.values(snapshot.val()) : [];
    res.json(referidos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ==================== FIN REFERIDOS ====================



// ==================== GENERAR CÓDIGO POR INICIAL DEL ROL ====================
app.get('/api/admin/generar-codigo', async (req, res) => {
  const { rol = 'ceo' } = req.query;
  const rolesValidos = ['ceo', 'admin', 'moderador', 'soporte'];
  if (!rolesValidos.includes(rol)) return res.status(400).json({ error: 'Rol no válido' });

  const ahora = new Date();
  const dia = String(ahora.getDate()).padStart(2, '0');
  const mes = String(ahora.getMonth() + 1).padStart(2, '0');
  const año = String(ahora.getFullYear()).slice(-2);
  const hora = String(ahora.getHours()).padStart(2, '0');
  const minuto = String(ahora.getMinutes()).padStart(2, '0');
  const rolInicial = rol.charAt(0).toUpperCase();
  const fecha = `${dia}${mes}${año}${hora}${minuto}`;
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  const codigo = `${rolInicial}${fecha}${random}`;

  res.json({ success: true, codigo, rol, formato: `${rolInicial}[DÍA][MES][AÑO][HORA][MINUTO][RANDOM_4]` });
});
// ==================== FIN GENERAR CÓDIGO ====================



// ==================== APLICAR CÓDIGO CEO ====================
app.post('/api/admin/aplicar-codigo', async (req, res) => {
  const { codigo, uid } = req.body;
  if (!codigo || !uid) return res.status(400).json({ error: 'Código o UID faltante' });

  const rolMap = { 'C': 'ceo', 'A': 'admin', 'M': 'moderador', 'S': 'soporte' };
  const rol = rolMap[codigo.charAt(0)];
  if (!rol) return res.status(400).json({ error: 'Código no válido' });

  await db.ref(`users/${uid}/rol`).set(rol);
  await db.ref(`auditLog/${Date.now()}`).set({ accion: 'rol_asignado', uid, rol, codigo, fecha: new Date().toISOString() });

  res.json({ success: true, uid, rol, mensaje: `Rol "${rol}" asignado al usuario ${uid}` });
});
// ==================== FIN APLICAR CÓDIGO ====================


setCache('fixtures', null);
console.log('Caché de fixtures limpiado al inicio.');
setCache("fixtures", null);
console.log("Caché de fixtures limpiado al inicio.");

// ════ POST /api/enriquecer — Frontend envía eventos ESPN, backend agrega cuotas ════
app.post('/api/enriquecer', async (req, res) => {
  try {
    const { eventos } = req.body;
    if (!Array.isArray(eventos) || eventos.length === 0) {
      return res.status(400).json({ error: 'Se requiere array de eventos' });
    }
    const enriquecidos = await enriquecerConCuotas(eventos);
    res.json({ status: 'success', total: enriquecidos.length, data: enriquecidos });
  } catch(err) {
    console.error('Error /api/enriquecer:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ════ AGENTE UNIFICADO HUGGING FACE ════
const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_MODELS = {
  analisis: 'moonshotai/Kimi-K2-Instruct-0905',   // análisis de apuestas
  chat: 'meta-llama/Llama-3.3-70B-Instruct',      // soporte al usuario
  rapido: 'Qwen/Qwen2.5-7B-Instruct'  // procesamiento rápido
};

app.post('/api/huggingface', async (req, res) => {
  const { prompt, tarea } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Falta prompt' });
  const model = HF_MODELS[tarea] || HF_MODELS['rapido'];
  try {
    const response = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000
      })
    });
    const data = await response.json();
    const reply = data?.choices?.[0]?.message?.content || JSON.stringify(data);
    res.json({ reply, model });
  } catch(err) {
    console.error('Hugging Face error:', err.message);
    res.status(500).json({ error: 'Error al contactar Hugging Face' });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Proxy escuchando en puerto ${PORT}`);
  precalentarCache();
  setInterval(precalentarCache, 3 * 60 * 1000);
});
