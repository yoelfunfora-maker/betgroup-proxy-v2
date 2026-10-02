// Prueba de la Etapa 8: ranking semanal, apodo, crédito promocional y fotos sin metadatos.
// Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { get, set, arrancar, ok } = require('./simulador');
const { semanaDe, semanaAnterior } = require('../lib/ranking');
const { limpiarJpeg } = require('../lib/imagenes');

const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, email, pw, datos) {
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado(pw, '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, ...datos });
}
usuario('BG_ceo', 'ceo@x.com', 'ceo-clave-1', { nombre: 'Jefe Grande', rol: 'superadmin', rolLevel: 3 });
usuario('BG_ana', 'ana@x.com', 'ana-clave-1', { nombre: 'Ana Pérez', rol: 'member', rolLevel: 1, creditoReal: 5000, creditoPromo: 300 });
['BG_b', 'BG_c', 'BG_d', 'BG_e'].forEach((u, i) => {
  usuario(u, `${u}@x.com`, 'clave-1234', { nombre: `Persona ${i}`, apodo: `Tigre${i}`, rol: 'member', rolLevel: 1 });
  set(`apodos/tigre${i}`, { uid: u });
});
for (let i = 1; i <= 3; i++) set(`codigosAcceso/RANK-${i}`, { code: `RANK-${i}`, createdBy: 'BG_ceo', usado: false, rol: 'member' });

// Semana pasada: depósitos y apuestas reales (ya liquidadas) para calcular premios.
const pasada = semanaAnterior();
const t = pasada.desde + 2 * 86400000;
const dep = (id, uid, monto) => set(`solicitudesDeposito/${id}`, { userId: uid, monto, estado: 'aprobado', aprobadoEn: t, nombre: 'x' });
dep('D1', 'BG_b', 2000); dep('D2', 'BG_c', 1500); dep('D3', 'BG_d', 1200); dep('D4', 'BG_e', 1000); // E: 1000 justos → no participa
const apuesta = (uid, id, monto, estado, pago, extra = {}) => set(`apuestas/${uid}/${id}`, { monto, cuota: 2, estado, pago, fecha: t + monto, tipoSaldo: 'real', saldoCampo: 'creditoReal', ...extra });
apuesta('BG_b', 'b1', 900, 'perdida', 0);            // B: apostó 900, perdió 900 → 1.º y consuelo
apuesta('BG_c', 'c1', 1200, 'ganada', 2400);         // C: apostó 1200, ganó → (más apostado) 1.º
apuesta('BG_d', 'd1', 300, 'perdida', 0);            // D: 300 → 3.º, sin consuelo
apuesta('BG_d', 'd2', 5000, 'perdida', 0, { tipoSaldo: 'promo', saldoCampo: 'creditoPromo' }); // promo: no cuenta
apuesta('BG_e', 'e1', 4000, 'perdida', 0);           // E no participa aunque apostó mucho

// Partido con una cuota baja (1.30) y una alta (2.50) para la regla de cuota mínima con promo.
const futuro = new Date(Date.now() + 86400000).toISOString();
const espn = { leagues: [{ name: 'Premier League' }], events: [{ id: '900', date: futuro, status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
  { homeAway: 'home', team: { displayName: 'Equipo A' } }, { homeAway: 'away', team: { displayName: 'Equipo B' } }] }] }] };
const fetchReal = global.fetch;
const { llamar } = arrancar({
  puerto: 3992,
  env: { ODDS_API_KEYS: 'k1', IMGBB_API_KEY: '' },
  espn: (p) => (p.includes('soccer/eng.1') ? JSON.stringify(espn) : null),
  axiosGet: async (url) => {
    if (!url.includes('the-odds-api')) throw new Error('sin red');
    return { data: [{ home_team: 'Equipo A', away_team: 'Equipo B', commence_time: futuro, bookmakers: [{ markets: [{ key: 'h2h', outcomes: [{ name: 'Equipo A', price: 1.3 }, { name: 'Equipo B', price: 2.5 }, { name: 'Draw', price: 4 }] }] }] }], headers: {} };
  }
});
const entrar = async (id, pw) => (await llamar('POST', '/api/auth/login', { identificador: id, password: pw }))[1]?.token;

