// Prueba en navegador real (Etapa 11): comisiones semanales en los paneles de CEO, agente y supervisor.
// Ejecutar: NODE_PATH=$(npm root -g) node test/comisiones.e2e.js  (necesita Playwright instalado)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const fetchReal = global.fetch;
const { get, set, arrancar, ok } = require('./simulador');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3985, PUERTO_WEB = 8093;
const API_REAL = 'https://betgroup-proxy-v2-8vqj.onrender.com';
const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, email, datos) {
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, ...datos });
}
const { semanaAnterior } = require('../lib/ranking');
usuario('BG_ceo', 'ceo@x.com', { nombre: 'Jefe', rol: 'superadmin', rolLevel: 3 });
usuario('BG_SUP', 'sup@x.com', { nombre: 'Sara Supervisora', apodo: 'Sara', rol: 'director', rolLevel: 2.8 });
usuario('BG_AG', 'ag@x.com', { nombre: 'Andrés Agente', apodo: 'Andres', rol: 'subadmin', rolLevel: 2, codigoInvitacion: 'BGAG0001', supervisorUid: 'BG_SUP' });
const tp = semanaAnterior().desde + 86400000;
for (let i = 1; i <= 6; i++) {
  usuario(`BG_j${i}`, `j${i}@x.com`, { nombre: `Jugador ${i}`, rol: 'member', rolLevel: 1, referidoPorUid: 'BG_AG' });
  set(`apuestas/BG_j${i}/a`, { monto: 1000, cuota: 2, estado: 'perdida', pago: 0, fecha: tp, liquidadaEn: tp, tipoSaldo: 'real' });
}
set('apuestas/BG_j1/b', { monto: 1000, cuota: 2, estado: 'ganada', pago: 2000, fecha: tp, liquidadaEn: tp, tipoSaldo: 'real' }); // ganancia red = 6000 − 1000 = 5000
// Sara conserva un cliente propio: esta semana pierde 1.000 → como agente cobra 5 % = 50.
usuario('BG_sc', 'sc@x.com', { nombre: 'Cliente de Sara', rol: 'member', rolLevel: 1, referidoPorUid: 'BG_SUP' });
set('apuestas/BG_sc/d', { monto: 1000, cuota: 2, estado: 'perdida', pago: 0, fecha: Date.now(), liquidadaEn: Date.now(), tipoSaldo: 'real' });
set('apuestas/BG_j2/c', { monto: 300, cuota: 2, estado: 'perdida', pago: 0, fecha: Date.now(), liquidadaEn: Date.now(), tipoSaldo: 'real' }); // esta semana
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
  const apostadoHoy = async () => {
    await pagina.evaluate(() => goPanel('sub'));
    await pagina.waitForTimeout(2500);
    return (await pagina.textContent('#subRec')).trim();
  };

  try {
    await pagina.goto(`http://127.0.0.1:${PUERTO_WEB}/index.html`);
    await pagina.evaluate(() => { localStorage.setItem('betgroup_terms_accepted', 'true'); ['jugador', 'agente', 'supervisor', 'ceo'].forEach(t => localStorage.setItem('bg_tutorial_' + t, '1')); }); // tutoriales ya vistos (se prueban en tutorial.e2e.js)

    // ---- CEO: tabla de la semana pasada y cierre ----
    await entrar('ceo@x.com');
    await pagina.evaluate(() => goPanel('ceo'));
    await pagina.waitForSelector('#ceoComTabla >> text=Cerrar semana', { timeout: 20000 });
    const tabla = await pagina.textContent('#ceoComTabla');
    ok(/Andres/.test(tabla) && /10 %/.test(tabla) && /500 CR/.test(tabla) && /250 CR/.test(tabla) && /4\.?250 CR/.test(tabla),
      'el CEO ve: red de Andrés gana 5.000 → agente 10 % = 500, supervisora 5 % = 250, casa 4.250');
    await pagina.locator('#ceoComisionesCard').screenshot({ path: path.join(__dirname, 'captura-comisiones-ceo.png') });
    await pagina.click('#ceoComTabla >> text=Cerrar semana');
    await pagina.waitForSelector('#ceoComTabla >> text=Semana cerrada', { timeout: 15000 });
    ok(Object.values(get('comisionesSemana') || {})[0].cerrada === true, 'el CEO cierra la semana desde su panel');
    ok((await pagina.$$eval('#ceoComAgente option', os => os.map(o => o.textContent).join('|'))).includes('Andres'), 'la lista de agentes para asignar supervisor está cargada');

    // ---- Agente: su comisión de esta semana ----
    await entrar('ag@x.com');
    ok(/Agente/.test(await pagina.textContent('#tabSub')), 'la pestaña se llama "Agente"');
    await pagina.evaluate(() => goPanel('sub'));
    await pagina.waitForFunction(() => /Tu porcentaje/.test(document.getElementById('subComisionDatos').textContent), null, { timeout: 15000 });
    const mia = await pagina.textContent('#subComisionDatos');
    ok(/300 CR/.test(mia) && /5 %/.test(mia) && /15 CR/.test(mia), 'el agente ve su semana: red gana 300, 5 %, comisión estimada 15 CR');
    await pagina.locator('#subComisionSemana').screenshot({ path: path.join(__dirname, 'captura-comision-agente.png') });

    // ---- Supervisora: sus agentes y su 5 % ----
    await entrar('sup@x.com');
    await pagina.evaluate(() => goPanel('director'));
    await pagina.waitForSelector('#supComisionCard >> text=Andres', { timeout: 15000 });
    await pagina.waitForFunction(() => /Tus jugadores propios/.test(document.getElementById('supComisionDatos').textContent), null, { timeout: 15000 });
    const sup = await pagina.textContent('#supComisionDatos');
    ok(/Por tu equipo \(5 %\)15 CR/.test(sup.replace(/\s+/g, ' ').replace(/ CR/g, ' CR').replace(/\) /g, ')')) || (/15 CR/.test(sup) && /50 CR/.test(sup)),
      'la supervisora ve su 5 % de equipo (15) y lo que cobra como agente por su cliente propio (50)');
    ok(/65 CR/.test(sup), 'su total estimado suma las dos cosas: 65 CR');
    await pagina.locator('#supComisionCard').screenshot({ path: path.join(__dirname, 'captura-comision-supervisor.png') });
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
    await pagina.screenshot({ path: path.join(__dirname, 'fallo-referidos.png') });
  }
  console.log('Errores JS en la página:', erroresJs.length ? erroresJs.slice(0, 8) : 'ninguno');
  await navegador.close();
  process.exit(0);
})();
