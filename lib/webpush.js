'use strict';

// ==================== NOTIFICACIONES PUSH ESTÁNDAR (sin librerías de terceros) ====================
// Decisión de Yoel (3 oct 2026): los avisos (apuesta registrada, ganada/perdida, depósitos, ofertas
// del día) deben llegar al teléfono aunque BetGroup esté cerrado.
//
// Se usa el estándar de los navegadores (Web Push), implementado solo con node:crypto:
//   · RFC 8291 — cifrado del mensaje: ECDH P-256 + HKDF-SHA-256 + AES-128-GCM ("aes128gcm", RFC 8188).
//     Solo el teléfono de la persona puede leer el aviso; el servicio de push (Google, Mozilla,
//     Apple, Microsoft) solo transporta bytes cifrados.
//   · RFC 8292 — identificación del servidor (VAPID): JWT firmado ES256 (ECDSA P-256 + SHA-256).
// Todos los algoritmos están aprobados por FIPS 140-3 (SP 800-56A, SP 800-56C, SP 800-38D, FIPS 186-5).
//
// La clave privada VAPID se genera sola la primera vez y se guarda en secretos/vapid CIFRADA con
// AES-256-GCM (clave derivada de SESSION_SECRET con HKDF). La web nunca puede leer ese nodo.

const crypto = require('crypto');

const TAM_REGISTRO = 4096;            // rs: un solo registro (los avisos son cortos)
const MAX_CARGA = 3000;               // bytes de texto del aviso antes de cifrar
const VIDA_JWT_S = 12 * 3600;         // RFC 8292: como máximo 24 h

// Servicios de push conocidos. Solo se envía a estos dominios: así nadie puede usar el servidor
// para hacer peticiones a direcciones arbitrarias (SSRF) registrando un "endpoint" falso.
const DOMINIOS_PUSH = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
  /^web\.push\.apple\.com$/
];

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const deB64u = (txt) => Buffer.from(String(txt || ''), 'base64url');

// ¿La suscripción que manda el navegador es válida? Devuelve { endpoint, p256dh, auth } o null.
function limpiarSuscripcion(s) {
  if (!s || typeof s !== 'object') return null;
  const endpoint = typeof s.endpoint === 'string' ? s.endpoint.trim() : '';
  if (!endpoint || endpoint.length > 1024) return null;
  let url;
  try { url = new URL(endpoint); } catch (e) { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (!DOMINIOS_PUSH.some(re => re.test(url.hostname))) return null;
  const keys = s.keys || {};
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(keys.auth)) return null;
  const p256dh = deB64u(keys.p256dh.replace(/=+$/, ''));
  const auth = deB64u(keys.auth.replace(/=+$/, ''));
  if (p256dh.length !== 65 || p256dh[0] !== 0x04 || auth.length !== 16) return null;
  // La clave pública del teléfono debe ser un punto válido de la curva P-256.
  try { crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(p256dh.subarray(1, 33)), y: b64u(p256dh.subarray(33)) }, format: 'jwk' }); } catch (e) { return null; }
  return { endpoint: url.toString(), p256dh: b64u(p256dh), auth: b64u(auth) };
}

// Identificador estable de una suscripción (para guardarla sin repetir y borrarla).
function idSuscripcion(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('base64url').slice(0, 32);
}

function hmac(clave, datos) { return crypto.createHmac('sha256', clave).update(datos).digest(); }

