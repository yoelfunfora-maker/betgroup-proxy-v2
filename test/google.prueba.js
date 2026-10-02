// Prueba de "Entrar con Google" y de la casilla de Cloudflare (Turnstile) en el registro.
// Google se simula con una clave RSA propia: se firma un ID token igual que lo haría Google.
// Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { get, set, arrancar, ok } = require('./simulador');

const CLIENT_ID = '1234-prueba.apps.googleusercontent.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otra = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); // clave de un falsificador
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'clave-1', alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(datos, { clave = privateKey, kid = 'clave-1' } = {}) {
  const ahora = Math.floor(Date.now() / 1000);
  const cuerpo = { iss: 'https://accounts.google.com', aud: CLIENT_ID, iat: ahora, exp: ahora + 3600, email_verified: true, ...datos };
  const firmado = b64({ alg: 'RS256', kid, typ: 'JWT' }) + '.' + b64(cuerpo);
  return firmado + '.' + crypto.sign('RSA-SHA256', Buffer.from(firmado), clave).toString('base64url');
}

set('codigosAcceso/GOOG-1', { code: 'GOOG-1', createdBy: 'BG_ag', generadoPor: 'BG_ag', usado: false, rol: 'member' });
set('codigosAcceso/GOOG-2', { code: 'GOOG-2', createdBy: 'BG_ag', generadoPor: 'BG_ag', usado: false, rol: 'member' });
set('users/BG_ag', { uid: 'BG_ag', email: 'ag@x.com', activo: true, nombre: 'Agente', rol: 'subadmin', rolLevel: 2, creditoReal: 0, creditoPromo: 0 });
// Cuenta antigua con correo de Gmail (se vincula) y otra con correo propio (no se vincula sola).
set('users/BG_viejo', { uid: 'BG_viejo', email: 'viejo@gmail.com', activo: true, nombre: 'Viejo', rol: 'member', rolLevel: 1, creditoReal: 50, creditoPromo: 0 });
set('credenciales_acceso/viejo-gmail-com', { email: 'viejo@gmail.com', uid: 'BG_viejo' });
set('users/BG_emp', { uid: 'BG_emp', email: 'yo@empresa.cu', activo: true, nombre: 'Emp', rol: 'member', rolLevel: 1, creditoReal: 0, creditoPromo: 0 });
set('credenciales_acceso/yo-empresa-cu', { email: 'yo@empresa.cu', uid: 'BG_emp' });
for (let i = 1; i <= 3; i++) set(`codigosAcceso/TURN-${i}`, { code: `TURN-${i}`, createdBy: 'BG_ag', usado: false, rol: 'member' });

const { llamar } = arrancar({ puerto: 3983, env: { ODDS_API_KEYS: '', GOOGLE_CLIENT_ID: CLIENT_ID, TURNSTILE_SITE_KEY: '0x4AAAprueba', TURNSTILE_SECRET: 'secreto-turnstile-prueba' } });
// Red simulada: claves públicas de Google y respuesta de Cloudflare.
let pidioClaves = 0, turnstileVio = null, turnstileCaido = false;
global.fetch = async (url, opciones) => {
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
    pidioClaves++;
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'public, max-age=21600' } });
  }
  if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    if (turnstileCaido) throw new Error('sin red');
    const p = new URLSearchParams(opciones.body.toString()); turnstileVio = p;
    return new Response(JSON.stringify({ success: p.get('response') === 'humano-ok' }));
  }
  throw new Error('sin red en pruebas');
};
const persona = (i, extra = {}) => ({ nombre: `Persona ${i}`, telefono: `5354${String(i).padStart(4, '0')}`, email: `p${i}@nauta.cu`, password: 'clave-segura-1', codigo: `TURN-${i}`, apodo: `Robot_${i}`, ...extra });

