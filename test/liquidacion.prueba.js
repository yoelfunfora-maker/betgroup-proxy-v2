// Prueba de la Etapa 4 (mercados y liquidación). Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { get, set, arrancar, ok } = require('./simulador');
const { interpretar, cuotaPara, resolver } = require('../lib/mercados');

// ---- Reglas de cada mercado (sin servidor) ----
const ev = { local: 'Equipo A', visitante: 'Equipo B', sport: 'soccer', cuota_local: 1.8, cuota_visitante: 2.1, cuota_empate: 3.2,
  handicap_local: -1.5, handicap_local_cuota: 2.4, handicap_visitante: 1.5, handicap_visitante_cuota: 1.6,
  total_over_point: 2.5, total_over_price: 1.9, total_under_point: 2.5, total_under_price: 1.95 };
const m = (t) => interpretar(t, ev);
ok(cuotaPara(ev, m('Handicap Equipo A (-1.5)')) === 2.4 && cuotaPara(ev, m('Over 2.5')) === 1.9, 'cuotas de hándicap y totales salen del servidor');
ok(cuotaPara(ev, m('Over 3.5')) === null, 'una línea que el servidor no ofrece no tiene cuota');
ok(cuotaPara({ ...ev, sport: 'basketball' }, m('Empate')) === null, 'no hay empate fuera del fútbol');
const r = (t, l, v) => resolver(m(t), { marcador: { local: l, visitante: v } });
ok(r('Handicap Equipo A (-1.5)', 2, 0) === 'ganada' && r('Handicap Equipo A (-1.5)', 1, 0) === 'perdida', 'hándicap -1.5: gana por 2, pierde por 1');
ok(r('Handicap Equipo B (1)', 1, 0) === 'anulada', 'hándicap exacto: se devuelve el dinero');
ok(r('Over 2.5', 2, 1) === 'ganada' && r('Under 2.5', 2, 1) === 'perdida' && r('Over 3', 2, 1) === 'anulada', 'más/menos de 2.5 y línea exacta');
ok(r('Empate', 1, 1) === 'ganada' && r('Local', 1, 1) === 'perdida', '1X2 con marcador');
ok(resolver(m('Over 2.5'), { ganador: 'Local' }) === null, 'sin marcador, un total no se decide (queda pendiente)');

