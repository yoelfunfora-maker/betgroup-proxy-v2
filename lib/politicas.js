'use strict';

// ==================== PERMISOS DE LA BASE DE DATOS ====================
// Las reglas de Firebase quedan cerradas para todos los navegadores.
// Toda lectura/escritura del frontend pasa por /api/db y se decide aquí,
// según QUIÉN la pide (sesión del servidor) y QUÉ toca.
//
// Roles (nivel): miembro 1 · subadmin 2 · director 2.8 · CEO 3.
// El saldo, el rol y las credenciales NUNCA se escriben por aquí:
// tienen endpoints propios y auditados.

const { NIVEL } = require('./autenticacion');

const DIRECTOR = 2.8;

class Denegado extends Error {
  constructor(motivo = 'No tienes permiso para esta acción') {
    super(motivo);
    this.estado = 403;
  }
}

class Invalido extends Error {
  constructor(motivo = 'Datos inválidos') {
    super(motivo);
    this.estado = 400;
  }
}

// Campos de users/{uid} que solo cambian endpoints específicos.
const CAMPOS_PROTEGIDOS = new Set([
  'creditoReal', 'creditoPromo', 'saldo', 'rol', 'role', 'rolLevel', 'sesionVersion', 'hash', 'salt', 'uid',
  'apodo', 'apodoCambiadoEn', 'ultimoPremioRanking', 'supervisorUid',
  'bonoInscripcion', 'depositadoCUP', 'depositadoMLC', 'googleSub', 'equiposFavoritos'
]);
// Campos que jamás salen del servidor.
const CAMPOS_SECRETOS = ['hash', 'salt', 'sesionVersion'];

