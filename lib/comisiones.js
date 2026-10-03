'use strict';

// ==================== COMISIONES DE LA RED (Etapa 11) ====================
// Decidido por Yoel (2 oct 2026; porcentajes cambiados el 3 oct 2026):
//   CEO ─┬─ Supervisor (rol interno "director")  → 10 % de la ganancia de SUS agentes
//        └─ Agente     (rol interno "subadmin")  → 5 % FIJO de la ganancia de SUS jugadores
//   (antes: agente con escala 5-25 % según jugadores activos y supervisor 5 %)
// - Liquidación SEMANAL (lunes a domingo, hora de Cuba) con ARRASTRE: si la red de un agente
//   pierde dinero en la semana, no hay comisión y esa pérdida se descuenta de las semanas
//   siguientes. Así nadie cobra por ganancias que no existen y la casa nunca paga de más.
// - Sobre la GANANCIA: agente 5 % + supervisor 10 % = 15 % (la casa conserva ≥ 85 % de la ganancia).
//   El 3 % de inyección (abajo) se paga aparte y solo en semanas con ganancia.
//
// Ganancia de la red (lo que la casa gana con los jugadores de un agente):
//   apuestas con saldo REAL liquidadas en la semana: lo apostado − lo pagado
//   apuestas con PROMO ganadas: lo pagado al saldo real cuenta como gasto
//   (las pendientes cuentan la semana en que se resuelvan)
//
// Pago por INYECCIÓN (decisión de Yoel, 2 oct 2026): el agente cobra además un 3 % FIJO de la
// inyección neta semanal de su red = depósitos aprobados − retiros pedidos (no rechazados).
// Solo cuentan los jugadores activos de esa semana y solo se paga si la red dejó ganancia
// (neto > 0, igual que la comisión por ganancia). Si la inyección neta es negativa, cuenta 0.
// Un SUPERVISOR que conserva sus propios jugadores sigue cobrando por ellos como agente
// (5 % por ganancia + 3 % de inyección), además de su 10 % por equipo (decisión de Yoel).
// Jugador ACTIVO = hizo al menos una apuesta con dinero REAL liquidada en la semana (ganada o
// perdida). Las apuestas con promo/bono no cuentan: así nadie sube de escalón con cuentas falsas
// que solo juegan el bono de bienvenida.

const { centavos } = require('./apuestas');
const { semanaDe, semanaPorId } = require('./ranking');

// Agente: 5 % fijo sea cual sea el número de jugadores activos (decisión de Yoel, 3 oct 2026).
// Se mantiene como "escala" de un solo escalón para que el resto del sistema no cambie.
const ESCALA_AGENTE = Object.freeze([{ desde: 0, pct: 0.05 }]);
const PCT_SUPERVISOR = 0.10;
const PCT_INYECCION = 0.03;

function pctAgente(activos) {
  return ESCALA_AGENTE.find(e => activos >= e.desde).pct;
}

// Miembros de un agente: la misma regla que usa todo el sistema (lib/politicas.js).
function miembrosDe(agenteUid, agente, usuarios, codigos) {
  const mios = new Set();
  for (const [clave, c] of Object.entries(codigos || {})) {
    if (c && (c.generadoPor === agenteUid || c.createdBy === agenteUid)) {
      mios.add(clave); if (c.codigo) mios.add(c.codigo); if (c.code) mios.add(c.code);
    }
  }
  return Object.entries(usuarios).filter(([uid, u]) => uid !== agenteUid && u && (
    u.referidoPorUid === agenteUid
    || (agente.codigoInvitacion && u.referidoPor === agente.codigoInvitacion)
    || (u.referidoPor && mios.has(u.referidoPor))
  )).map(([uid]) => uid);
}

// Ganancia de la casa con un jugador en la semana.
function gananciaJugador(apuestas, sem) {
  let ganancia = 0, jugo = false;
  for (const b of Object.values(apuestas || {})) {
    if (!b || !['ganada', 'perdida', 'anulada'].includes(b.estado)) continue;
    const t = Number(b.liquidadaEn || b.fecha) || 0;
    if (t < sem.desde || t >= sem.hasta) continue;
    const monto = Number(b.monto) || 0, pago = Number(b.pago) || 0;
    const esPromo = b.tipoSaldo === 'promo' || b.saldoCampo === 'creditoPromo';
    if (!esPromo && b.estado !== 'anulada' && monto > 0) jugo = true; // solo dinero real cuenta como activo
    if (!esPromo) ganancia += b.estado === 'anulada' ? 0 : monto - pago;
    else if (b.estado === 'ganada' && b.reglaPromo) ganancia -= pago; // la ganancia del promo sale en saldo real
  }
  return { ganancia: centavos(ganancia), jugo };
}