(async () => {
  try {
    await new Promise(r => setTimeout(r, 800));
    for (let i = 0; i < 20; i++) { const f = (await llamar('GET', '/api/fixtures'))[1]; if (f && f.status === 'online') break; await new Promise(r => setTimeout(r, 300)); }
    let s, j;
    const nuevo = { nombre: 'Carlos Gómez', telefono: '5351111111', email: 'carlos@nauta.cu', password: 'clave-segura-1', codigo: 'RANK-1' };

    // ---- Apodo en el registro ----
    [s, j] = await llamar('POST', '/api/auth/registro', nuevo);
    ok(s === 400 && /apodo/.test(j.error), 'el registro exige apodo → ' + j.error);
    [s, j] = await llamar('POST', '/api/auth/registro', { ...nuevo, apodo: 'CarlosGol' });
    ok(s === 400 && /nombre real/.test(j.error), 'el apodo no puede llevar el nombre real → ' + j.error);
    [s, j] = await llamar('POST', '/api/auth/registro', { ...nuevo, apodo: 'tigre0' });
    ok(s === 409 && get('codigosAcceso/RANK-1/usado') === false, 'apodo repetido (Tigre0 = tigre0) rechazado sin gastar el código');
    [s, j] = await llamar('POST', '/api/auth/registro', { ...nuevo, apodo: 'ElMago_10' });
    ok(s === 200 && get(`users/${j.uid}/apodo`) === 'ElMago_10' && get('apodos/elmago_10/uid') === j.uid, 'registro con apodo: queda guardado y reservado');
    [s, j] = await llamar('POST', '/api/auth/registro', { ...nuevo, email: 'otro@nauta.cu', codigo: 'NO-EXISTE', apodo: 'Fantasma' });
    ok(s === 400 && !get('apodos/fantasma'), 'si el código falla, el apodo reservado se libera');

    // ---- Apodo para usuarios antiguos ----
    const tAna = await entrar('ana@x.com', 'ana-clave-1');
    [s, j] = await llamar('POST', '/api/perfil/apodo', { apodo: 'Ana.Gol' }, tAna);
    ok(s === 400, 'Ana no puede usar su nombre en el apodo');
    [s, j] = await llamar('POST', '/api/perfil/apodo', { apodo: 'Relampago' }, tAna);
    ok(s === 200 && get('users/BG_ana/apodo') === 'Relampago', 'usuaria antigua elige su apodo');
    [s, j] = await llamar('POST', '/api/perfil/apodo', { apodo: 'Trueno' }, tAna);
    ok(s === 429, 'solo se cambia una vez por semana');
    [s] = await llamar('POST', '/api/db', { op: 'escribir', ruta: 'users/BG_ana/apodo', valor: 'Hack' }, tAna);
    ok(s === 403, 'el apodo no se puede cambiar por la vía genérica /api/db');
    [s] = await llamar('POST', '/api/db', { op: 'leer', ruta: 'apodos' }, tAna);
    ok(s === 403, 'la lista de apodos no se puede leer desde la web');

    // ---- Crédito promocional ----
    [s, j] = await llamar('POST', '/api/apostar', { eventoId: '900', tipo: 'Local', amount: 100, tipoSaldo: 'promo' }, tAna);
    ok(s === 400 && /cuota mínima es 1.50/.test(j.error), 'promo a cuota 1.30 rechazada (mínimo 1.50) → ' + j.error);
    [s, j] = await llamar('POST', '/api/apostar', { eventoId: '900', tipo: 'Visitante', amount: 100, tipoSaldo: 'promo' }, tAna);
    ok(s === 200 && get('users/BG_ana/creditoPromo') === 200, 'promo a cuota 2.50 aceptada: 300 → 200 promo');
    const real0 = get('users/BG_ana/creditoReal');
    const tCeo = await entrar('ceo@x.com', 'ceo-clave-1');
    [s] = await llamar('POST', '/api/apuestas/liquidar', { partidoId: '900', resultadoGanador: 'Visitante' }, tCeo);
    ok(get('users/BG_ana/creditoReal') === real0 + 150 && get('users/BG_ana/creditoPromo') === 200,
      `promo ganada: SOLO la ganancia (150) va al saldo real; el promo apostado se consume → real ${real0} → ${get('users/BG_ana/creditoReal')}`);

    // ---- Ranking: lo que ve un miembro ----
    [s, j] = await llamar('GET', '/api/ranking', null, tAna);
    ok(s === 200 && j.semana === semanaDe().id && j.yo.faltaParaParticipar === 1000, 'el miembro ve la semana actual y cuánto le falta depositar (1000)');
    ok(!JSON.stringify(j).match(/nombre|telefono|email|BG_/), 'el ranking público no lleva nombres, teléfonos, correos ni identificadores');

    // ---- Ranking: el CEO revisa la semana pasada ----
    [s, j] = await llamar('GET', '/api/admin/ranking', null, tCeo);
    const ap = (j.clasificados || []).map(f => f.apodo).join(',');
    ok(s === 200 && ap === 'Tigre1,Tigre0,Tigre2', 'orden por total apostado con saldo real (promo no cuenta; 1000 justos no participa) → ' + ap);
    const premios = (j.premios || []).map(p => `${p.apodo}:${p.monto}`).join(',');
    ok(premios === 'Tigre1:500,Tigre0:300,Tigre2:100,Tigre0:100', 'premios 500/300/100 + consuelo de 100 a quien perdió más de 500 → ' + premios);
    [s] = await llamar('GET', '/api/admin/ranking', null, tAna);
    ok(s === 403, 'un miembro no ve el detalle del CEO');
    [s, j] = await llamar('POST', '/api/admin/ranking/entregar', { semana: semanaDe().id }, tCeo);
    ok(s === 409, 'la semana en curso no se puede pagar todavía');
    [s, j] = await llamar('POST', '/api/admin/ranking/entregar', { semana: pasada.id }, tCeo);
    ok(s === 200 && get('users/BG_c/creditoPromo') === 500 && get('users/BG_b/creditoPromo') === 400 && get('users/BG_d/creditoPromo') === 100 && get('users/BG_e/creditoPromo') === 0,
      'premios entregados en crédito promo: C 500, B 300+100, D 100, E nada');
    [s] = await llamar('POST', '/api/admin/ranking/entregar', { semana: pasada.id }, tCeo);
    ok(s === 409 && get('users/BG_c/creditoPromo') === 500, 'pulsar «Entregar» dos veces no paga dos veces');

    // ---- Fotos sin metadatos ----
    // Bloque JPEG: marca + largo (2 bytes, cuenta el propio largo) + contenido.
    const bloque = (marca, contenido) => { const c = Buffer.from(contenido, 'latin1'); const l = Buffer.alloc(2); l.writeUInt16BE(c.length + 2); return Buffer.concat([Buffer.from([0xFF, marca]), l, c]); };
    const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8]), bloque(0xE0, 'JFIF\0'), bloque(0xE1, 'Exif\0\0GPS 23.1N 82.3W'), bloque(0xFE, 'iPhone'),
      bloque(0xDA, '\x01\x02'), Buffer.from([0x33, 0x44, 0xFF, 0xD9])]);
    const limpia = limpiarJpeg(jpeg);
    ok(!limpia.toString('latin1').includes('GPS') && !limpia.toString('latin1').includes('iPhone') && limpia.includes(Buffer.from([0x33, 0x44])),
      'la foto pierde el GPS y el modelo del móvil, y conserva la imagen');
    let rechazada = false; try { limpiarJpeg(Buffer.from('\x89PNG....')); } catch { rechazada = true; }
    ok(rechazada, 'solo se aceptan JPEG');
    const r = await fetchReal('http://127.0.0.1:3992/api/imagen', { method: 'POST', headers: { 'content-type': 'image/jpeg', authorization: `Bearer ${tAna}` }, body: jpeg });
    ok(r.status === 503, 'sin clave de ImgBB en el servidor responde 503 y la web usa su plan B → ' + r.status);
  } catch (e) {
    ok(false, 'error inesperado: ' + e.message);
  }
  process.exit(0);
})();
