'use strict';

// ==================== BANDEJA DE AVISOS (personales + generales) ====================
// Decisión de Yoel (3 oct 2026): cada persona tiene una bandeja donde se acumulan sus avisos
// (apuesta registrada, ganada/perdida/anulada, depósitos, bienvenida) y las ofertas del día que
// van a todos. Los ve en la campana, los marca como leídos uno a uno o todos a la vez, y además
// le llegan al teléfono como notificación (ver lib/webpush.js).
//
// Nodos (solo los toca el servidor; /api/db los deniega porque no tienen política):
//   notificaciones/{uid}/{id}      avisos personales  { tipo, titulo, texto, url, creadoEn, leida }
//   avisosGenerales/{id}           avisos para todos  { tipo, titulo, texto, url, creadoEn }
//   avisosLeidos/{uid}/{id}        qué avisos generales ya leyó cada persona
//   suscripcionesPush/{uid}/{id}   teléfonos de la persona donde mandar la notificación

const { limpiarSuscripcion, idSuscripcion } = require('./webpush');

const TIPOS = Object.freeze(['bienvenida', 'apuesta', 'ganada', 'perdida', 'anulada', 'deposito', 'deposito_rechazado', 'ofertas', 'equipo', 'general', 'nuevo_miembro']);
const MAX_PERSONALES = 100;          // se guardan los 100 más recientes por persona
const DIAS_GENERALES = 3;            // las ofertas generales se ven durante 3 días
const MAX_SUSCRIPCIONES = 5;         // teléfonos/navegadores por persona
const CONCURRENCIA_PUSH = 10;

const ID_VALIDO = /^[A-Za-z0-9_-]{1,40}$/;

