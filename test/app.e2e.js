// Prueba en navegador real (Etapa 10): app instalable, presentación y avisos.
// Ejecutar: NODE_PATH=$(npm root -g) node test/app.e2e.js  (necesita Playwright instalado)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const fetchReal = global.fetch;
const { get, set, arrancar, ok } = require('./simulador');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3989, PUERTO_WEB = 8095;
const API_REAL = 'https://betgroup-proxy-v2-8vqj.onrender.com';
const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
set('credenciales_acceso/m1-x-com', { email: 'm1@x.com', uid: 'BG_m1', salt: '0a0b0c0d', hash: legado('m1-clave-1', '0a0b0c0d') });
set('users/BG_m1', { uid: 'BG_m1', email: 'm1@x.com', activo: true, nombre: 'Miembro Uno', apodo: 'Rayo', rol: 'member', rolLevel: 1, telefono: '5355511111', creditoReal: 500, creditoPromo: 0 });
set('apodos/rayo', { uid: 'BG_m1' });
set('apuestas/BG_m1/b1', { eventoNombre: 'Equipo A vs Equipo B', monto: 100, cuota: 2, estado: 'pendiente', fecha: Date.now(), tipoSaldo: 'real', saldoCampo: 'creditoReal' });
set('config', { minBet: 100, maxBet: 500 });
arrancar({ puerto: PUERTO_API, env: { ODDS_API_KEYS: '', ALLOWED_ORIGINS: `http://127.0.0.1:${PUERTO_WEB}` } });

