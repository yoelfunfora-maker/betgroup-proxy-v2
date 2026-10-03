// Auditoría de accesos: matriz rango × función. Cada rango solo entra donde le corresponde.
// (Las acciones destructivas solo se prueban con quien NO debe poder hacerlas.)
// Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { set, arrancar, ok } = require('./simulador');

const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, rol, nivel, extra = {}) {
  const email = `${uid.toLowerCase()}@x.com`;
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, nombre: uid, rol, rolLevel: nivel, creditoReal: 0, creditoPromo: 0, ...extra });
}
usuario('BG_jug', 'member', 1, { referidoPorUid: 'BG_age' });
usuario('BG_age', 'subadmin', 2, { codigoInvitacion: 'BGAGE01' });
usuario('BG_sup', 'director', 2.8);
usuario('BG_ceo', 'superadmin', 3);
set('auditLog/a1', { action: 'X', uid: 'BG_ceo', timestamp: 1 });
set('secretos/apiFootball', { clave: 'x' });
set('perfilRiesgo/BG_jug', { puntos: 10 });
set('googleCuentas/123', { uid: 'BG_jug' });
set('comisionesArrastre/BG_age', { saldo: -5 });

const { llamar } = arrancar({ puerto: 3980, env: { ODDS_API_KEYS: '' } });
const entrar = async (uid) => (await llamar('POST', '/api/auth/login', { identificador: `${uid.toLowerCase()}@x.com`, password: 'clave-1234' }))[1]?.token;
const ROLES = ['anonimo', 'jugador', 'agente', 'supervisor', 'ceo'];
const NIVEL = { anonimo: 0, jugador: 1, agente: 2, supervisor: 2.8, ceo: 3 };

// [método, ruta, cuerpo, nivel mínimo, ¿destructiva?]
const RUTAS = [
  ['POST', '/api/admin/ajustar-saldo', { uid: 'BG_jug', tipo: 'real', monto: 1, motivo: 'x' }, 3, true],
  ['POST', '/api/admin/asignar-rol', { uid: 'BG_jug', rol: 'member' }, 3, true],
  ['POST', '/api/admin/restablecer-clave', { uid: 'BG_jug' }, 3, true],
  ['POST', '/api/admin/eliminar-usuario', { uid: 'BG_nadie' }, 3, true],
  ['POST', '/api/admin/asignar-supervisor', { agenteUid: 'BG_age', supervisorUid: 'BG_sup' }, 3, true],
  ['POST', '/api/admin/comisiones/cerrar', { semana: '2020-01-06' }, 3, true],
  ['POST', '/api/admin/ranking/entregar', { semana: '2020-01-06' }, 3, true],
  ['POST', '/api/admin/liquidar-ahora', {}, 3, true],
  ['POST', '/api/admin/reiniciar', {}, 3, true],
  ['POST', '/api/admin/generar-codigo', { rol: 'admin' }, 3, true],
  ['GET', '/api/admin/riesgo', null, 3, false],
  ['GET', '/api/admin/ranking', null, 3, false],
  ['GET', '/api/admin/auditoria/verificar', null, 3, false],
  ['GET', '/api/estado-sistema', null, 3, false],
  ['GET', '/api/red', null, 2.8, false],
  ['POST', '/api/depositos/NOEXISTE/aprobar', {}, 2.8, false],
  ['POST', '/api/solicitudes-deposito/NOEXISTE/aprobar', {}, 2.8, false],
  ['GET', '/api/comisiones', null, 2, false],
  ['GET', '/api/usuarios/mis-referidos', null, 2, false],
  ['GET', '/api/ranking', null, 1, false],
  ['GET', '/api/auth/yo', null, 1, false]
];
// Tablas privadas: nivel mínimo para LEER (99 = nadie, ni el CEO, desde el navegador).
const TABLAS = [
  ['auditLog', 3], ['secretos', 99], ['credenciales_acceso', 99], ['credenciales_servidor', 99],
  ['perfilRiesgo', 99], ['googleCuentas', 99], ['comisionesArrastre', 99], ['dispositivosUso', 99]
];

(async () => {
  try {
    await new Promise(r => setTimeout(r, 500));
    const tok = { anonimo: null };
    for (const [r, uid] of [['jugador', 'BG_jug'], ['agente', 'BG_age'], ['supervisor', 'BG_sup'], ['ceo', 'BG_ceo']]) tok[r] = await entrar(uid);
    let fallos = [];
    for (const [m, ruta, cuerpo, minimo, destructiva] of RUTAS) {
      for (const r of ROLES) {
        const debe = NIVEL[r] >= minimo;
        if (debe && destructiva) continue;
        const [s] = await llamar(m, ruta, cuerpo, tok[r]);
        const entra = s !== 401 && s !== 403;
        if (entra !== debe) fallos.push(`${r} ${m} ${ruta} → ${s} (debía ${debe ? 'entrar' : 'quedar fuera'})`);
      }
    }
    ok(!fallos.length, `rutas: cada rango entra solo donde le toca (${RUTAS.length} funciones × ${ROLES.length} rangos)` + (fallos.length ? ' → ' + fallos.join('; ') : ''));

    fallos = [];
    for (const [tabla, minimo] of TABLAS) {
      for (const r of ROLES.slice(1)) {
        const [s, j] = await llamar('POST', '/api/db', { op: 'leer', ruta: tabla }, tok[r]);
        const vio = Boolean(s === 200 && j && j.valor && Object.keys(j.valor).length > 0);
        if (vio !== (NIVEL[r] >= minimo)) fallos.push(`${r} leyó ${tabla}: ${vio} (status ${s})`);
      }
    }
    ok(!fallos.length, 'tablas privadas: contraseñas, secretos, antifraude y vínculos de Google no se leen desde el navegador' + (fallos.length ? ' → ' + fallos.join('; ') : ''));

    // Escalada de privilegios por la vía genérica
    fallos = [];
    for (const r of ['jugador', 'agente', 'supervisor']) {
      for (const [campo, valor] of [['rol', 'superadmin'], ['rolLevel', 3], ['creditoReal', 99999], ['supervisorUid', 'BG_x'], ['googleSub', '1']]) {
        const uid = { jugador: 'BG_jug', agente: 'BG_age', supervisor: 'BG_sup' }[r];
        const [s] = await llamar('POST', '/api/db', { op: 'escribir', ruta: `users/${uid}/${campo}`, valor }, tok[r]);
        if (s === 200) fallos.push(`${r} cambió su ${campo}`);
      }
    }
    ok(!fallos.length, 'nadie puede subirse de rango, de saldo ni cambiar su supervisor o su Google' + (fallos.length ? ' → ' + fallos.join('; ') : ''));

    const [sA, jA] = await llamar('POST', '/api/db', { op: 'leer', ruta: 'users' }, tok.agente);
    ok(sA === 200 && Object.keys(jA.valor || {}).sort().join() === 'BG_age,BG_jug', 'un agente solo lee su perfil y el de sus jugadores');
    const [sJ, jJ] = await llamar('POST', '/api/db', { op: 'leer', ruta: 'users' }, tok.jugador);
    ok(sJ === 200 && Object.keys(jJ.valor || {}).sort().join() === 'BG_age,BG_jug' && !jJ.valor.BG_age.email, 'un jugador solo se ve a sí mismo y lo justo de su agente (sin correo)');
  } catch (e) {
    ok(false, 'error inesperado: ' + e.message);
  }
  process.exit(0);
})();
