// Prueba de la Etapa 11: comisiones semanales de agentes y supervisores con arrastre.
// Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { get, set, arrancar, ok } = require('./simulador');
const { semanaDe, semanaAnterior } = require('../lib/ranking');

const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, datos) {
  const email = `${uid.toLowerCase()}@x.com`;
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, ...datos });
}
usuario('BG_ceo', { nombre: 'Jefe', rol: 'superadmin', rolLevel: 3 });
usuario('BG_S', { nombre: 'Supervisora', apodo: 'Sup', rol: 'director', rolLevel: 2.8 });
usuario('BG_A', { nombre: 'Agente A', apodo: 'AgA', rol: 'subadmin', rolLevel: 2, codigoInvitacion: 'BGA0001', supervisorUid: 'BG_S' });
usuario('BG_B', { nombre: 'Agente B', apodo: 'AgB', rol: 'subadmin', rolLevel: 2, codigoInvitacion: 'BGB0001' });
set('codigosAcceso/AA-1', { codigo: 'AA-1', generadoPor: 'BG_A', usado: true });

const pasada = semanaAnterior();
const actual = semanaDe();
const tp = pasada.desde + 2 * 86400000;
const ta = actual.desde + 60000;
// Agente A: 7 jugadores activos (unos por código fijo, otros por código generado, otros ligados).
// Apuestan 10.000 en total y la casa les paga 4.000 → ganancia 6.000; además una promo ganada paga 150.
const formas = [{ referidoPor: 'BGA0001' }, { referidoPor: 'AA-1' }, { referidoPorUid: 'BG_A' }];
for (let i = 1; i <= 7; i++) {
  usuario(`BG_a${i}`, { nombre: `Jugador a${i}`, rol: 'member', rolLevel: 1, ...formas[i % 3] });
  const monto = i === 7 ? 1000 + 3000 : 1000; // total 10.000
  set(`apuestas/BG_a${i}/p1`, { monto, cuota: 2, estado: 'perdida', pago: 0, fecha: tp, liquidadaEn: tp, tipoSaldo: 'real' });
}
set('apuestas/BG_a1/g1', { monto: 2000, cuota: 3, estado: 'ganada', pago: 6000, fecha: tp, liquidadaEn: tp, tipoSaldo: 'real' }); // +2000 apostado, −6000 pagado
set('apuestas/BG_a2/promo', { monto: 100, cuota: 2.5, estado: 'ganada', pago: 150, fecha: tp, liquidadaEn: tp, tipoSaldo: 'promo', saldoCampo: 'creditoPromo', reglaPromo: 'ganancia-a-real' });
// Cuenta que solo juega el bono (y pierde): es jugador de A pero NO cuenta como activo.
usuario('BG_a8', { nombre: 'Solo bono', rol: 'member', rolLevel: 1, referidoPorUid: 'BG_A' });
set('apuestas/BG_a8/bono', { monto: 100, cuota: 2, estado: 'perdida', pago: 0, fecha: tp, liquidadaEn: tp, tipoSaldo: 'promo', saldoCampo: 'creditoPromo', reglaPromo: 'ganancia-a-real' });
set('apuestas/BG_a3/pend', { monto: 500, cuota: 2, estado: 'pendiente', fecha: tp, tipoSaldo: 'real' }); // pendiente: no cuenta
// Agente B: 2 jugadores que GANARON a la casa 1.000 la semana pasada; esta semana pierden 1.500.
usuario('BG_b1', { nombre: 'Jugador b1', rol: 'member', rolLevel: 1, referidoPor: 'BGB0001' });
usuario('BG_b2', { nombre: 'Jugador b2', rol: 'member', rolLevel: 1, referidoPorUid: 'BG_B' });
set('apuestas/BG_b1/x', { monto: 1000, cuota: 3, estado: 'ganada', pago: 3000, fecha: tp, liquidadaEn: tp, tipoSaldo: 'real' }); // −2000
set('apuestas/BG_b2/y', { monto: 1000, cuota: 2, estado: 'perdida', pago: 0, fecha: tp, liquidadaEn: tp, tipoSaldo: 'real' });  // +1000
set('apuestas/BG_b1/z', { monto: 1500, cuota: 2, estado: 'perdida', pago: 0, fecha: ta, liquidadaEn: ta, tipoSaldo: 'real' }); // esta semana +1500

const { llamar } = arrancar({ puerto: 3986, env: { ODDS_API_KEYS: '' } });
const entrar = async (uid) => (await llamar('POST', '/api/auth/login', { identificador: `${uid.toLowerCase()}@x.com`, password: 'clave-1234' }))[1]?.token;

