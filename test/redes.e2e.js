// Prueba en navegador real: cada panel ve SOLO su gente (agente, supervisor, CEO).
// Ejecutar: NODE_PATH=$(npm root -g) node test/redes.e2e.js  (necesita Playwright instalado)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const fetchReal = global.fetch;
const { get, set, arrancar, ok } = require('./simulador');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3981, PUERTO_WEB = 8098;
const API_REAL = 'https://betgroup-proxy-v2-8vqj.onrender.com';
const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, email, datos) {
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, ...datos });
}

// CEO sin código fijo, con un jugador propio (código creado por el CEO).
usuario('BG_c', 'c@x.com', { nombre: 'Jefe', apodo: 'Jefe', rol: 'superadmin', rolLevel: 3, telefono: '5352200001' });
set('codigosAcceso/CEO-1', { codigo: 'CEO-1', generadoPor: 'BG_c', usado: true, rol: 'member' });
usuario('BG_cp', 'cp@x.com', { nombre: 'Cliente Del Ceo', apodo: 'DelCeo', rol: 'member', rolLevel: 1, telefono: '5352200002', referidoPor: 'CEO-1' });
// Supervisora con el agente Alfredo asignado; Alfredo tiene 2 jugadores.
usuario('BG_s', 's@x.com', { nombre: 'Sara Supervisora', apodo: 'Sara', rol: 'director', rolLevel: 2.8, telefono: '5352200003' });
usuario('BG_alf', 'alf@x.com', { nombre: 'Alfredo Agente', apodo: 'Alfredo', rol: 'subadmin', rolLevel: 2, telefono: '5352200004', codigoInvitacion: 'BGALF01', supervisorUid: 'BG_s' });
usuario('BG_p1', 'p1@x.com', { nombre: 'Pedro Uno', apodo: 'PedroUno', rol: 'member', rolLevel: 1, telefono: '5352200005', referidoPorUid: 'BG_alf', creditoReal: 300 });
usuario('BG_p2', 'p2@x.com', { nombre: 'Pablo Dos', apodo: 'PabloDos', rol: 'member', rolLevel: 1, telefono: '5352200006', referidoPor: 'BGALF01' });
// Otro agente que NO es de la supervisora, con su jugador.
usuario('BG_otro', 'otro@x.com', { nombre: 'Otro Agente', apodo: 'OtroAg', rol: 'subadmin', rolLevel: 2, telefono: '5352200007', codigoInvitacion: 'BGOTRO1' });
usuario('BG_q1', 'q1@x.com', { nombre: 'Quique Ajeno', apodo: 'QuiqueAj', rol: 'member', rolLevel: 1, telefono: '5352200008', referidoPorUid: 'BG_otro' });
// Ese otro agente también tiene un código generado y YA USADO (antes la tabla de referidos de
// cualquier agente/supervisor/CEO mostraba todos los códigos usados de la casa).
set('codigosAcceso/OTRO-9', { codigo: 'OTRO-9', generadoPor: 'BG_otro', generadoPorNombre: 'Otro Agente', usado: true, rol: 'member' });
usuario('BG_q2', 'q2@x.com', { nombre: 'Quino Codigo', apodo: 'QuinoCod', rol: 'member', rolLevel: 1, telefono: '5352200009', referidoPor: 'OTRO-9' });
const sol = (id, uid, nombre, monto) => set(`solicitudesDeposito/${id}`, { id, userId: uid, nombre, telefono: '53', monto, moneda: 'CUP', estado: 'pendiente', creadoEn: Date.now(), fotoUrl: '' });
sol('S1', 'BG_p1', 'Pedro Uno', 600); sol('S2', 'BG_q1', 'Quique Ajeno', 700); sol('S3', 'BG_cp', 'Cliente Del Ceo', 800);
set('config', { minBet: 100, maxBet: 500 });
arrancar({ puerto: PUERTO_API, env: { ODDS_API_KEYS: '', ALLOWED_ORIGINS: `http://127.0.0.1:${PUERTO_WEB}` } });

