// Prueba en navegador real (Playwright): la web + este servidor con Firebase simulado.
// Ejecutar: NODE_PATH=$(npm root -g) node test/navegador.e2e.js  (necesita Playwright instalado)
// Prueba de extremo a extremo: la web real (index.html + bg-api.js) en Chromium
// contra servidor.js con Firebase simulado.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const fetchReal = global.fetch;
const { get, set, arrancar, ok } = require('./simulador');

// Carpeta del frontend (repo privado betgroup-frontend). Se puede cambiar con BG_FRONTEND.
const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3996, PUERTO_WEB = 8099;
const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, email, pw, datos) {
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado(pw, '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, ...datos });
}
usuario('BG_ceo', 'ceo@x.com', 'ceo-clave-1', { nombre: 'Jefe', rol: 'superadmin', rolLevel: 3, telefono: '5350000000' });
usuario('BG_sub', 'sub@x.com', 'sub-clave-1', { nombre: 'Sub', rol: 'subadmin', rolLevel: 2, codigoInvitacion: 'BGSUB1', telefono: '5355500001' });
usuario('BG_m1', 'm1@x.com', 'm1-clave-1', { nombre: 'Miembro Uno', rol: 'member', rolLevel: 1, referidoPorUid: 'BG_sub', telefono: '5355511111', creditoReal: 500 });
set('config', { minBet: 100, maxBet: 500, maxPago: 2500, dailyLossLimit: 5000 });

const futuro = new Date(Date.now() + 86400000).toISOString();
const evento = { events: [{ id: '777', date: futuro, status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
  { homeAway: 'home', team: { displayName: 'Equipo A' }, score: '0' }, { homeAway: 'away', team: { displayName: 'Equipo B' }, score: '0' }] }] }], leagues: [{ name: 'Liga Prueba' }] };
arrancar({
  puerto: PUERTO_API,
  env: { ODDS_API_KEYS: 'k1', ALLOWED_ORIGINS: `http://127.0.0.1:${PUERTO_WEB}` },
  espn: (p) => (p.includes('soccer/eng.1') ? JSON.stringify(evento) : null),
  axiosGet: async (url) => {
    if (url.includes('the-odds-api')) return { data: [{ home_team: 'Equipo A', away_team: 'Equipo B', bookmakers: [{ markets: [{ key: 'h2h', outcomes: [{ name: 'Equipo A', price: 1.8 }, { name: 'Equipo B', price: 2.1 }, { name: 'Draw', price: 3.2 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 2.5, price: 1.9 }, { name: 'Under', point: 2.5, price: 1.95 }] }] }] }] };
    throw new Error('sin red');
  }
});

