// Prueba en navegador real de los fallos que "siempre" afectaban al login:
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
const { set, arrancar, ok } = require('./simulador');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3983, PUERTO_WEB = 8096;
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

(async () => {
  const navegador = await chromium.launch();
  const contexto = await navegador.newContext({ viewport: { width: 400, height: 860 } });
  const pagina = await contexto.newPage();
  const erroresJs = [];
  pagina.on('pageerror', (e) => erroresJs.push(e.message));
  pagina.on('dialog', (d) => d.accept());
  // Estado del "servidor" simulado: fallosOpciones = cuántas veces más responde 503 (reiniciando).
  const red = { fallosOpciones: 0, caido: false, lecturasUsers: 0 };
  await pagina.route('**/*', async (ruta) => {
    const req = ruta.request(); const url = req.url();
    if (url.startsWith('https://accounts.google.com/gsi/client')) return ruta.fulfill({ status: 200, contentType: 'text/javascript', body: GSI });
    if (url.startsWith('https://challenges.cloudflare.com/turnstile/')) return ruta.fulfill({ status: 200, contentType: 'text/javascript', body: TURN });
    if (url.startsWith(API_REAL)) {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization', 'access-control-allow-methods': 'GET, POST' };
      if (req.method() === 'OPTIONS') return ruta.fulfill({ status: 204, headers: cors });
      if (red.caido) return ruta.abort('connectionrefused');
      if (url.includes('/api/auth/opciones') && red.fallosOpciones > 0) { red.fallosOpciones--; return ruta.fulfill({ status: 503, headers: cors, body: 'Service Unavailable' }); }
      if (url.endsWith('/api/db')) { try { const b = JSON.parse(req.postData() || '{}'); if (b.ruta === 'users' && !b.consulta) red.lecturasUsers++; } catch (e) {} }
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
    red.fallosOpciones = 1e9; // en la primera carga no responde: así no queda nada recordado
    await pagina.goto(`http://127.0.0.1:${PUERTO_WEB}/index.html`);
    await pagina.evaluate(() => { localStorage.clear(); localStorage.setItem('betgroup_terms_accepted', 'true'); ['jugador', 'agente', 'supervisor', 'ceo'].forEach(t => localStorage.setItem('bg_tutorial_' + t, '1')); });

    // ---- 1. Servidor reiniciándose: las 2 primeras preguntas fallan (503) ----
    red.fallosOpciones = 2;
    await pagina.reload();
    await pagina.waitForSelector('#bgGoogleZona:not([hidden]) #botonGoogleFalso', { timeout: 30000 });
    ok(red.fallosOpciones === 0, 'con el servidor reiniciándose (2 respuestas 503), el botón de Google aparece igual en cuanto responde');
    ok(!!(await pagina.$('#casillaFalsa')), 'y también la casilla de Cloudflare');

    // ---- 2. Al día siguiente el servidor está caído del todo al abrir la web ----
    red.caido = true;
    await pagina.reload();
    await pagina.waitForSelector('#bgGoogleZona:not([hidden]) #botonGoogleFalso', { timeout: 15000 });
    ok(await pagina.evaluate(() => window.__gsiCliente) === CLIENT_ID, 'con el servidor caído, "Continuar con Google" sale al instante con lo recordado de la última vez');
    red.caido = false;

    // ---- 3. Pestaña de agente visitada muchas veces: una sola escucha de usuarios ----
    await pagina.evaluate(() => { try { localStorage.removeItem('bg_sesion'); } catch (e) {} });
    await pagina.reload();
    await pagina.click('#btnEmail');
    await pagina.fill('#loginEmail', 'ag@x.com');
    await pagina.fill('#loginPass', 'clave-1234');
    await pagina.click('text=Iniciar Sesión');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 20000 });
    await pagina.evaluate(() => { if (typeof cerrarTutorial === 'function') cerrarTutorial(); });
    for (let i = 0; i < 6; i++) { await pagina.evaluate(() => goPanel('sub')); await pagina.waitForTimeout(300); await pagina.evaluate(() => goPanel('home')); }
    await pagina.evaluate(() => goPanel('sub'));
    await pagina.waitForTimeout(1500);
    red.lecturasUsers = 0;
    await pagina.waitForTimeout(41000); // dos rondas de escucha (cada 20 s)
    ok(red.lecturasUsers <= 6, `tras entrar 7 veces en la pestaña de agente, en 41 s hay ${red.lecturasUsers} lecturas de la tabla de usuarios (antes se multiplicaban: 7 escuchas × 2 rondas, más sus lecturas extra)`);

    // ---- 4. Con la app en segundo plano no se consulta ----
    await pagina.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); });
    red.lecturasUsers = 0;
    await pagina.waitForTimeout(21000);
    ok(red.lecturasUsers === 0, 'con la app en segundo plano (pantalla apagada) no se consulta nada → ' + red.lecturasUsers);
    ok(!erroresJs.length, 'sin errores de JavaScript → ' + (erroresJs.slice(0, 3).join(' | ') || 'ninguno'));
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
    await pagina.screenshot({ path: path.join(__dirname, 'fallo-resiliencia.png') });
  }
  await navegador.close();
  process.exit(0);
})();
