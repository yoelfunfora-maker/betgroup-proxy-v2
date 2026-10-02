// Prueba en navegador real: botón "Continuar con Google" y casilla de Cloudflare en el registro.
// Los scripts de Google y Cloudflare se simulan; también el caso en que no cargan (Cuba).
// Ejecutar: NODE_PATH=$(npm root -g) node test/google.e2e.js  (necesita Playwright instalado)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const fetchReal = global.fetch;
const { get, set, arrancar, ok } = require('./simulador');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3982, PUERTO_WEB = 8097;
const API_REAL = 'https://betgroup-proxy-v2-8vqj.onrender.com';
const CLIENT_ID = '999-prueba.apps.googleusercontent.com';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(datos) {
  const ahora = Math.floor(Date.now() / 1000);
  const f = b64({ alg: 'RS256', kid: 'k1' }) + '.' + b64({ iss: 'accounts.google.com', aud: CLIENT_ID, iat: ahora, exp: ahora + 3600, email_verified: true, ...datos });
  return f + '.' + crypto.sign('RSA-SHA256', Buffer.from(f), privateKey).toString('base64url');
}
const TOKEN = idToken({ sub: '5550001', email: 'maria.cuba@gmail.com', name: 'María <b>Pérez</b>' });

set('codigosAcceso/GG-1', { code: 'GG-1', createdBy: 'BG_ag', generadoPor: 'BG_ag', usado: false, rol: 'member' });
set('codigosAcceso/TT-1', { code: 'TT-1', createdBy: 'BG_ag', usado: false, rol: 'member' });
set('codigosAcceso/TT-2', { code: 'TT-2', createdBy: 'BG_ag', usado: false, rol: 'member' });
set('users/BG_ag', { uid: 'BG_ag', email: 'ag@x.com', activo: true, nombre: 'Agente', rol: 'subadmin', rolLevel: 2, creditoReal: 0, creditoPromo: 0 });
set('config', { minBet: 100, maxBet: 500 });
arrancar({ puerto: PUERTO_API, env: { ODDS_API_KEYS: '', ALLOWED_ORIGINS: `http://127.0.0.1:${PUERTO_WEB}`, GOOGLE_CLIENT_ID: CLIENT_ID, TURNSTILE_SITE_KEY: '0x4AAAweb', TURNSTILE_SECRET: 'secreto-web' } });
let turnstileRecibido = [];
global.fetch = async (url, op) => {
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') return new Response(JSON.stringify({ keys: [jwk] }));
  if (url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    const r = new URLSearchParams(op.body.toString()).get('response'); turnstileRecibido.push(r);
    return new Response(JSON.stringify({ success: r === 'humano-ok' }));
  }
  throw new Error('sin red en pruebas');
};

// Scripts falsos de Google (botón que devuelve el token) y de Cloudflare (casilla que se marca sola).
const GSI = `window.google={accounts:{id:{_cb:null,initialize:function(o){this._cb=o.callback;window.__gsiCliente=o.client_id;},
  renderButton:function(el){var b=document.createElement('button');b.id='botonGoogleFalso';b.textContent='Continuar con Google';var s=this;b.onclick=function(){s._cb({credential:${JSON.stringify(TOKEN)}});};el.appendChild(b);}}}};`;
const TURN = `window.turnstile={render:function(el,o){var d=document.createElement('div');d.id='casillaFalsa';d.textContent='✓ No soy un robot';el.appendChild(d);setTimeout(function(){o.callback('humano-ok');},50);return 'w1';},reset:function(){window.__turnReset=(window.__turnReset||0)+1;}};`;

