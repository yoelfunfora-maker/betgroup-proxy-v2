// Prueba en navegador real (Etapa 6): registro desde un móvil con el servidor dormido
// y fotos de luchadores de MMA.
// Ejecutar: NODE_PATH=$(npm root -g) node test/registro.e2e.js  (necesita Playwright instalado)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const fetchReal = global.fetch;
const { get, set, arrancar, ok } = require('./simulador');

const FRONT = process.env.BG_FRONTEND || path.join(__dirname, '..', '..', 'betgroup-frontend');
const PUERTO_API = 3994, PUERTO_WEB = 8098;
const API_REAL = 'https://betgroup-proxy-v2-8vqj.onrender.com';

set('codigosAcceso/INVITA-2026', { code: 'INVITA-2026', createdBy: 'BG_ceo', usado: false, rol: 'member' });
set('config', { minBet: 100, maxBet: 500 });
// La pelea de MMA de ejemplo no tiene cuota: se muestran también los partidos sin cuota (aquí se prueban las fotos).
set('config/mostrarPartidosSinCuota', true);

// Velada de UFC: un luchador con foto que carga y otro cuya foto falla.
const futuro = new Date(Date.now() + 86400000).toISOString();
const velada = {
  leagues: [{ name: 'UFC' }],
  events: [{ id: '900', date: futuro, status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
    { id: '111', homeAway: 'home', athlete: { id: '111', displayName: 'Alex Pereira', headshot: { href: 'https://a.espncdn.com/i/headshots/mma/players/full/111.png' } } },
    { id: '222', homeAway: 'away', athlete: { id: '222', displayName: 'Jiri Prochazka' } }
  ] }] }]
};
arrancar({
  puerto: PUERTO_API,
  env: { ODDS_API_KEYS: '', ALLOWED_ORIGINS: `http://127.0.0.1:${PUERTO_WEB}` },
  espn: (p) => (p.includes('mma/ufc') ? JSON.stringify(velada) : null)
});

