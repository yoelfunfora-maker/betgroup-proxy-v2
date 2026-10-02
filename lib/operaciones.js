'use strict';

// ==================== OPERACIONES CON DINERO Y ADMINISTRACIÓN ====================
// Lo que antes hacía el navegador escribiendo directamente en Firebase
// (sumar saldo, cambiar roles, registrar usuarios) ahora pasa solo por aquí:
// validado, atómico y auditado.

const crypto = require('crypto');
const { NIVEL, EMAIL_RE, normalizarClave } = require('./autenticacion');
const { esUid, texto } = require('./validacion');
const { centavos } = require('./apuestas');
const { DIRECTOR, revisarTextos, Invalido } = require('./politicas');

const ROLES = Object.freeze({ member: 1, subadmin: 2, director: 2.8, superadmin: 3 });
const LIMITES_POR_DEFECTO = Object.freeze({ cupDailyLimit: 5000, cupMonthlyLimit: 20000, mlcDailyLimit: 500, mlcMonthlyLimit: 2000 });
const CODIGO_RE = /^[A-Z0-9ÁÉÍÓÚÑÜ-]{3,40}$/;

class ErrorOperacion extends Error {
  constructor(estado, mensaje) {
    super(mensaje);
    this.estado = estado;
  }
}

function crearOperaciones({ db, auditoria, auth, config, notificarTelegram, escaparHtml }) {
  // Cambia el estado de un depósito una sola vez (pendiente → otro). Devuelve el registro o null.
  async function cerrarRegistro(ruta, estadoPendiente, cambios) {
    let resultado = null;
    const tx = await db.ref(ruta).transaction((r) => {
      resultado = null;
      if (r === null) return null; // fuerza la lectura real (ver lib/apuestas.js)
      if (r.estado !== estadoPendiente) return undefined;
      resultado = { ...r, ...cambios };
      return resultado;
    });
    return tx.committed ? resultado : null;
  }

  async function sumarSaldo(uid, campo, monto) {
    let final = null;
    const tx = await db.ref(`users/${uid}/${campo}`).transaction((actual) => {
      // Primera llamada con null sin caché: para restas se devuelve null y Firebase relee el valor real.
      if (actual === null && monto < 0) { final = null; return null; }
      final = centavos((Number(actual) || 0) + monto);
      if (final < 0) return undefined; // nunca saldo negativo
      return final;
    });
    if (!tx.committed || final === null) throw new ErrorOperacion(400, 'El saldo no puede quedar negativo');
    return final;
  }

  async function leerLimites() {
    const c = (await db.ref('config').once('value')).val() || {};
    const r = {};
    for (const [k, v] of Object.entries(LIMITES_POR_DEFECTO)) r[k] = Number(c[k]) > 0 ? Number(c[k]) : v;
    return r;
  }

  // ---------- Recargas que pide un subadmin (nodo depositos) ----------
  async function aprobarDeposito(req, id) {
    const dep = (await db.ref(`depositos/${id}`).once('value')).val();
    if (!dep || dep.estado !== 'pending') throw new ErrorOperacion(404, 'Recarga no encontrada o ya procesada');
    const monto = Number(dep.monto);
    if (!esUid(dep.userId) || !(monto > 0)) throw new ErrorOperacion(400, 'Recarga mal formada');

    // Límites diario y mensual por moneda (antes solo los miraba el navegador).
    const lim = await leerLimites();
    const ahora = new Date();
    const inicioDia = new Date(ahora).setHours(0, 0, 0, 0);
    const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1).getTime();
    const delUsuario = (await db.ref('depositos').orderByChild('userId').equalTo(dep.userId).once('value')).val() || {};
    let dia = 0;
    let mes = 0;
    for (const d of Object.values(delUsuario)) {
      if (d && d.estado === 'approved' && d.moneda === dep.moneda) {
        if (d.fecha >= inicioDia) dia += Number(d.monto) || 0;
        if (d.fecha >= inicioMes) mes += Number(d.monto) || 0;
      }
    }
    const limDia = dep.moneda === 'MLC' ? lim.mlcDailyLimit : lim.cupDailyLimit;
    const limMes = dep.moneda === 'MLC' ? lim.mlcMonthlyLimit : lim.cupMonthlyLimit;
    if (dia + monto > limDia) throw new ErrorOperacion(400, `Límite diario excedido (${limDia})`);
    if (mes + monto > limMes) throw new ErrorOperacion(400, `Límite mensual excedido (${limMes})`);

    const cerrado = await cerrarRegistro(`depositos/${id}`, 'pending', {
      estado: 'approved', aprobadoPor: req.usuario.uid, aprobadoPorNombre: req.usuario.datos.nombre || null, aprobadoEn: Date.now()
    });
    if (!cerrado) throw new ErrorOperacion(409, 'Esta recarga ya fue procesada');
    const saldo = await sumarSaldo(dep.userId, 'creditoReal', monto);
    await auditoria.registrarSeguro({ accion: 'recarga_aprobada', actor: req.usuario.uid, objetivo: dep.userId, requestId: req.id, detalles: { id, monto, moneda: dep.moneda } });
    await notificarTelegram(`✅ <b>Recarga aprobada</b>\nPor: ${escaparHtml(req.usuario.datos.nombre || '')}\nMonto: ${monto} ${escaparHtml(dep.moneda || '')}`);
    return { saldo };
  }

  async function rechazarDeposito(req, id) {
    const cerrado = await cerrarRegistro(`depositos/${id}`, 'pending', {
      estado: 'rejected', rechazadoPor: req.usuario.uid, rechazadoEn: Date.now()
    });
    if (!cerrado) throw new ErrorOperacion(409, 'Esta recarga ya fue procesada');
    await auditoria.registrarSeguro({ accion: 'recarga_rechazada', actor: req.usuario.uid, objetivo: id, requestId: req.id });
    return {};
  }

  // ---------- Solicitudes que hace el propio usuario (nodo solicitudesDeposito) ----------
  async function aprobarSolicitud(req, id) {
    const sol = (await db.ref(`solicitudesDeposito/${id}`).once('value')).val();
    if (!sol || sol.estado !== 'pendiente') throw new ErrorOperacion(404, 'Solicitud no encontrada o ya procesada');
    const monto = Number(sol.monto);
    if (!esUid(sol.userId) || !(monto > 0)) throw new ErrorOperacion(400, 'Solicitud mal formada');
    const cerrado = await cerrarRegistro(`solicitudesDeposito/${id}`, 'pendiente', {
      estado: 'aprobado', aprobadoPor: req.usuario.uid, aprobadoPorNombre: req.usuario.datos.nombre || null, aprobadoEn: Date.now()
    });
    if (!cerrado) throw new ErrorOperacion(409, 'Esta solicitud ya fue procesada');
    const saldo = await sumarSaldo(sol.userId, 'creditoReal', monto);
    await auditoria.registrarSeguro({ accion: 'deposito_aprobado', actor: req.usuario.uid, objetivo: sol.userId, requestId: req.id, detalles: { id, monto, moneda: sol.moneda } });
    await notificarTelegram(`✅ <b>Depósito aprobado</b>\n👤 ${escaparHtml(String(sol.nombre || '').split(' ')[0])}\n💰 ${monto} ${escaparHtml(sol.moneda || '')}\n👨‍💼 Aprobado por: ${escaparHtml(req.usuario.datos.nombre || '')}`);
    return { saldo };
  }

  async function rechazarSolicitud(req, id) {
    const cerrado = await cerrarRegistro(`solicitudesDeposito/${id}`, 'pendiente', {
      estado: 'rechazado', rechazadoPor: req.usuario.uid, rechazadoEn: Date.now()
    });
    if (!cerrado) throw new ErrorOperacion(409, 'Esta solicitud ya fue procesada');
    await auditoria.registrarSeguro({ accion: 'deposito_rechazado', actor: req.usuario.uid, objetivo: id, requestId: req.id });
    return {};
  }

  // ---------- CEO ----------
  async function ajustarSaldo(req) {
    const { uid, tipo } = req.body || {};
    const monto = Number(req.body?.monto);
    const motivo = texto(req.body?.motivo, 200);
    if (!esUid(uid) || !['real', 'promo'].includes(tipo) || !Number.isFinite(monto) || monto === 0
      || Math.abs(monto) > 1000000 || Math.round(monto * 100) !== monto * 100 || !motivo) {
      throw new ErrorOperacion(400, 'Datos del ajuste inválidos (usuario, tipo, monto y motivo son obligatorios)');
    }
    revisarTextos(motivo);
    if (!(await db.ref(`users/${uid}`).once('value')).exists()) throw new ErrorOperacion(404, 'Usuario no encontrado');
    const campo = tipo === 'real' ? 'creditoReal' : 'creditoPromo';
    const saldo = await sumarSaldo(uid, campo, monto);
    await auditoria.registrar({ accion: 'ajuste_ceo', actor: req.usuario.uid, objetivo: uid, requestId: req.id, detalles: { campo, monto, motivo } });
    return { saldo };
  }

  async function asignarRol(req) {
    const { uid, rol } = req.body || {};
    if (!esUid(uid) || !Object.prototype.hasOwnProperty.call(ROLES, rol)) throw new ErrorOperacion(400, 'Usuario o rol inválido');
    if (uid === req.usuario.uid) throw new ErrorOperacion(400, 'No puedes cambiar tu propio rol');
    if (!(await db.ref(`users/${uid}`).once('value')).exists()) throw new ErrorOperacion(404, 'Usuario no encontrado');
    await db.ref(`users/${uid}`).update({ rol, rolLevel: ROLES[rol] });
    await auditoria.registrar({ accion: 'rol_asignado', actor: req.usuario.uid, objetivo: uid, requestId: req.id, detalles: { rol } });
    return { rol };
  }

  // Borra a un usuario por completo: perfil, apuestas, historial, teléfono y credenciales.
  // No se permite si tiene saldo o apuestas pendientes (habría dinero en juego).
  async function eliminarUsuario(req) {
    const { uid } = req.body || {};
    if (!esUid(uid)) throw new ErrorOperacion(400, 'Usuario inválido');
    if (uid === req.usuario.uid) throw new ErrorOperacion(400, 'No puedes eliminarte a ti mismo');
    const u = (await db.ref(`users/${uid}`).once('value')).val();
    if (!u) throw new ErrorOperacion(404, 'Usuario no encontrado');
    const saldo = (Number(u.creditoReal) || 0) + (Number(u.creditoPromo) || 0);
    const apuestas = (await db.ref(`apuestas/${uid}`).once('value')).val() || {};
    const pendientes = Object.values(apuestas).filter(a => a && a.estado === 'pendiente').length;
    if (saldo > 0 || pendientes > 0) {
      throw new ErrorOperacion(409, `No se puede eliminar: tiene ${saldo} de saldo y ${pendientes} apuestas pendientes. Pon su saldo a 0 o suspende la cuenta.`);
    }
    const cambios = {
      [`users/${uid}`]: null, [`apuestas/${uid}`]: null, [`historial/${uid}`]: null,
      [`transacciones/${uid}`]: null, [`alertas/${uid}`]: null
    };
    const digitos = String(u.telefono || '').replace(/[^0-9]/g, '');
    if (digitos) cambios[`telefonos/${digitos}/${uid}`] = null;
    if (typeof u.email === 'string' && u.email) {
      const clave = normalizarClave(u.email);
      cambios[`credenciales_acceso/${clave}`] = null;
      cambios[`credenciales_servidor/${clave}`] = null;
    }
    await db.ref().update(cambios);
    await auditoria.registrar({ accion: 'usuario_eliminado', actor: req.usuario.uid, objetivo: uid, requestId: req.id, detalles: { nombre: u.nombre || null } });
    return {};
  }

  // Genera una contraseña temporal para quien la olvidó (se la da el CEO en persona).
  async function restablecerClave(req) {
    const { uid } = req.body || {};
    if (!esUid(uid)) throw new ErrorOperacion(400, 'Usuario inválido');
    const u = (await db.ref(`users/${uid}`).once('value')).val();
    if (!u || typeof u.email !== 'string') throw new ErrorOperacion(404, 'Usuario sin email registrado');
    const temporal = crypto.randomBytes(9).toString('base64url');
    const clave = normalizarClave(u.email);
    await db.ref().update({
      [`credenciales_servidor/${clave}`]: await auth.credencialNueva(uid, temporal),
      [`credenciales_acceso/${clave}/hash`]: null,
      [`credenciales_acceso/${clave}/salt`]: null,
      [`credenciales_acceso/${clave}/uid`]: uid,
      [`credenciales_acceso/${clave}/email`]: u.email,
      [`users/${uid}/sesionVersion`]: (Number.isInteger(u.sesionVersion) ? u.sesionVersion : 0) + 1
    });
    await auditoria.registrar({ accion: 'clave_restablecida', actor: req.usuario.uid, objetivo: uid, requestId: req.id });
    return { claveTemporal: temporal };
  }

  // ---------- Registro ----------
  async function registrar(req) {
    // Cada dato se revisa por separado para decirle a la persona exactamente qué corregir.
    const nombre = texto(req.body?.nombre, 60);
    const telefono = texto(req.body?.telefono, 20);
    // Correo sin espacios y en minúsculas (los móviles suelen poner la primera letra en mayúscula).
    const email = typeof req.body?.email === 'string' ? texto(req.body.email.replace(/\s+/g, '').toLowerCase(), 254) : null;
    const password = req.body?.password;
    // Código sin espacios (al copiarlo de WhatsApp a veces se cuela uno en medio).
    const codigo = typeof req.body?.codigo === 'string' ? req.body.codigo.replace(/\s+/g, '').toLocaleUpperCase('es') : '';
    if (!nombre) throw new ErrorOperacion(400, 'Escribe tu nombre (máximo 60 letras)');
    if (!telefono) throw new ErrorOperacion(400, 'Escribe tu número de teléfono');
    if (!email || !EMAIL_RE.test(email)) throw new ErrorOperacion(400, 'El correo no es válido. Ejemplo: nombre@nauta.cu');
    if (!CODIGO_RE.test(codigo)) throw new ErrorOperacion(400, 'El código de invitación no tiene un formato válido. Cópialo tal cual te lo enviaron');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      throw new ErrorOperacion(400, 'La contraseña debe tener al menos 8 caracteres');
    }
    try { revisarTextos({ nombre, telefono, email }); } catch (e) { throw new ErrorOperacion(400, e.message); }
    const digitos = telefono.replace(/[^0-9]/g, '');
    if (digitos.length < 6 || digitos.length > 15) throw new ErrorOperacion(400, 'Teléfono no válido: escribe solo los números, por ejemplo 51234567');

    const clave = normalizarClave(email);
    const [cred1, cred2] = await Promise.all([
      db.ref(`credenciales_acceso/${clave}`).once('value'),
      db.ref(`credenciales_servidor/${clave}`).once('value')
    ]);
    if (cred1.exists() || cred2.exists()) throw new ErrorOperacion(409, 'Ese correo ya tiene una cuenta. Ve a «Iniciar sesión» o usa «¿Olvidaste tu contraseña?»');

    const uid = 'BG_' + Date.now().toString(36) + '_' + crypto.randomBytes(5).toString('hex');
    // Código de un solo uso: se marca como usado de forma atómica.
    let datosCodigo = null;
    const tx = await db.ref(`codigosAcceso/${codigo}`).transaction((c) => {
      datosCodigo = null;
      if (c === null) return null;
      if (c.usado) return undefined;
      datosCodigo = c;
      return { ...c, usado: true, usadoPor: uid, usadoEn: Date.now() };
    });
    if (!tx.committed || !datosCodigo) throw new ErrorOperacion(400, 'Ese código de invitación no existe o ya se usó. Pide uno nuevo a quien te invitó');

    const patrocinador = datosCodigo.generadoPor || datosCodigo.subadminUid || datosCodigo.createdBy || null;
    const perfil = {
      uid, email, nombre, telefono,
      rol: 'member', role: 'member', rolLevel: 1,
      creditoReal: 0, creditoPromo: 0,
      codigoInvitacion: 'BG' + crypto.randomBytes(4).toString('hex').toUpperCase(),
      referidoPor: codigo,
      referidoPorUid: esUid(patrocinador) ? patrocinador : null,
      activo: true,
      fecha_registro: Date.now()
    };
    await db.ref().update({
      [`users/${uid}`]: perfil,
      [`credenciales_acceso/${clave}`]: { email, uid },
      [`credenciales_servidor/${clave}`]: await auth.credencialNueva(uid, password),
      [`telefonos/${digitos}/${uid}`]: { email }
    });
    await auditoria.registrarSeguro({ accion: 'registro', actor: uid, requestId: req.id, detalles: { codigo } });
    await notificarTelegram(`👤 <b>Nuevo miembro</b>\n${escaparHtml(nombre.split(' ')[0])}\n🔑 ${escaparHtml(codigo)}`);
    return { uid };
  }

  // Responde siempre lo mismo (no revela si el usuario existe). Avisa al CEO si existe.
  async function solicitarRecuperacion(req) {
    const id = texto(req.body?.identificador, 254);
    if (!id) throw new ErrorOperacion(400, 'Indica tu correo o teléfono');
    let existe = false;
    if (EMAIL_RE.test(id)) {
      const k = normalizarClave(id);
      existe = (await db.ref(`credenciales_acceso/${k}`).once('value')).exists()
        || (await db.ref(`credenciales_servidor/${k}`).once('value')).exists();
    } else {
      const digitos = id.replace(/[^0-9]/g, '');
      existe = digitos.length >= 6 && (await db.ref(`telefonos/${digitos}`).once('value')).exists();
    }
    if (existe) {
      await notificarTelegram(`🔑 <b>Solicitud de nueva contraseña</b>\n👤 ${escaparHtml(id)}\nEl CEO puede generar una temporal desde su panel.`);
      await auditoria.registrarSeguro({ accion: 'recuperacion_solicitada', actor: 'anonimo', requestId: req.id });
    }
    return { mensaje: 'Si la cuenta existe, el administrador te contactará.' };
  }

  // ---------- Avisos a Telegram desde el navegador (el token ya no está en el frontend) ----------
  async function notificar(req) {
    const crudo = typeof req.body?.texto === 'string' ? req.body.texto.slice(0, 1500) : '';
    if (!crudo.trim()) throw new ErrorOperacion(400, 'Mensaje vacío');
    // Solo se permite <b>…</b>; todo lo demás se escapa.
    const limpio = escaparHtml(crudo).replace(/&lt;(\/?)b&gt;/g, '<$1b>');
    const firma = `\n— ${escaparHtml((req.usuario.datos.nombre || 'Usuario').split(' ')[0])} (${escaparHtml(req.usuario.datos.rol || 'member')})`;
    await notificarTelegram(limpio + firma);
    const foto = req.body?.fotoUrl;
    if (typeof foto === 'string' && /^https:\/\/i\.ibb\.co\//.test(foto) && config.telegram.token && config.telegram.chatId) {
      await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: config.telegram.chatId, photo: foto, caption: escaparHtml(String(req.body?.leyenda || '').slice(0, 200)), parse_mode: 'HTML' }),
        signal: AbortSignal.timeout(8000)
      }).catch(() => {});
    }
    return {};
  }

  return {
    aprobarDeposito, rechazarDeposito, aprobarSolicitud, rechazarSolicitud,
    ajustarSaldo, asignarRol, restablecerClave, eliminarUsuario, registrar, solicitarRecuperacion, notificar
  };
}

module.exports = { crearOperaciones, ErrorOperacion, ROLES, DIRECTOR, NIVEL, Invalido };
