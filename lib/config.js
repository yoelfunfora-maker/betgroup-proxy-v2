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
  geminiKey: leer('GEMINI_API_KEY'),
  groqKey: leer('GROQ_API_KEY'),
  tavilyKey: leer('TAVILY_API_KEY'),
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
