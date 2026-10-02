const express = require('express');
const https = require('https');
// firebase-admin 12+ usa la API modular.
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const axios = require('axios');
const config = require('./lib/config');
const {
  corsRestringido, cabecerasSeguras, idPeticion, ipCliente, limitador,
  responderError, manejadorErrores, rutaNoEncontrada
} = require('./lib/seguridad');
const { crearAuditoria } = require('./lib/auditoria');
const { crearAutenticacion, NIVEL } = require('./lib/autenticacion');
const validar = require('./lib/validacion');
const { crearMotorApuestas, ErrorApuesta } = require('./lib/apuestas');
const { crearRanking, semanaPorId, semanaAnterior } = require('./lib/ranking');
const imagenes = require('./lib/imagenes');
const { fusionarCuotasBot } = require('./lib/mercadosBot');
const { leerMarcador } = require('./lib/mercados');
const { crearProxyDb } = require('./lib/proxyDb');
const { crearOperaciones, ErrorOperacion } = require('./lib/operaciones');
const { Denegado, Invalido, DIRECTOR } = require('./lib/politicas');
const crypto = require('crypto');

const app = express();
const PORT = config.puerto;

// Render pone un proxy delante: así req.ip es la IP real del visitante.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(idPeticion);
app.use(cabecerasSeguras);
app.use(corsRestringido(config.origenesPermitidos));
app.use(express.json({ limit: '32kb', strict: true }));
// Límite general por IP. Es alto a propósito: en Cuba muchos usuarios de datos
// móviles comparten la misma IP pública de ETECSA. Los límites finos van por usuario.
app.use(limitador({ ventanaMs: 60 * 1000, maximo: 900 }));

// ==================== NOTIFICACIÓN DE ERRORES A TELEGRAM ====================
// El token y el chat salen de variables de entorno. Si faltan, no se envía nada.

function notifyTelegram(texto) {
  if (!config.telegram.token || !config.telegram.chatId) return;
  const url = `https://api.telegram.org/bot${config.telegram.token}/sendMessage`;
  https.get(`${url}?chat_id=${encodeURIComponent(config.telegram.chatId)}&text=${encodeURIComponent(texto)}`).on('error', () => {});
}

process.on('uncaughtException', (err) => {
  console.error('❌ Error no capturado:', err);
  notifyTelegram('🚨 BetGroup Proxy: error no capturado. Revisar logs de Render.');
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesa rechazada:', reason);
  notifyTelegram('⚠️ BetGroup Proxy: promesa rechazada. Revisar logs de Render.');
});
// ==================== FIN NOTIFICACIÓN TELEGRAM ====================

// ==================== FIREBASE ====================

let db;

try {
  const serviceAccountJson = Buffer.from(config.firebase.serviceAccountB64, 'base64').toString('utf8');
  const serviceAccount = JSON.parse(serviceAccountJson);

  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: config.firebase.databaseURL
  });

  console.log('✅ Firebase Admin SDK inicializado');
  db = getDatabase();
} catch(error) {
  console.error('Error al inicializar Firebase Admin SDK:', error.message);
  process.exit(1);
}

// Registro de auditoría encadenado y firmado (ver lib/auditoria.js).
const auditoria = crearAuditoria(db, config.auditoriaSecreto);
// Sesiones firmadas por el servidor (ver lib/autenticacion.js).
const auth = crearAutenticacion({ db, config, auditoria });
const { requerirSesion, requerirNivel } = auth;
// Único sitio que coloca y liquida apuestas (ver lib/apuestas.js).
const motor = crearMotorApuestas({
  db, auditoria,
  obtenerEventos: () => { const f = getCache('fixtures'); return f && Array.isArray(f.data) ? f.data : null; },
  avisar: (texto) => notificarTelegram(texto)
});
// El frontend lee y escribe la base de datos solo a través de /api/db (ver lib/politicas.js).
const proxyDb = crearProxyDb({ db, auditoria });
const operaciones = crearOperaciones({
  db, auditoria, auth, config,
  notificarTelegram: (t) => notificarTelegram(t),
  escaparHtml: (t) => escaparHtml(t)
});

// Ranking semanal (ver lib/ranking.js).
const ranking = crearRanking({ db, auditoria, notificarTelegram: (t) => notificarTelegram(t), escaparHtml: (t) => escaparHtml(t) });

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
// ODDS_API_KEYS = "clave1,clave2,clave3" en Render. Se reparten por franja horaria.

