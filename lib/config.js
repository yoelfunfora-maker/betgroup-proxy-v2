'use strict';

// ==================== CONFIGURACIÓN CENTRAL ====================
// Todas las claves salen de variables de entorno (Render → Environment).
// Ninguna clave puede volver a escribirse dentro del código.

function leer(nombre, { requerida = false, minLongitud = 0 } = {}) {
  const valor = (process.env[nombre] || '').trim();
  if (requerida && !valor) {
    throw new Error(`Falta la variable de entorno obligatoria ${nombre}`);
  }
  if (valor && valor.length < minLongitud) {
    throw new Error(`La variable ${nombre} debe tener al menos ${minLongitud} caracteres`);
  }
  return valor;
}

function lista(nombre, porDefecto = []) {
  const valor = leer(nombre);
  if (!valor) return porDefecto;
  return valor.split(',').map(v => v.trim()).filter(Boolean);
}

const config = Object.freeze({
  puerto: Number.parseInt(process.env.PORT, 10) || 3000,
  produccion: process.env.NODE_ENV === 'production',

  firebase: Object.freeze({
    serviceAccountB64: leer('FIREBASE_SERVICE_ACCOUNT_B64', { requerida: true }),
    databaseURL: leer('FIREBASE_DATABASE_URL') || 'https://betgroup-cuba-2024-default-rtdb.firebaseio.com'
  }),

  // Firma de las sesiones del servidor (HMAC-SHA256). Mínimo 32 caracteres aleatorios.
  sesionSecreto: leer('SESSION_SECRET', { requerida: true, minLongitud: 32 }),
  // Firma de la cadena de auditoría (HMAC-SHA256). Distinto del de sesiones.
  auditoriaSecreto: leer('AUDIT_SECRET', { requerida: true, minLongitud: 32 }),
  // Secreto del login antiguo ("Inmune"). Solo se usa para migrar hashes viejos a PBKDF2.
  pimientaLegada: leer('LEGACY_PASSWORD_PEPPER'),
  // Clave web PÚBLICA de Firebase (la misma del index.html): para migrar usuarios antiguos de Firebase Auth.
  firebaseWebApiKey: leer('FIREBASE_WEB_API_KEY'),

  origenesPermitidos: lista('ALLOWED_ORIGINS', [
    'https://betgroup-cuba-2024.web.app',
    'https://betgroup-cuba-2024.firebaseapp.com',
    'https://betgroup-proxy-v2-8vqj.onrender.com'
  ]),

  telegram: Object.freeze({
    token: leer('TELEGRAM_BOT_TOKEN'),
    chatId: leer('TELEGRAM_CHAT_ID')
  }),

  oddsApiKeys: Object.freeze(lista('ODDS_API_KEYS')),
  // Respaldo de cuotas de fútbol (opcional: también se puede guardar desde el panel/Termux).
  apiFootballKey: leer('API_FOOTBALL_KEY'),
  // Clave de ImgBB solo en el servidor (las fotos se suben limpias de metadatos desde aquí).
  imgbbKey: leer('IMGBB_API_KEY'),
  geminiKey: leer('GEMINI_API_KEY'),
  groqKey: leer('GROQ_API_KEY'),
  tavilyKey: leer('TAVILY_API_KEY'),
  // "Entrar con Google" (ID de cliente OAuth, público) y casilla de Cloudflare Turnstile en el registro.
  // Sin estas variables, las dos funciones quedan apagadas (lib/accesoExterno.js).
  googleClientId: leer('GOOGLE_CLIENT_ID'),
  turnstile: Object.freeze({
    sitio: leer('TURNSTILE_SITE_KEY'),
    secreto: leer('TURNSTILE_SECRET')
  }),
  cloudflare: Object.freeze({
    accountId: leer('CF_ACCOUNT_ID'),
    token: leer('CF_TOKEN')
  }),

  // Usuario de prueba que revisa el verificador (opcional).
  uidPrueba: leer('TEST_USER_UID'),
  // El reinicio total del sistema queda apagado salvo que se active a propósito.
  permitirReinicio: process.env.ALLOW_SYSTEM_RESET === 'true'
});

module.exports = config;