function limpiarTexto(t, max) {
  return String(t == null ? '' : t).replace(/[\u0000-\u001F\u007F<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
// Solo enlaces internos de la propia web (nunca a otro sitio).
function limpiarUrl(u) {
  const s = String(u || '');
  return /^#[a-z0-9_-]{1,30}$/i.test(s) ? s : '#avisos';
}
function limpiarAviso(a) {
  const tipo = TIPOS.includes(a && a.tipo) ? a.tipo : 'general';
  const titulo = limpiarTexto(a && a.titulo, 80);
  const texto = limpiarTexto(a && a.texto, 400);
  if (!titulo) throw new Error('Aviso sin título');
  return { tipo, titulo, texto, url: limpiarUrl(a && a.url) };
}

function crearNotificaciones({ db, webpush, ahora = () => Date.now() }) {
  // Manda la notificación a todos los teléfonos de la persona; borra los que ya no existen.
  async function empujar(uid, aviso, opciones) {
    if (!webpush) return 0;
    const subs = (await db.ref(`suscripcionesPush/${uid}`).once('value')).val() || {};
    let enviados = 0;
    await Promise.all(Object.entries(subs).map(async ([id, sub]) => {
      const r = await webpush.enviarA(sub, aviso, opciones).catch(() => ({ ok: false }));
      if (r.ok) enviados++;
      if (r.caducada) await db.ref(`suscripcionesPush/${uid}/${id}`).remove().catch(() => {});
    }));
    return enviados;
  }

  // Aviso personal: queda en la bandeja y llega al teléfono.
  async function notificar(uid, datos, { push = true, urgencia = 'normal' } = {}) {
    if (typeof uid !== 'string' || !ID_VALIDO.test(uid)) return null;
    const aviso = limpiarAviso(datos);
    const ref = db.ref(`notificaciones/${uid}`).push();
    const fila = { ...aviso, creadoEn: ahora(), leida: false };
    await ref.set(fila);
    // Se conservan solo los más recientes.
    const todos = (await db.ref(`notificaciones/${uid}`).orderByChild('creadoEn').once('value')).val() || {};
    const ids = Object.keys(todos).sort((a, b) => (todos[a].creadoEn || 0) - (todos[b].creadoEn || 0));
    if (ids.length > MAX_PERSONALES) {
      const borrar = {};
      ids.slice(0, ids.length - MAX_PERSONALES).forEach(id => { borrar[id] = null; });
      await db.ref(`notificaciones/${uid}`).update(borrar);
    }
    if (push) await empujar(uid, { id: ref.key, ...aviso }, { urgencia });
    return ref.key;
  }

  // Aviso para todos (ofertas del día): una sola copia y notificación a todos los teléfonos.
  async function avisoGeneral(datos, { push = true } = {}) {
    const aviso = limpiarAviso(datos);
    const ref = db.ref('avisosGenerales').push();
    await ref.set({ ...aviso, creadoEn: ahora() });
    // Limpieza: fuera los de hace más de 30 días.
    const viejos = (await db.ref('avisosGenerales').orderByChild('creadoEn').endAt(ahora() - 30 * 86400000).once('value')).val() || {};
    if (Object.keys(viejos).length) {
      const borrar = {}; Object.keys(viejos).forEach(id => { borrar[id] = null; });
      await db.ref('avisosGenerales').update(borrar);
    }
    let enviados = 0;
    if (push && webpush) {
      const todas = (await db.ref('suscripcionesPush').once('value')).val() || {};
      const uids = Object.keys(todas);
      for (let i = 0; i < uids.length; i += CONCURRENCIA_PUSH) {
        const lote = uids.slice(i, i + CONCURRENCIA_PUSH);
        const r = await Promise.all(lote.map(uid => empujar(uid, { id: ref.key, ...aviso }, { ttl: 6 * 3600 }).catch(() => 0)));
        enviados += r.reduce((s, n) => s + n, 0);
      }
    }
    return { id: ref.key, enviados };
  }

  // Bandeja de la persona: personales + generales recientes, del más nuevo al más viejo.
  async function listar(uid) {
    const [pers, gen, leidos] = await Promise.all([
      db.ref(`notificaciones/${uid}`).orderByChild('creadoEn').limitToLast(50).once('value'),
      db.ref('avisosGenerales').orderByChild('creadoEn').startAt(ahora() - DIAS_GENERALES * 86400000).once('value'),
      db.ref(`avisosLeidos/${uid}`).once('value')
    ]);
    const marcados = leidos.val() || {};
    const avisos = [];
    for (const [id, a] of Object.entries(pers.val() || {})) {
      if (a) avisos.push({ id, tipo: a.tipo, titulo: a.titulo, texto: a.texto, url: a.url, creadoEn: a.creadoEn, leida: a.leida === true, general: false });
    }
    for (const [id, a] of Object.entries(gen.val() || {})) {
      if (a) avisos.push({ id, tipo: a.tipo, titulo: a.titulo, texto: a.texto, url: a.url, creadoEn: a.creadoEn, leida: marcados[id] === true, general: true });
    }
    avisos.sort((a, b) => (b.creadoEn || 0) - (a.creadoEn || 0));
    return { avisos, noLeidas: avisos.filter(a => !a.leida).length };
  }

  // Marcar como leídos: lista de ids, o todos.
  async function marcarLeidas(uid, { ids, todas } = {}) {
    const actual = await listar(uid);
    const objetivo = todas === true
      ? actual.avisos.filter(a => !a.leida)
      : actual.avisos.filter(a => Array.isArray(ids) && ids.includes(a.id) && !a.leida);
    const cambios = {};
    for (const a of objetivo) {
      if (a.general) cambios[`avisosLeidos/${uid}/${a.id}`] = true;
      else cambios[`notificaciones/${uid}/${a.id}/leida`] = true;
    }
    if (Object.keys(cambios).length) await db.ref().update(cambios);
    return { marcadas: objetivo.length, noLeidas: actual.noLeidas - objetivo.length };
  }

  // Guardar el teléfono de la persona (validado: solo servicios de push conocidos).
  async function suscribir(uid, datos, agente = '') {
    const s = limpiarSuscripcion(datos);
    if (!s) return null;
    const id = idSuscripcion(s.endpoint);
    const actuales = (await db.ref(`suscripcionesPush/${uid}`).once('value')).val() || {};
    const otros = Object.entries(actuales).filter(([k]) => k !== id).sort((a, b) => (a[1].creadaEn || 0) - (b[1].creadaEn || 0));
    const cambios = { [id]: { ...s, creadaEn: ahora(), agente: limpiarTexto(agente, 120) } };
    // Como máximo 5 teléfonos: se quita el más antiguo.
    otros.slice(0, Math.max(0, otros.length - (MAX_SUSCRIPCIONES - 1))).forEach(([k]) => { cambios[k] = null; });
    await db.ref(`suscripcionesPush/${uid}`).update(cambios);
    return id;
  }

  async function baja(uid, endpoint) {
    if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
    await db.ref(`suscripcionesPush/${uid}/${idSuscripcion(endpoint)}`).remove();
    return true;
  }

  return { notificar, avisoGeneral, listar, marcarLeidas, suscribir, baja };
}

// ---------- Textos de los avisos automáticos (funciones puras: fáciles de probar) ----------
const cr = (n) => String(Math.round((Number(n) || 0) * 100) / 100);

function avisoApuesta({ evento, tipo, monto, cuota, ganancia, tipoSaldo }) {
  return {
    tipo: 'apuesta', url: '#historial',
    titulo: 'Apuesta registrada',
    texto: `${evento} · ${tipo} · ${cr(monto)} CR a cuota ×${cuota}. Posible cobro: ${cr(ganancia)} CR${tipoSaldo === 'promo' ? ' (saldo promocional)' : ''}.`
  };
}

function avisoLiquidacion(b) {
  const evento = b.eventoNombre || 'Tu partido';
  if (b.estado === 'ganada') {
    return { tipo: 'ganada', url: '#historial', titulo: `¡Ganaste ${cr(b.pago)} CR!`, texto: `${evento} (${b.resultado}). Tu pronóstico "${b.tipo}" acertó y el premio ya está en tu saldo.` };
  }
  if (b.estado === 'perdida') {
    return { tipo: 'perdida', url: '#historial', titulo: 'Apuesta perdida', texto: `${evento} terminó ${b.resultado}. Tu pronóstico: "${b.tipo}" (${cr(b.monto)} CR).` };
  }
  return { tipo: 'anulada', url: '#historial', titulo: `Apuesta anulada: te devolvimos ${cr(b.pago)} CR`, texto: `${evento}: el partido no tuvo resultado oficial (aplazado o cancelado). Lo apostado volvió a tu saldo.` };
}

function avisoDeposito({ aprobado, monto, moneda }) {
  return aprobado
    ? { tipo: 'deposito', url: '#pagos', titulo: 'Depósito aprobado', texto: `Se acreditaron ${cr(monto)} ${moneda || 'CUP'} a tu saldo. ¡Suerte!` }
    : { tipo: 'deposito_rechazado', url: '#pagos', titulo: 'Depósito rechazado', texto: 'No se pudo comprobar tu depósito. Revisa el comprobante o habla con tu agente.' };
}

function avisoBienvenida({ bono }) {
  return {
    tipo: 'bienvenida', url: '#home', titulo: 'Bienvenido a BetGroup',
    texto: bono > 0
      ? `Tienes ${cr(bono)} CR de bono para probar. Aquí te avisaremos de tus apuestas, premios y las mejores cuotas del día.`
      : 'Aquí te avisaremos de tus apuestas, premios y las mejores cuotas del día.'
  };
}

// Aviso al CEO (y al agente que invitó) cada vez que entra alguien nuevo (decisión de Yoel, 3 oct 2026).
function avisoNuevoMiembro({ apodo, agente, via, paraAgente }) {
  return paraAgente
    ? { tipo: 'nuevo_miembro', url: '#sub', titulo: 'Tienes un jugador nuevo', texto: `${apodo} se registró con tu invitación${via === 'google' ? ' (con Google)' : ''}.` }
    : { tipo: 'nuevo_miembro', url: '#ceo', titulo: 'Nuevo miembro en BetGroup', texto: `${apodo} se registró${agente ? ` · agente: ${agente}` : ' · sin agente'}${via === 'google' ? ' · con Google' : ''}.` };
}

module.exports = { crearNotificaciones, limpiarAviso, TIPOS, avisoApuesta, avisoLiquidacion, avisoDeposito, avisoBienvenida, avisoNuevoMiembro };