(async () => {
  try {
    await new Promise(r => setTimeout(r, 500));
    let s, j;

    [s, j] = await llamar('GET', '/api/auth/opciones');
    ok(s === 200 && j.google === CLIENT_ID && j.turnstile === '0x4AAAprueba', 'la web sabe qué mostrar: botón de Google y casilla de Cloudflare (solo datos públicos)');
    ok(!JSON.stringify(j).includes('secreto-turnstile'), 'la clave secreta de Cloudflare nunca sale del servidor');

    // ---- Persona nueva con Google ----
    const tNuevo = idToken({ sub: '111111', email: 'Nueva.Persona@gmail.com', name: 'Nueva Persona' });
    [s, j] = await llamar('POST', '/api/auth/google', { credential: tNuevo });
    ok(s === 200 && j.registroPendiente === true && j.email === 'nueva.persona@gmail.com' && !j.token, 'persona nueva: el servidor pide apodo, teléfono y código (no entra sin invitación)');
    [s, j] = await llamar('POST', '/api/auth/google', { credential: tNuevo, codigo: 'GOOG-1', apodo: 'Gugle_1', telefono: '53 55554444' });
    const uidN = j && j.usuario && j.usuario.uid;
    ok(s === 200 && j.token && uidN, 'con su código de invitación se crea la cuenta y entra directamente');
    const u = get(`users/${uidN}`) || {};
    ok(u.email === 'nueva.persona@gmail.com' && u.nombre === 'Nueva Persona' && u.apodo === 'Gugle_1' && u.googleSub === '111111', 'correo y nombre salen de Google; apodo y teléfono los pone la persona');
    ok(u.referidoPorUid === 'BG_ag' && get('codigosAcceso/GOOG-1/usado') === true, 'queda ligada al agente del código, y el código se gasta');
    ok(u.creditoPromo === 100 && u.bonoInscripcion, 'recibe el bono de bienvenida como cualquier registro');
    [s, j] = await llamar('POST', '/api/auth/google', { credential: tNuevo });
    ok(s === 200 && j.token && j.usuario.uid === uidN, 'la segunda vez entra directamente con Google');
    ok(pidioClaves === 1, 'las claves públicas de Google se guardan en memoria (no se piden en cada acceso)');

    // ---- Cuentas que ya existían ----
    [s, j] = await llamar('POST', '/api/auth/google', { credential: idToken({ sub: '222222', email: 'viejo@gmail.com' }) });
    ok(s === 200 && j.usuario && j.usuario.uid === 'BG_viejo' && get('googleCuentas/222222/uid') === 'BG_viejo', 'cuenta antigua de Gmail: se vincula a su cuenta de siempre (no se duplica)');
    [s, j] = await llamar('POST', '/api/auth/google', { credential: idToken({ sub: '333333', email: 'yo@empresa.cu' }) });
    ok(s === 409 && /contraseña/.test(j.error), 'correo que no es de Gmail y ya tiene cuenta: no se vincula solo, debe entrar con su contraseña');

    // ---- Ataques ----
    [s] = await llamar('POST', '/api/auth/google', { credential: idToken({ sub: '444444', email: 'x@gmail.com' }, { clave: otra.privateKey }) });
    ok(s === 401, 'token firmado por otra clave (falsificado): rechazado');
    [s] = await llamar('POST', '/api/auth/google', { credential: idToken({ sub: '444444', email: 'x@gmail.com', aud: 'otra-app.apps.googleusercontent.com' }) });
    ok(s === 401, 'token de Google emitido para OTRA aplicación: rechazado');
    [s] = await llamar('POST', '/api/auth/google', { credential: idToken({ sub: '444444', email: 'x@gmail.com', exp: Math.floor(Date.now() / 1000) - 3600 }) });
    ok(s === 401, 'token caducado: rechazado');
    [s] = await llamar('POST', '/api/auth/google', { credential: idToken({ sub: '444444', email: 'x@gmail.com', iss: 'https://evil.example' }) });
    ok(s === 401, 'token de otro emisor: rechazado');
    [s] = await llamar('POST', '/api/auth/google', { credential: idToken({ sub: '444444', email: 'x@gmail.com', email_verified: false }) });
    ok(s === 401, 'correo de Google sin verificar: rechazado');
    [s, j] = await llamar('POST', '/api/auth/google', { credential: 'basura.total.aqui' });
    ok(s === 401 && !/stack|Error:/.test(JSON.stringify(j)), 'basura en vez de token: rechazado sin revelar detalles internos');
    [s] = await llamar('POST', '/api/db', { op: 'leer', ruta: 'googleCuentas' }, (await llamar('POST', '/api/auth/google', { credential: tNuevo }))[1].token);
    ok(s === 403, 'la tabla de vínculos con Google no se puede leer desde el navegador');

    // ---- Cloudflare Turnstile en el registro normal ----
    [s, j] = await llamar('POST', '/api/auth/registro', persona(1, { turnstile: 'bot-falso' }));
    ok(s === 400 && /persona/.test(j.error), 'Cloudflare dice que es un robot: registro rechazado → ' + j.error);
    [s] = await llamar('POST', '/api/auth/registro', persona(1, { turnstile: 'humano-ok' }));
    ok(s === 200 && turnstileVio.get('secret') === 'secreto-turnstile-prueba', 'Cloudflare confirma que es una persona: registro correcto');
    turnstileCaido = true;
    [s] = await llamar('POST', '/api/auth/registro', persona(2));
    ok(s === 200, 'si la casilla no carga (conexión lenta), puede registrarse igual con su código');
    set('config/turnstileObligatorio', true);
    [s, j] = await llamar('POST', '/api/auth/registro', persona(3));
    ok(s === 400 && /No soy un robot/.test(j.error), 'si el CEO la hace obligatoria (config/turnstileObligatorio), sin casilla no hay registro');
  } catch (e) {
    ok(false, 'error inesperado: ' + e.message);
  }
  process.exit(0);
})();
