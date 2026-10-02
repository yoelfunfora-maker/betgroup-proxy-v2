// Prueba en navegador real: código de invitación → referido → ganancias del subadmin.
// Ejecutar: NODE_PATH=$(npm root -g) node test/referidos.e2e.js  (necesita Playwright instalado)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const fetchReal = global.fetch;
const { get, set, arrancar, ok } = require('./simulador');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3987, PUERTO_WEB = 8094;
const API_REAL = 'https://betgroup-proxy-v2-8vqj.onrender.com';
const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, email, datos) {
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, ...datos });
}
usuario('BG_S', 's@x.com', { nombre: 'Íñigo Suárez', apodo: 'Jefe_Sur', rol: 'subadmin', rolLevel: 2, telefono: '5352000001', codigoInvitacion: 'BGFIJO01' });
usuario('BG_T', 't@x.com', { nombre: 'Tomás Otro', apodo: 'Jefe_Norte', rol: 'subadmin', rolLevel: 2, telefono: '5352000002', codigoInvitacion: 'BGFIJO02' });
usuario('BG_L', 'l@x.com', { nombre: 'Luis Antiguo', apodo: 'Veterano', rol: 'member', rolLevel: 1, telefono: '5352000003', referidoPor: 'BGFIJO01' });
set('apodos/jefe_sur', { uid: 'BG_S' }); set('apodos/jefe_norte', { uid: 'BG_T' }); set('apodos/veterano', { uid: 'BG_L' });
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
    await pagina.evaluate(() => { localStorage.setItem('betgroup_terms_accepted', 'true'); });

    // ---- 1. El subadmin genera un código desde SU panel (con nombre con tilde y Ñ) ----
    await entrar('s@x.com');
    await pagina.evaluate(() => goPanel('sub'));
    await pagina.fill('#subCodeQty', '1');
    await pagina.click('button:has-text("Generar") >> visible=true');
    await pagina.waitForSelector('#subCodesGenerated code', { timeout: 15000 }).catch(async () => {
      console.log('TOAST:', await pagina.textContent('#toast'), 'CODIGOS:', JSON.stringify(get('codigosAcceso')));
      throw new Error('no se generó el código');
    });
    const codigo = (await pagina.textContent('#subCodesGenerated code')).trim();
    ok(/^[A-Z]{2}-\d{8}-\d{6}$/.test(codigo) && get(`codigosAcceso/${codigo}/generadoPor`) === 'BG_S',
      'el subadmin genera un código desde su panel y queda a SU nombre → ' + codigo);

    // ---- 2. Una persona nueva se registra con ese código ----
    await pagina.evaluate(() => { try { localStorage.removeItem('bg_sesion'); } catch (e) {} });
    await pagina.reload();
    await pagina.click('text=Crear cuenta');
    await pagina.fill('#rNombre', 'Nuevo Cliente');
    await pagina.fill('#rApodo', 'Tiburon_9');
    await pagina.fill('#rTel', '5352000099');
    await pagina.fill('#rEmail', 'nuevo@nauta.cu');
    await pagina.fill('#rPass', 'clave-segura-1');
    await pagina.fill('#rPass2', 'clave-segura-1');
    await pagina.fill('#rCodigo', codigo.toLowerCase());
    await pagina.click('#btnRegistro');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 30000 });
    const nuevo = Object.values(get('users') || {}).find(u => u.email === 'nuevo@nauta.cu') || {};
    ok(nuevo.referidoPorUid === 'BG_S' && nuevo.referidoPor === codigo, 'el nuevo usuario queda ligado al subadmin que creó el código');
    ok(get(`codigosAcceso/${codigo}/usado`) === true && get(`codigosAcceso/${codigo}/usadoPor`) === nuevo.uid, 'el código queda gastado (no sirve para otra persona)');

    // ---- 3. Ambos miembros apuestan hoy: el antiguo (código fijo) y el nuevo (código generado) ----
    const hoy = Date.now();
    set('apuestas/BG_L/x1', { eventoNombre: 'A vs B', monto: 100, cuota: 2, estado: 'perdida', fecha: hoy, tipoSaldo: 'real' });
    set(`apuestas/${nuevo.uid}/y1`, { eventoNombre: 'C vs D', monto: 200, cuota: 2, estado: 'perdida', fecha: hoy, tipoSaldo: 'real' });

    // ---- 4. Las ganancias del subadmin cuentan a LOS DOS ----
    await entrar('s@x.com');
    const recS = await apostadoHoy();
    ok(recS === '300.00', 'el panel del subadmin suma lo apostado por el miembro antiguo (100) y el nuevo (200) → ' + recS + ' (antes solo contaba 100)');
    const comS = (await pagina.textContent('#subCom')).trim();
    ok(Number(comS) > 0, 'y calcula su comisión sobre ese total → ' + comS);
    await pagina.evaluate(() => cargarSolicitudesSubadmin());
    await pagina.waitForTimeout(1500);

    // ---- 5. Otro subadmin NO se lleva nada de esos miembros ----
    await entrar('t@x.com');
    const recT = await apostadoHoy();
    ok(recT === '0.00', 'otro subadmin no ve ni cobra esos miembros → ' + recT);
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
    await pagina.screenshot({ path: path.join(__dirname, 'fallo-referidos.png') });
  }
  console.log('Errores JS en la página:', erroresJs.length ? erroresJs.slice(0, 8) : 'ninguno');
  await navegador.close();
  process.exit(0);
})();
