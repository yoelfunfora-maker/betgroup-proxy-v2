// Prueba en navegador real: Mi perfil (equipos favoritos, partidos, calendario, avisos y estadísticas).
// Ejecutar: NODE_PATH=$(npm root -g) node test/perfil.e2e.js  (necesita Playwright instalado)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const fetchReal = global.fetch;
const { get, set, arrancar, ok } = require('./simulador');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3978, PUERTO_WEB = 8099;
const API_REAL = 'https://betgroup-proxy-v2-8vqj.onrender.com';
const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, email, datos) {
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, ...datos });
}

usuario('BG_fan', 'fan@x.com', { nombre: 'Fan Total', apodo: 'Hincha_1', rol: 'member', rolLevel: 1, telefono: '5352300001', fecha_registro: Date.UTC(2026, 0, 10) });
// 6 apuestas con resultado conocido
const ap = (id, d) => set(`apuestas/BG_fan/${id}`, { eventoNombre: 'X vs Y', fecha: d.t, liquidadaEn: d.t, tipoSaldo: 'real', ...d });
ap('b1', { estado: 'ganada', monto: 100, cuota: 2, pago: 200, sport: 'soccer', mercado: '1X2', eventoNombre: 'Arsenal vs Chelsea', t: Date.UTC(2026, 0, 15) });
ap('b2', { estado: 'perdida', monto: 200, cuota: 1.8, pago: 0, sport: 'soccer', mercado: '1X2', t: Date.UTC(2026, 1, 3) });
ap('b3', { estado: 'ganada', monto: 100, cuota: 3.5, pago: 350, sport: 'basketball', mercado: 'Más/Menos', eventoNombre: 'Lakers vs Celtics', t: Date.UTC(2026, 1, 20) });
ap('b4', { estado: 'ganada', monto: 100, cuota: 2, pago: 100, sport: 'soccer', mercado: '1X2', tipoSaldo: 'promo', saldoCampo: 'creditoPromo', reglaPromo: 'ganancia-a-real', t: Date.UTC(2026, 2, 1) });
ap('b5', { estado: 'pendiente', monto: 50, cuota: 2, sport: 'soccer', t: Date.UTC(2026, 2, 5) });
ap('b6', { estado: 'anulada', monto: 100, cuota: 2, sport: 'soccer', t: Date.UTC(2026, 2, 6) });
// Partidos que manda ESPN: uno de su equipo en 30 minutos, otro mañana y uno que no es de sus equipos
const enMin = (m) => new Date(Date.now() + m * 60000).toISOString();
const partido = (id, local, visit, fecha) => ({ id, date: fecha, status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
  { homeAway: 'home', team: { displayName: local } }, { homeAway: 'away', team: { displayName: visit } }] }] });