const TIPOS = { '.css': 'text/css', '.webp': 'image/webp', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
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
    await pagina.evaluate(() => { if (typeof cerrarTutorial === 'function') cerrarTutorial(); });
  };

  // Ningún emoji visible: texto de la página, opciones de listas y avisos.
  const EMOJI = /(?:[\u{1F000}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF\u2300-\u23FF])/u;
  const emojisVisibles = async (panel) => {
    if (panel) { await pagina.evaluate((p) => goPanel(p), panel); await pagina.waitForTimeout(2500); }
    return pagina.evaluate((re) => {
      const r = new RegExp(re, 'u');
      const textos = [document.body.innerText, ...Array.from(document.querySelectorAll('option')).map(o => o.textContent)];
      return textos.filter(t => r.test(t)).map(t => (t.match(new RegExp(re, 'gu')) || []).join('')).join('');
    }, EMOJI.source);
  };
  const sinEmojis = [];
  try {
    await pagina.goto(`http://127.0.0.1:${PUERTO_WEB}/index.html`);
    await pagina.evaluate(() => { localStorage.setItem('betgroup_terms_accepted', 'true'); ['jugador', 'agente', 'supervisor', 'ceo'].forEach(t => localStorage.setItem('bg_tutorial_' + t, '1')); });

    await pagina.reload(); await pagina.waitForTimeout(3200);
    sinEmojis.push(['pantalla de acceso', await emojisVisibles()]);
    await pagina.evaluate(() => showReg()); sinEmojis.push(['crear cuenta', await emojisVisibles()]);

    // ---- CEO en su panel de AGENTE: solo su propio jugador ----
    await entrar('c@x.com');
    await pagina.evaluate(() => goPanel('sub'));
    await pagina.waitForFunction(() => /Cliente Del Ceo|Sin miembros|Sin solicitudes/.test(document.getElementById('subSolicitudesPendientes').textContent), null, { timeout: 15000 });
    await pagina.waitForTimeout(1500);
    const solCeo = await pagina.textContent('#subSolicitudesPendientes');
    ok(/Cliente Del Ceo/.test(solCeo) && !/Pedro Uno|Quique Ajeno/.test(solCeo), 'CEO en su panel de agente: ve el depósito de SU jugador y no los de Alfredo ni de otros → ' + solCeo.replace(/\s+/g, ' ').slice(0, 80));
    const opciones = await pagina.$$eval('#subMember option', (o) => o.map(x => x.textContent).join(' | '));
    ok(!/Pedro|Pablo|Quique/.test(opciones), 'y en "Recargar a un jugador" no salen los jugadores de otros agentes → ' + opciones);
    await pagina.waitForFunction(() => /Cliente Del Ceo/.test(document.getElementById('dynamicReferralsBody').textContent), null, { timeout: 15000 });
    await pagina.waitForTimeout(3000); // la tabla antes "volvía" a pintar a los de otros unos segundos después
    const tablaCeo = await pagina.textContent('#dynamicReferralsBody');
    ok(/Cliente Del Ceo/.test(tablaCeo) && !/Quino Codigo|Pedro Uno|Pablo Dos|Quique Ajeno/.test(tablaCeo), 'CEO: la tabla de referidos muestra solo a SU jugador y no vuelve a aparecer la gente de otros agentes → ' + tablaCeo.replace(/\s+/g, ' ').slice(0, 90));

    for (const p of ['home', 'pagos', 'retiros', 'sub', 'director', 'ceo']) sinEmojis.push(['CEO ' + p, await emojisVisibles(p)]);

    // ---- Supervisora: Mi red con Alfredo y sus jugadores; depósitos solo de su red ----
    await entrar('s@x.com');
    await pagina.evaluate(() => goPanel('director'));
    await pagina.waitForSelector('#supRedCard:not([hidden]) .bg-red-grupo', { timeout: 15000 });
    const red = await pagina.textContent('#supRedCard');
    ok(/Agente Alfredo/.test(red) && /2 jugadores/.test(red) && !/OtroAg|Otro Agente/.test(red), 'supervisora: "Mi red" muestra a su agente Alfredo con sus 2 jugadores, y no a otros agentes');
    await pagina.click('#supRedCard summary');
    const red2 = await pagina.textContent('#supRedCard');
    ok(/PedroUno/.test(red2) && /PabloDos/.test(red2) && !/QuiqueAj/.test(red2), 'al tocar el agente ve la lista de sus jugadores');
    await pagina.fill('#supRedBuscar', 'pablo');
    ok(!/PedroUno/.test(await pagina.textContent('#supRedLista')) && /PabloDos/.test(await pagina.textContent('#supRedLista')), 'el buscador filtra por apodo o nombre');
    await pagina.fill('#supRedBuscar', '');
    await pagina.locator('#supRedCard').screenshot({ path: path.join(__dirname, 'captura-mi-red.png') });
    await pagina.waitForFunction(() => !/Cargando|loader/.test(document.getElementById('solicitudesList').innerHTML), null, { timeout: 15000 });
    const solSup = await pagina.textContent('#solicitudesList');
    ok(/Pedro Uno/.test(solSup) && !/Quique Ajeno|Cliente Del Ceo/.test(solSup), 'supervisora: solo ve los depósitos de su red (antes veía los de toda la casa)');

    for (const p of ['home', 'sub', 'director']) sinEmojis.push(['supervisora ' + p, await emojisVisibles(p)]);

    // ---- Alfredo (agente): solo sus jugadores ----
    await entrar('alf@x.com');
    await pagina.evaluate(() => goPanel('sub'));
    await pagina.waitForFunction(() => /Pedro Uno|Sin solicitudes/.test(document.getElementById('subSolicitudesPendientes').textContent), null, { timeout: 15000 });
    const solAlf = await pagina.textContent('#subSolicitudesPendientes');
    ok(/Pedro Uno/.test(solAlf) && !/Quique Ajeno|Cliente Del Ceo/.test(solAlf), 'Alfredo: solo los depósitos de sus jugadores');
    await pagina.waitForFunction(() => /Pedro Uno/.test(document.getElementById('dynamicReferralsBody').textContent), null, { timeout: 15000 });
    await pagina.waitForTimeout(2000);
    const tablaAlf = await pagina.textContent('#dynamicReferralsBody');
    ok(/Pedro Uno/.test(tablaAlf) && /Pablo Dos/.test(tablaAlf) && !/Quino Codigo|Cliente Del Ceo|Quique Ajeno/.test(tablaAlf), 'Alfredo: su tabla de referidos tiene a sus 2 jugadores y a nadie más');

    for (const p of ['home', 'pagos', 'retiros', 'sub']) sinEmojis.push(['agente ' + p, await emojisVisibles(p)]);
    const conEmoji = sinEmojis.filter(([, e]) => e);
    ok(!conEmoji.length, 'ningún emoji visible en ' + sinEmojis.length + ' pantallas (CEO, supervisora, agente)' + (conEmoji.length ? ' → ' + conEmoji.map(x => x.join(': ')).join(' | ') : ''));
    const iconos = await pagina.evaluate(async () => { await document.fonts.ready; const i = document.querySelector('.tab i'); return { n: document.querySelectorAll('i.fa-solid, i.fas').length, fuente: /Font Awesome/.test(getComputedStyle(i).fontFamily) && getComputedStyle(i, '::before').content !== 'none', css: Array.from(document.styleSheets).some(x => /\/fuentes\/fa\/css\/all\.min\.css$/.test(x.href || '')) }; });
    ok(iconos.n > 20 && iconos.fuente && iconos.css, 'los iconos profesionales salen de la propia web (sin servidores externos): ' + JSON.stringify(iconos));
    await pagina.evaluate(() => toast('✅ Depósito aprobado', 'green', 5000));
    await pagina.waitForTimeout(200);
    ok(await pagina.$('#toast i.fa-circle-check') && !/✅/.test(await pagina.textContent('#toast')), 'un aviso con emoji sale con su icono profesional (✓ verde)');
    await pagina.evaluate(() => goPanel('home')); await pagina.waitForTimeout(800);
    await pagina.screenshot({ path: path.join(__dirname, 'captura-pestanas-iconos.png') });
    const pest = await pagina.evaluate(() => Array.from(document.querySelectorAll('.tab')).filter(t => t.offsetParent).map(t => { const i = t.querySelector('i'); return i && i.getBoundingClientRect().height > 10 && /Font Awesome/.test(getComputedStyle(i).fontFamily); }));
    ok(pest.length >= 4 && pest.every(Boolean), 'las pestañas de abajo muestran su icono (dibujado con la fuente de iconos)');
    await pagina.evaluate(() => goPanel('sub')); await pagina.waitForTimeout(800);

    // ---- Alfredo genera un código y lo comparte por enlace ----
    await pagina.fill('#subCodeQty', '1');
    await pagina.click('button:has-text("Generar") >> visible=true');
    await pagina.waitForSelector('#subCodesGenerated .bg-compartir', { timeout: 15000 });
    const botones = await pagina.$$eval('#subCodesGenerated .bg-compartir button', (b) => b.map(x => x.textContent).join(' | '));
    ok(botones === 'Compartir | WhatsApp | Copiar enlace', 'al generar un código salen los botones: ' + botones);
    await pagina.locator('#subCodesGenerated').screenshot({ path: path.join(__dirname, 'captura-compartir-codigo.png') });
    const codigoNuevo = await pagina.getAttribute('#subCodesGenerated .bg-compartir', 'data-codigo');
    const enlace = await pagina.evaluate((c) => enlaceInvitacion(c), codigoNuevo);
    ok(enlace.endsWith('/?invitacion=' + encodeURIComponent(codigoNuevo)), 'el enlace lleva el código: ' + enlace);
    await pagina.waitForSelector('#subActiveCodesList .bg-compartir', { timeout: 15000 });
    ok(true, 'también en la lista de códigos disponibles se puede compartir');

    // ---- Una persona nueva abre el enlace ----
    await pagina.evaluate(() => { try { localStorage.removeItem('bg_sesion'); sessionStorage.clear(); } catch (e) {} });
    await pagina.goto(enlace);
    await pagina.waitForSelector('#regScreen', { state: 'visible', timeout: 15000 });
    ok(await pagina.inputValue('#rCodigo') === codigoNuevo && /ya está puesto/.test(await pagina.textContent('#bgAvisoInvitacion')),
      'al abrir el enlace entra directo a "Crear cuenta" con el código ya puesto');
    ok(!/invitacion=/.test(pagina.url()), 'y el código se quita de la barra de direcciones (no queda a la vista)');
    await pagina.screenshot({ path: path.join(__dirname, 'captura-enlace-invitacion.png') });
    await pagina.fill('#rNombre', 'Rosa Nueva'); await pagina.fill('#rApodo', 'Gacela_8'); await pagina.fill('#rTel', '5352200099');
    await pagina.fill('#rEmail', 'rosa@nauta.cu'); await pagina.fill('#rPass', 'clave-segura-1'); await pagina.fill('#rPass2', 'clave-segura-1');
    await pagina.click('#btnRegistro');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 30000 });
    const rosa = Object.values(get('users') || {}).find(u => u.email === 'rosa@nauta.cu') || {};
    ok(rosa.referidoPorUid === 'BG_alf', 'se registra sin escribir el código y queda ligada a Alfredo (el que compartió el enlace)');
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
    await pagina.screenshot({ path: path.join(__dirname, 'fallo-redes.png') });
  }
  console.log('Errores JS en la página:', erroresJs.length ? erroresJs.slice(0, 8) : 'ninguno');
  await navegador.close();
  process.exit(0);
})();