const TIPOS = { '.webp': 'image/webp', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/manifest+json', '.svg': 'image/svg+xml' };
http.createServer((req, res) => {
  const f = path.join(FRONT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(f)] || 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
}).listen(PUERTO_WEB);

(async () => {
  const navegador = await chromium.launch();
  const contexto = await navegador.newContext({ viewport: { width: 400, height: 860 } });
  // Chromium sin pantalla deniega las notificaciones por defecto; un móvil nuevo está en "preguntar".
  // Se simula ese estado "preguntar" y la respuesta "Permitir" del usuario.
  await contexto.addInitScript(() => {
    let estado = 'default';
    try {
      Object.defineProperty(Notification, 'permission', { get: () => estado, configurable: true });
      Notification.requestPermission = async () => { estado = 'granted'; return estado; };
      // Chromium sin pantalla no dibuja notificaciones: se anota lo que la app pide mostrar.
      window.__notis = [];
      ServiceWorkerRegistration.prototype.showNotification = async function (t, o) { window.__notis.push(t + ' | ' + ((o && o.body) || '') + ' | ' + ((o && o.icon) || '')); };
    } catch (e) { /* sin Notification */ }
  });
  const pagina = await contexto.newPage();
  const erroresJs = [];
  pagina.on('pageerror', (e) => erroresJs.push(e.message));
  await contexto.route('**/*', async (ruta) => {
    const req = ruta.request();
    const url = req.url();
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
    // ---- Presentación ----
    await pagina.goto(`http://127.0.0.1:${PUERTO_WEB}/index.html`);
    ok(await pagina.isVisible('#bgIntro'), 'al abrir se ve la presentación');
    await pagina.waitForTimeout(2900);
    ok(!(await pagina.$('#bgIntro')), 'la presentación desaparece sola (~2,5 s)');
    await pagina.evaluate(() => { localStorage.setItem('betgroup_terms_accepted', 'true'); });
    await pagina.reload();
    ok(!(await pagina.$('#bgIntro')), 'no se repite al recargar en la misma sesión');

    // ---- App instalable ----
    const manifiesto = await pagina.evaluate(async () => (await fetch(document.querySelector('link[rel=manifest]').href)).json());
    const tam = (manifiesto.icons || []).map(i => i.sizes + '/' + (i.purpose || 'any')).join(' ');
    ok(manifiesto.display === 'standalone' && /192x192/.test(tam) && /512x512\/maskable/.test(tam) && manifiesto.start_url && manifiesto.id,
      'manifiesto de app correcto: pantalla completa, iconos 192/512 y adaptable → ' + tam);
    const iconosOk = await pagina.evaluate(async (lista) => (await Promise.all(lista.map(s => fetch(s).then(r => r.ok)))).every(Boolean), (manifiesto.icons || []).map(i => i.src));
    ok(iconosOk, 'todos los iconos del manifiesto existen');
    const sw = await pagina.evaluate(async () => { const r = await navigator.serviceWorker.ready; return r.active && r.active.scriptURL; });
    ok(/\/sw\.js$/.test(sw || ''), 'el trabajador en segundo plano (sw.js) queda activo → ' + sw);

    // ---- Sin conexión: la app abre igual ----
    await pagina.reload(); // ya controlada por sw.js
    await contexto.setOffline(true);
    await pagina.reload();
    ok(await pagina.isVisible('#loginScreen'), 'sin conexión la app abre con la última copia (no la pantalla del dinosaurio)');
    await contexto.setOffline(false);
    await pagina.reload();

    // ---- Avisos: tarjeta en vez de pedir permiso de golpe ----
    await pagina.fill('#loginTel', '5355511111');
    await pagina.fill('#loginPass', 'm1-clave-1');
    await pagina.click('text=Iniciar Sesión');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 20000 });
    await pagina.waitForFunction(() => sessionStorage.getItem('bg_disp_enviado') === '1', null, { timeout: 15000 });
    const usos = get('dispositivosUso') || {};
    ok(Object.values(usos).some(g => g && g.BG_m1) && !JSON.stringify(usos).includes(await pagina.evaluate(() => localStorage.getItem('bg_disp'))),
      'antifraude: el móvil envía su identificador al entrar y el servidor lo guarda cifrado');
    // Primero sale el tutorial; la tarjeta de avisos espera a que se cierre.
    await pagina.waitForSelector('#bgTut', { timeout: 8000 });
    ok(!(await pagina.$('#bgInvitarAvisos')), 'mientras está el tutorial no se le pide nada más');
    await pagina.click('#bgTut .bg-tut-saltar');
    await pagina.waitForSelector('#bgInvitarAvisos', { timeout: 15000 });
    await pagina.waitForTimeout(3500); // que se vaya el "Bienvenido" para la captura
    ok(true, 'tras entrar aparece "¿Te avisamos?" (explica para qué antes de pedir permiso)');
    await pagina.locator('#bgInvitarAvisos').screenshot({ path: path.join(__dirname, 'captura-avisos.png') });
    await contexto.grantPermissions(['notifications'], { origin: `http://127.0.0.1:${PUERTO_WEB}` });
    await pagina.click('#bgAvisosSi');
    ok(!(await pagina.$('#bgInvitarAvisos')), 'al pulsar "Activar" la tarjeta se cierra');

    // ---- Una apuesta se resuelve → aviso ----
    set('apuestas/BG_m1/b1', { ...get('apuestas/BG_m1/b1'), estado: 'ganada', pago: 200 });
    await pagina.evaluate(() => { window.__bgEspera = Date.now(); });
    await pagina.waitForFunction(() => /Ganaste/.test(document.getElementById('toast').textContent), null, { timeout: 30000 });
    ok(true, 'cuando se resuelve una apuesta ganada, aparece "✅ ¡Ganaste!"');
    const notis = await pagina.evaluate(() => window.__notis || []);
    ok(notis.some(n => /Ganaste/.test(n) && /\+200 CR/.test(n) && /iconos\/icono-192\.png/.test(n)), 'y también en la barra de notificaciones del móvil, con el icono de la app → ' + notis.join(' / '));
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
    await pagina.screenshot({ path: path.join(__dirname, 'fallo-app.png') });
  }
  console.log('Errores JS en la página:', erroresJs.length ? erroresJs.slice(0, 8) : 'ninguno');
  await navegador.close();
  process.exit(0);
})();
