// Prueba del bono de inscripción: 100 de crédito promocional al registrarse y retiro bloqueado
// hasta depositar al menos 500 CUP. Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { get, set, arrancar, ok } = require('./simulador');

const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
set('credenciales_acceso/ceo-x-com', { email: 'ceo@x.com', uid: 'BG_ceo', salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
set('users/BG_ceo', { uid: 'BG_ceo', email: 'ceo@x.com', activo: true, nombre: 'Jefe', rol: 'superadmin', rolLevel: 3, creditoReal: 0, creditoPromo: 0 });
// Cuenta antigua (sin bono): sigue retirando como siempre.
set('credenciales_acceso/viejo-x-com', { email: 'viejo@x.com', uid: 'BG_viejo', salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
set('users/BG_viejo', { uid: 'BG_viejo', email: 'viejo@x.com', activo: true, nombre: 'Antiguo', rol: 'member', rolLevel: 1, creditoReal: 800, creditoPromo: 0 });
for (let i = 1; i <= 3; i++) set(`codigosAcceso/BONO-${i}`, { code: `BONO-${i}`, createdBy: 'BG_ceo', usado: false, rol: 'member' });

const { llamar } = arrancar({ puerto: 3984, env: { ODDS_API_KEYS: '' } });
const db = (token, op, ruta, extra = {}) => llamar('POST', '/api/db', { op, ruta, ...extra }, token);
const entrar = async (identificador) => (await llamar('POST', '/api/auth/login', { identificador, password: 'clave-1234' }))[1]?.token;
const retiro = (token, uid, id, monto) => db(token, 'escribir', `solicitudesRetiro/${id}`, { valor: { id, userId: uid, estado: 'pendiente', monto } });
const registro = (i) => llamar('POST', '/api/auth/registro', { nombre: `Nuevo ${i}`, apodo: `Novato_${i}`, telefono: `5353${String(i).padStart(4, '0')}`, email: `nuevo${i}@x.com`, password: 'clave-1234', codigo: `BONO-${i}` });

(async () => {
  try {
    await new Promise(r => setTimeout(r, 500));
    let s, j;

    // ---- Registro: entra con 100 de promo ----
    [s, j] = await registro(1);
    const uid = j.uid;
    ok(s === 200 && j.bonoInscripcion === 100, 'al registrarse recibe el bono (respuesta del servidor)');
    ok(get(`users/${uid}/creditoPromo`) === 100 && get(`users/${uid}/creditoReal`) === 0, 'su cuenta empieza con 100 de crédito promocional y 0 real');
    ok(get(`users/${uid}/bonoInscripcion/monto`) === 100, 'la cuenta queda marcada con el bono (para la regla de retiro)');
    const tN = await entrar('nuevo1@x.com');

    // ---- Gana con el bono → no puede retirar sin depositar ----
    set(`users/${uid}/creditoReal`, 60); // lo que ganó apostando el promo (solo la ganancia pasa a real)
    [s, j] = await retiro(tN, uid, 'R1', 60);
    ok(s === 400 && /depositado al menos 500 CUP/.test(j.error), 'no puede retirar sin haber depositado 500 CUP → ' + j.error);

    // ---- No puede hacer trampa escribiendo su contador ----
    [s] = await db(tN, 'escribir', `users/${uid}/depositadoCUP`, { valor: 500 });
    ok(s === 403, 'no puede marcarse a sí mismo como que depositó');
    [s] = await db(tN, 'escribir', `users/${uid}/bonoInscripcion`, { valor: null });
    ok(s === 403, 'ni quitarse la marca del bono');

    // ---- Deposita 500 CUP, se aprueba y ya puede retirar ----
    [s] = await db(tN, 'escribir', 'solicitudesDeposito/D1', { valor: { id: 'D1', userId: uid, estado: 'pendiente', monto: 500, moneda: 'CUP', fotoUrl: 'https://i.ibb.co/x.jpg' } });
    ok(s === 200, 'envía su depósito de 500 CUP');
    [s, j] = await retiro(tN, uid, 'R2', 60);
    ok(s === 400, 'mientras el depósito no se aprueba, sigue sin poder retirar');
    const tC = await entrar('ceo@x.com');
    [s] = await llamar('POST', '/api/solicitudes-deposito/D1/aprobar', {}, tC);
    ok(s === 200 && get(`users/${uid}/depositadoCUP`) === 500 && get(`users/${uid}/creditoReal`) === 560, 'se aprueba: suma 500 a su saldo real y a su total depositado');
    [s] = await retiro(tN, uid, 'R3', 560);
    ok(s === 200, 'con 500 CUP depositados ya puede retirar');

    // ---- Cuentas antiguas: sin cambios ----
    const tV = await entrar('viejo@x.com');
    [s] = await retiro(tV, 'BG_viejo', 'R4', 100);
    ok(s === 200, 'una cuenta antigua (sin bono) retira como siempre');

    // ---- El CEO puede cambiar o apagar el bono ----
    set('config/bonoInscripcion', 0);
    [s, j] = await registro(2);
    ok(s === 200 && j.bonoInscripcion === 0 && get(`users/${j.uid}/creditoPromo`) === 0 && !get(`users/${j.uid}/bonoInscripcion`), 'con config/bonoInscripcion = 0 no hay bono ni bloqueo');
    set('config/bonoInscripcion', 250);
    [s, j] = await registro(3);
    ok(s === 200 && get(`users/${j.uid}/creditoPromo`) === 250, 'con config/bonoInscripcion = 250 el bono es de 250');
  } catch (e) {
    ok(false, 'error inesperado: ' + e.message);
  }
  process.exit(0);
})();