const TIPOS = { '.webp': 'image/webp', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
http.createServer((req, res) => {
  const f = path.join(FRONT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(f)] || 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
}).listen(PUERTO_WEB);

async function nuevaPagina(navegador, { externosCaidos = false } = {}) {
  const pagina = await navegador.newPage({ viewport: { width: 400, height: 860 } });
  pagina.erroresJs = [];
  pagina.on('pageerror', (e) => pagina.erroresJs.push(e.message));
  pagina.on('dialog', (d) => d.accept());
  await pagina.route('**/*', async (ruta) => {
    const req = ruta.request(); const url = req.url();
    if (url.startsWith('https://accounts.google.com/gsi/client')) return externosCaidos ? ruta.abort() : ruta.fulfill({ status: 200, contentType: 'text/javascript', body: GSI });
    if (url.startsWith('https://challenges.cloudflare.com/turnstile/')) return externosCaidos ? ruta.abort() : ruta.fulfill({ status: 200, contentType: 'text/javascript', body: TURN });
    if (url.startsWith(API_REAL)) {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization', 'access-control-allow-methods': 'GET, POST' };
      if (req.method() === 'OPTIONS') return ruta.fulfill({ status: 204, headers: cors });
      const h = req.headers();
      const r = await fetchReal(url.replace(API_REAL, `http://127.0.0.1:${PUERTO_API}`), {
        method: req.method(), headers: { 'content-type': h['content-type'] || 'application/json', ...(h.authorization ? { authorization: h.authorization } : {}) },
        body: req.method() === 'GET' ? undefined : req.postDataBuffer()
      });
      return ruta.fulfill({ status: r.status, headers: { ...cors, 'content-type': 'application/json' }, body: await r.text() });
    }
    if (url.startsWith(`http://127.0.0.1:${PUERTO_WEB}`)) return ruta.continue();
    return ruta.abort();
  });
  await pagina.goto(`http://127.0.0.1:${PUERTO_WEB}/index.html`);
  await pagina.evaluate(() => { localStorage.setItem('betgroup_terms_accepted', 'true'); ['jugador', 'agente', 'supervisor', 'ceo'].forEach(t => localStorage.setItem('bg_tutorial_' + t, '1')); });
  await pagina.reload();
  return pagina;
}
async function registrar(pagina, i, codigo) {
  await pagina.click('text=Crear cuenta');
  await pagina.fill('#rNombre', `Persona Web ${i}`); await pagina.fill('#rApodo', `Halcon_${i}`);
  await pagina.fill('#rTel', `535600000${i}`); await pagina.fill('#rEmail', `web${i}@nauta.cu`);
  await pagina.fill('#rPass', 'clave-segura-1'); await pagina.fill('#rPass2', 'clave-segura-1'); await pagina.fill('#rCodigo', codigo);
}

(async () => {
  const navegador = await chromium.launch();
  let pagina;
  try {
    // ---- Con Google y Cloudflare disponibles ----
    pagina = await nuevaPagina(navegador);
    await pagina.waitForSelector('#bgGoogleZona:not([hidden]) #botonGoogleFalso', { timeout: 15000 });
    ok(await pagina.evaluate(() => window.__gsiCliente) === CLIENT_ID, 'aparece "Continuar con Google" con el ID de cliente que da el servidor');
    await pagina.screenshot({ path: path.join(__dirname, 'captura-login-google.png') });
    await pagina.click('#botonGoogleFalso');
    await pagina.waitForSelector('#bgModalGoogle', { timeout: 15000 });
    ok(/María <b>Pérez<\/b>/.test(await pagina.textContent('#bgModalGoogle')) && !(await pagina.$('#bgModalGoogle b')), 'persona nueva: pide apodo, teléfono y código; el nombre de Google se muestra como texto (sin inyectar HTML)');
    await pagina.locator('#bgModalGoogle .card').screenshot({ path: path.join(__dirname, 'captura-registro-google.png') });
    await pagina.fill('#gApodo', 'Tiburona_7'); await pagina.fill('#gTel', '53 5777 1234'); await pagina.fill('#gCodigo', 'gg-1');
    await pagina.click('#bgModalGoogle >> text=Crear cuenta');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 30000 });
    const u = Object.values(get('users') || {}).find(x => x.email === 'maria.cuba@gmail.com') || {};
    ok(u.nombre === 'María bPérez/b' && u.googleSub === '5550001' && u.apodo === 'Tiburona_7' && u.referidoPorUid === 'BG_ag' && u.creditoPromo === 100, 'cuenta creada con Google (nombre limpio de < >), ligada al agente y con su bono → entra a la app');
    ok(!(await pagina.$('#bgModalGoogle')), 'el formulario se cierra al entrar');

    // Registro normal con la casilla de Cloudflare
    await pagina.evaluate(() => { try { localStorage.removeItem('bg_sesion'); } catch (e) {} });
    await pagina.reload();
    await registrar(pagina, 1, 'TT-1');
    await pagina.waitForSelector('#bgTurnstile:not([hidden]) #casillaFalsa', { timeout: 15000 });
    await pagina.waitForTimeout(200);
    await pagina.click('#btnRegistro');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 30000 });
    ok(turnstileRecibido.includes('humano-ok') && Object.values(get('users')).some(x => x.email === 'web1@nauta.cu'), 'registro normal: la casilla de Cloudflare se envía y el servidor la comprueba');
    ok(await pagina.evaluate(() => window.__turnReset >= 1), 'después de usarla, la casilla se reinicia (cada verificación vale una sola vez)');
    ok(!pagina.erroresJs.length, 'sin errores de JavaScript → ' + (pagina.erroresJs.join(' | ') || 'ninguno'));
    await pagina.close();

    // ---- Google y Cloudflare bloqueados (conexión de Cuba) ----
    pagina = await nuevaPagina(navegador, { externosCaidos: true });
    await pagina.waitForTimeout(2500);
    ok(await pagina.isHidden('#bgGoogleZona'), 'si Google no carga, no aparece un botón roto');
    await registrar(pagina, 2, 'TT-2');
    ok(await pagina.isHidden('#bgTurnstile'), 'si Cloudflare no carga, no aparece una casilla rota');
    await pagina.click('#btnRegistro');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 30000 });
    ok(Object.values(get('users')).some(x => x.email === 'web2@nauta.cu'), 'y la persona se registra igual con su código de invitación');
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
    if (pagina) await pagina.screenshot({ path: path.join(__dirname, 'fallo-google.png') });
  }
  await navegador.close();
  process.exit(0);
})();
