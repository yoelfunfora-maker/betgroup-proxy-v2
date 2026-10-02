// Prueba en navegador real (Etapa 8): apodo, ranking, saldo promo en el boleto,
// premios del CEO y fotos sin metadatos.
// Ejecutar: NODE_PATH=$(npm root -g) node test/etapa8.e2e.js  (necesita Playwright instalado)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const fetchReal = global.fetch;
const { get, set, arrancar, ok } = require('./simulador');
const { semanaAnterior } = require('../lib/ranking');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3991, PUERTO_WEB = 8097;
const API_REAL = 'https://betgroup-proxy-v2-8vqj.onrender.com';
const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, email, pw, datos) {
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado(pw, '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, ...datos });
}
usuario('BG_ceo', 'ceo@x.com', 'ceo-clave-1', { nombre: 'Jefe', rol: 'superadmin', rolLevel: 3, telefono: '5350000000' });
usuario('BG_m1', 'm1@x.com', 'm1-clave-1', { nombre: 'Miembro Uno', rol: 'member', rolLevel: 1, telefono: '5355511111', creditoReal: 500, creditoPromo: 200 });
usuario('BG_t', 't@x.com', 'clave-1234', { nombre: 'Tercero', apodo: 'Pantera', rol: 'member', rolLevel: 1 });
set('apodos/pantera', { uid: 'BG_t' });
set('codigosAcceso/E8-CODIGO', { code: 'E8-CODIGO', createdBy: 'BG_ceo', usado: false, rol: 'member' });
set('config', { minBet: 100, maxBet: 500, maxPago: 2500, dailyLossLimit: 5000 });
// Semana pasada: Pantera depositó 1500 y apostó 800 (perdidos) → 1.º y consuelo.
const sp = semanaAnterior();
set('solicitudesDeposito/S1', { userId: 'BG_t', monto: 1500, estado: 'aprobado', aprobadoEn: sp.desde + 3600000, nombre: 'x' });
set('apuestas/BG_t/a1', { monto: 800, cuota: 2, estado: 'perdida', pago: 0, fecha: sp.desde + 7200000, tipoSaldo: 'real', saldoCampo: 'creditoReal' });

const futuro = new Date(Date.now() + 86400000).toISOString();
const evento = { events: [{ id: '777', date: futuro, status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
  { homeAway: 'home', team: { displayName: 'Equipo A' }, score: '0' }, { homeAway: 'away', team: { displayName: 'Equipo B' }, score: '0' }] }] }], leagues: [{ name: 'Premier League' }] };
