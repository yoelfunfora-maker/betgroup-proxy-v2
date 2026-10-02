// Prueba de la Etapa 10: antifraude propio (solo avisa, no bloquea). Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { get, set, arrancar, ok } = require('./simulador');

const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
function usuario(uid, datos) {
  const email = `${uid.toLowerCase()}@x.com`;
  set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
  set(`users/${uid}`, { uid, email, activo: true, creditoReal: 1000, creditoPromo: 0, rol: 'member', rolLevel: 1, fecha_registro: Date.now() - 3600000, ...datos });
}
usuario('BG_ceo', { nombre: 'Jefe', rol: 'superadmin', rolLevel: 3, telefono: '5350000000' });
usuario('BG_A', { apodo: 'Alfa', telefono: '5351000001' });
usuario('BG_B', { apodo: 'Beta', telefono: '5351000002' });
usuario('BG_C', { apodo: 'Gamma', telefono: '53 5100 0003' });
usuario('BG_D', { apodo: 'Delta', telefono: '5351000003' });                      // mismo teléfono que C
usuario('BG_E', { apodo: 'Eco', telefono: '5351000005', datosBancarios: { cuenta: '9205 1234 5678 9012' } });
usuario('BG_F', { apodo: 'Foxtrot', telefono: '5351000006', datosBancarios: { cuenta: '9205123456789012' } }); // misma cuenta que E
usuario('BG_G', { apodo: 'Golf', telefono: '5351000007' });
usuario('BG_H', { apodo: 'Hotel', telefono: '5351000008' });
usuario('BG_I', { apodo: 'India', telefono: '5351000009' });
// A y B apuestan a lados opuestos del mismo partido.
set('apuestas/BG_A/a1', { eventoId: '777', tipo: 'Local', monto: 300, fecha: Date.now(), estado: 'pendiente', tipoSaldo: 'real' });
set('apuestas/BG_B/b1', { eventoId: '777', tipo: 'Visitante', monto: 300, fecha: Date.now(), estado: 'pendiente', tipoSaldo: 'real' });
// G deposita 1000, apuesta 100 y pide retirar 900.
set('solicitudesDeposito/S1', { userId: 'BG_G', monto: 1000, estado: 'aprobado', aprobadoEn: Date.now() - 86400000 });
set('apuestas/BG_G/g1', { eventoId: '888', tipo: 'Local', monto: 100, fecha: Date.now(), estado: 'perdida', tipoSaldo: 'real' });
set('solicitudesRetiro/R1', { userId: 'BG_G', monto: 900, estado: 'pendiente', creadoEn: Date.now() });

const { llamar } = arrancar({ puerto: 3988, env: { ODDS_API_KEYS: '' } });
const entrar = async (uid) => (await llamar('POST', '/api/auth/login', { identificador: `${uid.toLowerCase()}@x.com`, password: 'clave-1234' }))[1]?.token;
const hex = (n, c) => c.repeat(n);

(async () => {
  try {
    await new Promise(r => setTimeout(r, 500));
    const tok = {};
    for (const u of ['BG_A', 'BG_B', 'BG_H', 'BG_I', 'BG_ceo']) tok[u] = await entrar(u);

    // A y B entran desde el MISMO móvil; H e I tienen móviles distintos pero idénticos (misma huella).
    let [s] = await llamar('POST', '/api/dispositivo', { id: hex(32, 'a'), huella: hex(64, '1') }, tok.BG_A);
    ok(s === 200, 'el móvil registra su identificador al entrar');
    await llamar('POST', '/api/dispositivo', { id: hex(32, 'a'), huella: hex(64, '1') }, tok.BG_B);
    await llamar('POST', '/api/dispositivo', { id: hex(32, 'c'), huella: hex(64, '9') }, tok.BG_H);
    await llamar('POST', '/api/dispositivo', { id: hex(32, 'd'), huella: hex(64, '9') }, tok.BG_I);
    [s] = await llamar('POST', '/api/dispositivo', { id: 'no-es-valido', huella: 'x' }, tok.BG_A);
    ok(s === 400, 'datos de dispositivo inválidos se rechazan');
    ok(!JSON.stringify(get('dispositivosUso') || {}).includes(hex(32, 'a')), 'el identificador del móvil se guarda cifrado (no se puede leer)');

    // El CEO recalcula
    let j;
    [s] = await llamar('POST', '/api/admin/riesgo/recalcular', {}, tok.BG_A);
    ok(s === 403, 'un miembro no puede ver ni recalcular el riesgo');
    [s, j] = await llamar('POST', '/api/admin/riesgo/recalcular', {}, tok.BG_ceo);
    const de = (uid) => (j.usuarios || []).find(u => u.uid === uid) || { puntos: 0, nivel: 'normal', senales: [] };
    const codigos = (uid) => de(uid).senales.map(x => x.codigo).sort().join(',');
    ok(s === 200 && codigos('BG_A') === 'dispositivo,opuestas' && de('BG_A').puntos === 70 && de('BG_A').nivel === 'alto',
      `A: mismo móvil que B + apuestas opuestas → ${de('BG_A').puntos} pts (${de('BG_A').nivel})`);
    ok(de('BG_A').senales.find(x => x.codigo === 'dispositivo').con[0].apodo === 'Beta', 'el CEO ve con quién está vinculada (apodo y nombre)');
    ok(codigos('BG_C') === 'telefono' && de('BG_C').nivel === 'revisar', `C y D: mismo teléfono escrito distinto → ${de('BG_C').puntos} pts (revisar)`);
    ok(codigos('BG_E') === 'banco' && de('BG_F').puntos === 35, 'E y F: misma cuenta bancaria (con y sin espacios) → 35 pts');
    ok(codigos('BG_G') === 'retiroSinApostar' && de('BG_G').puntos === 25, 'G: pide retirar 900 tras apostar solo 100 de 1000 depositados → 25 pts');
    ok(codigos('BG_H') === 'huella' && de('BG_H').nivel === 'normal', 'H e I: solo móviles idénticos (señal débil) → nivel normal');
    ok(de('BG_ceo').puntos === 0, 'quien no tiene señales no aparece');
    ok(get('users/BG_A/activo') === true && get('users/BG_A/creditoReal') === 1000, 'nadie es bloqueado ni pierde saldo: solo es un aviso');

    // La web no puede leer nada de esto
    for (const nodo of ['riesgo', 'perfilRiesgo', 'dispositivosUso', 'huellasUso']) {
      [s] = await llamar('POST', '/api/db', { op: 'leer', ruta: nodo }, tok.BG_ceo);
      ok(s === 403, `/api/db no deja leer "${nodo}" (ni al CEO)`);
    }
    [s, j] = await llamar('GET', '/api/admin/riesgo', null, tok.BG_ceo);
    ok(s === 200 && j.usuarios.length >= 7, 'el CEO ve la lista de riesgo ordenada por puntos');
  } catch (e) {
    ok(false, 'error inesperado: ' + e.message);
  }
  process.exit(0);
})();
