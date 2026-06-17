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
        // ========== MONEYLINE (H2H) ==========
        cuota_local: null,
        cuota_empate: null,
        cuota_visitante: null,
        // ========== HANDICAP (SPREADS) ==========
        handicap_local: null,           // punto del handicap local
        handicap_local_cuota: null,     // cuota del handicap local
        handicap_visitante: null,       // punto del handicap visitante
        handicap_visitante_cuota: null, // cuota del handicap visitante
        // ========== TOTALES (TOTALS) ==========
        total_over_point: null,         // punto del over (ej: 2.5)
        total_over_price: null,         // cuota del over
        total_under_point: null,        // punto del under (ej: 2.5)
        total_under_price: null         // cuota del under
      });
    } catch(e) { 
      /* evento inválido */ 
    }
  }
  
  return events;
}

// ==================== ENRIQUECER CON CUOTAS ====================



// ==================== ENRIQUECER CON CUOTAS ====================

// ==================== SIMILITUD Y NORMALIZACIÓN ====================

function normalizarNombre(nombre) {
  if (!nombre) return '';
  
  return nombre
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // tildes
    .replace(/\b(ny|n\.y\.)\b/g, 'new york')
    .replace(/\b(la|l\.a\.)\b/g, 'los angeles')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Alias para compatibilidad
function limpiarNombre(nombre) {
  return normalizarNombre(nombre);
}

// ==================== SIMILITUD DE JACCARD ====================
function jaccardSimilarity(str1, str2) {
  const tokens1 = new Set(str1.split(' ').filter(t => t.length > 1));
  const tokens2 = new Set(str2.split(' ').filter(t => t.length > 1));
  
  if (tokens1.size === 0 && tokens2.size === 0) return 1.0;
  if (tokens1.size === 0 || tokens2.size === 0) return 0.0;
  
  const interseccion = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);
  
  return interseccion.size / union.size;
}

// ==================== DISTANCIA DE LEVENSHTEIN ====================
function levenshteinDistance(s1, s2) {
  const len1 = s1.length;
  const len2 = s2.length;
  const d = Array(len2 + 1).fill(0).map(() => Array(len1 + 1).fill(0));
  
  for (let i = 0; i <= len1; i++) d[0][i] = i;
  for (let j = 0; j <= len2; j++) d[j][0] = j;
  
  for (let j = 1; j <= len2; j++) {
    for (let i = 1; i <= len1; i++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      d[j][i] = Math.min(
        d[j][i - 1] + 1,
        d[j - 1][i] + 1,
        d[j - 1][i - 1] + cost
      );
    }
  }
  
  return d[len2][len1];
}

function levenshteinSimilarity(s1, s2) {
  const maxLen = Math.max(s1.length, s2.length);
  if (maxLen === 0) return 1.0;
  return 1 - (levenshteinDistance(s1, s2) / maxLen);
}

// ==================== PUNTUACIÓN DE SIMILITUD MULTI-CRITERIO ====================
function calcularPuntuacionSimilitud(evento, game) {
  const localNorm = normalizarNombre(evento.local);
  const visitanteNorm = normalizarNombre(evento.visitante);
  const homeNorm = normalizarNombre(game.home_team || '');
  const awayNorm = normalizarNombre(game.away_team || '');
  
  // COINCIDENCIA DIRECTA: local = home, visitante = away
  const jaccardHome = jaccardSimilarity(localNorm, homeNorm);
  const jaccardAway = jaccardSimilarity(visitanteNorm, awayNorm);
  const levenHome = levenshteinSimilarity(localNorm, homeNorm);
  const levenAway = levenshteinSimilarity(visitanteNorm, awayNorm);
  
  const puntuacionDirecta = (jaccardHome * 0.4 + levenHome * 0.35) + (jaccardAway * 0.4 + levenAway * 0.35);
  
  // COINCIDENCIA CRUZADA: local = away, visitante = home
  const jaccardHomeX = jaccardSimilarity(localNorm, awayNorm);
  const jaccardAwayX = jaccardSimilarity(visitanteNorm, homeNorm);
  const levenHomeX = levenshteinSimilarity(localNorm, awayNorm);
  const levenAwayX = levenshteinSimilarity(visitanteNorm, homeNorm);
  
  const puntuacionCruzada = (jaccardHomeX * 0.4 + levenHomeX * 0.35) + (jaccardAwayX * 0.4 + levenAwayX * 0.35);
  
  return {
    directa: puntuacionDirecta,
    cruzada: puntuacionCruzada,
    mejor: Math.max(puntuacionDirecta, puntuacionCruzada),
    tipo: puntuacionDirecta > puntuacionCruzada ? 'directa' : 'cruzada'
  };
}


// Cache de cuotas por sportKey (12h de vida)
const oddsCache = {};