(async () => {
  try {
    await new Promise(r => setTimeout(r, 500));
    const t = {}; for (const u of ['BG_ceo', 'BG_S', 'BG_A', 'BG_B', 'BG_a1']) t[u] = await entrar(u);
    let s, j;

    // ---- Semana pasada (vista del CEO) ----
    [s, j] = await llamar('GET', `/api/comisiones?semana=${pasada.id}`, null, t.BG_ceo);
    const A = j.agentes.find(a => a.uid === 'BG_A'), B = j.agentes.find(a => a.uid === 'BG_B');
    ok(s === 200 && A.jugadores === 8 && A.activos === 7, 'el agente A tiene 8 jugadores, pero solo 7 activos: el que solo jugó el bono no cuenta');
    ok(A.ganancia === 5850, 'ganancia de la red de A: 12.000 apostado − 6.000 pagado − 150 de promo (la pendiente no cuenta) → ' + A.ganancia);
    ok(A.pct === 0.10 && A.comisionAgente === 585, '7 activos → 10 % para el agente: 585 CR');
    ok(A.comisionSupervisor === 292.5 && A.casa === 4972.5, 'supervisora 5 %: 292,5 CR · casa: 4.972,5 CR (≥ 70 %)');
    ok(B.ganancia === -1000 && B.comisionAgente === 0 && B.arrastreSiguiente === -1000, 'red de B en pérdidas (−1.000): sin comisión y la pérdida pasa a la semana siguiente');
    ok(j.totales.casa === 4972.5 - 1000, 'totales para el CEO: casa ' + j.totales.casa);

    // ---- Quién ve qué ----
    [s, j] = await llamar('GET', `/api/comisiones?semana=${pasada.id}`, null, t.BG_A);
    ok(s === 200 && j.agentes.length === 1 && j.agentes[0].uid === 'BG_A' && !j.totales, 'el agente solo ve lo suyo');
    [s, j] = await llamar('GET', `/api/comisiones?semana=${pasada.id}`, null, t.BG_S);
    ok(s === 200 && j.agentes.map(a => a.uid).join() === 'BG_A' && j.supervisores[0].comision === 292.5, 'la supervisora ve solo a sus agentes y su comisión (292,5)');
    [s] = await llamar('GET', '/api/comisiones', null, t.BG_a1);
    ok(s === 403, 'un jugador no ve comisiones');

    // ---- Cierre de semana ----
    [s] = await llamar('POST', '/api/admin/comisiones/cerrar', { semana: actual.id }, t.BG_ceo);
    ok(s === 409, 'la semana en curso no se puede cerrar');
    [s, j] = await llamar('POST', '/api/admin/comisiones/cerrar', { semana: pasada.id }, t.BG_A);
    ok(s === 403, 'un agente no puede cerrar semanas');
    [s, j] = await llamar('POST', '/api/admin/comisiones/cerrar', { semana: pasada.id }, t.BG_ceo);
    ok(s === 200 && get('comisionesArrastre/BG_B/saldo') === -1000 && get(`comisionesSemana/${pasada.id}/cerrada`) === true, 'el CEO cierra la semana: queda guardada y B arrastra −1.000');
    [s] = await llamar('POST', '/api/admin/comisiones/cerrar', { semana: pasada.id }, t.BG_ceo);
    ok(s === 409, 'cerrar dos veces no paga dos veces');

    // ---- Semana actual: B gana 1.500 pero arrastra −1.000 → comisión solo sobre 500 ----
    [s, j] = await llamar('GET', '/api/comisiones', null, t.BG_ceo);
    const B2 = j.agentes.find(a => a.uid === 'BG_B');
    ok(B2.ganancia === 1500 && B2.arrastreAnterior === -1000 && B2.neto === 500 && B2.comisionAgente === 25,
      'esta semana B gana 1.500, descuenta el arrastre de −1.000 y cobra el 5 % de 500 = 25 CR');

    // ---- Asignar supervisor ----
    [s] = await llamar('POST', '/api/admin/asignar-supervisor', { agenteUid: 'BG_B', supervisorUid: 'BG_A' }, t.BG_ceo);
    ok(s === 400, 'solo un usuario con rango de supervisor puede supervisar');
    [s] = await llamar('POST', '/api/admin/asignar-supervisor', { agenteUid: 'BG_B', supervisorUid: 'BG_S' }, t.BG_ceo);
    ok(s === 200 && get('users/BG_B/supervisorUid') === 'BG_S', 'el CEO asigna el agente B a la supervisora');
    [s] = await llamar('POST', '/api/db', { op: 'escribir', ruta: 'users/BG_A/supervisorUid', valor: 'BG_ceo' }, t.BG_ceo);
    ok(s === 403, 'el supervisor no se puede cambiar por la vía genérica /api/db');
  } catch (e) {
    ok(false, 'error inesperado: ' + e.message);
  }
  process.exit(0);
})();
