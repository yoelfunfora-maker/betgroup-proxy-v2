'use strict';

// ==================== MOTOR DE APUESTAS ====================
// Único sitio que coloca y liquida apuestas. Reglas de dinero:
// - El saldo se descuenta con una transacción (no hay doble gasto).
// - La cuota la pone el servidor, no el cliente.
// - Una apuesta solo pasa de "pendiente" a otro estado una vez (no hay doble pago).
// - El premio vuelve al mismo saldo con el que se apostó (promo → promo).

const { TIPOS_APUESTA } = require('./validacion');

const CAMPOS_SALDO = Object.freeze({ real: 'creditoReal', promo: 'creditoPromo' });
const CONFIG_POR_DEFECTO = Object.freeze({ minBet: 100, maxBet: 500, maxPago: 2500, dailyLossLimit: 5000, bankroll: 20000 });
const UMBRAL_EXPOSICION = 0.8; // kill-switch al 80% de la caja
const CONFIG_TTL_MS = 60 * 1000;
const TOLERANCIA_CUOTA = 0.005;
const ZONA_CUBA_MS = -4 * 60 * 60 * 1000; // UTC-4

class ErrorApuesta extends Error {
  constructor(estado, mensaje, extra = {}) {
    super(mensaje);
    this.estado = estado;
    this.extra = extra;
  }
}