// Inyección de un jugador en la semana: depósitos aprobados − retiros pedidos (no rechazados).
function inyeccionJugador(uid, deps, sols, rets, sem) {
  const enSemana = (t) => { t = Number(t) || 0; return t >= sem.desde && t < sem.hasta; };
  let depositado = 0, retirado = 0;
  for (const d of Object.values(deps || {})) if (d && d.userId === uid && d.estado === 'approved' && enSemana(d.aprobadoEn || d.fecha)) depositado += Number(d.monto) || 0;
  for (const d of Object.values(sols || {})) if (d && d.userId === uid && d.estado === 'aprobado' && enSemana(d.aprobadoEn || d.creadoEn)) depositado += Number(d.monto) || 0;
  for (const r of Object.values(rets || {})) if (r && r.userId === uid && r.estado !== 'rechazado' && enSemana(r.creadoEn)) retirado += Number(r.monto) || 0;
  return { depositado: centavos(depositado), retirado: centavos(retirado) };
}

function crearComisiones({ db, auditoria, notificarTelegram, escaparHtml }) {
  // Calcula la semana (sin guardar nada). arrastres: { agenteUid: número ≤ 0 } de la semana anterior.
  async function calcular(sem) {
    const [uS, cS, aS, arrS, dS, sS, rS] = await Promise.all(['users', 'codigosAcceso', 'apuestas', 'comisionesArrastre', 'depositos', 'solicitudesDeposito', 'solicitudesRetiro'].map(n => db.ref(n).once('value')));
    const usuarios = uS.val() || {}, codigos = cS.val() || {}, apuestas = aS.val() || {}, arrastres = arrS.val() || {};
    const deps = dS.val() || {}, sols = sS.val() || {}, rets = rS.val() || {};
    const agentes = [];
    for (const [uid, u] of Object.entries(usuarios)) {
      if (!u || (u.rol !== 'subadmin' && u.rol !== 'director')) continue;
      const miembros = miembrosDe(uid, u, usuarios, codigos);
      if (u.rol === 'director' && !miembros.length) continue; // supervisor sin jugadores propios
      let ganancia = 0, activos = 0, depositado = 0, retirado = 0;
      for (const m of miembros) {
        const r = gananciaJugador(apuestas[m], sem); ganancia += r.ganancia;
        if (!r.jugo) continue; // la inyección solo cuenta de jugadores activos (apostaron dinero real)
        activos++;
        const iny = inyeccionJugador(m, deps, sols, rets, sem); depositado += iny.depositado; retirado += iny.retirado;
      }
      ganancia = centavos(ganancia);
      const inyeccionNeta = Math.max(0, centavos(depositado - retirado));
      const arrastreAnterior = Math.min(0, Number(arrastres[uid] && arrastres[uid].saldo) || 0);
      const neto = centavos(ganancia + arrastreAnterior);
      const pct = pctAgente(activos);
      const positivo = neto > 0;
      const comisionAgente = positivo ? centavos(neto * pct) : 0;
      const supervisorUid = u.supervisorUid && u.supervisorUid !== uid && usuarios[u.supervisorUid] && usuarios[u.supervisorUid].rol === 'director' ? u.supervisorUid : null;
      const comisionSupervisor = positivo && supervisorUid ? centavos(neto * PCT_SUPERVISOR) : 0;
      const comisionInyeccion = positivo ? centavos(inyeccionNeta * PCT_INYECCION) : 0;
      agentes.push({
        uid, apodo: u.apodo || null, nombre: u.nombre || null, rol: u.rol, supervisorUid,
        supervisorNombre: supervisorUid ? (usuarios[supervisorUid].nombre || usuarios[supervisorUid].apodo || null) : null,
        jugadores: miembros.length, activos, ganancia, arrastreAnterior, neto, pct,
        depositado: centavos(depositado), retirado: centavos(retirado), inyeccionNeta, comisionInyeccion,
        comisionAgente, totalAgente: centavos(comisionAgente + comisionInyeccion), comisionSupervisor,
        casa: positivo ? centavos(neto - comisionAgente - comisionSupervisor - comisionInyeccion) : neto,
        arrastreSiguiente: positivo ? 0 : neto
      });
    }
    agentes.sort((a, b) => b.neto - a.neto);
    const supervisores = {};
    for (const a of agentes) {
      if (!a.supervisorUid) continue;
      const s = supervisores[a.supervisorUid] || (supervisores[a.supervisorUid] = { uid: a.supervisorUid, nombre: a.supervisorNombre, agentes: 0, comision: 0 });
      s.agentes++; s.comision = centavos(s.comision + a.comisionSupervisor);
    }
    const suma = (k) => centavos(agentes.reduce((t, a) => t + a[k], 0));
    return {
      semana: sem.id, desde: sem.desde, hasta: sem.hasta, terminada: sem.hasta <= Date.now(),
      reglas: { escalaAgente: ESCALA_AGENTE, pctSupervisor: PCT_SUPERVISOR, pctInyeccion: PCT_INYECCION },
      agentes, supervisores: Object.values(supervisores),
      totales: { ganancia: suma('ganancia'), inyeccionNeta: suma('inyeccionNeta'), comisionAgentes: suma('comisionAgente'), comisionInyeccion: suma('comisionInyeccion'), comisionSupervisores: suma('comisionSupervisor'), casa: suma('casa') }
    };
  }

  // El CEO cierra una semana terminada: guarda las cifras y actualiza los arrastres. Una sola vez,
  // y en orden (no se puede cerrar una semana si hay otra anterior con datos sin cerrar).
  async function cerrar(sem, actor, requestId) {
    if (sem.hasta > Date.now()) throw Object.assign(new Error('Esa semana aún no ha terminado'), { estado: 409 });
    const ultima = (await db.ref('comisionesUltimaSemana').once('value')).val();
    if (ultima && ultima >= sem.id) throw Object.assign(new Error('Esa semana ya está cerrada'), { estado: 409 });
    if (ultima) {
      const siguiente = semanaPorId(ultima) && semanaDe(semanaPorId(ultima).hasta + 12 * 3600000).id;
      if (siguiente && siguiente < sem.id) throw Object.assign(new Error(`Primero cierra la semana del ${siguiente}`), { estado: 409 });
    }
    const t = await calcular(sem);
    let ok = false;
    await db.ref(`comisionesSemana/${sem.id}`).transaction((r) => { ok = false; if (r && r.cerrada) return undefined; ok = true; return { ...t, cerrada: true, cerradaPor: actor, cerradaEn: Date.now() }; });
    if (!ok) throw Object.assign(new Error('Esa semana ya está cerrada'), { estado: 409 });
    const cambios = { comisionesUltimaSemana: sem.id };
    for (const a of t.agentes) cambios[`comisionesArrastre/${a.uid}`] = { saldo: a.arrastreSiguiente, semana: sem.id };
    await db.ref().update(cambios);
    await auditoria.registrarSeguro({ accion: 'comisiones_semana_cerrada', actor, objetivo: sem.id, requestId, detalles: { totales: t.totales } });
    const lineas = t.agentes.slice(0, 15).map(a => `• ${escaparHtml(a.apodo || a.nombre || a.uid)}: ${a.totalAgente} CR (ganancia ${a.comisionAgente} al ${Math.round(a.pct * 100)} % + inyección ${a.comisionInyeccion} de ${a.inyeccionNeta})${a.arrastreSiguiente < 0 ? ` · arrastre ${a.arrastreSiguiente}` : ''}`).join('\n') || '• Sin agentes';
    const sups = t.supervisores.map(s => `• ${escaparHtml(s.nombre || s.uid)}: ${s.comision} CR`).join('\n') || '• Sin supervisores';
    await notificarTelegram(`💼 <b>Comisiones semana del ${sem.id}</b>\nGanancia de la red: ${t.totales.ganancia} CR\n\n<b>Agentes</b>\n${lineas}\n\n<b>Supervisores</b>\n${sups}\n\n🏦 Casa: ${t.totales.casa} CR`);
    return t;
  }

  // Lo que ve cada uno: el agente lo suyo; el supervisor sus agentes; el CEO todo.
  function filtrarPara(usuario, tabla) {
    if (usuario.nivel >= 3) return tabla;
    const agentes = usuario.datos.rol === 'director'
      ? tabla.agentes.filter(a => a.supervisorUid === usuario.uid || a.uid === usuario.uid) // su equipo y sus propios jugadores
      : tabla.agentes.filter(a => a.uid === usuario.uid);
    const supervisores = tabla.supervisores.filter(s => s.uid === usuario.uid);
    return { ...tabla, agentes, supervisores, totales: undefined };
  }

  return { calcular, cerrar, filtrarPara };
}

module.exports = { crearComisiones, pctAgente, gananciaJugador, inyeccionJugador, miembrosDe, ESCALA_AGENTE, PCT_SUPERVISOR, PCT_INYECCION };
