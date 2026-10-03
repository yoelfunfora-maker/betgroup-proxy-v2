// Prueba en navegador real: campana de avisos (contador, bandeja, leer uno / todos, destino).
// (Arranque copiado de resiliencia.e2e.js.)
// Antes:
//  1. Servidor reiniciándose (cada despliegue) o despertando: el botón de Google y la casilla de
//     Cloudflare no aparecían nunca porque la web solo preguntaba una vez.
//  2. Servidor caído del todo al abrir: con lo recordado de la última vez, Google sale igual.
//  3. Entrar varias veces en la pestaña de agente multiplicaba las descargas de la tabla de usuarios.
// Ejecutar: NODE_PATH=$(npm root -g) node test/resiliencia.e2e.js  (necesita Playwright instalado)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const fetchReal = global.fetch;
const { get, set, arrancar, ok } = require('./simulador');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3977, PUERTO_WEB = 8090;
const API_REAL = 'https://betgroup-proxy-v2-8vqj.onrender.com';
const CLIENT_ID = '999-prueba.apps.googleusercontent.com';
const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
set('credenciales_acceso/ag-x-com', { email: 'ag@x.com', uid: 'BG_ag', salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
set('users/BG_ag', { uid: 'BG_ag', email: 'ag@x.com', activo: true, nombre: 'Agente Uno', apodo: 'AgenteUno', rol: 'subadmin', rolLevel: 2, telefono: '5352211111', codigoInvitacion: 'BGAG01', creditoReal: 0, creditoPromo: 0, googleSub: '123' });
set('config', { minBet: 100, maxBet: 500 });
arrancar({ puerto: PUERTO_API, env: { ODDS_API_KEYS: '', ALLOWED_ORIGINS: `http://127.0.0.1:${PUERTO_WEB}`, GOOGLE_CLIENT_ID: CLIENT_ID, TURNSTILE_SITE_KEY: '0x4AAAweb', TURNSTILE_SECRET: 'secreto-web' } });

const GSI = `window.google={accounts:{id:{initialize:function(o){window.__gsiCliente=o.client_id;},prompt:function(){},cancel:function(){},
  renderButton:function(el){var b=document.createElement('button');b.id='botonGoogleFalso';b.textContent='Continuar con Google';el.appendChild(b);}}}};`;
const TURN = `window.turnstile={render:function(el,o){var d=document.createElement('div');d.id='casillaFalsa';el.appendChild(d);return 'w1';},reset:function(){}};`;

const TIPOS = { '.css': 'text/css', '.webp': 'image/webp', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
http.createServer((req, res) => {
  const f = path.join(FRONT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(f)] || 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
}).listen(PUERTO_WEB);

const ahora = Date.now();
set('notificaciones/BG_ag/N0', { tipo: 'bienvenida', titulo: 'Bienvenido a BetGroup', texto: 'Hola', url: '#home', creadoEn: ahora - 864e5 * 2, leida: true });
set('notificaciones/BG_ag/N1', { tipo: 'ganada', titulo: '¡Ganaste 290 CR!', texto: 'Arsenal vs Leeds (2-1). <img src=x onerror=alert(1)>', url: '#historial', creadoEn: ahora - 60e3, leida: false });
set('notificaciones/BG_ag/N2', { tipo: 'apuesta', titulo: 'Apuesta registrada', texto: 'Arsenal vs Leeds · Local · 100 CR', url: '#historial', creadoEn: ahora - 3600e3, leida: false });
set('avisosGenerales/G1', { tipo: 'ofertas', titulo: 'Cuotas de la tarde', texto: 'Napoli vs Frosinone 1 ×1.40', url: '#home', creadoEn: ahora - 1800e3 });

(async () => {
  const navegador = await chromium.launch();
  const pagina = await navegador.newPage({ viewport: { width: 400, height: 860 } });
  const erroresJs = [];
  pagina.on('pageerror', (e) => erroresJs.push(e.message));
  pagina.on('dialog', (d) => d.accept());
  await pagina.route('**/*', async (ruta) => {
    const req = ruta.request(); const url = req.url();
    if (url.startsWith('https://accounts.google.com/gsi/client')) return ruta.fulfill({ status: 200, contentType: 'text/javascript', body: GSI });
    if (url.startsWith('https://challenges.cloudflare.com/turnstile/')) return ruta.fulfill({ status: 200, contentType: 'text/javascript', body: TURN });
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
  try {
    await pagina.goto(`http://127.0.0.1:${PUERTO_WEB}/index.html`);
    await pagina.evaluate(() => { localStorage.setItem('betgroup_terms_accepted', 'true'); ['jugador', 'agente', 'supervisor', 'ceo'].forEach(t => localStorage.setItem('bg_tutorial_' + t, '1')); });
    await pagina.reload();
    await pagina.click('#btnEmail');
    await pagina.fill('#loginEmail', 'ag@x.com');
    await pagina.fill('#loginPass', 'clave-1234');
    await pagina.click('text=Iniciar Sesión');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 20000 });
    await pagina.evaluate(() => { if (typeof cerrarTutorial === 'function') cerrarTutorial(); });
    // ---- Contador de la campana ----
    await pagina.waitForSelector('#avisosBadge:not([hidden])', { timeout: 15000 });
    ok(await pagina.textContent('#avisosBadge') === '3', 'la campana muestra 3 avisos sin leer (2 personales + 1 para todos)');
    await pagina.locator('.bg-barra').screenshot({ path: path.join(__dirname, 'captura-campana.png') });
    // ---- Bandeja ----
    await pagina.click('#btnAvisos');
    await pagina.waitForSelector('#bgAvisosLista .bg-aviso-item', { timeout: 10000 });
    const items = await pagina.$$eval('#bgAvisosLista .bg-aviso-item', (d) => d.map(x => x.textContent));
    ok(items.length === 4 && /Ganaste 290 CR/.test(items[0]), 'la bandeja lista los avisos, el más nuevo arriba → ' + items.length + ' avisos');
    ok(items.some(t => /Cuotas de la tarde/.test(t) && /para todos/.test(t)), 'las ofertas del día salen marcadas "para todos"');
    ok(!(await pagina.$('#bgAvisosLista b script, #bgAvisosLista img')), 'el texto de los avisos no puede inyectar HTML');
    await pagina.locator('.bg-avisos').screenshot({ path: path.join(__dirname, 'captura-bandeja.png') });
    // ---- Tocar un aviso: se marca como leído y lleva a su pantalla ----
    await pagina.click('#bgAvisosLista .bg-aviso-item >> nth=0');
    await pagina.waitForTimeout(800);
    ok(!(await pagina.$('#bgAvisosCapa')), 'al tocar "¡Ganaste…!" se cierra la bandeja y lleva al historial');
    ok(await pagina.textContent('#avisosBadge') === '2', 'y el contador baja a 2');
    ok(get('notificaciones/BG_ag/N1/leida') === true, 'el servidor lo guarda como leído');
    // ---- Marcar todas ----
    await pagina.click('#btnAvisos');
    await pagina.waitForSelector('#bgAvisosTodas');
    await pagina.click('#bgAvisosTodas');
    await pagina.waitForTimeout(800);
    ok(await pagina.isHidden('#avisosBadge'), '"Marcar todas como leídas" deja la campana sin número');
    ok(get('avisosLeidos/BG_ag/G1') === true && get('notificaciones/BG_ag/N2/leida') === true, 'el servidor guarda todos como leídos (también el aviso para todos)');
    ok(!(await pagina.$('#bgAvisosLista .no-leido')), 'ya no queda ninguno resaltado');
    await pagina.click('#bgAvisosCerrar');
    // ---- Aviso nuevo mientras usa la app ----
    set('notificaciones/BG_ag/N4', { tipo: 'deposito', titulo: 'Depósito aprobado', texto: 'Se acreditaron 500 CUP', url: '#pagos', creadoEn: Date.now(), leida: false });
    await pagina.evaluate(() => refrescarAvisos());
    await pagina.waitForSelector('#avisosBadge:not([hidden])', { timeout: 5000 });
    ok(await pagina.textContent('#avisosBadge') === '1', 'un aviso nuevo vuelve a encender la campana');
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
  }
  await navegador.close();
  process.exit(0);
})();
