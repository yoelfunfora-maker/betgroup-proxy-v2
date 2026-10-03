// Prueba en navegador real: historial de apuestas (antiguas, anuladas, incompletas).
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
const { set, arrancar, ok } = require('./simulador');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3978, PUERTO_WEB = 8091;
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

set('users/BG_ag/creditoReal', 300);
const ahora = Date.now();
set('apuestas/BG_ag/A0', { estado: 'anulada', pagado: true, liquidadaEn: ahora, liquidadaPor: 'auto-sin-resultado' }); // registro viejo incompleto
set('apuestas/BG_ag/A1', { eventoNombre: 'Genoa vs Fiorentina', tipo: 'Local', monto: 150, cuota: 2.1, estado: 'anulada', fecha: ahora - 9 * 864e5 });
set('apuestas/BG_ag/A2', { evento: 'Arsenal vs Leeds', seleccion: 'Visitante', amount: 100, odds: 3.4, estado: 'pendiente', fecha: ahora - 3600e3 }); // formato antiguo
set('apuestas/BG_ag/A3', { eventoNombre: 'Napoli vs Frosinone', tipo: 'Local', monto: 200, cuota: 1.5, estado: 'ganada', fecha: ahora - 7200e3 });

// 25 apuestas del sistema antiguo con claves de letras (en Firebase van DESPUÉS de las nuevas "-O…").
for (let k = 0; k < 25; k++) set(`apuestas/BG_ag/bet_${String(k).padStart(3, '0')}`, { estado: 'anulada', pagado: true, liquidadaEn: ahora - 30 * 864e5 });
// Apuesta NUEVA (clave como las de Firebase: empieza por "-"), la más reciente de todas.
set('apuestas/BG_ag/-OzNueva001', { eventoNombre: 'Real Madrid vs Villarreal', tipo: 'Local', monto: 120, cuota: 1.6, estado: 'pendiente', fecha: ahora - 60e3 });

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
    await pagina.evaluate(() => loadHistory());
    await pagina.waitForFunction(() => /Genoa/.test(document.getElementById('histList').textContent), null, { timeout: 15000 });
    const txt = await pagina.textContent('#histList');
    const tarjetas = await pagina.$$eval('#histList > div', d => d.length);
    ok(!/undefined|NaN/.test(txt), 'el historial ya no muestra "undefined" en ningún sitio');
    ok(tarjetas === 4, 'las 26 apuestas antiguas incompletas (sin partido ni monto) no se muestran: se ven solo las 4 completas → ' + tarjetas);
    ok(/Anulada: se te devolvieron 150 CR/.test(txt), 'una anulada dice que se devolvió el dinero (antes decía "Esperando resultado")');
    ok(/Arsenal vs Leeds/.test(txt) && /Visitante/.test(txt) && /100 CR/.test(txt), 'las apuestas con el formato antiguo se leen bien');
    ok(/Napoli vs Frosinone/.test(txt), 'las normales siguen igual');
    ok(/Real Madrid vs Villarreal/.test(txt), 'la apuesta recién hecha aparece aunque haya muchas antiguas (antes quedaba fuera de "las últimas 20")');
    ok(txt.indexOf('Real Madrid') < txt.indexOf('Napoli'), 'y aparece la primera (la más reciente arriba)');
    await pagina.locator('#histList').screenshot({ path: require('path').join(__dirname, 'captura-historial.png') });
    ok(!erroresJs.length, 'sin errores de JavaScript → ' + (erroresJs.slice(0, 3).join(' | ') || 'ninguno'));
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
  }
  await navegador.close();
  process.exit(0);
})();