// Dinero siempre redondeado a centavos.
function centavos(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Inicio del día de hoy en hora de Cuba, como marca de tiempo UTC.
function inicioDiaCuba(ahora = Date.now()) {
  const local = new Date(ahora + ZONA_CUBA_MS);
  local.setUTCHours(0, 0, 0, 0);
  return local.getTime() - ZONA_CUBA_MS;
}

function nombreEvento(ev) {
  return `${ev.local} vs ${ev.visitante}`;
}

function cuotaDe(ev, tipo) {
  const valor = { Local: ev.cuota_local, Visitante: ev.cuota_visitante, Empate: ev.cuota_empate }[tipo];
  const n = Number(valor);
  return Number.isFinite(n) && n > 1 ? n : null;
}

// Cola por usuario: sus apuestas se procesan de una en una (límite diario sin carreras).
function crearCandado() {
  const colas = new Map();
  return async function conCandado(clave, fn) {
    const anterior = colas.get(clave) || Promise.resolve();
    let liberar;
    const actual = new Promise((r) => { liberar = r; });
    const encadenada = anterior.then(() => actual);
    colas.set(clave, encadenada);
    await anterior;
    try {
      return await fn();
    } finally {
      liberar();
      if (colas.get(clave) === encadenada) colas.delete(clave);
    }
  };
}

function crearMotorApuestas({ db, auditoria, obtenerEventos, avisar = async () => {} }) {
  const conCandado = crearCandado();
  let configCache = null;

  async function leerConfig() {
    if (configCache && Date.now() - configCache.t < CONFIG_TTL_MS) return configCache.v;
    const remoto = (await db.ref('config').once('value')).val() || {};
    const v = {};
    for (const k of Object.keys(CONFIG_POR_DEFECTO)) {
      const n = Number(remoto[k]);
      v[k] = Number.isFinite(n) && n > 0 ? n : CONFIG_POR_DEFECTO[k];
    }
    configCache = { v, t: Date.now() };
    return v;
  }

  function buscarEvento({ eventoId, evento }) {
    const eventos = obtenerEventos();
    if (!eventos) throw new ErrorApuesta(503, 'Los eventos se están cargando. Prueba en un minuto.');
    if (eventoId) {
      const porId = eventos.find(e => String(e.id) === String(eventoId));
      if (porId) return porId;
    }
    const nombre = String(evento || '').toLowerCase().trim();
    return eventos.find(e => nombreEvento(e).toLowerCase().trim() === nombre) || null;
  }

  // Lo arriesgado hoy: apuestas perdidas + pendientes (las pendientes cuentan como posible pérdida).
  async function riesgoDeHoy(uid) {
    const desde = inicioDiaCuba();
    const todas = (await db.ref(`apuestas/${uid}`).once('value')).val() || {};
    let total = 0;
    for (const b of Object.values(todas)) {
      if (!b || !(Number(b.fecha) >= desde)) continue;
      if (b.estado === 'perdida' || b.estado === 'pendiente') total += Number(b.monto) || 0;
    }
    return centavos(total);
  }

  // Riesgo por partido (lo que antes escribía el navegador en mercados/).
  async function registrarMercado(registro) {
    const clave = registro.eventoNombre.replace(/[^a-zA-Z0-9]/g, '_').substr(0, 30);
    const riesgo = registro.monto * (registro.cuota - 1);
    await db.ref(`mercados/${clave}`).transaction((m) => {
      const r = m || { riesgoHome: 0, riesgoAway: 0, dineroHome: 0, dineroAway: 0 };
      if (registro.tipo === 'Local') { r.dineroHome = (r.dineroHome || 0) + registro.monto; r.riesgoHome = (r.riesgoHome || 0) + riesgo; }
      else { r.dineroAway = (r.dineroAway || 0) + registro.monto; r.riesgoAway = (r.riesgoAway || 0) + riesgo; }
      return r;
    });
  }

  // Kill-switch: si lo que la casa podría pagar supera el 80% de la caja, se bloquean las apuestas.
  async function revisarExposicion(cfg) {
    const todas = (await db.ref('apuestas').once('value')).val() || {};
    let exposicion = 0;
    let pendientes = 0;
    for (const delUsuario of Object.values(todas)) {
      for (const b of Object.values(delUsuario || {})) {
        if (b && b.estado === 'pendiente') { exposicion += (Number(b.monto) || 0) * (Number(b.cuota) || 1); pendientes++; }
      }
    }
    if (exposicion > cfg.bankroll * UMBRAL_EXPOSICION) {
      await db.ref('config/killSwitch').set({
        activo: true, motivo: 'EXPOSICION_CAJA', exposicion: centavos(exposicion), caja: cfg.bankroll, timestamp: Date.now(), totalPendientes: pendientes
      });
      configCache = null;
      await avisar(`🚨 <b>KILL-SWITCH ACTIVADO</b>\n💰 Exposición: ${exposicion.toFixed(0)} CR\n🏦 Caja: ${cfg.bankroll} CR\n⚠️ ${pendientes} apuestas pendientes.`);
    }
  }

  async function colocarApuesta({ uid, usuario, eventoId, evento, tipo, monto, cuotaCliente, tipoSaldo, requestId }) {
    return conCandado(uid, async () => {
      // 0. Sistema abierto: ni pausa del CEO ni kill-switch de exposición.
      const [panico, killSwitch] = await Promise.all([
        db.ref('system/panicMode').once('value'),
        db.ref('config/killSwitch/activo').once('value')
      ]);
      if (panico.val() === true) throw new ErrorApuesta(503, 'Sistema en mantenimiento. Prueba más tarde.');
      if (killSwitch.val() === true) throw new ErrorApuesta(503, 'Apuestas pausadas por seguridad (límite de exposición).');

      // 1. Cuenta activa y sin autoexclusión.
      if (usuario.activo === false) throw new ErrorApuesta(403, 'Cuenta desactivada');
      if (Number(usuario.autoexcludedUntil) > Date.now()) {
        throw new ErrorApuesta(403, 'Cuenta en autoexclusión', { hasta: Number(usuario.autoexcludedUntil) });
      }

      // 2. Evento real, futuro y con cuota del servidor.
      const ev = buscarEvento({ eventoId, evento });
      if (!ev) throw new ErrorApuesta(404, 'Evento no disponible');
      if (ev.estado !== 'scheduled') throw new ErrorApuesta(409, 'Solo se puede apostar antes de que empiece el partido');
      const inicio = Date.parse(ev.horaInicio);
      if (Number.isFinite(inicio) && inicio <= Date.now()) {
        throw new ErrorApuesta(409, 'Solo se puede apostar antes de que empiece el partido');
      }
      const cuota = cuotaDe(ev, tipo);
      if (!cuota) throw new ErrorApuesta(409, 'No hay cuota disponible para esa selección');
      if (cuotaCliente !== undefined && cuotaCliente !== null
        && Math.abs(Number(cuotaCliente) - cuota) > TOLERANCIA_CUOTA) {
        throw new ErrorApuesta(409, 'La cuota ha cambiado. Revísala y confirma de nuevo.', { cuotaActual: cuota });
      }

      // 3. Límites de la casa (config en Firebase).
      const cfg = await leerConfig();
      if (monto < cfg.minBet) throw new ErrorApuesta(400, `Monto mínimo: ${cfg.minBet}`);
      if (monto > cfg.maxBet) throw new ErrorApuesta(400, `Monto máximo: ${cfg.maxBet}`);
      const ganancia = centavos(monto * cuota);
      if (ganancia > cfg.maxPago) {
        throw new ErrorApuesta(400, `Pago máximo: ${cfg.maxPago}`, { montoMaximo: Math.floor(cfg.maxPago / cuota) });
      }
      const riesgo = await riesgoDeHoy(uid);
      if (riesgo + monto > cfg.dailyLossLimit) {
        throw new ErrorApuesta(403, 'Límite diario alcanzado', { usado: riesgo, limite: cfg.dailyLossLimit });
      }

      // 4. Descuento atómico del saldo.
      const campo = CAMPOS_SALDO[tipoSaldo] || CAMPOS_SALDO.real;
      let saldoNuevo = null;
      const tx = await db.ref(`users/${uid}/${campo}`).transaction((actual) => {
        // Firebase llama primero con null si aún no tiene el dato: se devuelve null
        // para que lo pida al servidor y repita (abortar aquí no reintentaría).
        saldoNuevo = null;
        if (actual === null) return null;
        const saldo = Number(actual) || 0;
        if (saldo < monto) return undefined;
        saldoNuevo = centavos(saldo - monto);
        return saldoNuevo;
      });
      if (!tx.committed || saldoNuevo === null) {
        throw new ErrorApuesta(400, 'Saldo insuficiente', { saldoActual: Number(tx.snapshot.val()) || 0 });
      }

      // 5. Registro de la apuesta; si falla, se devuelve el dinero.
      const ref = db.ref(`apuestas/${uid}`).push();
      const registro = {
        eventoId: String(ev.id),
        eventoNombre: nombreEvento(ev),
        sport: ev.sport,
        liga: ev.liga || ev.sport,
        tipo,
        monto,
        cuota,
        ganancia,
        saldoCampo: campo,
        tipoSaldo: campo === CAMPOS_SALDO.promo ? 'promo' : 'real',
        estado: 'pendiente',
        fecha: Date.now()
      };
      try {
        await ref.set(registro);
      } catch (err) {
        await db.ref(`users/${uid}/${campo}`).transaction(a => centavos((Number(a) || 0) + monto));
        throw err;
      }

      try {
        await registrarMercado(registro);
        await revisarExposicion(cfg);
      } catch (err) {
        console.error('Mercado/exposición no actualizados:', err.message);
      }

      await auditoria.registrarSeguro({
        accion: 'apuesta_colocada', actor: uid, objetivo: ref.key, requestId,
        detalles: { eventoId: registro.eventoId, tipo, monto, cuota, campo }
      });
      return { betId: ref.key, saldoNuevo, cuota, ganancia };
    });
  }

  // resultado: 'Local' | 'Visitante' | 'Empate' | 'ANULADA' (devuelve lo apostado).
  async function liquidarApuesta({ uid, betId, resultado, origen, requestId = null }) {
    if (resultado !== 'ANULADA' && !TIPOS_APUESTA.includes(resultado)) throw new Error('Resultado inválido');
    let liquidada = null;

    // Paso 1: cambio de estado atómico. Solo una de las liquidaciones simultáneas gana.
    const tx = await db.ref(`apuestas/${uid}/${betId}`).transaction((b) => {
      liquidada = null;
      if (b === null) return null; // ver nota de null en colocarApuesta
      if (b.estado !== 'pendiente') return undefined;
      const monto = Number(b.monto) || 0;
      let estado;
      let pago;
      if (resultado === 'ANULADA') { estado = 'anulada'; pago = centavos(monto); }
      else if (b.tipo === resultado) { estado = 'ganada'; pago = centavos(monto * Number(b.cuota)); }
      else { estado = 'perdida'; pago = 0; }
      liquidada = { ...b, estado, pago, resultado, liquidadaEn: Date.now(), liquidadaPor: origen, pagado: pago === 0 };
      return liquidada;
    });
    if (!tx.committed || !liquidada) return null;

    // Paso 2: abono al mismo saldo con el que se apostó (las apuestas antiguas, a creditoReal).
    if (liquidada.pago > 0) {
      const campo = Object.values(CAMPOS_SALDO).includes(liquidada.saldoCampo) ? liquidada.saldoCampo : CAMPOS_SALDO.real;
      await db.ref(`users/${uid}/${campo}`).transaction(a => centavos((Number(a) || 0) + liquidada.pago));
      await db.ref(`apuestas/${uid}/${betId}/pagado`).set(true);
    }

    await auditoria.registrarSeguro({
      accion: 'apuesta_liquidada', actor: origen, objetivo: `${uid}/${betId}`, requestId,
      detalles: { estado: liquidada.estado, pago: liquidada.pago, resultado }
    });
    return liquidada;
  }

  return { colocarApuesta, liquidarApuesta, leerConfig };
}

module.exports = { crearMotorApuestas, ErrorApuesta, centavos, inicioDiaCuba, nombreEvento, CAMPOS_SALDO };
