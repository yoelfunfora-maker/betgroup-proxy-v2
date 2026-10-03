// Prueba de los avisos: cifrado Web Push (RFC 8291/8292), bandeja personal y general, permisos,
// y avisos automáticos (bienvenida, depósito aprobado, apuesta ganada/perdida/anulada).
// Ejecutar: npm test
'use strict';

const crypto = require('crypto');
const { cifrar, limpiarSuscripcion, crearWebPush } = require('../lib/webpush');
const { get, set, arrancar, ok } = require('./simulador');

// ---------- 1. Vector oficial del RFC 8291 (Apéndice A) ----------
{
  const efimera = crypto.createECDH('prime256v1');
  efimera.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
  const salida = cifrar('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg'
  }, { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), efimera });
  ok(salida.toString('base64url') === 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    'el cifrado del aviso coincide byte a byte con el ejemplo oficial del estándar (RFC 8291)');
}

// Un "teléfono" de prueba: genera sus claves como lo hace el navegador.
function telefono(endpoint) {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, sub: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}
// Descifra como lo haría el teléfono (RFC 8291 + RFC 8188), para comprobar que el aviso le llega.
function descifrar(cuerpo, tel) {
  const salt = cuerpo.subarray(0, 16);
  const idlen = cuerpo[20];
  const asPublica = cuerpo.subarray(21, 21 + idlen);
  const datos = cuerpo.subarray(21 + idlen);
  const h = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const ecdhSecreto = tel.ecdh.computeSecret(asPublica);
  const ua = tel.ecdh.getPublicKey();
  const ikm = h(h(tel.auth, ecdhSecreto), Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublica, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(datos.subarray(datos.length - 16));
  const plano = Buffer.concat([d.update(datos.subarray(0, datos.length - 16)), d.final()]);
  return JSON.parse(plano.subarray(0, plano.lastIndexOf(2)).toString('utf8'));
}

// ---------- 2. Solo se envía a servicios de push reales (evita SSRF) ----------
{
  const t = telefono('https://fcm.googleapis.com/fcm/send/abc');
  ok(!!limpiarSuscripcion(t.sub), 'acepta un teléfono de Google (fcm.googleapis.com)');
  ok(!limpiarSuscripcion({ ...t.sub, endpoint: 'https://evil.example.com/x' }), 'rechaza enviar avisos a un servidor cualquiera');
  ok(!limpiarSuscripcion({ ...t.sub, endpoint: 'http://fcm.googleapis.com/x' }), 'rechaza direcciones sin cifrar (http)');
  ok(!limpiarSuscripcion({ ...t.sub, endpoint: 'https://fcm.googleapis.com:8443/x' }), 'rechaza puertos raros');
  ok(!limpiarSuscripcion({ ...t.sub, keys: { p256dh: 'AAAA', auth: t.sub.keys.auth } }), 'rechaza claves del teléfono no válidas');
}

(async () => {
  try {
    // ---------- 3. Envío real cifrado + identificación VAPID ----------
    {
      const enviados = [];
      const memoria = {};
      const dbFalsa = { ref: (p) => ({
        once: async () => ({ val: () => memoria[p] || null }),
        transaction: async (fn) => { const v = fn(memoria[p] || null); if (v !== undefined) memoria[p] = v; return { committed: v !== undefined }; }
      }) };
      const wp = crearWebPush({ db: dbFalsa, secreto: 'x'.repeat(40), enviar: async (url, op) => { enviados.push({ url, op }); return { status: 201 }; } });
      const tel = telefono('https://updates.push.services.mozilla.com/wpush/v2/abc');
      const r = await wp.enviarA({ endpoint: tel.sub.endpoint, p256dh: tel.sub.keys.p256dh, auth: tel.sub.keys.auth }, { titulo: '¡Ganaste 290 CR!', texto: 'A vs B' });
      ok(r.ok && enviados.length === 1, 'el aviso se envía al servicio de push del teléfono');
      const aviso = descifrar(enviados[0].op.body, tel);
      ok(aviso.titulo === '¡Ganaste 290 CR!', 'solo el teléfono puede descifrar el aviso, y llega completo');
      ok(enviados[0].op.headers['Content-Encoding'] === 'aes128gcm', 'cabecera de cifrado estándar (aes128gcm)');
      const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(enviados[0].op.headers.Authorization) || [];
      const [cab, carga, firma] = (jwt || '').split('.');
      const pub = Buffer.from(k, 'base64url');
      const clave = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
      const firmaOk = crypto.verify('sha256', Buffer.from(cab + '.' + carga), { key: clave, dsaEncoding: 'ieee-p1363' }, Buffer.from(firma, 'base64url'));
      const datos = JSON.parse(Buffer.from(carga, 'base64url').toString());
      ok(firmaOk && datos.aud === 'https://updates.push.services.mozilla.com' && datos.exp > Date.now() / 1000, 'el servidor se identifica con una firma ES256 válida (RFC 8292)');
      ok(memoria['secretos/vapid'] && memoria['secretos/vapid'].privada.alg === 'AES-256-GCM' && !JSON.stringify(memoria['secretos/vapid']).includes('PRIVATE KEY'),
        'la clave privada del servidor se guarda cifrada (AES-256-GCM), nunca en claro');
      const caducada = crearWebPush({ db: dbFalsa, secreto: 'x'.repeat(40), enviar: async () => ({ status: 410 }) });
      ok((await caducada.enviarA({ endpoint: tel.sub.endpoint, p256dh: tel.sub.keys.p256dh, auth: tel.sub.keys.auth }, { titulo: 'x' })).caducada, 'si el teléfono ya no existe (410) se marca para borrarlo');
    }

    // ---------- 4. Bandeja y avisos automáticos (servidor completo) ----------
    const legado = (pw, sal) => crypto.createHash('sha256').update(pw + sal + 'BetGroup-S3cr3t0-2026').digest('hex');
    const usuario = (uid, email, datos) => {
      set(`credenciales_acceso/${email.replace(/\./g, '-').replace(/@/g, '-')}`, { email, uid, salt: '0a0b0c0d', hash: legado('clave-1234', '0a0b0c0d') });
      set(`users/${uid}`, { uid, email, activo: true, creditoReal: 0, creditoPromo: 0, ...datos });
    };
    usuario('BG_ceo', 'ceo@x.com', { nombre: 'Jefe', rol: 'superadmin', rolLevel: 3 });
    usuario('BG_otro', 'otro@x.com', { nombre: 'Otro', rol: 'member', rolLevel: 1 });
    set('codigosAcceso/AV-1', { code: 'AV-1', createdBy: 'BG_ceo', usado: false, rol: 'member' });
    set('config', { minBet: 100, maxBet: 500 });

    const { llamar } = arrancar({ puerto: 3986, env: { ODDS_API_KEYS: '' } });
    await new Promise(r => setTimeout(r, 500));
    const entrar = async (id) => (await llamar('POST', '/api/auth/login', { identificador: id, password: 'clave-1234' }))[1]?.token;
    let s, j;

    [s, j] = await llamar('POST', '/api/auth/registro', { nombre: 'Rosa Nueva', apodo: 'Gacela_9', telefono: '53530099', email: 'rosa@x.com', password: 'clave-1234', codigo: 'AV-1' });
    const uid = j.uid;
    const tR = await entrar('rosa@x.com');
    [s, j] = await llamar('GET', '/api/notificaciones', null, tR);
    ok(s === 200 && j.noLeidas === 1 && j.avisos[0].tipo === 'bienvenida', 'al registrarse recibe el aviso de bienvenida (1 sin leer) → ' + (j.avisos[0] || {}).titulo);

    // Aviso al CEO: alguien nuevo entró
    await new Promise(r => setTimeout(r, 200));
    const avisosCeo = Object.values(get('notificaciones/BG_ceo') || {});
    ok(avisosCeo.some(a => a.tipo === 'nuevo_miembro' && /Gacela_9 se registró/.test(a.texto)), 'el CEO recibe "Nuevo miembro en BetGroup" → ' + ((avisosCeo.find(a => a.tipo === 'nuevo_miembro') || {}).texto));
    ok(!Object.values(get('notificaciones/BG_otro') || {}).some(a => a.tipo === 'nuevo_miembro'), 'un jugador cualquiera no recibe ese aviso');

    // Depósito aprobado
    const tC = await entrar('ceo@x.com');
    set('solicitudesDeposito/D1', { id: 'D1', userId: uid, nombre: 'Rosa Nueva', monto: 500, moneda: 'CUP', estado: 'pendiente', creadoEn: Date.now() });
    [s] = await llamar('POST', '/api/solicitudes-deposito/D1/aprobar', {}, tC);
    [, j] = await llamar('GET', '/api/notificaciones', null, tR);
    ok(s === 200 && j.avisos[0].tipo === 'deposito' && /500 CUP/.test(j.avisos[0].texto), 'al aprobarle el depósito le llega "Depósito aprobado" → ' + j.avisos[0].texto);

    // Apuestas liquidadas: ganada, perdida y anulada
    const ap = (id, tipo, extra = {}) => set(`apuestas/${uid}/${id}`, { eventoId: 'E9', eventoNombre: 'Arsenal vs Leeds', tipo, monto: 100, cuota: 2.9, estado: 'pendiente', saldoCampo: 'creditoReal', tipoSaldo: 'real', fecha: Date.now(), ...extra });
    ap('A1', 'Local'); ap('A2', 'Visitante');
    [s] = await llamar('POST', '/api/apuestas/liquidar', { partidoId: 'E9', marcador: '2-1' }, tC);
    [, j] = await llamar('GET', '/api/notificaciones', null, tR);
    const gano = j.avisos.find(a => a.tipo === 'ganada');
    const perdio = j.avisos.find(a => a.tipo === 'perdida');
    ok(s === 200 && gano && /Ganaste 290 CR/.test(gano.titulo), 'apuesta ganada → "' + (gano || {}).titulo + '"');
    ok(perdio && /terminó 2-1/.test(perdio.texto), 'apuesta perdida → "' + (perdio || {}).texto + '"');
    ap('A3', 'Local', { eventoId: 'E10', eventoNombre: 'Genoa vs Fiorentina' });
    await llamar('POST', '/api/apuestas/liquidar', { partidoId: 'E10', resultadoGanador: 'ANULADA' }, tC);
    [, j] = await llamar('GET', '/api/notificaciones', null, tR);
    ok(j.avisos[0].tipo === 'anulada' && /devolvimos 100 CR/.test(j.avisos[0].titulo), 'apuesta anulada → "' + j.avisos[0].titulo + '"');
    ok(j.noLeidas === 5, 'los avisos se acumulan: 5 sin leer');

    // Marcar como leídos
    [s, j] = await llamar('POST', '/api/notificaciones/leer', { ids: [j.avisos[0].id] }, tR);
    ok(s === 200 && j.noLeidas === 4, 'marca uno como leído → quedan 4');
    [s, j] = await llamar('POST', '/api/notificaciones/leer', { todas: true }, tR);
    ok(s === 200 && j.noLeidas === 0, 'marca todos como leídos → 0');

    // Aviso general del CEO (ofertas) → lo ve todo el mundo, cada uno con su "leído"
    [s] = await llamar('POST', '/api/admin/aviso-general', { titulo: 'Cuotas de la tarde', texto: 'Arsenal ×1.45' }, tR);
    ok(s === 403, 'un jugador no puede mandar avisos a todos');
    [s] = await llamar('POST', '/api/admin/aviso-general', { titulo: 'Cuotas de la tarde', texto: 'Arsenal ×1.45 <script>' }, tC);
    const tO = await entrar('otro@x.com');
    const [, jR] = await llamar('GET', '/api/notificaciones', null, tR);
    const [, jO] = await llamar('GET', '/api/notificaciones', null, tO);
    ok(s === 200 && jR.avisos[0].general && jO.avisos.some(a => a.titulo === 'Cuotas de la tarde'), 'el aviso general del CEO les llega a todos los inscritos');
    ok(!/[<>]/.test(jR.avisos[0].texto), 'el texto de los avisos se limpia (sin < >)');
    await llamar('POST', '/api/notificaciones/leer', { todas: true }, tO);
    const [, jR2] = await llamar('GET', '/api/notificaciones', null, tR);
    ok(jR2.noLeidas === 1, 'que otra persona lo lea no lo marca como leído para ti');
    ok(!jO.avisos.some(a => a.tipo === 'bienvenida' || a.tipo === 'ganada'), 'nadie ve los avisos personales de otro');

    // Nadie puede leer la bandeja ajena por la vía genérica
    [s] = await llamar('POST', '/api/db', { op: 'leer', ruta: `notificaciones/${uid}` }, tO);
    ok(s === 403, 'la bandeja de otro no se puede leer por /api/db');
    [s] = await llamar('POST', '/api/db', { op: 'leer', ruta: 'secretos/vapid' }, tC);
    ok(s === 403, 'la clave de las notificaciones no la puede leer nadie desde la web, ni el CEO');

    // Suscripción del teléfono
    const tel = telefono('https://fcm.googleapis.com/fcm/send/rosa1');
    [s] = await llamar('POST', '/api/push/suscribir', { suscripcion: tel.sub }, tR);
    ok(s === 200 && Object.keys(get(`suscripcionesPush/${uid}`) || {}).length === 1, 'el teléfono queda suscrito para recibir avisos');
    [s] = await llamar('POST', '/api/push/suscribir', { suscripcion: { ...tel.sub, endpoint: 'https://evil.example.com/x' } }, tR);
    ok(s === 400, 'no se acepta un "teléfono" que apunte a otro servidor');
    [s, j] = await llamar('GET', '/api/push/clave');
    ok(s === 200 && Buffer.from(j.clave, 'base64url').length === 65, 'la web obtiene la clave pública del servidor para suscribirse');
    [s] = await llamar('POST', '/api/push/baja', { endpoint: tel.sub.endpoint }, tR);
    ok(s === 200 && !get(`suscripcionesPush/${uid}`), 'puede darse de baja');
  } catch (e) {
    ok(false, 'excepción: ' + e.message);
  }
  process.exit(0);
})();