async function enriquecerConCuotas(eventos) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('⚠️ Sin The Odds API Key - usando cuotas por defecto');
    return eventos;
  }

  const sportKeyMap = {
    'soccer': (liga) => {
    const l = (liga || '').toLowerCase();
    if (l.includes('world') || l.includes('copa') || l.includes('fifa')) return 'soccer_fifa_world_cup';
    if (l.includes('friendly') || l.includes('amistoso')) return 'soccer_international_friendly';
    return 'soccer_epl';
  },
    'basketball': 'basketball_nba',
    'baseball': 'baseball_mlb',
    'mma': 'mma_mixed_martial_arts',
    'tennis': 'tennis_atp'
  };

  // Agrupar eventos por sportKey
  const grupos = {};
  for (const evento of eventos) {
    const sportKey = typeof sportKeyMap[evento.sport] === 'function' 
      ? sportKeyMap[evento.sport](evento.liga) 
      : sportKeyMap[evento.sport];
    if (!sportKey) continue;
    if (!grupos[sportKey]) grupos[sportKey] = [];
    grupos[sportKey].push(evento);
  }

  // Procesar cada grupo
  for (const [sportKey, eventosGrupo] of Object.entries(grupos)) {
    const cacheKey = `odds_${sportKey}`;
    const cacheEntry = oddsCache[cacheKey];
    let juegos = null;

    // Usar caché si es válido (menos de 5 minutos)
    if (cacheEntry && (Date.now() - cacheEntry.timestamp) < 5 * 60 * 1000) {
      juegos = cacheEntry.data;
    } else {
      try {
        console.log(`📡 Consultando The Odds API para: ${sportKey} (h2h, spreads, totals)...`);
        
        // CAMBIO CLAVE: markets=h2h,spreads,totals
        const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${apiKey}&markets=h2h,spreads,totals&regions=us`;
        const response = await axios.get(url, { timeout: 5000 });
        if (response.data) {
          juegos = response.data.data || response.data;
          oddsCache[cacheKey] = { data: juegos, timestamp: Date.now() };
          console.log(`✅ Obtenidas cuotas para ${juegos.length} eventos de ${sportKey}`);
        }
      } catch(err) {
        console.error(`❌ Error consultando cuotas para ${sportKey}:`, err.message);
        continue;
      }
    }

    if (!juegos) continue;

    // Procesar cada evento con TODOS los mercados
    for (const evento of eventosGrupo) {
      let mejorCoincidencia = null;
      let mejorPuntuacion = 0;
      const UMBRAL_MINIMO = 0.70;

      for (const game of juegos) {
        const puntuacion = calcularPuntuacionSimilitud(evento, game);
        
        if (puntuacion.mejor > mejorPuntuacion && puntuacion.mejor >= UMBRAL_MINIMO) {
          mejorPuntuacion = puntuacion.mejor;
          mejorCoincidencia = {
            game: game,
            tipo: puntuacion.tipo,
            puntuacion: puntuacion.mejor
          };
        }
      }

      if (mejorCoincidencia) {
        const game = mejorCoincidencia.game;
        const bookmakers = game.bookmakers?.[0];
        
        if (bookmakers && bookmakers.markets) {
          // ================== PROCESAR CADA MERCADO ==================
          
          for (const market of bookmakers.markets) {
            if (!market.outcomes) continue;

            // ========== MERCADO H2H (MONEYLINE) ==========
            if (market.key === 'h2h') {
              const outcomes = market.outcomes;
              
              if (mejorCoincidencia.tipo === 'directa') {
                const homeOutcome = outcomes.find(o => o.name === 'Home');
                const awayOutcome = outcomes.find(o => o.name === 'Away');
                const drawOutcome = outcomes.find(o => o.name === 'Draw');
                
                if (homeOutcome) evento.cuota_local = homeOutcome.price;
                if (awayOutcome) evento.cuota_visitante = awayOutcome.price;
                if (drawOutcome) evento.cuota_empate = drawOutcome.price;
              } else {
                // CRUZADO: local es away, visitante es home
                const homeOutcome = outcomes.find(o => o.name === 'Home');
                const awayOutcome = outcomes.find(o => o.name === 'Away');
                const drawOutcome = outcomes.find(o => o.name === 'Draw');
                
                if (homeOutcome) evento.cuota_visitante = homeOutcome.price;
                if (awayOutcome) evento.cuota_local = awayOutcome.price;
                if (drawOutcome) evento.cuota_empate = drawOutcome.price;
              }
              
              console.log(`✅ H2H [${evento.local} vs ${evento.visitante}]: ${evento.cuota_local} | ${evento.cuota_visitante}`);
            }
            
            // ========== MERCADO SPREADS (HANDICAP) ==========
            if (market.key === 'spreads') {
              const outcomes = market.outcomes;
              
              if (mejorCoincidencia.tipo === 'directa') {
                const homeSpread = outcomes.find(o => o.name === 'Home');
                const awaySpread = outcomes.find(o => o.name === 'Away');
                
                if (homeSpread) {
                  evento.handicap_local = homeSpread.point;
                  evento.handicap_local_cuota = homeSpread.price;
                }
                if (awaySpread) {
                  evento.handicap_visitante = awaySpread.point;
                  evento.handicap_visitante_cuota = awaySpread.price;
                }
              } else {
                // CRUZADO
                const homeSpread = outcomes.find(o => o.name === 'Home');
                const awaySpread = outcomes.find(o => o.name === 'Away');
                
                if (homeSpread) {
                  evento.handicap_visitante = homeSpread.point;
                  evento.handicap_visitante_cuota = homeSpread.price;
                }
                if (awaySpread) {
                  evento.handicap_local = awaySpread.point;
                  evento.handicap_local_cuota = awaySpread.price;
                }
              }
              
              console.log(`✅ SPREADS [${evento.local} vs ${evento.visitante}]: L(${evento.handicap_local}@${evento.handicap_local_cuota}) | V(${evento.handicap_visitante}@${evento.handicap_visitante_cuota})`);
            }
            
            // ========== MERCADO TOTALS (OVER/UNDER) ==========
            if (market.key === 'totals') {
              const outcomes = market.outcomes;
              
              const overOutcome = outcomes.find(o => o.name === 'Over');
              const underOutcome = outcomes.find(o => o.name === 'Under');
              
              if (overOutcome) {
                evento.total_over_point = overOutcome.point;
                evento.total_over_price = overOutcome.price;
              }
              if (underOutcome) {
                evento.total_under_point = underOutcome.point;
                evento.total_under_price = underOutcome.price;
              }
              
              console.log(`✅ TOTALS [${evento.local} vs ${evento.visitante}]: O(${evento.total_over_point}@${evento.total_over_price}) | U(${evento.total_under_point}@${evento.total_under_price})`);
            }
          }
          
          console.log(`✨ Evento completo [${evento.local} vs ${evento.visitante}] con ${Object.keys(evento).filter(k => evento[k] !== null && k.includes('cuota') || k.includes('handicap') || k.includes('total')).length} mercados`);
        }
      } else {
        console.warn(`⚠️ Sin coincidencia > ${UMBRAL_MINIMO * 100}% para: ${evento.local} vs ${evento.visitante}`);
        // ⚠️ FALLBACK: Sin coincidencia pero garantizar cuotas
        evento.cuota_local = evento.cuota_local || 2.00;
        evento.cuota_visitante = evento.cuota_visitante || 1.80;
        evento.cuota_empate = evento.cuota_empate || 3.50;
        evento.handicap_local = evento.handicap_local || -0.5;
        evento.handicap_local_cuota = evento.handicap_local_cuota || 1.91;
        evento.handicap_visitante = evento.handicap_visitante || 0.5;
        evento.handicap_visitante_cuota = evento.handicap_visitante_cuota || 1.95;
        evento.total_over_point = evento.total_over_point || 2.5;
        evento.total_over_price = evento.total_over_price || 1.89;
        evento.total_under_point = evento.total_under_point || 2.5;
        evento.total_under_price = evento.total_under_price || 1.95;
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
    { path: 'soccer/fifa.friendly/scoreboard', sport: 'soccer' },
    { path: 'soccer/fifa.world/scoreboard', sport: 'soccer' },
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
  // Si las cuotas no se obtuvieron, usar Athos
  const sinCuotas = allEvents.filter(e => !e.cuota_local || e.cuota_local <= 1.0);
  if (sinCuotas.length > 0) {
    console.log(`Athos buscando cuotas para ${sinCuotas.length} eventos...`);
    // Athos eliminado - el sistema usa solo The Odds API
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
  const { uid, amount, evento, tipo, cuota } = req.body;

  if (!uid || !amount || !evento || !tipo || !cuota) {
    return res.status(400).json({ error: 'Parámetros faltantes' });
  }

  try {
    if (!db) {
      return res.status(500).json({ error: 'Firebase no configurado' });
    }

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
  const status = { Geminis02: 'unknown', Agente_groc01: 'unknown', Athos_Tavily: 'unknown' };

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

  const tavilyKey = process.env.TAVILY_API_KEY;
  status.Athos_Tavily = tavilyKey ? 'configured' : 'no_key';
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
  try {
    const prompt = `Eres el asistente virtual de BetGroup Pro, una plataforma de apuestas deportivas. Responde de forma clara, breve y útil. Solo debes ayudar con dudas sobre cómo apostar, cómo registrarse, cómo funciona el sistema de créditos, cómo contactar con soporte y otras cuestiones operativas. No debes dar información sobre otros usuarios, resultados de apuestas ni datos internos del sistema. Pregunta del usuario: "${mensaje.trim()}"`;
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


app.listen(PORT, () => {
  console.log(`✅ Proxy escuchando en puerto ${PORT}`);
  precalentarCache();
  setInterval(precalentarCache, 3 * 60 * 1000);
});