const SEGMENTO_RE = /^[^.#$[\]/\u0000-\u001F\u007F]{1,200}$/;
const CODIGO_RE = /^[A-Z0-9ÁÉÍÓÚÑÜ-]{3,40}$/;

// ==================== UTILIDADES ====================
function partir(ruta) {
  if (typeof ruta !== 'string' || ruta.length > 500) throw new Invalido('Ruta inválida');
  const segs = ruta.split('/').filter(Boolean);
  if (segs.length === 0 || segs.length > 8 || !segs.every(s => SEGMENTO_RE.test(s))) throw new Invalido('Ruta inválida');
  return segs;
}

function esObjeto(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Ningún texto guardado puede contener < o > (evita XSS guardado en el panel del CEO).
function revisarTextos(valor, profundidad = 0) {
  if (profundidad > 6) throw new Invalido('Datos demasiado anidados');
  if (typeof valor === 'string') {
    if (valor.length > 2000) throw new Invalido('Texto demasiado largo');
    if (/[<>]/.test(valor)) throw new Invalido('Los textos no pueden contener < ni >');
    return;
  }
  if (Array.isArray(valor)) return valor.forEach(v => revisarTextos(v, profundidad + 1));
  if (esObjeto(valor)) {
    for (const [k, v] of Object.entries(valor)) {
      if (!SEGMENTO_RE.test(k)) throw new Invalido('Clave inválida');
      revisarTextos(v, profundidad + 1);
    }
  }
}

// Detalles de auditoría: sin < >, y si pasan de 2 KB se guardan como texto recortado.
function limpiarDetalles(detalles) {
  if (!esObjeto(detalles)) return {};
  const texto = JSON.stringify(detalles, (k, v) => (typeof v === 'string' ? v.replace(/[<>]/g, '') : v));
  if (texto.length <= 2000) return JSON.parse(texto);
  return { resumen: texto.slice(0, 2000) };
}

function numeroPositivo(v, max = 1000000) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= max;
}

// Depósito mínimo (decisión de Yoel: 500 pesos CUP). Se puede cambiar en config/depositoMinimoCUP.
const DEPOSITO_MINIMO_CUP = 500;
async function revisarDepositoMinimo(db, valor) {
  if (valor.moneda !== 'CUP') return;
  const conf = Number((await db.ref('config/depositoMinimoCUP').once('value')).val());
  const minimo = Number.isFinite(conf) && conf > 0 ? conf : DEPOSITO_MINIMO_CUP;
  if (Number(valor.monto) < minimo) throw new Invalido(`El depósito mínimo es de ${minimo} CUP`);
}

// Retiro mínimo (decisión de Yoel, 3 oct 2026): no se puede pedir un canje de menos de 500
// (config/retiroMinimoCUP). Igual que el depósito mínimo; 1 CR = 1 CUP.
const RETIRO_MINIMO_CUP = 500;
async function revisarRetiroMinimo(db, monto) {
  const conf = Number((await db.ref('config/retiroMinimoCUP').once('value')).val());
  const minimo = Number.isFinite(conf) && conf > 0 ? conf : RETIRO_MINIMO_CUP;
  if (Number(monto) < minimo) throw new Invalido(`El retiro mínimo es de ${minimo} CUP`);
}

// Bono de inscripción (decisión de Yoel): quien entra nuevo recibe crédito promocional para probar,
// pero no puede retirar nada hasta haber depositado al menos 500 CUP (config/bonoDepositoParaRetirar).
// Solo afecta a cuentas con bono: las antiguas siguen igual. Un depósito en MLC aprobado también vale.
const BONO_DEPOSITO_PARA_RETIRAR = 500;
async function revisarRetiroConBono(db, uid) {
  const [uS, cS] = await Promise.all([db.ref(`users/${uid}`).once('value'), db.ref('config/bonoDepositoParaRetirar').once('value')]);
  const usuario = uS.val() || {};
  if (!usuario.bonoInscripcion) return;
  const conf = cS.val() === null || cS.val() === undefined ? NaN : Number(cS.val()); // Number(null) sería 0
  const minimo = Number.isFinite(conf) && conf >= 0 ? conf : BONO_DEPOSITO_PARA_RETIRAR;
  const cup = Number(usuario.depositadoCUP) || 0;
  if (cup >= minimo || (Number(usuario.depositadoMLC) || 0) > 0) return;
  throw new Invalido(`Para retirar necesitas haber depositado al menos ${minimo} CUP (llevas ${cup}). El bono de bienvenida es para probar la plataforma.`);
}

function urlHttpsOVacia(v) {
  if (v === undefined || v === null || v === '') return true;
  try { return new URL(String(v)).protocol === 'https:'; } catch { return false; }
}

function sinSecretos(fila) {
  if (!esObjeto(fila)) return fila;
  const copia = { ...fila };
  for (const k of CAMPOS_SECRETOS) delete copia[k];
  return copia;
}

// ==================== RELACIONES (subadmin ↔ miembros) ====================
// Carga perezosa de users y codigosAcceso, una vez por petición.
function crearContexto(db, usuario) {
  let usuarios = null;
  let codigos = null;
  async function todosUsuarios() {
    if (!usuarios) usuarios = (await db.ref('users').once('value')).val() || {};
    return usuarios;
  }
  async function todosCodigos() {
    if (!codigos) codigos = (await db.ref('codigosAcceso').once('value')).val() || {};
    return codigos;
  }
  // Códigos que creó este usuario (los dos formatos que existen en la base).
  async function codigosDe(uid) {
    const c = await todosCodigos();
    const set = new Set();
    for (const [clave, cod] of Object.entries(c)) {
      if (cod && (cod.generadoPor === uid || cod.createdBy === uid)) {
        set.add(clave);
        if (cod.codigo) set.add(cod.codigo);
        if (cod.code) set.add(cod.code);
      }
    }
    return set;
  }
  let misCodigosCache = null;
  async function esMiMiembro(fila) {
    if (!esObjeto(fila)) return false;
    const yo = usuario.uid;
    if (fila.referidoPorUid === yo) return true;
    const miCodigo = usuario.datos.codigoInvitacion;
    if (miCodigo && fila.referidoPor === miCodigo) return true;
    if (!fila.referidoPor) return false;
    if (!misCodigosCache) misCodigosCache = await codigosDe(yo);
    return misCodigosCache.has(fila.referidoPor);
  }
  async function esMiMiembroUid(uid) {
    const u = (await todosUsuarios())[uid];
    return esMiMiembro(u);
  }
  // ¿Es fila el subadmin que me refirió a mí?
  async function esMiPatrocinador(uidFila, fila) {
    const d = usuario.datos;
    if (!esObjeto(fila)) return false;
    if (d.referidoPorUid && d.referidoPorUid === uidFila) return true;
    if (d.referidoPor && fila.codigoInvitacion === d.referidoPor) return true;
    if (d.referidoPor) {
      const cod = (await todosCodigos())[d.referidoPor];
      if (cod && (cod.generadoPor === uidFila || cod.createdBy === uidFila)) return true;
    }
    return false;
  }
  // ¿fila es jugador del agente agenteUid? (misma regla que lib/comisiones.js → miembrosDe)
  async function esMiembroDe(fila, agenteUid, agente) {
    if (!esObjeto(fila) || !esObjeto(agente)) return false;
    if (fila.referidoPorUid === agenteUid) return true;
    if (agente.codigoInvitacion && fila.referidoPor === agente.codigoInvitacion) return true;
    if (!fila.referidoPor) return false;
    return (await codigosDe(agenteUid)).has(fila.referidoPor);
  }
  // RED de un supervisor (rol "director"): sus jugadores propios, los agentes que el CEO le asignó
  // (users/<agente>/supervisorUid) y los jugadores de esos agentes. Para un agente, solo sus jugadores.
  async function esDeMiRedUid(uid) {
    if (!uid) return false;
    const todos = await todosUsuarios();
    const fila = todos[uid];
    if (!esObjeto(fila)) return false;
    if (await esMiMiembro(fila)) return true;
    if (usuario.datos.rol !== 'director') return false;
    const yo = usuario.uid;
    if (fila.rol === 'subadmin' && fila.supervisorUid === yo) return true;
    for (const [agUid, ag] of Object.entries(todos)) {
      if (ag && ag.rol === 'subadmin' && ag.supervisorUid === yo && await esMiembroDe(fila, agUid, ag)) return true;
    }
    return false;
  }
  return { usuario, todosUsuarios, todosCodigos, esMiMiembro, esMiMiembroUid, esMiPatrocinador, esDeMiRedUid };
}

// ==================== LECTURA ====================
// Cada nodo decide fila por fila qué ve el usuario (null = no la ve).
// clave = id de la fila (uid, id de depósito...), fila = su contenido completo.
const LECTURA = {
  async users(ctx, clave, fila) {
    const u = ctx.usuario;
    if (u.nivel >= NIVEL.CEO || clave === u.uid) return sinSecretos(fila);
    if (u.nivel >= NIVEL.SUBADMIN && (await ctx.esMiMiembro(fila) || await ctx.esDeMiRedUid(clave))) return sinSecretos(fila);
    if (await ctx.esMiPatrocinador(clave, fila)) {
      // Un miembro solo ve de su subadmin lo necesario para pagarle.
      return {
        uid: clave, nombre: fila.nombre || null, codigoInvitacion: fila.codigoInvitacion || null,
        datosBancarios: fila.datosBancarios || null
      };
    }
    return null;
  },
  async apuestas(ctx, clave, fila) {
    const u = ctx.usuario;
    if (u.nivel >= NIVEL.CEO || clave === u.uid) return fila;
    if (u.nivel >= NIVEL.SUBADMIN && await ctx.esDeMiRedUid(clave)) return fila;
    return null;
  },
  async codigosAcceso(ctx, clave, fila) {
    const u = ctx.usuario;
    if (u.nivel >= NIVEL.CEO) return fila;
    if (u.nivel >= NIVEL.SUBADMIN && esObjeto(fila) && (fila.generadoPor === u.uid || fila.createdBy === u.uid)) return fila;
    return null;
  },
  async cierresDia(ctx, clave, fila) {
    const u = ctx.usuario;
    if (u.nivel >= NIVEL.CEO) return fila;
    if (u.nivel >= NIVEL.SUBADMIN && esObjeto(fila) && fila.subadminId === u.uid) return fila;
    return null;
  },
  // El CEO ve todo. El supervisor, solo lo de su red (antes veía los de toda la casa).
  async depositos(ctx, clave, fila) {
    const u = ctx.usuario;
    if (u.nivel >= NIVEL.CEO) return fila;
    if (u.nivel >= NIVEL.SUBADMIN && esObjeto(fila) && fila.solicitadoPor === u.uid) return fila;
    if (u.nivel >= DIRECTOR && esObjeto(fila) && (await ctx.esDeMiRedUid(fila.userId) || await ctx.esDeMiRedUid(fila.solicitadoPor))) return fila;
    return null;
  },
  async solicitudesDeposito(ctx, clave, fila) {
    const u = ctx.usuario;
    if (u.nivel >= NIVEL.CEO) return fila;
    if (esObjeto(fila) && fila.userId === u.uid) return fila;
    if (u.nivel >= NIVEL.SUBADMIN && esObjeto(fila) && await ctx.esDeMiRedUid(fila.userId)) return fila;
    return null;
  },
  async solicitudesRetiro(ctx, clave, fila) {
    const u = ctx.usuario;
    if (u.nivel >= NIVEL.CEO) return fila;
    if (esObjeto(fila) && fila.userId === u.uid) return fila;
    if (u.nivel >= DIRECTOR && esObjeto(fila) && await ctx.esDeMiRedUid(fila.userId)) return fila;
    return null;
  },
  async premios(ctx, clave, fila) {
    const u = ctx.usuario;
    if (u.nivel >= NIVEL.CEO) return fila;
    if (esObjeto(fila) && (fila.userId === u.uid || fila.enviadoPor === u.uid)) return fila;
    return null;
  },
  async alertas(ctx, clave, fila) {
    return ctx.usuario.nivel >= NIVEL.CEO || clave === ctx.usuario.uid ? fila : null;
  },
  async auditLog(ctx, clave, fila) {
    return ctx.usuario.nivel >= NIVEL.CEO ? fila : null;
  },
  async historial(ctx, clave, fila) {
    return ctx.usuario.nivel >= NIVEL.CEO ? fila : null;
  },
  async transacciones(ctx, clave, fila) {
    return ctx.usuario.nivel >= NIVEL.CEO ? fila : null;
  }
};
// Nodos de solo lectura para cualquier usuario con sesión (sin datos personales).
const LECTURA_PUBLICA = new Set(['config', 'system', 'mercados', 'eventos', 'fases']);
// Nodos cuya visibilidad depende solo de la clave (se pueden consultar sin leer la fila).
const POR_CLAVE = new Set(['apuestas', 'alertas', 'historial', 'transacciones']);

function puedeConsultarNodo(nodo) {
  return LECTURA_PUBLICA.has(nodo) || Object.prototype.hasOwnProperty.call(LECTURA, nodo);
}

// ==================== ESCRITURA ====================
// Recibe UNA escritura atómica (ruta + valor; null = borrar) y devuelve el valor a guardar.
// Las "update" se descomponen antes en escrituras por campo.
async function revisarEscritura(ctx, db, segs, valor, { esPush = false } = {}) {
  const u = ctx.usuario;
  const esCEO = u.nivel >= NIVEL.CEO;
  const [nodo, clave, campo] = segs;
  const borrar = valor === null;
  if (!borrar && nodo !== 'auditLog') revisarTextos(valor);

  switch (nodo) {
    case 'users': {
      if (!clave) throw new Denegado();
      if (!campo) {
        if (borrar && esCEO && clave !== u.uid) return null; // eliminar usuario
        throw new Denegado('Actualiza los campos uno a uno');
      }
      if (CAMPOS_PROTEGIDOS.has(campo)) throw new Denegado('Ese campo solo se cambia desde su función específica');
      if (esCEO) return valor;
      if (clave === u.uid) {
        if (campo === 'datosBancarios' && segs.length === 3 && esObjeto(valor)) {
          const { banco, titular, cuenta, telefono } = valor;
          if (![banco, titular, cuenta, telefono].every(t => typeof t === 'string' && t.trim() && t.length <= 100)) {
            throw new Invalido('Datos bancarios incompletos');
          }
          return { banco, titular, cuenta, telefono, actualizado: Date.now() };
        }
        if (campo === 'riskFlag' && valor === true) return true;
        if (campo === 'activo' && valor === false) return false;
        if (campo === 'autoexcludedUntil' && segs.length === 3) {
          const actual = Number(u.datos.autoexcludedUntil) || 0;
          const n = Number(valor);
          if (!Number.isFinite(n) || n < Date.now() || n < actual || n > Date.now() + 400 * 86400000) {
            throw new Invalido('Fecha de autoexclusión inválida');
          }
          return n;
        }
        throw new Denegado();
      }
      if (u.nivel >= NIVEL.SUBADMIN && campo === 'ultimoPremio' && segs.length === 3 && await ctx.esMiMiembroUid(clave)) {
        if (!esObjeto(valor) || !numeroPositivo(valor.monto) || !urlHttpsOVacia(valor.fotoUrl)) throw new Invalido();
        return { monto: Number(valor.monto), fotoUrl: valor.fotoUrl || null, fecha: Date.now(), de: u.datos.nombre || null };
      }
      throw new Denegado();
    }

    case 'apuestas': case 'historial': case 'transacciones': case 'telefonos':
      // Las apuestas solo las crea y liquida el servidor. El CEO puede borrar datos de un usuario eliminado.
      if (esCEO && borrar && clave && segs.length === 2) return null;
      throw new Denegado('Las apuestas solo las gestiona el servidor');

    case 'codigosAcceso': {
      if (!clave || !CODIGO_RE.test(clave)) throw new Invalido('Código inválido');
      const actual = (await db.ref(`codigosAcceso/${clave}`).once('value')).val();
      const esMio = actual && (actual.generadoPor === u.uid || actual.createdBy === u.uid);
      if (borrar && segs.length === 2) {
        if (esCEO || (u.nivel >= NIVEL.SUBADMIN && esMio && !actual.usado)) return null;
        throw new Denegado();
      }
      if (segs.length !== 2 || !esObjeto(valor) || u.nivel < NIVEL.SUBADMIN) throw new Denegado();
      if (actual && (!esMio || actual.usado)) throw new Denegado('Ese código ya existe');
      const creador = valor.generadoPor || valor.createdBy;
      const codigo = valor.codigo || valor.code;
      if (creador !== u.uid || codigo !== clave || valor.usado !== false) throw new Invalido('Código mal formado');
      const rolesPermitidos = esCEO ? ['member', 'subadmin', 'director'] : ['member'];
      if (!rolesPermitidos.includes(valor.rol)) throw new Denegado('No puedes crear códigos para ese rol');
      return { ...valor, usado: false, usadoPor: null, usadoEn: null, creadoEnServidor: Date.now() };
    }

    case 'config': case 'system': case 'eventos': case 'fases':
      if (esCEO) return valor;
      throw new Denegado();

    case 'cierresDia': {
      if (!clave) throw new Denegado();
      if (segs.length === 2 && !borrar && u.nivel >= NIVEL.SUBADMIN && esObjeto(valor)) {
        const existe = (await db.ref(`cierresDia/${clave}`).once('value')).exists();
        if (!existe && valor.subadminId === u.uid && valor.estado === 'pending') {
          return { ...valor, subadminNombre: u.datos.nombre || null, subadminTel: u.datos.telefono || null, createdAt: Date.now() };
        }
      }
      if (esCEO && !borrar) return valor; // confirmar cierre
      throw new Denegado();
    }

    case 'depositos': {
      if (!clave || segs.length !== 2 || borrar || !esObjeto(valor) || u.nivel < NIVEL.SUBADMIN) {
        throw new Denegado('Las recargas se aprueban o rechazan desde su botón');
      }
      if ((await db.ref(`depositos/${clave}`).once('value')).exists()) throw new Denegado('Esa recarga ya existe');
      if (valor.solicitadoPor !== u.uid || valor.estado !== 'pending' || !numeroPositivo(valor.monto)
        || !['CUP', 'MLC'].includes(valor.moneda) || !urlHttpsOVacia(valor.fotoUrl) || !urlHttpsOVacia(valor.fotoUrlUsuario)) {
        throw new Invalido('Recarga mal formada');
      }
      if (!esCEO && !(await ctx.esDeMiRedUid(valor.userId))) throw new Denegado('Ese usuario no es de tu equipo');
      await revisarDepositoMinimo(db, valor);
      return { ...valor, monto: Number(valor.monto), solicitadoPorNombre: u.datos.nombre || null, fecha: Date.now() };
    }

    case 'solicitudesDeposito': {
      if (!clave || segs.length !== 2 || borrar || !esObjeto(valor)) throw new Denegado('Las solicitudes se aprueban o rechazan desde su botón');
      if ((await db.ref(`solicitudesDeposito/${clave}`).once('value')).exists()) throw new Denegado('Esa solicitud ya existe');
      if (valor.userId !== u.uid || valor.estado !== 'pendiente' || !numeroPositivo(valor.monto)
        || !['CUP', 'MLC'].includes(valor.moneda) || !urlHttpsOVacia(valor.fotoUrl)) {
        throw new Invalido('Solicitud mal formada');
      }
      await revisarDepositoMinimo(db, valor);
      return { ...valor, monto: Number(valor.monto), nombre: u.datos.nombre || null, telefono: u.datos.telefono || null, creadoEn: Date.now() };
    }

    case 'solicitudesRetiro': {
      if (esCEO && clave && !borrar) return valor; // procesar el retiro
      if (!clave || segs.length !== 2 || borrar || !esObjeto(valor)) throw new Denegado();
      if ((await db.ref(`solicitudesRetiro/${clave}`).once('value')).exists()) throw new Denegado('Esa solicitud ya existe');
      if (valor.userId !== u.uid || valor.estado !== 'pendiente' || !numeroPositivo(valor.monto)) throw new Invalido('Solicitud mal formada');
      const saldo = Number((await db.ref(`users/${u.uid}/creditoReal`).once('value')).val()) || 0;
      if (Number(valor.monto) > saldo) throw new Invalido('Saldo insuficiente');
      await revisarRetiroConBono(db, u.uid);
      await revisarRetiroMinimo(db, valor.monto);
      // Límite bancario: 10 canjes por día en total.
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      const deHoy = await db.ref('solicitudesRetiro').orderByChild('creadoEn').startAt(hoy.getTime()).once('value');
      if (deHoy.numChildren() >= 10) throw new Invalido('Límite diario de 10 canjes alcanzado. Intenta mañana.');
      return { ...valor, monto: Number(valor.monto), nombre: u.datos.nombre || null, telefono: u.datos.telefono || null, creadoEn: Date.now() };
    }

    case 'auditLog': {
      // Cualquiera con sesión deja constancia, pero quién y cuándo los pone el servidor.
      if (borrar || !(esPush || segs.length === 2) || !esObjeto(valor)) throw new Denegado();
      return {
        action: String(valor.action || 'ACCION').slice(0, 60),
        details: limpiarDetalles(valor.details),
        uid: u.uid, nombre: u.datos.nombre || '', telefono: u.datos.telefono || '', timestamp: Date.now()
      };
    }

    case 'alertas':
      if (clave === u.uid || esCEO) return valor;
      throw new Denegado();

    case 'premios': {
      if (!clave || segs.length !== 2 || borrar || !esObjeto(valor) || u.nivel < NIVEL.SUBADMIN) throw new Denegado();
      if (valor.enviadoPor !== u.uid || !numeroPositivo(valor.monto) || !urlHttpsOVacia(valor.fotoUrl)) throw new Invalido();
      if (!esCEO && !(await ctx.esDeMiRedUid(valor.userId))) throw new Denegado('Ese usuario no es de tu equipo');
      return { ...valor, monto: Number(valor.monto), enviadoPorNombre: u.datos.nombre || null, fecha: Date.now() };
    }

    default:
      throw new Denegado();
  }
}

module.exports = {
  Denegado, Invalido, partir, esObjeto, revisarTextos, sinSecretos,
  crearContexto, LECTURA, LECTURA_PUBLICA, POR_CLAVE, puedeConsultarNodo, revisarEscritura,
  CAMPOS_PROTEGIDOS, DIRECTOR
};