arrancar({
  puerto: PUERTO_API,
  env: { ODDS_API_KEYS: 'k1', ALLOWED_ORIGINS: `http://127.0.0.1:${PUERTO_WEB}` },
  espn: (p) => (p.includes('soccer/eng.1') ? JSON.stringify(evento) : null),
  axiosGet: async (url) => {
    if (url.includes('the-odds-api')) return { data: [{ home_team: 'Equipo A', away_team: 'Equipo B', commence_time: futuro, bookmakers: [{ markets: [{ key: 'h2h', outcomes: [{ name: 'Equipo A', price: 1.3 }, { name: 'Equipo B', price: 2.5 }, { name: 'Draw', price: 3.2 }] }] }] }], headers: {} };
    throw new Error('sin red');
  }
});
http.createServer((req, res) => {
  const f = path.join(FRONT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.woff2') ? 'font/woff2' : 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
}).listen(PUERTO_WEB);

(async () => {
  const navegador = await chromium.launch();
  const pagina = await navegador.newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 1 });
  const erroresJs = [];
  pagina.on('pageerror', (e) => erroresJs.push(e.message));
  pagina.on('dialog', (d) => d.accept());
  await pagina.route('**/*', async (ruta) => {
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
  const salir = async () => { await pagina.evaluate(() => { try { localStorage.removeItem('bg_sesion'); } catch (e) {} }); await pagina.reload(); };

  try {
    await new Promise(r => setTimeout(r, 1500));
    await pagina.goto(`http://127.0.0.1:${PUERTO_WEB}/index.html`);
    await pagina.evaluate(() => { localStorage.setItem('betgroup_terms_accepted', 'true'); });
    await pagina.reload();

    // ---- Registro con apodo ----
    await pagina.click('text=Crear cuenta');
    await pagina.fill('#rNombre', 'Lucía Fernández');
    await pagina.fill('#rApodo', 'LuciaGol');
    await pagina.fill('#rTel', '5351234567');
    await pagina.fill('#rEmail', 'lucia@nauta.cu');
    await pagina.fill('#rPass', 'clave-segura-1');
    await pagina.fill('#rPass2', 'clave-segura-1');
    await pagina.fill('#rCodigo', 'E8-CODIGO');
    await pagina.click('#btnRegistro');
    await pagina.waitForFunction(() => /nombre real/.test(document.getElementById('registerStatusMsg').textContent), null, { timeout: 30000 });
    ok(true, 'el servidor rechaza un apodo con el nombre real y lo explica en el formulario');
    await pagina.fill('#rApodo', 'Centella_7');
    await pagina.click('#btnRegistro');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 30000 });
    await pagina.waitForFunction(() => document.getElementById('uApodo').textContent === 'Centella_7', null, { timeout: 15000 });
    ok(true, 'registro con apodo: entra y ve su apodo en la tarjeta');
    await pagina.waitForFunction(() => /Te faltan/.test(document.getElementById('rankingYo').textContent), null, { timeout: 15000 });
    ok(true, 'la tarjeta del ranking le dice cuánto le falta depositar para participar');
    await pagina.locator('#rankingCard').screenshot({ path: path.join(__dirname, 'captura-ranking.png') });
    await salir();

    // ---- Usuario antiguo sin apodo: lo elige desde el ranking ----
    await pagina.fill('#loginTel', '5355511111');
    await pagina.fill('#loginPass', 'm1-clave-1');
    await pagina.click('text=Iniciar Sesión');
    await pagina.waitForSelector('#apodoNuevo', { timeout: 20000 });
    await pagina.fill('#apodoNuevo', 'Rayo99');
    await pagina.click('#rankingApodo >> text=Guardar');
    await pagina.waitForFunction(() => document.getElementById('uApodo').textContent === 'Rayo99', null, { timeout: 15000 });
    ok(get('users/BG_m1/apodo') === 'Rayo99', 'usuario antiguo elige su apodo desde la tarjeta del ranking');

    // ---- Boleto con crédito promocional ----
    await pagina.waitForSelector('.bg-cuota', { timeout: 20000 });
    await pagina.click('.bg-cuota >> nth=0'); // Local 1.30
    ok(await pagina.isVisible('#bsSaldoElegir'), 'con crédito promo, el boleto deja elegir Real o Promo');
    await pagina.click('#bsSaldoPromo');
    ok(await pagina.isDisabled('#confirmBetBtn') && /cuota mínima es 1.50/.test(await pagina.textContent('#bsRiskMsg')), 'promo a cuota 1.30: botón bloqueado con aviso de cuota mínima');
    await pagina.click('.bg-cerrar');
    await pagina.click('.bg-cuota:has-text("2.50")');
    await pagina.click('#bsSaldoPromo');
    ok(/150 CR a tu saldo real/.test(await pagina.textContent('#potReturn')), 'el boleto explica que con promo cobra solo la ganancia (150) en saldo real');
    await pagina.locator('#betslip .bg-boleto').screenshot({ path: path.join(__dirname, 'captura-boleto-promo.png') });
    await pagina.click('#confirmBetBtn');
    await pagina.waitForFunction(() => document.getElementById('toast').textContent.includes('Apuesta registrada'), null, { timeout: 15000 });
    const ap = Object.values(get('apuestas/BG_m1') || {})[0] || {};
    ok(ap.tipoSaldo === 'promo' && ap.reglaPromo === 'ganancia-a-real' && get('users/BG_m1/creditoPromo') === 100 && get('users/BG_m1/creditoReal') === 500,
      'apuesta promo registrada: 200 → 100 promo, el saldo real intacto');

    // ---- Fotos: el móvil quita los metadatos antes de enviar ----
    const limpia = await pagina.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 40; c.height = 30; c.getContext('2d').fillRect(0, 0, 40, 30);
      const base = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/jpeg'))).arrayBuffer());
      const exif = new TextEncoder().encode('Exif\0\0GPS 23.1N 82.3W iPhone');
      const app1 = new Uint8Array([0xFF, 0xE1, 0, exif.length + 2, ...exif]);
      const conExif = new Uint8Array([...base.slice(0, 2), ...app1, ...base.slice(2)]);
      const salida = new Uint8Array(await (await limpiarFoto(new File([conExif], 'f.jpg', { type: 'image/jpeg' }))).arrayBuffer());
      const texto = Array.from(salida).map(b => String.fromCharCode(b)).join('');
      return { teniaGps: Array.from(conExif).map(b => String.fromCharCode(b)).join('').includes('GPS'), tieneGps: texto.includes('GPS') || texto.includes('iPhone'), esJpeg: salida[0] === 0xFF && salida[1] === 0xD8 };
    });
    ok(limpia.teniaGps && !limpia.tieneGps && limpia.esJpeg, 'la foto sale del móvil sin GPS ni modelo de teléfono');
    await salir();

    // ---- CEO: premios de la semana pasada ----
    await pagina.click('#btnEmail');
    await pagina.fill('#loginEmail', 'ceo@x.com');
    await pagina.fill('#loginPass', 'ceo-clave-1');
    await pagina.click('text=Iniciar Sesión');
    await pagina.waitForSelector('#tabCEO', { state: 'visible', timeout: 20000 });
    await pagina.evaluate(() => goPanel('ceo'));
    await pagina.waitForSelector('#ceoRankingTabla >> text=Entregar premios', { timeout: 20000 });
    const tabla = await pagina.textContent('#ceoRankingTabla');
    ok(/Pantera/.test(tabla) && /500 promo/.test(tabla) && /consuelo/.test(tabla), 'el CEO ve los ganadores de la semana pasada con sus premios');
    await pagina.locator('#ceoRankingCard').screenshot({ path: path.join(__dirname, 'captura-ranking-ceo.png') });
    await pagina.click('#ceoRankingTabla >> text=Entregar premios');
    await pagina.waitForSelector('#ceoRankingTabla >> text=Premios entregados', { timeout: 15000 });
    ok(get('users/BG_t/creditoPromo') === 600, 'al pulsar «Entregar», Pantera recibe 500 + 100 de consuelo en promo → ' + get('users/BG_t/creditoPromo'));
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
    await pagina.screenshot({ path: path.join(__dirname, 'fallo-etapa8.png') });
  }
  console.log('Errores JS en la página:', erroresJs.length ? erroresJs.slice(0, 8) : 'ninguno');
  await navegador.close();
  process.exit(0);
})();
