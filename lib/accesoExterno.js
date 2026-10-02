'use strict';

// ==================== ACCESO CON GOOGLE Y VERIFICACIÓN DE CLOUDFLARE ====================
// Decisión de Yoel (2 oct 2026): recuperar "Entrar con Google" de forma segura y añadir la
// casilla de Cloudflare (Turnstile) al registro. Las dos quedan APAGADAS hasta que existan
// sus variables de entorno en Render:
//   GOOGLE_CLIENT_ID      → ID de cliente OAuth (público)
//   TURNSTILE_SITE_KEY    → clave del sitio de Turnstile (pública)
//   TURNSTILE_SECRET      → clave secreta de Turnstile (solo en Render, nunca en el código)
//
// Google: el navegador recibe de Google un "ID token" (JWT firmado RS256). Aquí se comprueba
// la firma con las claves públicas oficiales de Google y los campos iss/aud/exp/email_verified.
// No se usa ninguna librería de terceros: solo node:crypto (RSA-SHA256, aprobado por FIPS 186).

const crypto = require('crypto');

const CLAVES_GOOGLE_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const EMISORES_GOOGLE = new Set(['accounts.google.com', 'https://accounts.google.com']);
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const HOLGURA_S = 60;          // diferencia de reloj tolerada
const MAX_TOKEN = 4096;        // un ID token real ronda 1 KB

class ErrorAcceso extends Error {
  constructor(estado, mensaje) { super(mensaje); this.estado = estado; }
}

function b64urlABuffer(txt) {
  if (typeof txt !== 'string' || !/^[A-Za-z0-9_-]*$/.test(txt)) throw new ErrorAcceso(401, 'Token de Google mal formado');
  return Buffer.from(txt, 'base64url');
}

function leerJson(txt) {
  try { return JSON.parse(b64urlABuffer(txt).toString('utf8')); } catch (e) { throw new ErrorAcceso(401, 'Token de Google mal formado'); }
}

function crearVerificadorGoogle({ clientId, ahora = () => Date.now() }) {
  let cache = { claves: null, hasta: 0 };

  async function clavesPublicas(forzar) {
    if (!forzar && cache.claves && cache.hasta > ahora()) return cache.claves;
    const r = await fetch(CLAVES_GOOGLE_URL, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new ErrorAcceso(503, 'No se pudo contactar con Google. Prueba en un momento');
    const datos = await r.json();
    const maxAge = Number((/max-age=(\d+)/.exec(r.headers.get('cache-control') || '') || [])[1]) || 3600;
    const claves = new Map();
    for (const jwk of (datos && datos.keys) || []) {
      if (jwk && jwk.kty === 'RSA' && typeof jwk.kid === 'string') claves.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
    cache = { claves, hasta: ahora() + Math.min(maxAge, 86400) * 1000 };
    return claves;
  }

  // Devuelve { sub, email, nombre } o lanza ErrorAcceso.
  async function verificar(idToken) {
    if (!clientId) throw new ErrorAcceso(503, 'El acceso con Google no está activado');
    if (typeof idToken !== 'string' || idToken.length > MAX_TOKEN) throw new ErrorAcceso(401, 'Token de Google mal formado');
    const partes = idToken.split('.');
    if (partes.length !== 3) throw new ErrorAcceso(401, 'Token de Google mal formado');
    const cabecera = leerJson(partes[0]);
    if (cabecera.alg !== 'RS256' || typeof cabecera.kid !== 'string') throw new ErrorAcceso(401, 'Token de Google no válido');

    let claves = await clavesPublicas(false);
    if (!claves.has(cabecera.kid)) claves = await clavesPublicas(true); // Google rota sus claves
    const clave = claves.get(cabecera.kid);
    if (!clave) throw new ErrorAcceso(401, 'Token de Google no válido');
    const firmaOk = crypto.verify('RSA-SHA256', Buffer.from(partes[0] + '.' + partes[1]), clave, b64urlABuffer(partes[2]));
    if (!firmaOk) throw new ErrorAcceso(401, 'Token de Google no válido');

    const d = leerJson(partes[1]);
    const s = Math.floor(ahora() / 1000);
    if (!EMISORES_GOOGLE.has(d.iss)) throw new ErrorAcceso(401, 'Token de Google no válido');
    if (d.aud !== clientId) throw new ErrorAcceso(401, 'Token de Google no válido');
    if (!(Number(d.exp) > s - HOLGURA_S) || (d.iat && Number(d.iat) > s + HOLGURA_S)) throw new ErrorAcceso(401, 'Tu sesión de Google caducó. Vuelve a intentarlo');
    if (typeof d.sub !== 'string' || !/^[0-9]{1,64}$/.test(d.sub)) throw new ErrorAcceso(401, 'Token de Google no válido');
    if (d.email_verified !== true || typeof d.email !== 'string') throw new ErrorAcceso(401, 'Tu cuenta de Google no tiene un correo verificado');
    return { sub: d.sub, email: d.email.trim().toLowerCase().slice(0, 254), nombre: typeof d.name === 'string' ? d.name.slice(0, 60) : '' };
  }

  return { verificar, activo: Boolean(clientId) };
}

// Turnstile: true = humano verificado, false = Cloudflare dice que NO, null = no se pudo comprobar.
async function comprobarTurnstile({ secreto, token, ip }) {
  if (!secreto || typeof token !== 'string' || !token || token.length > 2048) return null;
  try {
    const cuerpo = new URLSearchParams({ secret: secreto, response: token });
    if (ip) cuerpo.set('remoteip', ip);
    const r = await fetch(TURNSTILE_URL, { method: 'POST', body: cuerpo, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.success === true;
  } catch (e) {
    return null;
  }
}

// Correos donde Google es el dueño del buzón: solo con estos se vincula una cuenta ya existente.
function esCorreoDeGoogle(email) {
  return /@(gmail|googlemail)\.com$/i.test(email || '');
}

module.exports = { crearVerificadorGoogle, comprobarTurnstile, esCorreoDeGoogle, ErrorAcceso, CLAVES_GOOGLE_URL, TURNSTILE_URL };