// RFC 8291 §3.4 + RFC 8188 §2: cifra el texto para un teléfono concreto.
function cifrar(texto, { p256dh, auth }, { salt = crypto.randomBytes(16), efimera = null } = {}) {
  const plano = Buffer.from(texto, 'utf8');
  if (plano.length > MAX_CARGA) throw new Error('Aviso demasiado largo');
  const uaPublica = deB64u(p256dh);
  const secretoAuth = deB64u(auth);
  const ecdh = efimera || crypto.createECDH('prime256v1');
  if (!efimera) ecdh.generateKeys();
  const asPublica = ecdh.getPublicKey();
  const secretoEcdh = ecdh.computeSecret(uaPublica);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const prkClave = hmac(secretoAuth, secretoEcdh);
  const infoClave = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublica, asPublica, Buffer.from([1])]);
  const ikm = hmac(prkClave, infoClave);
  // CEK y NONCE (RFC 8188 §2.2 y §2.3)
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);

  const cifrador = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 = delimitador del último (y único) registro
  const cuerpo = Buffer.concat([cifrador.update(Buffer.concat([plano, Buffer.from([2])])), cifrador.final(), cifrador.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(TAM_REGISTRO);
  const cabecera = Buffer.concat([salt, rs, Buffer.from([asPublica.length]), asPublica]);
  return Buffer.concat([cabecera, cuerpo]);
}

// RFC 8292: cabecera Authorization "vapid t=<JWT>, k=<clave pública>".
function cabeceraVapid(endpoint, claves, contacto, ahora = Date.now()) {
  const aud = new URL(endpoint).origin;
  const cab = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const carga = b64u(JSON.stringify({ aud, exp: Math.floor(ahora / 1000) + VIDA_JWT_S, sub: contacto }));
  const firma = crypto.sign('sha256', Buffer.from(`${cab}.${carga}`), { key: claves.privada, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${cab}.${carga}.${b64u(firma)}, k=${claves.publica}`;
}

// ---------- Claves VAPID (generadas una vez, guardadas cifradas) ----------
function claveCifrado(secreto) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secreto), Buffer.from('betgroup-vapid'), Buffer.from('secretos/vapid'), 32));
}
function sellar(texto, secreto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', claveCifrado(secreto), iv);
  const datos = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return { iv: b64u(iv), datos: b64u(datos), etiqueta: b64u(c.getAuthTag()), alg: 'AES-256-GCM' };
}
function abrir(sellado, secreto) {
  const d = crypto.createDecipheriv('aes-256-gcm', claveCifrado(secreto), deB64u(sellado.iv));
  d.setAuthTag(deB64u(sellado.etiqueta));
  return Buffer.concat([d.update(deB64u(sellado.datos)), d.final()]).toString('utf8');
}

function crearWebPush({ db, secreto, contacto = 'mailto:soporte@betgroup.app', enviar = null }) {
  let claves = null;
  let cargando = null;

  async function cargarClaves() {
    if (claves) return claves;
    if (cargando) return cargando;
    cargando = (async () => {
      const ref = db.ref('secretos/vapid');
      let guardado = (await ref.once('value')).val();
      if (!guardado || !guardado.publica || !guardado.privada) {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const jwk = publicKey.export({ format: 'jwk' });
        const nuevo = {
          publica: b64u(Buffer.concat([Buffer.from([4]), deB64u(jwk.x), deB64u(jwk.y)])),
          privada: sellar(privateKey.export({ format: 'pem', type: 'pkcs8' }), secreto),
          creadaEn: Date.now()
        };
        // Si dos instancias arrancan a la vez, gana la primera que escribe.
        const tx = await ref.transaction(actual => (actual && actual.publica ? undefined : nuevo));
        guardado = tx.committed ? nuevo : (await ref.once('value')).val();
      }
      claves = { publica: guardado.publica, privada: crypto.createPrivateKey(abrir(guardado.privada, secreto)) };
      return claves;
    })();
    try { return await cargando; } finally { cargando = null; }
  }

  async function clavePublica() { return (await cargarClaves()).publica; }

  // Envía un aviso a una suscripción. Devuelve { ok, caducada } (caducada = borrarla).
  async function enviarA(sub, aviso, { ttl = 86400, urgencia = 'normal' } = {}) {
    const limpia = limpiarSuscripcion({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
    if (!limpia) return { ok: false, caducada: true };
    const k = await cargarClaves();
    const cuerpo = cifrar(JSON.stringify(aviso), limpia);
    const cabeceras = {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgencia,
      Authorization: cabeceraVapid(limpia.endpoint, k, contacto)
    };
    try {
      const r = enviar
        ? await enviar(limpia.endpoint, { method: 'POST', headers: cabeceras, body: cuerpo })
        : await fetch(limpia.endpoint, { method: 'POST', headers: cabeceras, body: cuerpo, redirect: 'error', signal: AbortSignal.timeout(10000) });
      // 404/410: el teléfono canceló el permiso o desinstaló la app → se borra la suscripción.
      return { ok: r.status >= 200 && r.status < 300, caducada: r.status === 404 || r.status === 410, estado: r.status };
    } catch (e) {
      return { ok: false, caducada: false };
    }
  }

  return { clavePublica, enviarA };
}

module.exports = { crearWebPush, limpiarSuscripcion, idSuscripcion, cifrar, cabeceraVapid, DOMINIOS_PUSH };