function getApiKey() {
  const claves = config.oddsApiKeys;
  if (claves.length === 0) return '';
  const franja = Math.floor(new Date().getHours() / (24 / claves.length));
  return claves[Math.min(franja, claves.length - 1)];
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

function parseEvents(espnData, sport, ruta = null) {
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
        // Deportes de equipo: escudo oficial del equipo.
        if (c?.team?.logo) return c.team.logo;
        // MMA, boxeo, tenis: foto del deportista. ESPN la manda como texto o como {href}.
        const foto = c?.athlete?.headshot;
        if (typeof foto === 'string' && foto) return foto;
        if (foto && typeof foto.href === 'string' && foto.href) return foto.href;
        // Si no viene, ESPN publica la foto con una dirección fija según el ID del luchador.
        const idAtleta = String(c?.athlete?.id || c?.id || '');
        if (String(sport).toLowerCase() === 'mma' && /^[0-9]{1,12}$/.test(idAtleta)) {
          return `https://a.espncdn.com/i/headshots/mma/players/full/${idAtleta}.png`;
        }
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
        ruta, // competición en ESPN: permite liquidar el partido días después
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
    // Letras que no se descomponen solas: Brøndby, Bodø, Śląsk/Wrocław, Kærup, Straße...
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ł/g, 'l').replace(/ß/g, 'ss').replace(/đ/g, 'd')
    .replace(/^ny\b|\bny$/g, 'new york')
    .replace(/^la\b|\bla$/g, 'los angeles')
    .replace(/^st\b|\bst\.?$/g, 'saint')
    .replace(/\b(fc|cf|sc|ac|club|deportivo|the|of)\b/g, '') // 'city', 'united', 'real'... distinguen equipos
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

// Palabras que no distinguen a un equipo ("CA Independiente" = "Independiente",
// "Instituto de Córdoba" ≈ "Instituto"). Las que sí distinguen (city, united, real...) se quedan.
const PALABRAS_VACIAS = new Set(['ca', 'cd', 'cs', 'sd', 'ud', 'sad', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'e']);
// Clubes que ESPN y The Odds API llaman de forma totalmente distinta (ya limpios con limpiarNombre).
const ALIAS_EQUIPOS = Object.freeze({
  'internazionale': 'inter milan',
  'sporting cp': 'sporting lisbon',
  'olympique lyonnais': 'lyon',
  'stade rennais': 'rennes',
  'stade brestois 29': 'brest', 'stade brestois': 'brest',
  'atletico mg': 'atletico mineiro', 'athletico pr': 'athletico paranaense',
  'kobenhavn': 'copenhagen', 'legia warszawa': 'legia warsaw'
});
function nombreCanonico(nombre) {
  const l = limpiarNombre(nombre);
  return ALIAS_EQUIPOS[l] || l;
}
function fichasEquipo(nombre) {
  return new Set(nombreCanonico(nombre).split(' ').filter(t => t.length > 1 && !PALABRAS_VACIAS.has(t)));
}

// Parecido entre dos nombres del mismo equipo (0 a 1).
function parecidoEquipo(a, b) {
  const la = nombreCanonico(a), lb = nombreCanonico(b);
  if (!la || !lb) return 0;
  if (la === lb) return 1;
  const fa = fichasEquipo(a), fb = fichasEquipo(b);
  // Todas las palabras del nombre corto están en el largo: es el mismo club escrito más largo.
  // (Para evitar confusiones como "Independiente" / "Independiente Rivadavia" se exige además
  // que coincida el rival y la hora del partido: ver coincideEquipo.)
  if (fa.size && fb.size) {
    const [corto, largo] = fa.size <= fb.size ? [fa, fb] : [fb, fa];
    if ([...corto].every(t => largo.has(t))) return 0.9;
  }
  return sorensenDice(la, lb) * 0.6 + jaccardTokens(la, lb) * 0.4;
}

// Los dos proveedores deben hablar del mismo partido: inicio con menos de 3 h de diferencia.
const VENTANA_HORARIO_MS = 3 * 60 * 60 * 1000;
function mismoHorario(evento, game) {
  const a = Date.parse(evento.horaInicio || '');
  const b = Date.parse(game.commence_time || '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true; // sin hora no se puede descartar
  return Math.abs(a - b) <= VENTANA_HORARIO_MS;
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

  // 2. Otro horario = otro partido (p. ej. la jornada siguiente con un rival parecido)
  if (!mismoHorario(evento, game)) return { score: 0, esCruzado: false };

  // 3. Verificar códigos ISO para selecciones
  const isoLocalESPN = tieneCodigoISO(localESPN);
  const isoVisitanteESPN = tieneCodigoISO(visitanteESPN);
  const isoHomeAPI = tieneCodigoISO(homeAPI);
  const isoAwayAPI = tieneCodigoISO(awayAPI);

  let scoreDirecto = 0, scoreCruzado = 0;

  if (isoLocalESPN && isoVisitanteESPN && isoHomeAPI && isoAwayAPI) {
    scoreDirecto = (isoLocalESPN === isoHomeAPI && isoVisitanteESPN === isoAwayAPI) ? 1.0 : 0;
    scoreCruzado = (isoLocalESPN === isoAwayAPI && isoVisitanteESPN === isoHomeAPI) ? 1.0 : 0;
  } else {
    // Tienen que parecerse LOS DOS equipos (antes bastaba uno: "Chelsea vs X" recibía
    // las cuotas de "Chelsea vs Y"). Se toma el peor de los dos parecidos.
    scoreDirecto = Math.min(parecidoEquipo(localESPN, homeAPI), parecidoEquipo(visitanteESPN, awayAPI));
    scoreCruzado = Math.min(parecidoEquipo(localESPN, awayAPI), parecidoEquipo(visitanteESPN, homeAPI));
  }

  const score = Math.max(scoreDirecto, scoreCruzado);
  return { score, esCruzado: scoreCruzado > scoreDirecto };
}
// ==================== FIN FUNCIONES DE SIMILITUD ====================

// Competición de ESPN → competición en The Odds API. Antes se adivinaba por el NOMBRE de la
// liga y fallaba: ESPN escribe "Argentine Liga Profesional" ("argentine" ≠ "argentina"),
// "Spanish LALIGA", "Brazilian Serie A" (caía en Italia)... y todo eso acababa pidiendo
// las cuotas de la Premier League inglesa, donde esos partidos no existen → partido bloqueado.
const ODDS_POR_RUTA = Object.freeze({
  'soccer/eng.1': 'soccer_epl',
  'soccer/esp.1': 'soccer_spain_la_liga',
  'soccer/ger.1': 'soccer_germany_bundesliga',
  'soccer/ita.1': 'soccer_italy_serie_a',
  'soccer/fra.1': 'soccer_france_ligue_one',
  'soccer/usa.1': 'soccer_usa_mls',
  'soccer/mex.1': 'soccer_mexico_ligamx',
  'soccer/bra.1': 'soccer_brazil_campeonato',
  'soccer/ned.1': 'soccer_netherlands_eredivisie',
  'soccer/arg.1': 'soccer_argentina_primera_division',
  'soccer/por.1': 'soccer_portugal_primeira_liga',
  'soccer/nor.1': 'soccer_norway_eliteserien',
  'soccer/swe.1': 'soccer_sweden_allsvenskan',
  'soccer/den.1': 'soccer_denmark_superliga',
  'soccer/pol.1': 'soccer_poland_ekstraklasa',
  'soccer/rus.1': 'soccer_russia_premier_league',
  'soccer/chi.1': 'soccer_chile_campeonato',
  'soccer/conmebol.libertadores': 'soccer_conmebol_copa_libertadores',
  'soccer/fifa.world': 'soccer_fifa_world_cup'
});

// Casas de apuestas de EE. UU. para deportes y ligas de allí (y la Premier, que cubren bien);
// casas europeas para el resto del fútbol (cubren Sudamérica y Europa). Mismo coste: 1 región.
const LIGAS_CON_CASAS_US = new Set(['soccer_epl', 'soccer_usa_mls', 'soccer_mexico_ligamx']);
function regionDeCuotas(sportKey) {
  return sportKey.startsWith('soccer_') && !LIGAS_CON_CASAS_US.has(sportKey) ? 'eu' : 'us';
}

// Solo se gastan créditos en ligas con partidos en este plazo.
const HORIZONTE_CUOTAS_MS = 48 * 60 * 60 * 1000;

// Último dato de créditos que quedan en The Odds API (para el diagnóstico del CEO).
const estadoOddsApi = { restantes: null, usados: null, actualizado: null, ultimoError: null };

async function enriquecerConCuotas(eventos) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn('⚠️ Sin The Odds API Key - usando cuotas por defecto');
    return eventos;
  }

  const sportKeyMap = {
    'soccer': function(liga, ruta) {
      if (ruta && ODDS_POR_RUTA[ruta]) return ODDS_POR_RUTA[ruta];
      const l = (liga || '').toLowerCase();
      if (l.includes('world') || l.includes('fifa')) return 'soccer_fifa_world_cup';
      if (l.includes('mls')) return 'soccer_usa_mls';
      if (l.includes('bundesliga') && l.includes('2')) return 'soccer_germany_bundesliga2';
      if (l.includes('bundesliga')) return 'soccer_germany_bundesliga';
      if (l.includes('premier') || l.includes('epl')) return 'soccer_epl';
      if (l.includes('la liga') || l.includes('spain')) return 'soccer_spain_la_liga';
      if (l.includes('serie a') || l.includes('italy')) return 'soccer_italy_serie_a';
      if (l.includes('ligue 1') || l.includes('france')) return 'soccer_france_ligue_one';
      if (l.includes('libertadores')) return 'soccer_conmebol_copa_libertadores';
      if (l.includes('sudamericana')) return 'soccer_conmebol_copa_sudamericana';
      if (l.includes('brazil') || l.includes('brasil')) return 'soccer_brazil_campeonato';
      if (l.includes('liga mx') || l.includes('mexico')) return 'soccer_mexico_ligamx';
      if (l.includes('eredivisie') || l.includes('netherlands')) return 'soccer_netherlands_eredivisie';
      if (l.includes('argentina')) return 'soccer_argentina_primera_division';
      if (l.includes('portugal')) return 'soccer_portugal_primeira_liga';
      if (l.includes('chile')) return 'soccer_chile_campeonato';
      if (l.includes('norway') || l.includes('eliteserien')) return 'soccer_norway_eliteserien';
      if (l.includes('sweden') || l.includes('allsvenskan')) return 'soccer_sweden_allsvenskan';
      if (l.includes('superettan')) return 'soccer_sweden_superettan';
      if (l.includes('denmark') || l.includes('superliga')) return 'soccer_denmark_superliga';
      if (l.includes('poland') || l.includes('ekstraklasa')) return 'soccer_poland_ekstraklasa';
      if (l.includes('russia')) return 'soccer_russia_premier_league';
      if (l.includes('switzerland') || l.includes('swiss')) return 'soccer_switzerland_superleague';
      if (l.includes('china')) return 'soccer_china_superleague';
      if (l.includes('korea') || l.includes('k league')) return 'soccer_korea_kleague1';
      if (l.includes('finland') || l.includes('veikkausliiga')) return 'soccer_finland_veikkausliiga';
      if (l.includes('scotland')) return 'soccer_spl';
      if (l.includes('belgium')) return 'soccer_belgium_first_div';
      if (l.includes('austria')) return 'soccer_austria_bundesliga';
      if (l.includes('greece')) return 'soccer_greece_super_league';
      return null; // liga desconocida: no se gastan créditos pidiendo otra liga que no es
    },
    'basketball': 'basketball_nba',
    'baseball': 'baseball_mlb',
    'mma': 'mma_mixed_martial_arts',
    'tennis': function(liga){ return (liga && liga.toLowerCase().includes('wta')) ? 'tennis_wta_wimbledon' : 'tennis_atp_wimbledon'; }
  };

  // Agrupar eventos por sportKey
  const grupos = {};
  for (const evento of eventos) {
    const sportKey = typeof sportKeyMap[evento.sport] === 'function' 
      ? sportKeyMap[evento.sport](evento.liga, evento.ruta) 
      : sportKeyMap[evento.sport];
    if (!sportKey) continue;
    if (!grupos[sportKey]) grupos[sportKey] = [];
    grupos[sportKey].push(evento);
  }

  // Procesar cada grupo
  for (const [sportKey, eventosGrupo] of Object.entries(grupos)) {
    // Ahorro de créditos 1: solo se piden cuotas de ligas con algún partido en las próximas 48 h.
    const ahora = Date.now();
    const hayProximo = eventosGrupo.some(e => {
      const t = Date.parse(e.horaInicio || '');
      return !Number.isFinite(t) || (t > ahora - 3 * 3600000 && t < ahora + HORIZONTE_CUOTAS_MS);
    });
    if (!hayProximo && !oddsCache[sportKey]) continue;

    // Ahorro de créditos 2: Render gratis se duerme y al despertar olvida la memoria; antes
    // eso volvía a gastar créditos en TODAS las ligas. Ahora se recupera la copia de Firebase.
    if (!oddsCache[sportKey]) {
      try {
        const guardada = (await db.ref(`cacheCuotas/${sportKey}`).once('value')).val();
        if (guardada && Array.isArray(guardada.data) && Number(guardada.timestamp) > 0) {
          oddsCache[sportKey] = { data: guardada.data, timestamp: Number(guardada.timestamp) };
        }
      } catch (e) { console.warn(`No se pudo leer la copia de cuotas de ${sportKey}:`, e.message); }
    }
    const cacheEntry = oddsCache[sportKey];
    let juegos = null;

    // Usar caché si es válido (menos de 12h)
    if (cacheEntry && (Date.now() - cacheEntry.timestamp) < 12 * 60 * 60 * 1000) {
      juegos = cacheEntry.data;
    } else if (!hayProximo) {
      continue;
    } else {
      try {
        console.log(`📡 Consultando The Odds API para: ${sportKey}...`);
        if (sportKey === 'mma_mixed_martial_arts') {
          console.log('🔍 MMA: Buscando cuotas para eventos de artes marciales mixtas');
        }
        // MMA solo tiene h2h, los demás tienen spreads y totals también
        const mkts = sportKey === 'mma_mixed_martial_arts' ? 'h2h' : 'h2h,spreads,totals';
        // Intentar con múltiples claves si la primera falla (ej. 401 para MMA)
        const apiKeys = config.oddsApiKeys;
        let success = false;
        for (const key of apiKeys) {
          try {
            const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds?apiKey=${key}&markets=${mkts}&regions=${regionDeCuotas(sportKey)}`;
            const response = await axios.get(url, { timeout: 5000 });
            const restantes = Number(response.headers?.['x-requests-remaining']);
            if (Number.isFinite(restantes)) {
              Object.assign(estadoOddsApi, { restantes, usados: Number(response.headers['x-requests-used']) || null, actualizado: new Date().toISOString() });
            }
            if (response.data) {
              // Se guarda solo lo que se usa (la primera casa de apuestas) para no llenar Firebase.
              juegos = (response.data.data || response.data || []).map(g => ({
                home_team: g.home_team, away_team: g.away_team, commence_time: g.commence_time,
                casas: (g.bookmakers || []).length, bookmakers: (g.bookmakers || []).slice(0, 1)
              }));
              oddsCache[sportKey] = { data: juegos, timestamp: Date.now() };
              db.ref(`cacheCuotas/${sportKey}`).set({ data: juegos, timestamp: oddsCache[sportKey].timestamp })
                .catch(e => console.warn(`No se pudo guardar la copia de cuotas de ${sportKey}:`, e.message));
              success = true;
              break;
            }
          } catch(innerErr) {
            estadoOddsApi.ultimoError = `${sportKey}: ${innerErr.response?.status || innerErr.code || 'error'} (${new Date().toISOString()})`;
            console.warn(`  Una clave de The Odds API falló (${innerErr.response?.status || innerErr.code || 'error'})`);
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
      // Se busca el partido más parecido (antes se tomaba el primero que pasara el umbral).
      let mejor = null;
      for (const game of juegos) {
        const r = coincideEquipo(evento, game);
        if (r.score >= 0.82 && (!mejor || r.score > mejor.score)) mejor = { ...r, game };
      }
      for (const game of mejor ? [mejor.game] : []) {
        const { score, esCruzado } = mejor;

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
  // Sin cuota real NO se inventa ninguna (antes se pedía a una IA o se generaba "al azar"
  // con un 20% de margen, lo que podía dar cuotas ≤ 1). Esos partidos salen bloqueados.
  return eventos;
}


// ==================== PRECALENTAR CACHÉ ====================

// Competiciones que se ofrecen (y que la liquidación automática revisa).
const DEPORTES = [
  { path: 'basketball/nba/scoreboard', sport: 'basketball' },
  { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
  { path: 'soccer/fifa.world/scoreboard', sport: 'soccer' },
  { path: 'soccer/fifa.friendly/scoreboard', sport: 'soccer' },
  { path: 'soccer/eng.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/esp.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/ger.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/ita.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/fra.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/usa.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/mex.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/bra.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/ned.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/arg.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/por.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/nor.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/swe.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/den.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/pol.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/rus.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/chi.1/scoreboard', sport: 'soccer' },
  { path: 'soccer/conmebol.libertadores/scoreboard', sport: 'soccer' },
  { path: 'tennis/wta/scoreboard', sport: 'tennis' },
  { path: 'mma/ufc/scoreboard', sport: 'mma' }
];

async function precalentarCache() {
  console.log('⏳ Precalentando caché...');


  let allEvents = [];

  for (const deporte of DEPORTES) {
    try {
      const data = await fetchESPN(deporte.path);
      const eventos = parseEvents(data, deporte.sport, deporte.path.replace(/\/scoreboard$/, ''));
      allEvents = allEvents.concat(eventos);
    } catch(err) {
      console.error(`Error ${deporte.path}:`, err.message);
    }
  }

  await enriquecerConCuotas(allEvents);
  // Cuotas del bot (nodo mercados) y boxeo: antes lo mezclaba el navegador.
  try {
    const [mercadosSnap, margenSnap] = await Promise.all([
      db.ref('mercados').once('value'),
      db.ref('config/margen').once('value')
    ]);
    const margen = Number(margenSnap.val());
    allEvents = fusionarCuotasBot(allEvents, mercadosSnap.val(), Number.isFinite(margen) && margen >= 0 && margen < 1 ? margen : 0.20);
  } catch (err) {
    console.error('No se pudieron mezclar las cuotas del bot:', err.message);
  }
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

// Versión del servidor: el script de publicación espera a que Render tenga esta antes de subir la web.
app.get('/api/version', (req, res) => {
  res.json({ version: 'etapa8' });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'online', 
    uptime: process.uptime(), 
    timestamp: new Date().toISOString() 
  });
});

// ==================== AUTENTICACIÓN ====================
// Login: 10 intentos por IP cada 15 minutos (además del bloqueo por cuenta).
const limiteLogin = limitador({
  // Por IP es permisivo (IPs compartidas); el freno real es el bloqueo por cuenta (5 fallos).
  ventanaMs: 15 * 60 * 1000, maximo: 60,
  mensaje: 'Demasiados intentos de acceso. Prueba en 15 minutos.'
});
app.post('/api/auth/login', limiteLogin, auth.login);

// Límites por usuario para lo que gasta cuotas de APIs de pago.
const porUsuario = (req) => (req.usuario ? `u:${req.usuario.uid}` : `ip:${ipCliente(req)}`);
const limiteIA = limitador({ ventanaMs: 60 * 1000, maximo: 10, clave: porUsuario });
const limiteAvisos = limitador({ ventanaMs: 60 * 1000, maximo: 10, clave: (req) => `aviso:${req.usuario ? req.usuario.uid : ipCliente(req)}` });
const limiteApuestas = limitador({ ventanaMs: 60 * 1000, maximo: 20, clave: porUsuario });
const soloCEO = [requerirSesion, requerirNivel(NIVEL.CEO)];
const directorOMas = [requerirSesion, requerirNivel(DIRECTOR)];

// ==================== DINERO Y ADMINISTRACIÓN (ver lib/operaciones.js) ====================
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
function conId(fn) {
  return (req) => {
    if (!ID_RE.test(req.params.id || '')) throw new ErrorOperacion(400, 'Identificador inválido');
    return fn(req, req.params.id);
  };
}
app.post('/api/depositos/:id/aprobar', directorOMas, operacion(conId(operaciones.aprobarDeposito)));
app.post('/api/depositos/:id/rechazar', directorOMas, operacion(conId(operaciones.rechazarDeposito)));
app.post('/api/solicitudes-deposito/:id/aprobar', directorOMas, operacion(conId(operaciones.aprobarSolicitud)));
app.post('/api/solicitudes-deposito/:id/rechazar', directorOMas, operacion(conId(operaciones.rechazarSolicitud)));
app.post('/api/admin/ajustar-saldo', soloCEO, operacion((req) => operaciones.ajustarSaldo(req)));
app.post('/api/admin/asignar-rol', soloCEO, operacion((req) => operaciones.asignarRol(req)));
app.post('/api/admin/restablecer-clave', soloCEO, operacion((req) => operaciones.restablecerClave(req)));
app.post('/api/admin/eliminar-usuario', soloCEO, operacion((req) => operaciones.eliminarUsuario(req)));
// Diagnóstico de cuotas: ¿por qué un partido sale sin cuota? (busca por nombre de equipo)
app.get('/api/admin/diagnostico-cuotas', soloCEO, operacion(async (req) => {
  const q = limpiarNombre(validar.texto(req.query?.q, 60) || '');
  if (q.length < 3) throw new ErrorOperacion(400, 'Escribe al menos 3 letras de un equipo (o "sincuota")');
  const todos = getCache('fixtures')?.data || [];
  // "sincuota": todos los partidos próximos que se quedaron sin cuota, para revisarlos de una vez.
  const eventos = q === 'sincuota'
    ? todos.filter(e => e.estado === 'scheduled' && !(Number(e.cuota_local) > 1)).slice(0, 40)
    : todos.filter(e => limpiarNombre(`${e.local} ${e.visitante}`).includes(q)).slice(0, 5);
  return {
    creditosOddsApi: estadoOddsApi,
    partidos: eventos.map(e => {
      const sportKey = e.sport === 'soccer' ? (ODDS_POR_RUTA[e.ruta] || null) : null;
      const juegos = (sportKey && oddsCache[sportKey]?.data) || [];
      const candidatos = juegos
        .map(g => ({ partidoOddsApi: `${g.home_team} vs ${g.away_team}`, inicio: g.commence_time, casas: g.casas ?? (g.bookmakers || []).length, parecido: Number(coincideEquipo(e, g).score.toFixed(2)) }))
        .sort((a, b) => b.parecido - a.parecido).slice(0, q === 'sincuota' ? 1 : 3);
      return {
        partido: `${e.local} vs ${e.visitante}`, liga: e.liga, ruta: e.ruta, inicio: e.horaInicio,
        competicionOddsApi: sportKey, region: sportKey ? regionDeCuotas(sportKey) : null,
        cuotas: { local: e.cuota_local, empate: e.cuota_empate, visitante: e.cuota_visitante },
        partidosEnOddsApi: juegos.length,
        cacheCuotas: sportKey && oddsCache[sportKey] ? new Date(oddsCache[sportKey].timestamp).toISOString() : null,
        mejoresCandidatos: candidatos
      };
    })
  };
}));
// ---------- Ranking semanal y apodo ----------
const limiteApodo = limitador({ ventanaMs: 60 * 60 * 1000, maximo: 20, clave: porUsuario });
app.post('/api/perfil/apodo', requerirSesion, limiteApodo, operacion((req) => operaciones.fijarApodo(req)));
// Cualquiera con sesión ve el top 10 (solo apodos, nunca nombres) y su propia situación.
app.get('/api/ranking', requerirSesion, operacion(async (req) => ranking.publico(req.usuario.uid)));
// El CEO ve la semana completa (por defecto la que acaba de terminar) y entrega los premios.
function semanaPedida(valor) {
  if (!valor) return semanaAnterior();
  const sem = semanaPorId(valor);
  if (!sem) throw new ErrorOperacion(400, 'Semana inválida (usa la fecha del lunes, AAAA-MM-DD)');
  return sem;
}
app.get('/api/admin/ranking', soloCEO, operacion(async (req) => {
  const sem = semanaPedida(req.query?.semana);
  const [tabla, estado] = await Promise.all([ranking.calcular(sem), db.ref(`rankingPremios/${sem.id}`).once('value')]);
  return { ...tabla, terminada: sem.hasta <= Date.now(), entrega: estado.val() || null };
}));
app.post('/api/admin/ranking/entregar', soloCEO, operacion(async (req) => {
  const sem = semanaPedida(req.body?.semana);
  try {
    return await ranking.entregar(sem, req.usuario.uid, req.id);
  } catch (err) {
    if (err.estado) throw new ErrorOperacion(err.estado, err.message);
    throw err;
  }
}));

// ---------- Fotos de comprobantes: se limpian de metadatos (GPS, móvil...) antes de subirlas ----------
const limiteFotos = limitador({ ventanaMs: 60 * 1000, maximo: 10, clave: porUsuario });
app.post('/api/imagen', requerirSesion, limiteFotos, express.raw({ type: 'image/jpeg', limit: imagenes.TAMANO_MAXIMO }), operacion(async (req) => {
  if (!config.imgbbKey) throw new ErrorOperacion(503, 'subida-no-configurada');
  let limpia;
  try { limpia = imagenes.limpiarJpeg(req.body); } catch (e) {
    if (e instanceof imagenes.ImagenInvalida) throw new ErrorOperacion(400, e.message);
    throw e;
  }
  const url = await imagenes.subirAImgbb(limpia, config.imgbbKey);
  await auditoria.registrarSeguro({ accion: 'foto_subida', actor: req.usuario.uid, requestId: req.id, detalles: { bytes: limpia.length } });
  return { url };
}));

// Liquidación automática bajo demanda (el CEO no tiene que esperar los 30 min).
app.post('/api/admin/liquidar-ahora', soloCEO, operacion(async () => ({ liquidadas: await liquidarApuestasAutomatico() })));
// Avisos a Telegram desde el navegador: el token ya no viaja al frontend.
app.post('/api/notificar', requerirSesion, limiteAvisos, operacion((req) => operaciones.notificar(req)));

app.post('/api/auth/logout', requerirSesion, auth.logout);
app.get('/api/auth/yo', requerirSesion, auth.yo);

// Envuelve una operación: traduce sus errores a respuestas claras sin filtrar detalles.
function operacion(fn) {
  return async (req, res) => {
    try {
      res.json({ success: true, ...(await fn(req)) });
    } catch (err) {
      if (err instanceof ErrorOperacion || err instanceof Denegado || err instanceof Invalido) {
        return res.status(err.estado).json({ error: err.message });
      }
      responderError(res, req, err, req.path);
    }
  };
}
// Registro: solo cuentan los intentos fallidos (20 por hora e IP). En Cuba muchísima gente
// sale a Internet por la misma IP de ETECSA; un registro correcto no gasta el cupo de nadie.
const limiteRegistro = limitador({
  ventanaMs: 60 * 60 * 1000, maximo: 20, soloFallos: true,
  mensaje: 'Demasiados intentos fallidos desde tu conexión. Espera una hora o pide ayuda a quien te invitó.'
});
// Tope global de fallos (todas las IPs juntas): aunque alguien falsificara su IP para
// saltarse el límite anterior, no podría probar más de 300 códigos por hora.
const limiteRegistroGlobal = limitador({
  ventanaMs: 60 * 60 * 1000, maximo: 300, soloFallos: true, clave: () => 'registro-global',
  mensaje: 'El registro está saturado ahora mismo. Prueba dentro de un rato.'
});
const limiteRecuperar = limitador({ ventanaMs: 60 * 60 * 1000, maximo: 10, mensaje: 'Demasiadas solicitudes. Prueba en una hora.' });
app.post('/api/auth/registro', limiteRegistroGlobal, limiteRegistro, operacion((req) => operaciones.registrar(req)));
app.post('/api/auth/recuperar', limiteRecuperar, operacion((req) => operaciones.solicitarRecuperacion(req)));

// ==================== BASE DE DATOS A TRAVÉS DEL SERVIDOR ====================
const limiteDb = limitador({ ventanaMs: 60 * 1000, maximo: 300, clave: (req) => `db:${req.usuario ? req.usuario.uid : ipCliente(req)}` });
app.post('/api/db', requerirSesion, limiteDb, proxyDb.manejar);

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
    if (!res.headersSent) responderError(res, req, err, '/api/fixtures');
    else console.error(`[${req.id}] /api/fixtures:`, err);
  }
});

app.post('/api/apostar', requerirSesion, limiteApuestas, async (req, res) => {
  // El usuario sale de la sesión; la cuota, del servidor.
  const monto = validar.monto(req.body?.amount);
  const evento = validar.texto(req.body?.evento, 200);
  const eventoId = validar.texto(req.body?.eventoId == null ? '' : String(req.body.eventoId), 64);
  const tipo = validar.tipoApuesta(req.body?.tipo);
  const tipoSaldo = req.body?.tipoSaldo === 'promo' ? 'promo' : 'real';
  const cuotaCliente = req.body?.cuota;
  if (monto === null || (!evento && !eventoId) || !tipo
    || (cuotaCliente !== undefined && !Number.isFinite(Number(cuotaCliente)))) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }
  try {
    const r = await motor.colocarApuesta({
      uid: req.usuario.uid, usuario: req.usuario.datos, eventoId, evento, tipo, monto,
      cuotaCliente: cuotaCliente === undefined ? undefined : Number(cuotaCliente), tipoSaldo, requestId: req.id
    });
    res.json({ success: true, ...r });
  } catch(err) {
    if (err instanceof ErrorApuesta) return res.status(err.estado).json({ error: err.message, ...err.extra });
    responderError(res, req, err, '/api/apostar');
  }
});

// ==================== INICIAR ====================


// ==================== ENDPOINT SALDO REAL ====================

app.get('/api/saldo/:uid', requerirSesion, async (req, res) => {
  const { uid } = req.params;

  if (!validar.esUid(uid)) {
    return res.status(400).json({ error: 'UID inválido' });
  }
  // Cada uno ve su propio saldo; solo administración puede ver el de otros.
  if (uid !== req.usuario.uid && req.usuario.nivel < NIVEL.ADMIN) {
    return res.status(403).json({ error: 'No tienes permiso para esta acción' });
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
    responderError(res, req, err, '/api/saldo');
  }
});







// ==================== ENDPOINT HF CUOTAS (sin bartender) ====================
app.post('/api/huggingface/cuotas', soloCEO, limiteIA, async (req, res) => {
  const { prompt, modelo } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Falta prompt' });
  const model = modelo || HF_MODELS.analisis;
  try {
    // Antes llamaba a resp.json() sobre un objeto normal y fallaba siempre.
    const reply = await callCF([{ role: 'user', content: String(prompt).slice(0, 2000) }], 'analisis');
    res.json({ reply, model });
  } catch(err) {
    console.error('Error /api/huggingface/cuotas:', err.message);
    res.status(500).json({ error: 'Error al contactar Hugging Face' });
  }
});
// ==================== FIN ENDPOINT HF CUOTAS ====================

// ==================== ENDPOINT DE ESTADO DE AGENTES ====================






app.get('/api/agents-status', soloCEO, async (req, res) => {
  const geminiKey = config.geminiKey;
  const groqKey   = config.groqKey;
  const status = { Geminis02: 'unknown', Agente_groc01: 'unknown', Athos_Tavily: 'unknown' };

  if (geminiKey) {
    try {
      const resp = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
        { contents: [{ parts: [{ text: 'OK' }] }] },
        { headers: { 'X-goog-api-key': geminiKey, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      status.Geminis02 = resp.data?.candidates ? 'online' : 'error';
    } catch(e) { status.Geminis02 = 'error'; console.error('agents-status Gemini:', e.message); }
  } else { status.Geminis02 = 'no_key'; }

  if (groqKey) {
    try {
      const resp = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        { model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'OK' }] },
        { headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      status.Agente_groc01 = resp.data?.choices ? 'online' : 'error';
    } catch(e) { status.Agente_groc01 = 'error'; console.error('agents-status Groq:', e.message); }
  } else { status.Agente_groc01 = 'no_key'; }

  const tavilyKey = config.tavilyKey;
  status.Athos_Tavily = tavilyKey ? 'configured' : 'no_key';
  res.json({ success: true, agents: status, timestamp: new Date().toISOString() });
});


// ==================== CHATBOT AGENTE_GROC01 ====================

app.post('/api/chat', requerirSesion, limiteIA, async (req, res) => {
  const mensaje = validar.texto(req.body?.mensaje, 500);
  if (!mensaje) {
    return res.status(400).json({ error: 'Mensaje vacío o inválido' });
  }
  const groqKey = config.groqKey;
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

// Revisa este mismo servidor desde dentro (antes llamaba a una URL de Render equivocada).
async function obtenerEstadoSistema() {
  const estado = { proxy: 'ok', agentes: {}, eventos: 0, chatbot: false, saldo_firebase: null };
  estado.agentes = {
    Geminis02: config.geminiKey ? 'configurado' : 'sin_clave',
    Agente_groc01: config.groqKey ? 'configurado' : 'sin_clave',
    Athos_Tavily: config.tavilyKey ? 'configurado' : 'sin_clave'
  };
  const fixtures = getCache('fixtures');
  estado.eventos = fixtures && fixtures.total ? fixtures.total : 0;
  estado.chatbot = Boolean(config.groqKey);

  // Saldo del usuario de prueba (TEST_USER_UID), leído directamente de Firebase.
  if (config.uidPrueba) {
    try {
      const snap = await db.ref(`users/${config.uidPrueba}/creditoReal`).once('value');
      estado.saldo_firebase = snap.val();
    } catch(e) { estado.saldo_firebase = 'error'; }
  }
  return estado;
}

// Los mensajes van con parse_mode HTML: el texto de usuarios se escapa antes.
function escaparHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function notificarTelegram(texto) {
  if (!config.telegram.token || !config.telegram.chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
      chat_id: config.telegram.chatId,
      text: texto,
      parse_mode: 'HTML'
    }, { timeout: 5000 });
  } catch(e) { console.error('Error notificando a Telegram:', e.message); }
}

app.get('/api/verificacion-geminis', soloCEO, async (req, res) => {
  try {
    const estado = await obtenerEstadoSistema();

    // Formato exacto del curl funcional
    const geminiKey = config.geminiKey;
    let informe = 'Sistema operativo. Eventos: ' + estado.eventos + ' | Saldo de prueba: ' + estado.saldo_firebase;
    
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

    await notificarTelegram('📊 <b>INFORME DE GEMINIS02</b>\n\n' + informe);

    res.json({ success: true, estado, informe });
  } catch(e) { responderError(res, req, e, '/api/verificacion-geminis'); }
});



// ==================== LIQUIDACIÓN DE APUESTAS (TRANSACCIONAL) ====================
// Aviso al grupo: solo nombre de pila, nunca email, teléfono ni saldo.
async function avisarApuestaGanada(uid, ap) {
  const NL = String.fromCharCode(10);
  const nombreSnap = await db.ref('users/' + uid + '/nombre').once('value');
  const nombre = escaparHtml(String(nombreSnap.val() || 'Usuario').split(' ')[0]);
  let msg = '🏆 APUESTA GANADA 🏆' + NL;
  msg += '━━━━━━━━━━━━━━━━━━━━━━' + NL;
  msg += '👤 Usuario: ' + nombre + NL;
  msg += '⚽ Evento: ' + escaparHtml(ap.eventoNombre) + NL;
  msg += '🎯 Seleccion: ' + escaparHtml(ap.tipo) + NL;
  msg += '📊 Cuota: x' + Number(ap.cuota).toFixed(2) + NL;
  msg += '💵 Monto apostado: $' + Number(ap.monto).toFixed(2) + NL;
  msg += '💰 Ganancia: $' + Number(ap.pago).toFixed(2) + NL;
  msg += '━━━━━━━━━━━━━━━━━━━━━━' + NL;
  msg += '🎉 Felicitaciones ' + nombre + '! Sigue en BetGroup Pro!';
  await notificarTelegram(msg);
}

// Liquida todas las apuestas pendientes de un evento (por id o por nombre).
async function liquidarEvento({ eventoId, nombre, resolucion, origen, requestId }) {
  const todas = (await db.ref('apuestas').once('value')).val() || {};
  const nombreNorm = String(nombre || '').toLowerCase().trim();
  const resumen = { liquidadas: 0, ganadas: 0, perdidas: 0, anuladas: 0, sinDecidir: 0 };
  for (const uid of Object.keys(todas)) {
    for (const betId of Object.keys(todas[uid] || {})) {
      const ap = todas[uid][betId];
      if (!ap || ap.estado !== 'pendiente') continue;
      const coincide = (eventoId && ap.eventoId && String(ap.eventoId) === String(eventoId))
        || (nombreNorm && String(ap.eventoNombre || '').toLowerCase().trim() === nombreNorm);
      if (!coincide) continue;
      const r = await motor.liquidarApuesta({ uid, betId, resolucion, origen, requestId });
      // null: otra liquidación llegó antes (no se paga dos veces) o faltan datos (p. ej. hándicap sin marcador)
      if (!r) { resumen.sinDecidir++; continue; }
      resumen.liquidadas++;
      if (r.estado === 'ganada') { resumen.ganadas++; await avisarApuestaGanada(uid, r); }
      else if (r.estado === 'perdida') resumen.perdidas++;
      else resumen.anuladas++;
    }
  }
  return resumen;
}

app.post('/api/apuestas/liquidar', soloCEO, async (req, res) => {
  // partidoId: id del evento o nombre "Local vs Visitante".
  // Se indica el marcador final ("2-1", resuelve todos los mercados), o solo el ganador
  // (Local/Visitante/Empate, resuelve 1X2), o ANULADA (devuelve lo apostado).
  const partidoId = validar.texto(req.body?.partidoId, 200);
  const r = req.body?.resultadoGanador;
  const marcador = leerMarcador(req.body?.marcador);
  let resolucion = null;
  if (r === 'ANULADA') resolucion = { anular: true };
  else if (marcador) resolucion = { marcador };
  else if (['Local', 'Visitante', 'Empate'].includes(r)) resolucion = { ganador: r };
  if (!partidoId || !resolucion) {
    return res.status(400).json({ error: 'Indica partidoId y el marcador final ("2-1"), el ganador (Local, Visitante, Empate) o ANULADA' });
  }
  await auditoria.registrarSeguro({
    accion: 'liquidacion_manual', actor: req.usuario.uid, objetivo: partidoId,
    requestId: req.id, detalles: { resultadoGanador: r || null, marcador: req.body?.marcador || null }
  });
  try {
    const resumen = await liquidarEvento({
      eventoId: partidoId, nombre: partidoId, resolucion,
      origen: `manual:${req.usuario.uid}`, requestId: req.id
    });
    res.json({ success: true, ...resumen, message: `${resumen.liquidadas} apuestas liquidadas.` });
  } catch (error) {
    responderError(res, req, error, '/api/apuestas/liquidar');
  }
});
// ==================== FIN LIQUIDACIÓN ====================



// ==================== REINICIO DEL SISTEMA (MULTI-NODO) ====================
app.post('/api/admin/reiniciar', soloCEO, async (req, res) => {
  // Borra TODO. Apagado salvo ALLOW_SYSTEM_RESET=true y confirmación escrita.
  if (!config.permitirReinicio) {
    return res.status(403).json({ error: 'El reinicio del sistema está desactivado' });
  }
  if (req.body?.confirmacion !== 'BORRAR TODO EL SISTEMA') {
    return res.status(400).json({ error: 'Falta la confirmación escrita' });
  }
  try {
    await auditoria.registrar({ accion: 'reinicio_sistema', actor: req.usuario.uid, requestId: req.id });
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
    responderError(res, req, error, '/api/admin/reiniciar');
  }
});
// ==================== FIN REINICIO ====================

// ==================== VERIFICAR CADENA DE AUDITORÍA ====================
app.get('/api/admin/auditoria/verificar', soloCEO, async (req, res) => {
  try {
    res.json(await auditoria.verificarCadena());
  } catch (err) {
    responderError(res, req, err, '/api/admin/auditoria/verificar');
  }
});



// ==================== REFERIDOS FILTRADOS POR SUBADMIN ====================
app.get('/api/usuarios/mis-referidos', requerirSesion, requerirNivel(NIVEL.SUBADMIN), async (req, res) => {
  // Un subadmin solo ve a los suyos; el CEO puede consultar los de cualquiera.
  const pedido = req.query.subadminUid;
  const subadminUid = req.usuario.nivel >= NIVEL.CEO && validar.esUid(pedido) ? pedido : req.usuario.uid;
  try {
    const snapshot = await db.ref('users')
      .orderByChild('creadoPor')
      .equalTo(subadminUid)
      .once('value');
    // Solo los campos que el panel necesita: nunca hash, sal ni datos bancarios.
    const referidos = Object.entries(snapshot.val() || {}).map(([uid, u]) => ({
      uid,
      nombre: u.nombre || null,
      telefono: u.telefono || null,
      creditoReal: Number(u.creditoReal) || 0,
      creditoPromo: Number(u.creditoPromo) || 0,
      activo: u.activo !== false,
      fecha_registro: u.fecha_registro || null
    }));
    res.json(referidos);
  } catch (error) {
    responderError(res, req, error, '/api/usuarios/mis-referidos');
  }
});
// ==================== FIN REFERIDOS ====================



// ==================== GENERAR CÓDIGO POR INICIAL DEL ROL ====================
const NIVEL_DE_CODIGO = Object.freeze({ ceo: 3, admin: 2.5, moderador: 2.5, soporte: 2 });
const CODIGO_RE = /^[CAMS][0-9]{10}[0-9A-F]{12}$/;
const CODIGO_VIGENCIA_MS = 24 * 60 * 60 * 1000;

app.post('/api/admin/generar-codigo', soloCEO, async (req, res) => {
  const rol = req.body?.rol || 'ceo';
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
  // 48 bits aleatorios criptográficos: imposible de adivinar.
  const random = crypto.randomBytes(6).toString('hex').toUpperCase();
  const codigo = `${rolInicial}${fecha}${random}`;

  try {
    // El código se guarda: solo funcionan los que se generaron aquí, una sola vez y durante 24 h.
    await db.ref(`codigosRol/${codigo}`).set({
      rol, creadoPor: req.usuario.uid, creado: Date.now(), expira: Date.now() + CODIGO_VIGENCIA_MS, usado: false
    });
    await auditoria.registrarSeguro({ accion: 'codigo_rol_generado', actor: req.usuario.uid, requestId: req.id, detalles: { rol } });
    res.json({ success: true, codigo, rol, expiraEnHoras: 24 });
  } catch (err) {
    responderError(res, req, err, '/api/admin/generar-codigo');
  }
});
// ==================== FIN GENERAR CÓDIGO ====================



// ==================== APLICAR CÓDIGO CEO ====================
app.post('/api/admin/aplicar-codigo', requerirSesion, limiteIA, async (req, res) => {
  // El código se aplica a quien tiene la sesión abierta, nunca a un uid del cuerpo.
  const uid = req.usuario.uid;
  const codigo = typeof req.body?.codigo === 'string' ? req.body.codigo.trim().toUpperCase() : '';
  if (!CODIGO_RE.test(codigo)) return res.status(400).json({ error: 'Código no válido' });

  try {
    let rol = null;
    const resultado = await db.ref(`codigosRol/${codigo}`).transaction((c) => {
      rol = null;
      // Firebase llama primero con null si aún no tiene el dato: devolver null fuerza la lectura real.
      if (c === null) return null;
      if (c.usado || !(c.expira > Date.now()) || !NIVEL_DE_CODIGO[c.rol]) return undefined;
      rol = c.rol;
      return { ...c, usado: true, usadoPor: uid, usadoEn: Date.now() };
    });
    if (!resultado.committed || !rol) {
      await auditoria.registrarSeguro({ accion: 'codigo_rol_rechazado', actor: uid, requestId: req.id });
      return res.status(400).json({ error: 'Código no válido, usado o caducado' });
    }

    await db.ref(`users/${uid}`).update({ rol, rolLevel: NIVEL_DE_CODIGO[rol] });
    await auditoria.registrarSeguro({ accion: 'rol_asignado', actor: uid, objetivo: uid, requestId: req.id, detalles: { rol } });
    res.json({ success: true, rol, mensaje: `Rol "${rol}" asignado` });
  } catch (err) {
    responderError(res, req, err, '/api/admin/aplicar-codigo');
  }
});
// ==================== FIN APLICAR CÓDIGO ====================


setCache('fixtures', null);
console.log('Caché de fixtures limpiado al inicio.');

// ════ AGENTE UNIFICADO HUGGING FACE ════
const HF_TOKEN = process.env.HF_TOKEN || '';

// Helper Cloudflare AI
async function callCF(messages, modelo) {
  const acc = config.cloudflare.accountId;
  const tok = config.cloudflare.token;
  const modelos = {
    rapido: '@cf/qwen/qwen2.5-7b-instruct',
    potente: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    analisis: '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
  };
  const url = 'https://api.cloudflare.com/client/v4/accounts/' + acc + '/ai/run/' + (modelos[modelo] || modelos.rapido);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: messages, max_tokens: 2000 })
  });
  const d = await r.json();
  if (d.result && d.result.response) return d.result.response;
  throw new Error(JSON.stringify(d));
}

const HF_MODELS = {
  analisis: 'moonshotai/Kimi-K2-Instruct-0905',
  chat: 'meta-llama/Llama-3.3-70B-Instruct',
  rapido: 'Qwen/Qwen2.5-7B-Instruct'
};

app.post('/api/huggingface', requerirSesion, limiteIA, async (req, res) => {
  const prompt = validar.texto(req.body?.prompt, 1000);
  const tarea = req.body?.tarea;
  // El rol que ve la IA sale de la base de datos, no de lo que diga el cliente.
  const rol = req.usuario.datos.rol || 'member';
  if (!prompt) return res.status(400).json({ error: 'Falta prompt' });
  const model = HF_MODELS[tarea] || HF_MODELS['rapido'];

  let eventosReales = '';
  try {
    const cached = getCache('fixtures');
    if (cached && cached.data && cached.data.length > 0) {
      const todos = cached.data;
      const ahora = Date.now();
      const hoy = todos.filter(e => {
        const t = new Date(e.horaInicio).getTime();
        return t > ahora && t - ahora < 86400000;
      });

      let analisis = '\n📊 ANÁLISIS DEL BARTENDER:\n';
      if (hoy.length > 0) {
        const porDeporte = {};
        for (const ev of hoy) {
          const sp = ev.sport || 'otro';
          if (!porDeporte[sp]) porDeporte[sp] = [];
          porDeporte[sp].push(ev);
        }
        analisis += '🔥 EVENTOS DE HOY:\n';
        let todasLasCuotas = [];
        for (const [sport, evs] of Object.entries(porDeporte)) {
          analisis += `\n${sport.toUpperCase()}: ${evs.length} partidos\n`;
          for (const ev of evs) {
            const hora = ev.horaInicio ? new Date(ev.horaInicio).toLocaleTimeString('es-CU', {hour:'2-digit', minute:'2-digit'}) : '?';
            analisis += `  ⚡ ${ev.local} vs ${ev.visitante} (${hora})\n`;
            if (ev.cuota_local) analisis += `     Local: ${ev.cuota_local} | Visita: ${ev.cuota_visitante} | Empate: ${ev.cuota_empate || 'N/D'}\n`;
            if (ev.cuota_local && ev.cuota_visitante) {
              todasLasCuotas.push({local: ev.local, visita: ev.visitante, cuota_local: ev.cuota_local, cuota_visitante: ev.cuota_visitante, cuota_empate: ev.cuota_empate});
            }
          }
        }
        if (todasLasCuotas.length > 0) {
          const underdog = todasLasCuotas.reduce((a,b) => a.cuota_visitante > b.cuota_visitante ? a : b);
          analisis += `\n💎 JOYA DEL DÍA: ${underdog.visita} paga ${underdog.cuota_visitante} contra ${underdog.local}. ¡Batacazo potencial!\n`;
          const seguras = todasLasCuotas.filter(e => e.cuota_local < 1.5).slice(0, 2);
          if (seguras.length >= 2) {
            const comb = (seguras[0].cuota_local * seguras[1].cuota_local).toFixed(2);
            analisis += `🎯 COMBINADO SEGURO: ${seguras[0].local} (${seguras[0].cuota_local}) + ${seguras[1].local} (${seguras[1].cuota_local}) = Cuota total ${comb}\n`;
          }
        }
      } else {
        analisis += '⚠️ NO HAY EVENTOS HOY. Pero puedo recomendarte los próximos.\n';
      }
      eventosReales = analisis + `\nReglas: Responde siempre en español cubano con emojis. Sé carismático. Recomienda basado en estos datos. Si no hay eventos HOY, dilo y ofrece los próximos. NO inventes información.`;
    }
  } catch(e) {}

  const systemPrompt = `Eres el bartender virtual de BetGroup Pro, una plataforma de apuestas deportivas cubana. 
Personalidad: carismático, divertido, cercano, como el mejor bartender que atiende una barra. 
Usa emojis abundantes. Habla en español cubano coloquial (si el usuario te habla en otro idioma, responde en ese idioma). 
Tu misión: recomendar las mejores apuestas usando SOLO los eventos reales del sistema que se te proporcionan. 
${eventosReales}
Reglas:
- SOLO recomiendes apuestas de los eventos que aparecen en la lista de arriba. NUNCA inventes eventos ni deportes.
- NUNCA menciones baloncesto, NFL, hockey ni cualquier deporte que no esté en la lista de deportes activos.
- Si te preguntan por un deporte que no está en la lista, responde que no hay eventos disponibles de ese deporte.
- NUNCA reveles datos privados de otros usuarios (saldo, UID, apuestas).
- NUNCA muestres información técnica del sistema (código, endpoints, servidores).
- Si el usuario es "admin" o "subadmin", habla de gestión general sin dar acceso al sistema.
- Si el usuario es "member" o "director", limítate a recomendar apuestas y resolver dudas de la plataforma.
- Responde con pasión por el deporte, como un fanático más.
El usuario actual tiene rol: ${rol || 'miembro'}.`;

  try {
    const _cfReply2 = await callCF([{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], 'potente');
    const data = { choices: [{ message: { content: _cfReply2 } }] };
    res.json({ reply: data?.choices?.[0]?.message?.content || JSON.stringify(data), model });
  } catch(err) {
    res.status(500).json({ error: 'Error al contactar Hugging Face' });
  }
});


// ════ POST /api/enriquecer ════
app.post('/api/enriquecer', requerirSesion, limiteIA, async (req, res) => {
  try {
    const recibidos = req.body?.eventos;
    if (!Array.isArray(recibidos) || recibidos.length === 0 || recibidos.length > 150) {
      return res.status(400).json({ error: 'Se requiere un array de 1 a 150 eventos' });
    }
    const eventos = recibidos.map(validar.eventoCliente).filter(Boolean);
    if (eventos.length === 0) return res.status(400).json({ error: 'Ningún evento válido' });
    const enriquecidos = await enriquecerConCuotas(eventos);
    res.json({ status: 'success', total: enriquecidos.length, data: enriquecidos });
  } catch(err) {
    responderError(res, req, err, '/api/enriquecer');
  }
});


// REPORTES Y AUTOMATIZACION
async function enviarReporteTelegram() {
  try {
    const NL = String.fromCharCode(10);
    // Intentar obtener eventos frescos directamente de ESPN + enriquecer con cuotas
    let eventos = [];
    // Intentar primero con el cache
    const fixtures = getCache('fixtures');
    if (fixtures && fixtures.data && fixtures.data.length > 0) {
      eventos = fixtures.data.filter(function(e){ return e.cuota_local && e.cuota_local > 0; }).slice(0,5);
    }
    // Si cache vacio, obtener directamente de ESPN + Odds API
    if (eventos.length === 0) {
      try {
        const espnMlb = await fetchESPN('baseball/mlb/scoreboard');
        const rawMlb = parseEvents(espnMlb, 'baseball');
        if (rawMlb.length > 0) {
          const enriq = await enriquecerConCuotas(rawMlb);
          eventos = enriq.filter(function(e){ return e.cuota_local && e.cuota_local > 0; }).slice(0,5);
        }
      } catch(e) { console.error('Error ESPN directo reporte:', e.message); }
    }
    // Ultimo recurso: ESPN todos los deportes
    if (eventos.length === 0) {
      const rutasReporte = [
        { path: 'baseball/mlb/scoreboard', sport: 'baseball' },
        { path: 'soccer/fifa.world/scoreboard', sport: 'soccer' },
        { path: 'soccer/eng.1/scoreboard', sport: 'soccer' },
        { path: 'soccer/bra.1/scoreboard', sport: 'soccer' },
        { path: 'soccer/arg.1/scoreboard', sport: 'soccer' },
        { path: 'soccer/mex.1/scoreboard', sport: 'soccer' },
        { path: 'soccer/usa.1/scoreboard', sport: 'soccer' },
        { path: 'mma/ufc/scoreboard', sport: 'mma' },
        { path: 'basketball/nba/scoreboard', sport: 'basketball' }
      ];
      let allRaw = [];
      for (const ruta of rutasReporte) {
        try {
          const espnData = await fetchESPN(ruta.path);
          const parsed = parseEvents(espnData, ruta.sport);
          allRaw = allRaw.concat(parsed);
        } catch(e) {}
      }
      if (allRaw.length > 0) {
        const enriquecidos = await enriquecerConCuotas(allRaw);
        eventos = enriquecidos.filter(function(e){ return e.cuota_local && e.cuota_local > 0; }).slice(0,5);
      }
    }
    if (eventos.length === 0) { await notificarTelegram('BetGroup Pro: Sin eventos para el reporte.'); return; }
    let resumen = '';
    for (const ev of eventos) {
      resumen += ev.local + ' vs ' + ev.visitante + ': Local@' + ev.cuota_local + ' Visitante@' + ev.cuota_visitante + NL;
    }
    const prompt = 'Analista deportivo cubano. Eventos de hoy:' + NL + resumen + NL + 'Genera mensaje Telegram: mejor cuota, combinacion recomendada, curiosidad. Emojis, cubano. Max 150 palabras.';
    const CF_ACCOUNT_ID2 = config.cloudflare.accountId;
    const CF_TOKEN2 = config.cloudflare.token;
    const hfResp = await fetch('https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT_ID2 + '/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + CF_TOKEN2, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: 400 })
    });
    const hfData = await hfResp.json();
    const mensaje = (hfData && hfData.result && hfData.result.response) ? hfData.result.response : 'Sin reporte.';
    await notificarTelegram(mensaje);
    console.log('Reporte Telegram OK.');
  } catch(e) { console.error('Error reporte:', e.message); }
}

// ==================== LIQUIDACIÓN AUTOMÁTICA ====================
// Cada 30 min: busca en ESPN el resultado de los partidos con apuestas pendientes
// (en su competición y en la fecha en que se jugaron) y las resuelve.
const ESTADOS_ANULAN = /CANCEL|ABANDON|FORFEIT/;          // se devuelve el dinero
const ESTADOS_APLAZADOS = /POSTPON|SUSPEND|DELAY/;          // se devuelve si pasan 48 h
const ESPERA_APLAZADO_MS = 48 * 60 * 60 * 1000;

function fechaEspn(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Traduce un evento terminado de ESPN a una resolución (o null si aún no se sabe).
function resolucionDeEspn(ev, sport) {
  const tipo = (ev.competitions && ev.competitions[0] && ev.competitions[0].status && ev.competitions[0].status.type) || (ev.status && ev.status.type) || {};
  const nombreEstado = String(tipo.name || '').toUpperCase();
  if (ESTADOS_ANULAN.test(nombreEstado)) return { anular: true };
  if (ESTADOS_APLAZADOS.test(nombreEstado)) {
    const inicio = Date.parse(ev.date);
    return Number.isFinite(inicio) && Date.now() - inicio > ESPERA_APLAZADO_MS ? { anular: true } : null;
  }
  if (tipo.state !== 'post' || tipo.completed === false) return null;

  const comp = ev.competitions && ev.competitions[0];
  const competidores = (comp && comp.competitors) || [];
  if (competidores.length < 2) return null;
  let local = competidores.find(c => c.homeAway === 'home');
  let visitante = competidores.find(c => c.homeAway === 'away');
  if (!local || !visitante) { local = competidores[0]; visitante = competidores[1]; }

  // Tenis y UFC: el "marcador" no son goles; se usa quién ganó.
  if (sport === 'tennis' || sport === 'mma' || sport === 'boxing') {
    if (local.winner === true) return { ganador: 'Local' };
    if (visitante.winner === true) return { ganador: 'Visitante' };
    return null;
  }
  const gl = Number(local.score && typeof local.score === 'object' ? local.score.value : local.score);
  const gv = Number(visitante.score && typeof visitante.score === 'object' ? visitante.score.value : visitante.score);
  if (!Number.isFinite(gl) || !Number.isFinite(gv)) return null;
  return { marcador: { local: gl, visitante: gv } };
}

let liquidandoAhora = false;
async function liquidarApuestasAutomatico() {
  if (liquidandoAhora) return 0; // nunca dos rondas a la vez
  liquidandoAhora = true;
  try {
    const todas = (await db.ref('apuestas').once('value')).val() || {};
    // Qué consultar: cada competición en las fechas de sus partidos pendientes.
    const consultas = new Map(); // ruta -> Set(fechas)
    const idsPendientes = new Set();
    const nombresPendientes = new Set();
    let pendientes = 0;
    for (const delUsuario of Object.values(todas)) {
      for (const ap of Object.values(delUsuario || {})) {
        if (!ap || ap.estado !== 'pendiente') continue;
        pendientes++;
        if (ap.eventoId) idsPendientes.add(String(ap.eventoId));
        if (ap.eventoNombre) nombresPendientes.add(String(ap.eventoNombre).toLowerCase().trim());
        if (ap.ruta) {
          const inicio = Date.parse(ap.horaInicio) || Number(ap.fecha) || Date.now();
          if (!consultas.has(ap.ruta)) consultas.set(ap.ruta, new Set());
          // ESPN agrupa por día de EE. UU.: se mira el día UTC y el anterior.
          consultas.get(ap.ruta).add(fechaEspn(inicio)).add(fechaEspn(inicio - 86400000));
        }
      }
    }
    if (pendientes === 0) return 0;
    // Apuestas antiguas (sin ruta): se revisan las competiciones del día.
    for (const d of DEPORTES.concat([{ path: 'tennis/atp/scoreboard', sport: 'tennis' }])) {
      const ruta = d.path.replace(/\/scoreboard$/, '');
      if (!consultas.has(ruta)) consultas.set(ruta, new Set());
      consultas.get(ruta).add('');
    }

    let liquidadas = 0;
    for (const [ruta, fechas] of consultas) {
      const sport = ruta.split('/')[0];
      for (const fecha of fechas) {
        try {
          const data = await fetchESPN(`${ruta}/scoreboard${fecha ? `?dates=${fecha}` : ''}`);
          for (const ev of (data.events || [])) {
            const resolucion = resolucionDeEspn(ev, sport);
            if (!resolucion) continue;
            const comp = ev.competitions && ev.competitions[0];
            const cs = (comp && comp.competitors) || [];
            const home = cs.find(c => c.homeAway === 'home') || cs[0];
            const away = cs.find(c => c.homeAway === 'away') || cs[1];
            const nombre = (n) => (n && ((n.team && n.team.displayName) || (n.athlete && n.athlete.displayName))) || '';
            const nombreEv = `${nombre(home)} vs ${nombre(away)}`;
            // Solo se procesa si hay apuestas pendientes de este partido.
            if (!idsPendientes.has(String(ev.id)) && !nombresPendientes.has(nombreEv.toLowerCase().trim())) continue;
            const r = await liquidarEvento({ eventoId: ev.id, nombre: nombreEv, resolucion, origen: 'auto' });
            liquidadas += r.liquidadas;
          }
        } catch (e) { console.error('AutoLiq', ruta, fecha, e.message); }
      }
    }
    if (liquidadas > 0) console.log('Auto-liquidadas: ' + liquidadas);
    return liquidadas;
  } catch (e) {
    console.error('Error auto-liq:', e.message);
    return 0;
  } finally {
    liquidandoAhora = false;
  }
}

async function enviarMonitoreo24h() {
  try {
    const NL = String.fromCharCode(10);
    const fix = getCache('fixtures');
    const totalEv = fix && fix.data ? fix.data.length : 0;
    const conQ = fix && fix.data ? fix.data.filter(function(e){ return e.cuota_local; }).length : 0;
    const apSnap = await db.ref('apuestas').once('value');
    const aps = apSnap.val() || {};
    let pend = 0, gan = 0, perd = 0;
    for (const uid of Object.keys(aps)) {
      for (const bid of Object.keys(aps[uid] || {})) {
        const ap = aps[uid][bid];
        if (!ap) continue;
        if (ap.estado === 'pendiente') pend++;
        else if (ap.estado === 'ganada') gan++;
        else if (ap.estado === 'perdida') perd++;
      }
    }
    const sep = '----------------------------';
    let msg = 'MONITOREO BETGROUP PRO 24H' + NL + sep + NL;
    msg += 'Servidor: ONLINE' + NL;
    msg += 'Eventos: ' + totalEv + ' (' + conQ + ' con cuotas)' + NL;
    msg += 'Pendientes: ' + pend + ' | Ganadas: ' + gan + ' | Perdidas: ' + perd + NL;
    msg += sep + NL + 'Sistema OK.';
    await notificarTelegram(msg);
    console.log('Monitoreo 24h enviado.');
  } catch(e) { console.error('Error monitoreo:', e.message); }
}

function programarReportes() {
  const ahora = new Date();
  // Calcula milisegundos hasta la proxima hora UTC exacta - sin drift
  function proximaHoraUTC(hUTC, mUTC) {
    var t = new Date();
    t.setUTCHours(hUTC, mUTC, 0, 0);
    if (t <= new Date()) { t.setUTCDate(t.getUTCDate() + 1); }
    return t - new Date();
  }
  // Reporte 8am Cuba = 12:00 UTC — se reprograma exacto cada dia
  function programar8am() {
    setTimeout(function() {
      enviarReporteTelegram();
      programar8am();
    }, proximaHoraUTC(12, 0));
  }
  // Reporte 2pm Cuba = 18:00 UTC — se reprograma exacto cada dia
  function programar2pm() {
    setTimeout(function() {
      enviarReporteTelegram();
      programar2pm();
    }, proximaHoraUTC(18, 0));
  }
  // Monitoreo 24h — se reprograma cada 24h exactas
  function programarMonitoreo() {
    setTimeout(function() {
      enviarMonitoreo24h();
      programarMonitoreo();
    }, 24 * 3600000);
  }
  programar8am();
  programar2pm();
  programarMonitoreo();
  setInterval(liquidarApuestasAutomatico, 30*60*1000);
  // Cada hora: si ya empezó una semana nueva, avisa al CEO de los ganadores (una sola vez).
  setInterval(() => ranking.avisarSemanaTerminada().catch(e => console.error('Aviso de ranking:', e.message)), 60*60*1000);
  setTimeout(liquidarApuestasAutomatico, 5*60*1000);
  console.log('Sistema automatizado: reportes 8am/2pm Cuba, liquidacion 30min, monitoreo 24h.');
}
// ════ MONITOREO DEL SISTEMA ════
app.get('/api/estado-sistema', soloCEO, async (req, res) => {
  const estado = {
    timestamp: new Date().toISOString(),
    proxy: 'online',
    firebase: 'unknown',
    odds_api: 'unknown',
    espn: 'unknown',
    huggingface: 'unknown'
  };
  try {
    const fbSnap = await db.ref('.info/connected').once('value');
    estado.firebase = fbSnap.val() === true ? 'online' : 'offline';
  } catch(e) { estado.firebase = 'error'; console.error('estado-sistema firebase:', e.message); }
  try {
    const oddsRes = await axios.get('https://api.the-odds-api.com/v4/sports/baseball_mlb/odds?apiKey=' + getApiKey() + '&markets=h2h&regions=us', {timeout: 5000});
    estado.odds_api = oddsRes.data && oddsRes.data.length > 0 ? 'online' : 'sin_datos';
  } catch(e) { estado.odds_api = 'error'; console.error('estado-sistema odds_api:', e.message); }
  try {
    const espnRes = await axios.get('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard', {timeout: 5000});
    estado.espn = espnRes.data && espnRes.data.events ? 'online' : 'sin_datos';
  } catch(e) { estado.espn = 'error'; console.error('estado-sistema espn:', e.message); }
  try {
    await callCF([{role: 'user', content: 'OK'}], 'rapido');
    estado.huggingface = 'online (cloudflare)';
  } catch(e) { estado.huggingface = 'error'; console.error('estado-sistema huggingface:', e.message); }
  res.json({ success: true, estado });
});

// ENDPOINT DE PRUEBA - disparar reporte manualmente
app.post('/api/test-reporte', soloCEO, async (req, res) => {
  try {
    await enviarReporteTelegram();
    res.json({ success: true, message: 'Reporte enviado a Telegram.' });
  } catch(e) {
    responderError(res, req, e, '/api/test-reporte');
  }
});

// ENDPOINT DEBUG - ver que eventos tiene el reporte
app.get('/api/debug-reporte', soloCEO, async (req, res) => {
  try {
    const fixtures = getCache('fixtures');
    const cacheEvs = fixtures && fixtures.data ? fixtures.data.length : 0;
    const cacheConCuotas = fixtures && fixtures.data ? fixtures.data.filter(function(e){ return e.cuota_local && e.cuota_local > 0; }).length : 0;
    let espnEvs = 0;
    try {
      const espnData = await fetchESPN('baseball/mlb/scoreboard');
      const parsed = parseEvents(espnData, 'baseball');
      espnEvs = parsed.length;
    } catch(e) {}
    res.json({
      cache_total: cacheEvs,
      cache_con_cuotas: cacheConCuotas,
      espn_mlb_directo: espnEvs,
      cf_account: config.cloudflare.accountId ? 'OK' : 'FALTA',
      cf_token: config.cloudflare.token ? 'OK' : 'FALTA'
    });
  } catch(e) {
    responderError(res, req, e, '/api/debug-reporte');
  }
});

app.use(rutaNoEncontrada);
app.use(manejadorErrores);

app.listen(PORT, () => {
  console.log(`✅ Proxy escuchando en puerto ${PORT}`);
  precalentarCache();
  setInterval(precalentarCache, 3 * 60 * 1000);
  programarReportes();
});
