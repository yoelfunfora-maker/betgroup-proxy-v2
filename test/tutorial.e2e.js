// Prueba en navegador real: tutorial guiado por rango (jugador, agente, supervisor, CEO).
// Ejecutar: NODE_PATH=$(npm root -g) node test/tutorial.e2e.js  (necesita Playwright instalado)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const fetchReal = global.fetch;
const { set, arrancar, ok } = require('./simulador');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3985, PUERTO_WEB = 8096;
const API_REAL = 'https://betgroup-proxy-v2-8vqj.onrender.com';
const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, email, datos) {
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, ...datos });
}
usuario('BG_j', 'j@x.com', { nombre: 'Jugador', apodo: 'Jugon', rol: 'member', rolLevel: 1, telefono: '5352100001' });
usuario('BG_a', 'a@x.com', { nombre: 'Agente', apodo: 'Agen', rol: 'subadmin', rolLevel: 2, telefono: '5352100002', codigoInvitacion: 'BGAG0001' });
usuario('BG_s', 's@x.com', { nombre: 'Supervisor', apodo: 'Super', rol: 'director', rolLevel: 2.8, telefono: '5352100003' });
usuario('BG_c', 'c@x.com', { nombre: 'Jefe', apodo: 'Jefe', rol: 'superadmin', rolLevel: 3, telefono: '5352100004' });
set('config', { minBet: 100, maxBet: 500 });
arrancar({ puerto: PUERTO_API, env: { ODDS_API_KEYS: '', ALLOWED_ORIGINS: `http://127.0.0.1:${PUERTO_WEB}` } });

const TIPOS = { '.webp': 'image/webp', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
http.createServer((req, res) => {
  const f = path.join(FRONT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(f)] || 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
}).listen(PUERTO_WEB);

(async () => {
  const navegador = await chromium.launch();
  const pagina = await navegador.newPage({ viewport: { width: 400, height: 860 } });
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
  const entrar = async (correo) => {
    await pagina.evaluate(() => { try { localStorage.removeItem('bg_sesion'); } catch (e) {} });
    await pagina.reload();
    await pagina.click('#btnEmail');
    await pagina.fill('#loginEmail', correo);
    await pagina.fill('#loginPass', 'clave-1234');
    await pagina.click('text=Iniciar Sesión');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 20000 });
  };
  const paso = async () => (await pagina.textContent('#bgTut .bg-tut-paso')).trim();
  // Recorre todo el tutorial con "Siguiente" y devuelve los títulos vistos.
  const recorrer = async () => {
    const titulos = [];
    for (let i = 0; i < 12 && await pagina.$('#bgTut'); i++) {
      await pagina.waitForTimeout(200); // la zona se ilumina tras ~60 ms
      titulos.push((await pagina.textContent('#bgTut .bg-tut-t')).trim());
      const luz = await pagina.evaluate(() => { const r = document.querySelector('.bg-tut-luz').getBoundingClientRect(); return r.width > 10 && r.height > 10; });
      if (!luz) titulos.push('(sin zona iluminada)');
      await pagina.click('#bgTut .bg-tut-sig');
      await pagina.waitForTimeout(150);
    }
    return titulos;
  };

  try {
    await pagina.goto(`http://127.0.0.1:${PUERTO_WEB}/index.html`);
    await pagina.evaluate(() => { localStorage.setItem('betgroup_terms_accepted', 'true'); });

    // ---- Jugador: sale solo la primera vez ----
    await entrar('j@x.com');
    await pagina.waitForSelector('#bgTut', { timeout: 8000 });
    ok(/Cómo jugar · 1 de \d/.test(await paso()), 'el jugador ve su tutorial al entrar por primera vez → ' + await paso());
    await pagina.screenshot({ path: path.join(__dirname, 'captura-tutorial.png') });
    await pagina.click('#bgTut .bg-tut-sig'); await pagina.waitForTimeout(150);
    ok(/2 de/.test(await paso()), '"Siguiente" avanza al paso 2');
    await pagina.click('#bgTut .bg-tut-atras'); await pagina.waitForTimeout(150);
    ok(/1 de/.test(await paso()), '"Atrás" vuelve al paso 1');
    const tj = await recorrer();
    ok(tj.length >= 6 && !tj.includes('(sin zona iluminada)'), `recorre todos los pasos del jugador iluminando cada zona → ${tj.join(' / ')}`);
    ok(!(await pagina.$('#bgTut')), 'al terminar se cierra');
    await entrar('j@x.com');
    await pagina.waitForTimeout(3000);
    ok(!(await pagina.$('#bgTut')), 'no vuelve a salir solo la segunda vez');
    await pagina.click('#btnTutorial');
    await pagina.waitForSelector('#bgTut', { timeout: 4000 });
    ok(true, 'el botón "?" lo repite cuando quiera');
    await pagina.click('#bgTut .bg-tut-saltar');
    ok(!(await pagina.$('#bgTut')), '"Saltar" lo cierra');

    // ---- Agente, supervisor y CEO: su propio recorrido en su panel ----
    for (const [correo, titulo, minimo] of [['a@x.com', 'Tu panel de agente', 5], ['s@x.com', 'Tu panel de supervisor', 2], ['c@x.com', 'Panel del CEO', 5]]) {
      await entrar(correo);
      await pagina.waitForSelector('#bgTut', { timeout: 8000 });
      ok((await paso()).startsWith(titulo), `${correo}: arranca "${titulo}"`);
      const t = await recorrer();
      ok(t.length >= minimo && !t.includes('(sin zona iluminada)'), `${correo}: ${t.length} pasos, cada uno con su zona → ${t.join(' / ')}`);
      await pagina.click('#btnTutorial');
      const menu = await pagina.textContent('#bgTutMenu');
      ok(menu.includes(titulo) && menu.includes('Cómo jugar'), `${correo}: el "?" ofrece su tutorial y el del jugador`);
      await pagina.click('#bgTutMenu >> text=Cómo jugar');
      await pagina.waitForSelector('#bgTut', { timeout: 4000 });
      await pagina.click('#bgTut .bg-tut-saltar');
    }
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
    await pagina.screenshot({ path: path.join(__dirname, 'fallo-tutorial.png') });
  }
  console.log('Errores JS en la página:', erroresJs.length ? erroresJs.slice(0, 8) : 'ninguno');
  await navegador.close();
  process.exit(0);
})();