// ---- Servidor completo ----
const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, email, pw, datos) {
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado(pw, '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, ...datos });
}
usuario('BG_ceo', 'ceo@x.com', 'ceo-clave-1', { nombre: 'Jefe', rol: 'superadmin', rolLevel: 3 });
usuario('BG_m1', 'm1@x.com', 'm1-clave-1', { nombre: 'Uno', rol: 'member', rolLevel: 1, creditoReal: 1000, telefono: '5355511111' });
set('telefonos/5355511111/BG_m1', { email: 'm1@x.com' });
set('config', { minBet: 100, maxBet: 500, maxPago: 5000, dailyLossLimit: 5000 });

const futuro = new Date(Date.now() + 86400000).toISOString();
const partido = (estado, marcador) => ({ events: [{ id: '777', date: futuro, status: { type: estado }, competitions: [{ status: { type: estado }, competitors: [
  { homeAway: 'home', team: { displayName: 'Equipo A' }, score: String(marcador[0]) }, { homeAway: 'away', team: { displayName: 'Equipo B' }, score: String(marcador[1]) }] }] },
  { id: '888', date: futuro, status: { type: { state: 'pre' } }, competitions: [{ status: { type: { state: 'pre' } }, competitors: [
  { homeAway: 'home', team: { displayName: 'Sin Cuotas FC' }, score: '0' }, { homeAway: 'away', team: { displayName: 'Nadie' }, score: '0' }] }] }],
  leagues: [{ name: 'Liga Prueba' }] });
let terminado = false;
let cancelado = false;
const { llamar } = arrancar({
  puerto: 3995,
  env: { ODDS_API_KEYS: 'k1' },
  espn: (p) => {
    if (!p.includes('soccer/eng.1')) return null;
    if (cancelado && p.includes('dates=')) return JSON.stringify(partido({ state: 'post', completed: false, name: 'STATUS_CANCELED' }, [0, 0]));
    if (terminado && p.includes('dates=')) return JSON.stringify(partido({ state: 'post', completed: true, name: 'STATUS_FULL_TIME' }, [2, 0]));
    return JSON.stringify(partido({ state: 'pre' }, [0, 0]));
  },
  axiosGet: async (url) => {
    if (url.includes('the-odds-api')) {
      return { data: [{ home_team: 'Equipo A', away_team: 'Equipo B', bookmakers: [{ markets: [
        { key: 'h2h', outcomes: [{ name: 'Equipo A', price: 1.8 }, { name: 'Equipo B', price: 2.1 }, { name: 'Draw', price: 3.2 }] },
        { key: 'spreads', outcomes: [{ name: 'Equipo A', point: -1.5, price: 2.4 }, { name: 'Equipo B', point: 1.5, price: 1.6 }] },
        { key: 'totals', outcomes: [{ name: 'Over', point: 2.5, price: 1.9 }, { name: 'Under', point: 2.5, price: 1.95 }] }] }] }] };
    }
    throw new Error('sin red');
  }
});

setTimeout(async () => {
  try {
    const t = (await llamar('POST', '/api/auth/login', { identificador: 'm1@x.com', password: 'm1-clave-1' }))[1].token;
    const tCeo = (await llamar('POST', '/api/auth/login', { identificador: 'ceo@x.com', password: 'ceo-clave-1' }))[1].token;
    let [s, j] = await llamar('GET', '/api/fixtures');
    const sinCuotas = (j.data || []).find(e => e.id === '888');
    ok(!sinCuotas && (j.data || []).some(e => e.id === '777'), 'partido sin cuota real: NO se publica (solo se ven los que tienen cuota de un proveedor)');
    [s] = await llamar('POST', '/api/apostar', { eventoId: '888', tipo: 'Local', amount: 100 }, t);
    ok(s === 409, 'no se puede apostar a un partido sin cuota real → ' + s);

    const apostar = (tipo) => llamar('POST', '/api/apostar', { eventoId: '777', tipo, amount: 100 }, t);
    const tipos = ['Local', 'Handicap Equipo A (-1.5)', 'Over 2.5', 'Under 2.5'];
    for (const tipo of tipos) { [s, j] = await apostar(tipo); ok(s === 200, `apuesta "${tipo}" aceptada a ×${j.cuota}`); }
    [s] = await apostar('Over 7.5');
    ok(s === 409, 'línea que no existe rechazada → ' + s);
    const apuestas = Object.values(get('apuestas/BG_m1'));
    ok(apuestas.every(a => a.ruta === 'soccer/eng.1' && a.mercado), 'cada apuesta guarda su competición y su mercado');
    ok(get('users/BG_m1/creditoReal') === 600, 'saldo tras 4 apuestas de 100: 600');

    // Termina 2-0 → la liquidación automática lo encuentra por fecha y competición.
    terminado = true;
    [s, j] = await llamar('POST', '/api/admin/liquidar-ahora', {}, tCeo);
    const estados = Object.fromEntries(Object.values(get('apuestas/BG_m1')).map(a => [a.tipo, a.estado]));
    ok(s === 200 && j.liquidadas === 4, 'liquidación automática: 4 apuestas resueltas → ' + JSON.stringify(j));
    ok(estados['Local'] === 'ganada' && estados['Handicap Equipo A (-1.5)'] === 'ganada' && estados['Over 2.5'] === 'perdida' && estados['Under 2.5'] === 'ganada',
      '2-0: Local gana, Hándicap -1.5 gana, Over 2.5 pierde, Under 2.5 gana');
    const esperado = 600 + 180 + 240 + 195;
    ok(get('users/BG_m1/creditoReal') === esperado, `premios pagados una vez: saldo ${get('users/BG_m1/creditoReal')} (esperado ${esperado})`);
    [s, j] = await llamar('POST', '/api/admin/liquidar-ahora', {}, tCeo);
    ok(get('users/BG_m1/creditoReal') === esperado, 'repetir la liquidación no paga dos veces');

    // Partido cancelado → se devuelve lo apostado.
    terminado = false;
    await apostar('Visitante');
    cancelado = true;
    const antes = get('users/BG_m1/creditoReal');
    [s, j] = await llamar('POST', '/api/admin/liquidar-ahora', {}, tCeo);
    ok(get('users/BG_m1/creditoReal') === antes + 100, 'partido cancelado: se devuelven los 100 apostados');

    // Liquidación manual del CEO con marcador.
    set('apuestas/BG_m1/manual1', { estado: 'pendiente', eventoId: '999', eventoNombre: 'X vs Y', tipo: 'Over 2.5', monto: 100, cuota: 2, saldoCampo: 'creditoReal' });
    [s, j] = await llamar('POST', '/api/apuestas/liquidar', { partidoId: '999', resultadoGanador: 'Local' }, tCeo);
    ok(get('apuestas/BG_m1/manual1/estado') === 'pendiente' && j.sinDecidir === 1, 'manual solo con ganador: un total queda pendiente (no se adivina)');
    [s, j] = await llamar('POST', '/api/apuestas/liquidar', { partidoId: '999', marcador: '3-1' }, tCeo);
    ok(get('apuestas/BG_m1/manual1/estado') === 'ganada', 'manual con marcador 3-1: Over 2.5 ganada');

    // Apuestas que nunca tienen resultado: a los 7 días se anulan y se devuelve lo apostado.
    const saldoAntes = get('users/BG_m1/creditoReal');
    set('apuestas/BG_m1/vieja', { estado: 'pendiente', eventoId: 'NOEXISTE1', eventoNombre: 'Fantasma vs Nadie', tipo: 'Local', monto: 150, cuota: 2, saldoCampo: 'creditoReal', fecha: Date.now() - 12 * 86400000 });
    set('apuestas/BG_m1/reciente', { estado: 'pendiente', eventoId: 'NOEXISTE2', eventoNombre: 'Hoy vs Manana', tipo: 'Local', monto: 50, cuota: 2, saldoCampo: 'creditoReal', fecha: Date.now() - 2 * 86400000 });
    [s, j] = await llamar('POST', '/api/admin/liquidar-ahora', {}, tCeo);
    ok(get('apuestas/BG_m1/vieja/estado') === 'anulada' && get('apuestas/BG_m1/vieja/liquidadaPor') === 'auto-sin-resultado' && get('users/BG_m1/creditoReal') === saldoAntes + 150,
      'apuesta pendiente de hace 12 días sin resultado: se anula y se devuelven los 150 CR');
    ok(get('apuestas/BG_m1/reciente/estado') === 'pendiente', 'una pendiente de hace 2 días sigue esperando su resultado');
    set('apuestas/BG_m1/reciente', null);
    set('users/BG_m1/creditoReal', 0);

    // Eliminar usuario.
    set('users/BG_m1/creditoReal', 10);
    [s, j] = await llamar('POST', '/api/admin/eliminar-usuario', { uid: 'BG_m1' }, tCeo);
    ok(s === 409, 'no se elimina a quien tiene saldo → ' + s);
    set('users/BG_m1/creditoReal', 0);
    [s, j] = await llamar('POST', '/api/admin/eliminar-usuario', { uid: 'BG_m1' }, tCeo);
    if (s !== 200) console.log('   respuesta:', s, JSON.stringify(j));
    ok(s === 200 && get('users/BG_m1') === null && get('credenciales_acceso/m1-x-com') === null && get('telefonos/5355511111') === null,
      'usuario eliminado del todo: perfil, credenciales y teléfono');
  } catch (e) {
    console.log('❌ excepción en la prueba: ' + e.stack);
  }
  process.exit(0);
}, 1500);