http.createServer((req, res) => {
  const f = path.join(FRONT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  if (!f.startsWith(FRONT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.woff2') ? 'font/woff2' : f.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
}).listen(PUERTO_WEB);

// PNG de 1x1 que hace de "foto" del luchador que sí carga.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const navegador = await chromium.launch();
  const pagina = await navegador.newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 1 });
  const erroresJs = [];
  pagina.on('pageerror', (e) => erroresJs.push(e.message));
  pagina.on('dialog', (d) => d.accept());

  // El servidor está "dormido": las primeras 3 llamadas a /api/ping fallan (como Render gratis).
  let pingsFallidos = 0;
  let cortarYo = false;
  await pagina.route('**/*', async (ruta) => {
    const req = ruta.request();
    const url = req.url();
    if (url === 'https://a.espncdn.com/i/headshots/mma/players/full/111.png') return ruta.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (url.startsWith(API_REAL)) {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Content-Type, Authorization', 'access-control-allow-methods': 'GET, POST' };
      if (req.method() === 'OPTIONS') return ruta.fulfill({ status: 204, headers: cors });
      if (url.endsWith('/api/ping') && pingsFallidos < 3) { pingsFallidos++; return ruta.fulfill({ status: 503, headers: cors, body: '' }); }
      if (url.endsWith('/api/auth/yo') && cortarYo) return ruta.abort('internetdisconnected');
      const r = await fetchReal(url.replace(API_REAL, `http://127.0.0.1:${PUERTO_API}`), {
        method: req.method(), headers: { 'content-type': 'application/json', ...(req.headers().authorization ? { authorization: req.headers().authorization } : {}) },
        body: req.method() === 'GET' ? undefined : req.postData()
      });
      return ruta.fulfill({ status: r.status, headers: { ...cors, 'content-type': 'application/json' }, body: await r.text() });
    }
    if (url.startsWith(`http://127.0.0.1:${PUERTO_WEB}`)) return ruta.continue();
    return ruta.abort(); // la foto de Prochazka (y CDNs) no cargan: debe salir con iniciales
  });

  try {
    await new Promise(r => setTimeout(r, 1500));
    await pagina.goto(`http://127.0.0.1:${PUERTO_WEB}/index.html`);
    await pagina.evaluate(() => { localStorage.setItem('betgroup_terms_accepted', 'true'); });
    await pagina.reload();
    pingsFallidos = 0; // la recarga vuelve a encontrar el servidor dormido

    await pagina.click('text=Crear cuenta');
    await pagina.waitForSelector('#regScreen', { state: 'visible' });
    ok(await pagina.isVisible('label[for="rCodigo"]'), 'el formulario tiene etiquetas visibles (no solo texto que desaparece)');

    // Dato mal escrito: el aviso sale en el propio formulario y señala el campo.
    await pagina.fill('#rNombre', 'Yoel Prueba');
    await pagina.fill('#rApodo', 'Cometa_21');
    await pagina.fill('#rTel', '5351234567');
    await pagina.fill('#rEmail', 'yoel-sin-arroba');
    await pagina.fill('#rPass', 'clave-segura-1');
    await pagina.fill('#rPass2', 'clave-segura-1');
    await pagina.fill('#rCodigo', 'invita- 2026');
    await pagina.click('#btnRegistro');
    const aviso = await pagina.textContent('#registerStatusMsg');
    const foco = await pagina.evaluate(() => document.activeElement.id);
    ok(/correo no es válido/.test(aviso) && foco === 'rEmail', 'correo mal escrito: aviso claro y el cursor va al campo → ' + aviso.trim());

    // Ya bien escrito (con mayúscula y el código con un espacio, como pasa al copiar de WhatsApp).
    await pagina.fill('#rEmail', ' Yoel@Nauta.cu');
    await pagina.screenshot({ path: path.join(__dirname, 'captura-registro.png') });
    await pagina.click('#btnRegistro');
    // Mientras el servidor despierta, la pantalla lo explica.
    await pagina.waitForFunction(() => /Despertando|Conectando/.test(document.getElementById('registerStatusMsg').textContent), null, { timeout: 10000 });
    ok(true, 'con el servidor dormido, el formulario explica que está despertando');
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 40000 });
    ok(true, 'tras crear la cuenta entra directamente a la app (sin volver a escribir los datos)');
    const nuevo = Object.values(get('users') || {}).find(u => u.email === 'yoel@nauta.cu');
    ok(nuevo && get('codigosAcceso/INVITA-2026/usado') === true, 'cuenta creada con el correo en minúsculas y el código gastado');

    // Bono de inscripción: 100 de promo, aviso de bienvenida y aviso en Canjes.
    ok(nuevo.creditoPromo === 100 && /bono/.test(await pagina.textContent('#toast')), 'entra con 100 CR de bono promocional y se lo dice al darle la bienvenida → ' + (await pagina.textContent('#toast')).trim());
    await pagina.evaluate(() => { if (typeof cerrarTutorial === 'function') cerrarTutorial(); goPanel('retiros'); });
    await pagina.waitForSelector('#avisoBonoRetiro:not([hidden])', { timeout: 5000 });
    ok(/deposita al menos 500 CUP/.test(await pagina.textContent('#avisoBonoRetiro')), 'en Canjes le explica que para retirar debe depositar 500 CUP');
    await pagina.evaluate(() => goPanel('home'));

    // Fotos de MMA.
    await pagina.waitForSelector('img.bg-foto', { timeout: 20000 });
    const fotos = await pagina.$$eval('img.bg-foto', (els) => els.map(e => e.getAttribute('src')));
    ok(fotos.includes('https://a.espncdn.com/i/headshots/mma/players/full/111.png'), 'la tarjeta de UFC muestra la foto de Alex Pereira desde ESPN');
    await pagina.waitForFunction(() => [...document.querySelectorAll('.bg-escudo-vacio')].some(e => e.textContent === 'JP'), null, { timeout: 10000 });
    ok(true, 'si la foto de un luchador no carga, salen sus iniciales (JP) en vez de un hueco');
    await pagina.locator('.bg-partido').first().screenshot({ path: path.join(__dirname, 'captura-mma.png') });

    // Corte de red al volver a abrir la app: NO se cierra la sesión.
    cortarYo = true;
    await pagina.reload();
    await new Promise(r => setTimeout(r, 4000));
    const sigue = await pagina.evaluate(() => Boolean(BG.token()));
    ok(sigue, 'si se corta la red al reabrir la app, la sesión no se pierde');
    cortarYo = false;
    await pagina.reload();
    await pagina.waitForSelector('#app', { state: 'visible', timeout: 20000 });
    ok(true, 'con la red de vuelta entra solo, sin escribir la contraseña');
  } catch (e) {
    ok(false, 'excepción: ' + e.message.split('\n')[0]);
    await pagina.screenshot({ path: path.join(__dirname, 'fallo-registro.png') });
  }
  console.log('Errores JS en la página:', erroresJs.length ? erroresJs.slice(0, 8) : 'ninguno');
  await navegador.close();
  process.exit(0);
})();
