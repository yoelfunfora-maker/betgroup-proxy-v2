// Prueba de la Etapa 3 (permisos de /api/db y operaciones). Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { get, set, arrancar, ok } = require('./simulador');

const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, email, pw, datos) {
  const clave = email.replace(/\./g, '-').replace(/@/g, '-');
  set(`credenciales_acceso/${clave}`, { email, uid, salt: '0a0b0c0d', hash: legado(pw, '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, hash: 'viejo', salt: 'viejo', ...datos });
}

// Datos: un CEO, un director, un subadmin con 3 miembros (por uid, por código fijo y por código dinámico) y un extraño.
usuario('BG_ceo', 'ceo@x.com', 'ceo-clave-1', { nombre: 'Jefe', rol: 'superadmin', rolLevel: 3 });
usuario('BG_dir', 'dir@x.com', 'dir-clave-1', { nombre: 'Dire', rol: 'director', rolLevel: 2.8 });
usuario('BG_sub', 'sub@x.com', 'sub-clave-1', { nombre: 'Sub Admin', rol: 'subadmin', rolLevel: 2, codigoInvitacion: 'BGSUB1', telefono: '5355500001', datosBancarios: { banco: 'BANDEC', titular: 'Sub', cuenta: '9200', telefono: '5355500001' } });
usuario('BG_m1', 'm1@x.com', 'm1-clave-1', { nombre: 'Miembro Uno', rol: 'member', rolLevel: 1, referidoPorUid: 'BG_sub', telefono: '5355511111', creditoReal: 500 });
usuario('BG_m2', 'm2@x.com', 'm2-clave-1', { nombre: 'Miembro Dos', rol: 'member', rolLevel: 1, referidoPor: 'BGSUB1' });
usuario('BG_m3', 'm3@x.com', 'm3-clave-1', { nombre: 'Miembro Tres', rol: 'member', rolLevel: 1, referidoPor: 'SA-20261001-1' });
usuario('BG_otro', 'otro@x.com', 'otro-clave-1', { nombre: 'Extraño', rol: 'member', rolLevel: 1 });
set('codigosAcceso/SA-20261001-1', { codigo: 'SA-20261001-1', generadoPor: 'BG_sub', usado: true, rol: 'member' });
set('codigosAcceso/MBR-LIBRE1', { code: 'MBR-LIBRE1', createdBy: 'BG_ceo', usado: false, rol: 'member' });
set('apuestas/BG_m1/b1', { estado: 'pendiente', monto: 100, cuota: 2 });
set('apuestas/BG_otro/b2', { estado: 'pendiente', monto: 100, cuota: 2 });
set('config', { minBet: 100, maxBet: 500 });

const { llamar } = arrancar({ puerto: 3997, env: { ODDS_API_KEYS: '' } });
const db = (token, op, ruta, extra = {}) => llamar('POST', '/api/db', { op, ruta, ...extra }, token);
const entrar = async (identificador, password) => (await llamar('POST', '/api/auth/login', { identificador, password }))[1]?.token;

setTimeout(async () => {
  try {
    let [s, j] = await db(null, 'leer', 'users');
    ok(s === 401, 'sin sesión no se lee nada → ' + s);

    const tM1 = await entrar('m1@x.com', 'm1-clave-1');
    const tSub = await entrar('sub@x.com', 'sub-clave-1');
    const tDir = await entrar('dir@x.com', 'dir-clave-1');
    const tCeo = await entrar('ceo@x.com', 'ceo-clave-1');
    const tOtro = await entrar('5355511111', 'm1-clave-1');
    ok(tM1 && tSub && tDir && tCeo, 'los 4 roles inician sesión');
    ok(Boolean(tOtro), 'login por teléfono funciona');

    // ---- Miembro ----
    [s, j] = await db(tM1, 'leer', 'users');
    const vistos = Object.keys(j.valor || {}).sort();
    ok(s === 200 && vistos.join() === 'BG_m1,BG_sub', 'miembro ve solo su perfil y a su subadmin: ' + vistos.join());
    ok(j.valor.BG_sub && j.valor.BG_sub.email === undefined && j.valor.BG_sub.datosBancarios, 'del subadmin solo ve nombre y datos bancarios');
    ok(!('hash' in j.valor.BG_m1) && !('salt' in j.valor.BG_m1), 'su propio perfil sale sin hash ni sal');
    [s] = await db(tM1, 'leer', 'users/BG_otro');
    ok(s === 403, 'miembro no puede leer a otro usuario → ' + s);
    [s, j] = await db(tM1, 'leer', 'users/BG_m1/creditoReal');
    ok(s === 200 && j.valor === 500, 'miembro lee su saldo');
    [s] = await db(tM1, 'escribir', 'users/BG_m1/creditoReal', { valor: 999999 });
    ok(s === 403 && get('users/BG_m1/creditoReal') === 500, 'miembro NO puede cambiar su saldo → ' + s);
    [s] = await db(tM1, 'actualizar', 'users/BG_m1', { valor: { rol: 'superadmin', rolLevel: 3 } });
    ok(s === 403 && get('users/BG_m1/rol') === 'member', 'miembro NO puede hacerse CEO → ' + s);
    [s] = await db(tM1, 'escribir', 'users/BG_m1/datosBancarios', { valor: { banco: 'B', titular: 'T', cuenta: '1', telefono: '5' } });
    ok(s === 200 && get('users/BG_m1/datosBancarios/banco') === 'B', 'miembro guarda sus datos bancarios');
    [s] = await db(tM1, 'escribir', 'users/BG_m1/datosBancarios', { valor: { banco: '<img src=x onerror=alert(1)>', titular: 'T', cuenta: '1', telefono: '5' } });
    ok(s === 400, 'texto con HTML rechazado (XSS guardado) → ' + s);
    [s] = await db(tM1, 'escribir', 'apuestas/BG_m1/b1/estado', { valor: 'ganada' });
    ok(s === 403 && get('apuestas/BG_m1/b1/estado') === 'pendiente', 'miembro NO puede marcar su apuesta como ganada → ' + s);
    [s, j] = await db(tM1, 'leer', 'apuestas');
    ok(s === 200 && Object.keys(j.valor || {}).join() === 'BG_m1', 'miembro solo ve sus apuestas');
    [s] = await db(tM1, 'leer', 'credenciales_acceso');
    ok(s === 403, 'credenciales_acceso inaccesibles → ' + s);
    [s] = await db(tCeo, 'leer', 'credenciales_servidor');
    ok(s === 403, 'credenciales_servidor inaccesibles incluso para el CEO → ' + s);
    [s] = await db(tM1, 'escribir', 'config/minBet', { valor: 1 });
    ok(s === 403, 'miembro no cambia la configuración → ' + s);
    [s, j] = await db(tM1, 'leer', 'config');
    ok(s === 200 && j.valor.minBet === 100, 'miembro lee la configuración');
    [s, j] = await db(tM1, 'agregar', 'auditLog', { valor: { action: 'X', uid: 'BG_ceo', details: { a: 1 } } });
    ok(s === 200 && get(`auditLog/${j.clave}/uid`) === 'BG_m1', 'auditLog: el servidor pone el autor real (no se puede suplantar)');
    [s] = await db(tM1, 'escribir', 'solicitudesRetiro/RET1', { valor: { id: 'RET1', userId: 'BG_m1', estado: 'pendiente', monto: 100000 } });
    ok(s === 400, 'retiro mayor que el saldo rechazado → ' + s);
    [s] = await db(tM1, 'escribir', 'solicitudesDeposito/DEP1', { valor: { id: 'DEP1', userId: 'BG_m1', estado: 'pendiente', monto: 200, moneda: 'CUP', fotoUrl: 'https://i.ibb.co/x.jpg' } });
    ok(s === 200, 'miembro crea su solicitud de depósito');
    [s] = await db(tM1, 'escribir', 'solicitudesDeposito/DEP2', { valor: { id: 'DEP2', userId: 'BG_otro', estado: 'pendiente', monto: 200, moneda: 'CUP' } });
    ok(s === 400, 'no puede crear solicitudes a nombre de otro → ' + s);
    [s] = await db(tM1, 'actualizar', 'users/BG_m1', { valor: { autoexcludedUntil: Date.now() + 86400000, activo: false } });
    ok(s === 200 && get('users/BG_m1/activo') === false, 'miembro puede autoexcluirse');
    set('users/BG_m1/activo', true);
    set('users/BG_m1/autoexcludedUntil', null);

    // ---- Subadmin ----
    [s, j] = await db(tSub, 'leer', 'users');
    const miembros = Object.keys(j.valor || {}).sort().join();
    ok(miembros === 'BG_m1,BG_m2,BG_m3,BG_sub', 'subadmin ve a sus 3 miembros (por uid, código fijo y código dinámico): ' + miembros);
    [s] = await db(tSub, 'leer', 'apuestas/BG_m1');
    ok(s === 200, 'subadmin ve apuestas de su miembro');
    [s] = await db(tSub, 'leer', 'apuestas/BG_otro');
    ok(s === 403, 'subadmin NO ve apuestas de extraños → ' + s);
    [s, j] = await db(tSub, 'leer', 'codigosAcceso');
    ok(Object.keys(j.valor || {}).join() === 'SA-20261001-1', 'subadmin solo ve sus códigos');
    [s] = await db(tSub, 'escribir', 'codigosAcceso/SA-NUEVO-1', { valor: { codigo: 'SA-NUEVO-1', generadoPor: 'BG_sub', usado: false, rol: 'member' } });
    ok(s === 200, 'subadmin crea código de miembro');
    [s] = await db(tSub, 'escribir', 'codigosAcceso/SA-NUEVO-2', { valor: { codigo: 'SA-NUEVO-2', generadoPor: 'BG_sub', usado: false, rol: 'director' } });
    ok(s === 403, 'subadmin NO crea códigos de director → ' + s);
    [s] = await db(tSub, 'escribir', 'depositos/DEP-A', { valor: { depositoId: 'DEP-A', userId: 'BG_m1', moneda: 'CUP', monto: 300, fotoUrl: 'https://i.ibb.co/r.jpg', estado: 'pending', solicitadoPor: 'BG_sub' } });
    ok(s === 200, 'subadmin pide recarga para su miembro');
    [s] = await db(tSub, 'escribir', 'depositos/DEP-B', { valor: { depositoId: 'DEP-B', userId: 'BG_otro', moneda: 'CUP', monto: 300, estado: 'pending', solicitadoPor: 'BG_sub' } });
    ok(s === 403, 'subadmin NO pide recargas para extraños → ' + s);
    [s] = await llamar('POST', '/api/depositos/DEP-A/aprobar', {}, tSub);
    ok(s === 403, 'subadmin NO aprueba recargas → ' + s);

    // ---- Director ----
    const antes = get('users/BG_m1/creditoReal');
    const dobles = await Promise.all([1, 2].map(() => llamar('POST', '/api/depositos/DEP-A/aprobar', {}, tDir)));
    ok(dobles.filter(([x]) => x === 200).length === 1 && get('users/BG_m1/creditoReal') === antes + 300, 'director aprueba la recarga UNA sola vez (doble clic): ' + antes + ' → ' + get('users/BG_m1/creditoReal'));
    [s] = await llamar('POST', '/api/solicitudes-deposito/DEP1/aprobar', {}, tDir);
    ok(s === 200 && get('users/BG_m1/creditoReal') === antes + 500 && get('solicitudesDeposito/DEP1/estado') === 'aprobado', 'director aprueba la solicitud del miembro');
    [s] = await llamar('POST', '/api/admin/ajustar-saldo', { uid: 'BG_m1', tipo: 'real', monto: 50, motivo: 'x' }, tDir);
    ok(s === 403, 'director NO hace ajustes de CEO → ' + s);

    // ---- CEO ----
    [s] = await llamar('POST', '/api/admin/ajustar-saldo', { uid: 'BG_m1', tipo: 'real', monto: -999999, motivo: 'prueba' }, tCeo);
    ok(s === 400, 'ajuste que deja saldo negativo rechazado → ' + s);
    [s] = await llamar('POST', '/api/admin/ajustar-saldo', { uid: 'BG_m1', tipo: 'promo', monto: 25, motivo: 'bono' }, tCeo);
    ok(s === 200 && get('users/BG_m1/creditoPromo') === 25, 'CEO ajusta saldo promo con motivo');
    [s] = await llamar('POST', '/api/admin/asignar-rol', { uid: 'BG_m2', rol: 'subadmin' }, tCeo);
    ok(s === 200 && get('users/BG_m2/rolLevel') === 2, 'CEO asigna rol');
    [s] = await db(tCeo, 'escribir', 'users/BG_m2/rol', { valor: 'superadmin' });
    ok(s === 403, 'ni el CEO cambia roles por la vía genérica (solo por su botón) → ' + s);
    [s, j] = await db(tCeo, 'comparar', 'config/minBet', { esperado: 100, valor: 150 });
    ok(s === 200 && j.aplicado && get('config/minBet') === 150, 'transacción optimista del CEO aplicada');
    [s, j] = await db(tCeo, 'comparar', 'config/minBet', { esperado: 100, valor: 200 });
    ok(s === 200 && !j.aplicado && get('config/minBet') === 150, 'transacción con valor viejo no se aplica');
    [s, j] = await llamar('POST', '/api/admin/restablecer-clave', { uid: 'BG_m3' }, tCeo);
    ok(s === 200 && (await entrar('m3@x.com', j.claveTemporal)), 'CEO genera contraseña temporal y funciona');

    // ---- Registro ----
    const nuevo = { nombre: 'Nuevo', telefono: '5355599999', email: 'nuevo@x.com', password: 'clave-nueva-1', codigo: 'MBR-LIBRE1', apodo: 'Halcon_99' };
    [s] = await llamar('POST', '/api/auth/registro', { ...nuevo, password: 'corta' });
    ok(s === 400, 'contraseña corta rechazada → ' + s);
    [s] = await llamar('POST', '/api/auth/registro', { ...nuevo, nombre: '<script>alert(1)</script>' });
    ok(s === 400, 'nombre con HTML rechazado → ' + s);
    [s, j] = await llamar('POST', '/api/auth/registro', nuevo);
    ok(s === 200 && get('codigosAcceso/MBR-LIBRE1/usado') === true, 'registro crea la cuenta y gasta el código');
    ok(get(`users/${j.uid}/rol`) === 'member' && get(`users/${j.uid}/referidoPorUid`) === 'BG_ceo', 'el nuevo usuario es miembro y queda ligado a quien creó el código');
    ok(!get('credenciales_acceso/nuevo-x-com/hash'), 'no se guarda ningún hash legible');
    ok(Boolean(await entrar('nuevo@x.com', 'clave-nueva-1')), 'el nuevo usuario inicia sesión');
    [s] = await llamar('POST', '/api/auth/registro', { ...nuevo, email: 'otro2@x.com', apodo: 'Otro_Halcon' });
    ok(s === 400, 'código ya usado rechazado → ' + s);
    [s, j] = await llamar('POST', '/api/auth/recuperar', { identificador: 'noexiste@x.com' });
    ok(s === 200 && /Si la cuenta existe/.test(j.mensaje), 'recuperar no revela si el usuario existe');

    [s] = await db(tCeo, 'escribir', 'users/BG_otro', { valor: null });
    ok(s === 200 && get('users/BG_otro') === null, 'CEO elimina un usuario');
    [s] = await db(tM1, 'leer', 'auditLog');
    ok(s === 200 && j && (await db(tM1, 'leer', 'auditLog'))[1].valor === null, 'miembro no ve el auditLog');
  } catch (e) {
    console.log('❌ excepción en la prueba: ' + e.stack);
  }
  process.exit(0);
}, 600);