// Servidor estático de la web
http.createServer((req, res) => {
  const f = path.join(FRONT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.woff2') ? 'font/woff2' : f.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
}).listen(PUERTO_WEB);

(async () => {
  const navegador = await chromium.launch();
  // Tamaño de móvil: así la usan los usuarios
  const pagina = await navegador.newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 1 });
  const prohibidas = [];
  const erroresJs = [];
  pagina.on('pageerror', (e) => erroresJs.push(e.message));
  pagina.on('dialog', (d) => d.accept());
  await pagina.route('**/*', async (ruta) => {
    const req = ruta.request();
    const url = req.url();
    if (/firebaseio\.com|googleapis\.com|gstatic\.com|telegram\.org/.test(url)) { prohibidas.push(url); return ruta.abort(); }
    if (url.startsWith('https://betgroup-proxy-v2-8vqj.onrender.com')) {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization', 'access-control-allow-methods': 'GET, POST' };
      if (req.method() === 'OPTIONS') return ruta.fulfill({ status: 204, headers: cors });
      const r = await fetchReal(url.replace('https://betgroup-proxy-v2-8vqj.onrender.com', `http://127.0.0.1:${PUERTO_API}`), {
        method: req.method(), headers: { 'content-type': 'application/json', ...(req.headers().authorization ? { authorization: req.headers().authorization } : {}) },
        body: req.method() === 'GET' ? undefined : req.postData()
      });
      return ruta.fulfill({ status: r.status, headers: { ...cors, 'content-type': 'application/json' }, body: await r.text() });
    }
    if (url.startsWith(`http://127.0.0.1:${PUERTO_WEB}`)) return ruta.continue();
    return ruta.abort(); // fuentes, CDN, sonidos: no hacen falta para la prueba
  });

  try {
    await new Promise(r => setTimeout(r, 1500)); // precalentado de partidos en el servidor
    await pagina.goto(`http://127.0.0.1:${PUERTO_WEB}/index.html`);
    await pagina.evaluate(() => { localStorage.setItem('betgroup_terms_accepted', 'true'); ['jugador', 'agente', 'supervisor', 'ceo'].forEach(t => localStorage.setItem('bg_tutorial_' + t, '1')); }); // tutoriales ya vistos (se prueban en tutorial.e2e.js)
    await pagina.reload();

    // ---- Miembro entra con su TELÉFONO (pestaña por defecto) ----
    await pagina.fill('#loginTel', '5355511111');
    await pagina.fill('#loginPass', 'm1-clave-1');
    await pagina.click('text=Iniciar Sesión');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 15000 });
    ok(true, 'miembro entra con su teléfono (antes la pestaña Teléfono no funcionaba)');
    await pagina.waitForFunction(() => document.getElementById('hReal') && document.getElementById('hReal').innerText === '500', null, { timeout: 15000 });
    ok(true, 'la cabecera muestra su saldo real: 500');

    await pagina.waitForSelector('.bg-cuota', { timeout: 20000 });
    await pagina.screenshot({ path: path.join(__dirname, 'captura-inicio.png') });
    const cuotaPantalla = await pagina.textContent('.bg-cuota >> nth=0 >> b');
    ok(cuotaPantalla.trim() === '1.80', 'los partidos y cuotas salen del servidor (cuota local ' + cuotaPantalla.trim() + ')');
    await pagina.click('.bg-cuota >> nth=0');
    ok((await pagina.textContent('#confirmBetBtn')).trim() === 'Apostar 100 CR', 'el boleto propone 100 CR y el botón dice la cifra');
    await pagina.fill('#betInput', '5000');
    ok(await pagina.isDisabled('#confirmBetBtn') && (await pagina.textContent('#bsRiskMsg')).includes('saldo'), 'monto mayor que el saldo: botón bloqueado con aviso');
    await pagina.screenshot({ path: path.join(__dirname, 'captura-boleto.png') });
    await pagina.fill('#betInput', '100');
    await pagina.click('#confirmBetBtn');
    await pagina.waitForFunction(() => document.getElementById('toast').textContent.includes('Apuesta registrada'), null, { timeout: 15000 });
    const apuestas = Object.values(get('apuestas/BG_m1') || {});
    ok(apuestas.length === 1 && apuestas[0].cuota === 1.8 && apuestas[0].estado === 'pendiente' && get('users/BG_m1/creditoReal') === 400,
      'apuesta desde la web: registrada en el servidor y saldo 500 → ' + get('users/BG_m1/creditoReal'));

    // Mercado de más/menos goles desde la web
    ok(!(await pagina.isVisible('.bg-cuota:has-text("Más de 2.5")')), 'los mercados extra empiezan ocultos');
    await pagina.click('.bg-mas');
    ok(await pagina.isVisible('.bg-cuota:has-text("Más de 2.5")') && (await pagina.textContent('.bg-mas')).includes('Ocultar'), 'al pulsar "+ mercados" aparecen (antes el botón no hacía nada visible)');
    await pagina.click('.bg-cuota:has-text("Más de 2.5")');
    ok((await pagina.textContent('#bsSelection')).trim() === 'Más de 2.5', 'el boleto muestra "Más de 2.5" (antes decía "Empate")');
    await pagina.fill('#betInput', '100');
    await pagina.click('#confirmBetBtn');
    await pagina.waitForFunction(() => document.getElementById('toast').textContent.includes('×1.9'), null, { timeout: 15000 });
    ok(Object.values(get('apuestas/BG_m1')).some(a => a.tipo === 'Over 2.5' && a.cuota === 1.9), 'apuesta Over 2.5 desde la web a la cuota del servidor');

    const ataque = await pagina.evaluate(() => db.ref('users/BG_m1/creditoReal').set(99999).then(() => 'escrito', (e) => e.message));
    ok(ataque !== 'escrito' && get('users/BG_m1/creditoReal') === 300, 'intento de subirse el saldo desde la consola del navegador: rechazado (' + ataque + ')');
    const ataque2 = await pagina.evaluate(() => {
      const k = Object.keys(window.__x || {});
      return db.ref('apuestas/BG_m1').once('value').then(s => { const id = Object.keys(s.val())[0]; return db.ref('apuestas/BG_m1/' + id + '/estado').set('ganada'); }).then(() => 'escrito', (e) => e.message);
    });
    ok(ataque2 !== 'escrito', 'intento de marcar su apuesta como ganada: rechazado (' + ataque2 + ')');
    const sol = await pagina.evaluate(() => db.ref('solicitudesDeposito/DEPWEB1').set({ id: 'DEPWEB1', userId: 'BG_m1', nombre: 'x', telefono: 'x', banco: 'B', titular: 'T', cuenta: '1', telBanco: '5', monto: 500, moneda: 'CUP', nota: '', fotoUrl: 'https://i.ibb.co/x.jpg', estado: 'pendiente', creadoEn: Date.now() }).then(() => 'ok', e => e.message));
    ok(sol === 'ok', 'el miembro crea una solicitud de depósito desde la web');

    await pagina.evaluate(() => doLogout());
    await pagina.waitForSelector('#loginScreen', { state: 'visible' });
    ok(!(await pagina.evaluate(() => localStorage.getItem('bg_sesion'))), 'al salir no queda la sesión guardada');

    // ---- CEO entra con su EMAIL ----
    await pagina.click('#btnEmail');
    await pagina.fill('#loginEmail', 'ceo@x.com');
    await pagina.fill('#loginPass', 'ceo-clave-1');
    await pagina.click('text=Iniciar Sesión');
    await pagina.waitForSelector('#tabCEO', { state: 'visible', timeout: 15000 });
    ok(true, 'CEO entra con su email y ve su pestaña');

    await pagina.evaluate(() => goPanel('director'));
    await pagina.waitForSelector('text=Aprobar y acreditar', { timeout: 15000 });
    await pagina.click('#solicitudesList >> text=Aprobar y acreditar');
    await pagina.waitForFunction(() => document.getElementById('toast').textContent.includes('Depósito aprobado'), null, { timeout: 15000 });
    ok(get('users/BG_m1/creditoReal') === 800 && get('solicitudesDeposito/DEPWEB1/estado') === 'aprobado', 'CEO aprueba el depósito (mínimo 500) desde su panel: saldo 300 → ' + get('users/BG_m1/creditoReal'));

    await pagina.evaluate(() => goPanel('ceo'));
    await pagina.waitForFunction(() => document.querySelectorAll('#adjUser option').length > 1, null, { timeout: 15000 });
    await pagina.selectOption('#adjUser', 'BG_m1');
    await pagina.selectOption('#adjTipo', 'promo');
    await pagina.fill('#adjMonto', '50');
    await pagina.fill('#adjMotivo', 'bono de prueba');
    await pagina.click('text=Aplicar ajuste');
    await pagina.waitForFunction(() => document.getElementById('toast').textContent.includes('Ajuste aplicado'), null, { timeout: 15000 });
    ok(get('users/BG_m1/creditoPromo') === 50, 'CEO ajusta saldo promo desde su panel → ' + get('users/BG_m1/creditoPromo'));

    await pagina.click('text=Liquidar ahora');
    await pagina.waitForFunction(() => document.getElementById('toast').textContent.includes('apuestas liquidadas'), null, { timeout: 15000 });
    ok(true, 'botón "Liquidar ahora" del CEO responde');

    await pagina.reload();
    await pagina.waitForSelector('#tabCEO', { state: 'visible', timeout: 15000 });
    ok(true, 'al recargar la página la sesión se restaura sola');
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
    await pagina.screenshot({ path: path.join(__dirname, 'fallo-navegador.png') });
  }
  ok(prohibidas.length === 0, 'la web no contacta Firebase, Google ni Telegram directamente (' + prohibidas.length + ' intentos)' + (prohibidas.length ? ': ' + prohibidas.slice(0, 3).join(' ') : ''));
  console.log('Errores JS en la página:', erroresJs.length ? erroresJs.slice(0, 8) : 'ninguno');
  await navegador.close();
  process.exit(0);
})();