const espn = (ruta) => {
  if (/eng\.1/.test(ruta)) return JSON.stringify({ leagues: [{ name: 'Premier League' }], events: [partido('900001', 'Arsenal', 'Chelsea', enMin(30)), partido('900002', 'Liverpool', 'Everton', enMin(60 * 26))] });
  if (/ita\.1/.test(ruta)) return JSON.stringify({ leagues: [{ name: 'Serie A' }], events: [partido('900003', 'Internazionale', 'Parma', enMin(60 * 50))] });
  return null;
};
set('config', { minBet: 100, maxBet: 500 });
// Los partidos de ejemplo no tienen cuota: se muestran igual (aquí se prueba el perfil, no las cuotas).
set('config/mostrarPartidosSinCuota', true);
arrancar({ puerto: PUERTO_API, env: { ODDS_API_KEYS: '', ALLOWED_ORIGINS: `http://127.0.0.1:${PUERTO_WEB}` }, espn });

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

  try {
    await pagina.goto(`http://127.0.0.1:${PUERTO_WEB}/index.html`);
    await pagina.evaluate(() => { localStorage.setItem('betgroup_terms_accepted', 'true'); ['jugador', 'agente', 'supervisor', 'ceo'].forEach(t => localStorage.setItem('bg_tutorial_' + t, '1')); });
    await entrar('fan@x.com');
    await pagina.waitForFunction(() => (allEvents || []).length >= 3, null, { timeout: 30000 });

    // ---- Estadísticas exactas ----
    const R = await pagina.evaluate(async () => calcularEstadisticas((await db.ref('apuestas/' + CU.uid).once('value')).val()));
    ok(R.total === 6 && R.pendientes === 1 && R.anuladas === 1 && R.ganadas === 3 && R.perdidas === 1, 'cuenta bien: 6 apuestas, 3 ganadas, 1 perdida, 1 pendiente, 1 anulada');
    ok(R.apostado === 400 && R.cobrado === 550 && R.neto === 150 && Math.abs(R.roi - 0.375) < 1e-9 && R.acierto === 0.75,
      'dinero real: apostado 400, cobrado 550, ganancia neta +150, rentabilidad 37,5 %, acierto 75 %');
    ok(R.apostadoPromo === 100 && R.gananciaPromo === 100, 'bono aparte: apostado 100 con bono, ganado 100 que pasó a saldo real');
    ok(R.rachaGanadora === 2 && R.rachaPerdedora === 1 && R.rachaActual.tipo === 'ganadas' && R.rachaActual.n === 2, 'rachas: mejor 2 seguidas, peor 1, actual 2 ganadas');
    ok(R.mayorPremio.neto === 250 && /Lakers/.test(R.mayorPremio.evento) && R.mayorCuota.cuota === 3.5, 'mayor premio +250 (Lakers vs Celtics) y cuota más alta acertada 3,50');
    ok(R.porDeporte['Fútbol'].apuestas === 3 && R.porDeporte['Fútbol'].neto === -100 && R.porDeporte['Baloncesto'].neto === 250 && R.meses['2026-01'] === 100 && R.meses['2026-02'] === 50 && R.meses['2026-03'] === 0,
      'desglose por deporte y por mes con el mismo criterio (dinero real): fútbol −100, baloncesto +250; ene +100, feb +50, mar 0');

    // ---- Mi perfil ----
    await pagina.click('#btnPerfil');
    await pagina.waitForSelector('#perfilPanel', { state: 'visible', timeout: 5000 });
    ok((await pagina.textContent('#perfilApodo')) === 'Hincha_1', 'el botón de la cabecera abre "Mi perfil" con su apodo');
    await pagina.waitForSelector('#statsContenido .bg-stats-kpis', { timeout: 15000 });
    const st = await pagina.textContent('#statsContenido');
    ok(/\+150,00 CR/.test(st) && /75 %/.test(st) && /37,5 %/.test(st) && /Mejor racha ganadora/.test(st) && /1 seguida(?!s)/.test(st), 'se ven las estadísticas: +150,00 CR, 75 %, 37,5 %, rachas…');
    ok(await pagina.$('#statsContenido svg.bg-stats-graf rect'), 'y la gráfica de ganancia por mes');

    // Favoritos
    const sug = await pagina.$$eval('#favSugerencias option', o => o.map(x => x.value));
    ok(sug.includes('Arsenal') && sug.includes('Internazionale'), 'al escribir sugiere los equipos que hay en la portada');
    await pagina.fill('#favInput', 'Arsenal'); await pagina.click('#favAgregar');
    await pagina.waitForFunction(() => /Arsenal/.test(document.getElementById('favChips').textContent), null, { timeout: 10000 });
    await pagina.fill('#favInput', 'Inter'); await pagina.press('#favInput', 'Enter');
    await pagina.waitForFunction(() => /Inter/.test(document.getElementById('favChips').textContent), null, { timeout: 10000 });
    ok(JSON.stringify(get('users/BG_fan/equiposFavoritos')) === '["Arsenal","Inter"]', 'añade favoritos (botón o Enter) y quedan guardados en el servidor');
    const part = await pagina.textContent('#favPartidos');
    ok(/Arsenal vs Chelsea/.test(part) && /Internazionale vs Parma/.test(part) && !/Liverpool/.test(part), 'muestra solo los partidos de sus equipos (Inter = Internazionale)');
    const enlace = await pagina.getAttribute('#favPartidos .bg-fav-cal', 'href');
    ok(/calendar\.google\.com\/calendar\/render\?action=TEMPLATE&text=Arsenal%20vs%20Chelsea&dates=\d{8}T\d{6}Z\/\d{8}T\d{6}Z/.test(enlace), 'cada partido tiene "Añadir" a Google Calendar con su hora');
    const g = await pagina.getAttribute('#calGoogle', 'href'), a = await pagina.getAttribute('#calApple', 'href');
    ok(/^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal/.test(g) && /^webcal:\/\/.+\/api\/calendario\/BG_fan\/[0-9a-f]{32}\.ics$/.test(a), 'botones para sincronizar con Google Calendar e iPhone');
    await pagina.screenshot({ path: path.join(__dirname, 'captura-perfil.png'), fullPage: true });

    // Aviso: su equipo juega en 30 minutos
    await pagina.evaluate(() => { try { Object.keys(localStorage).filter(k => k.startsWith('bg_rec_')).forEach(k => localStorage.removeItem(k)); } catch (e) {} revisarRecordatoriosFavoritos(); });
    await pagina.waitForFunction(() => /juega pronto/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    ok(true, 'avisa cuando su equipo juega pronto (1 hora antes) → ' + (await pagina.textContent('#toast')).trim().slice(0, 80));

    // Quitar un favorito
    await pagina.click('#favChips .bg-fav-chip:has-text("Inter") button');
    await pagina.waitForFunction(() => !/Inter/.test(document.getElementById('favChips').textContent), null, { timeout: 10000 });
    ok(JSON.stringify(get('users/BG_fan/equiposFavoritos')) === '["Arsenal"]' && !/Parma/.test(await pagina.textContent('#favPartidos')), 'quitar un favorito lo borra y sus partidos desaparecen');
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
    await pagina.screenshot({ path: path.join(__dirname, 'fallo-perfil.png') });
  }
  console.log('Errores JS en la página:', erroresJs.length ? erroresJs.slice(0, 8) : 'ninguno');
  await navegador.close();
  process.exit(0);
})();
