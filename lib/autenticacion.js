'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const pbkdf2 = promisify(crypto.pbkdf2);

// ==================== PARÁMETROS ====================
// PBKDF2-HMAC-SHA256 (aprobado FIPS 140-3) con 600.000 iteraciones (OWASP 2023).
const PBKDF2_ITERACIONES = 600000;
const PBKDF2_LONGITUD = 32;
const SAL_BYTES = 16;
const SESION_DURACION_S = 12 * 60 * 60;
const MAX_FALLOS_CUENTA = 5;
const BLOQUEO_MS = 15 * 60 * 1000;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

// Niveles de rol: el servidor SIEMPRE lee el rol de la base de datos, nunca del cliente.
const NIVEL_POR_ROL = Object.freeze({
  member: 1, miembro: 1,
  subadmin: 2,
  admin: 2.5, moderador: 2.5, soporte: 2,
  director: 2.8,
  ceo: 3, superadmin: 3
});
const NIVEL = Object.freeze({ MIEMBRO: 1, SUBADMIN: 2, ADMIN: 2.5, CEO: 3 });

// Misma regla que usa el frontend para la clave de credenciales_acceso.
function normalizarClave(email) {
  return email.toLowerCase().replace(/\./g, '-').replace(/@/g, '-');
}

function nivelDe(usuario) {
  if (!usuario) return 0;
  const rol = String(usuario.rol || usuario.role || '').toLowerCase();
  const porRol = NIVEL_POR_ROL[rol] || 0;
  const porNumero = Number(usuario.rolLevel);
  // Se toma el menor de los dos: un rolLevel inflado sin rol a juego no da privilegios.
  if (Number.isFinite(porNumero) && porNumero > 0 && porRol > 0) return Math.min(porNumero, porRol);
  return porRol || (Number.isFinite(porNumero) && porNumero > 0 ? Math.min(porNumero, NIVEL.MIEMBRO) : 0);
}

function compararSeguro(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// ==================== TOKENS DE SESIÓN (JWT HS256) ====================
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function firmarToken(payload, secreto) {
  const cabecera = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const cuerpo = b64url(JSON.stringify(payload));
  const firma = crypto.createHmac('sha256', secreto).update(`${cabecera}.${cuerpo}`).digest('base64url');
  return `${cabecera}.${cuerpo}.${firma}`;
}

function verificarToken(token, secreto) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [cabecera, cuerpo, firma] = partes;
  const esperada = crypto.createHmac('sha256', secreto).update(`${cabecera}.${cuerpo}`).digest('base64url');
  if (!compararSeguro(firma, esperada)) return null;
  try {
    const h = JSON.parse(Buffer.from(cabecera, 'base64url').toString('utf8'));
    if (h.alg !== 'HS256' || h.typ !== 'JWT') return null;
    const p = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    const ahora = Math.floor(Date.now() / 1000);
    if (typeof p.sub !== 'string' || !Number.isInteger(p.exp) || p.exp <= ahora) return null;
    return p;
  } catch {
    return null;
  }
}

// ==================== HASH DE CONTRASEÑAS ====================
async function hashPbkdf2(password, salHex) {
  const derivada = await pbkdf2(password, Buffer.from(salHex, 'hex'), PBKDF2_ITERACIONES, PBKDF2_LONGITUD, 'sha256');
  return derivada.toString('hex');
}

function hashLegado(password, sal, pimienta) {
  return crypto.createHash('sha256').update(password + sal + pimienta, 'utf8').digest('hex');
}

// Hash ficticio para que "usuario no existe" tarde lo mismo que "contraseña mala".
const SAL_FICTICIA = crypto.randomBytes(SAL_BYTES).toString('hex');

// Datos del usuario que sí puede ver el propio usuario (sin hash, sal ni internos).
function perfilPublico(uid, u) {
  return {
    uid,
    email: u.email || null,
    nombre: u.nombre || null,
    rol: u.rol || u.role || 'member',
    rolLevel: nivelDe(u),
    creditoReal: Number(u.creditoReal) || 0,
    creditoPromo: Number(u.creditoPromo) || 0,
    codigoInvitacion: u.codigoInvitacion || null
  };
}

// ==================== FÁBRICA ====================
function crearAutenticacion({ db, config, auditoria }) {
  const fallosPorCuenta = new Map();

  function cuentaBloqueada(clave) {
    const f = fallosPorCuenta.get(clave);
    if (!f) return false;
    if (f.hasta && f.hasta > Date.now()) return true;
    if (f.hasta && f.hasta <= Date.now()) fallosPorCuenta.delete(clave);
    return false;
  }

  function anotarFallo(clave) {
    const f = fallosPorCuenta.get(clave) || { cuenta: 0, hasta: 0 };
    f.cuenta += 1;
    if (f.cuenta >= MAX_FALLOS_CUENTA) f.hasta = Date.now() + BLOQUEO_MS;
    fallosPorCuenta.set(clave, f);
  }

  async function migrarHashLegado(clave, uid, password) {
    const sal = crypto.randomBytes(SAL_BYTES).toString('hex');
    const hash = await hashPbkdf2(password, sal);
    await db.ref().update({
      [`credenciales_servidor/${clave}`]: {
        uid, algoritmo: 'pbkdf2-sha256', iteraciones: PBKDF2_ITERACIONES, sal, hash, actualizado: Date.now()
      },
      // Se borran los hashes viejos que hoy cualquiera puede leer.
      [`credenciales_acceso/${clave}/hash`]: null,
      [`credenciales_acceso/${clave}/salt`]: null,
      [`users/${uid}/hash`]: null,
      [`users/${uid}/salt`]: null
    });
  }

  // Devuelve el uid si la contraseña es correcta; null en cualquier otro caso.
  async function comprobarCredenciales(clave, password) {
    const nuevoSnap = await db.ref(`credenciales_servidor/${clave}`).once('value');
    const nuevo = nuevoSnap.val();
    if (nuevo && nuevo.algoritmo === 'pbkdf2-sha256' && typeof nuevo.sal === 'string') {
      const calculado = nuevo.iteraciones === PBKDF2_ITERACIONES
        ? await hashPbkdf2(password, nuevo.sal)
        : (await pbkdf2(password, Buffer.from(nuevo.sal, 'hex'), nuevo.iteraciones, PBKDF2_LONGITUD, 'sha256')).toString('hex');
      return compararSeguro(calculado, nuevo.hash) ? nuevo.uid : null;
    }

    const legadoSnap = await db.ref(`credenciales_acceso/${clave}`).once('value');
    const legado = legadoSnap.val();
    if (!legado || !legado.hash || !legado.salt || !legado.uid || !config.pimientaLegada) {
      await hashPbkdf2(password, SAL_FICTICIA);
      return null;
    }
    if (!compararSeguro(hashLegado(password, legado.salt, config.pimientaLegada), legado.hash)) {
      return null;
    }
    await migrarHashLegado(clave, legado.uid, password);
    return legado.uid;
  }

  // POST /api/auth/login  { email, password }
  async function login(req, res, next) {
    try {
      const { email, password } = req.body || {};
      if (typeof email !== 'string' || typeof password !== 'string'
        || !EMAIL_RE.test(email.trim()) || password.length < 1 || password.length > 128) {
        return res.status(400).json({ error: 'Email o contraseña con formato inválido' });
      }
      const clave = normalizarClave(email.trim());
      if (cuentaBloqueada(clave)) {
        return res.status(429).json({ error: 'Cuenta bloqueada temporalmente por intentos fallidos. Prueba en 15 minutos.' });
      }

      const uid = await comprobarCredenciales(clave, password);
      const usuario = uid ? (await db.ref(`users/${uid}`).once('value')).val() : null;

      if (!uid || !usuario || usuario.activo === false) {
        anotarFallo(clave);
        await auditoria.registrarSeguro({ accion: 'login_fallido', actor: 'anonimo', objetivo: clave, requestId: req.id });
        return res.status(401).json({ error: 'Email o contraseña incorrectos' });
      }

      fallosPorCuenta.delete(clave);
      const version = Number.isInteger(usuario.sesionVersion) ? usuario.sesionVersion : 0;
      const ahora = Math.floor(Date.now() / 1000);
      const token = firmarToken({
        sub: uid, ver: version, iat: ahora, exp: ahora + SESION_DURACION_S, jti: crypto.randomUUID()
      }, config.sesionSecreto);

      await auditoria.registrarSeguro({ accion: 'login_ok', actor: uid, requestId: req.id });
      return res.json({ token, expiraEn: SESION_DURACION_S, usuario: perfilPublico(uid, usuario) });
    } catch (err) {
      return next(err);
    }
  }

  // Middleware: exige "Authorization: Bearer <token>" válido y carga req.usuario desde la BD.
  async function requerirSesion(req, res, next) {
    try {
      const cabecera = req.get('authorization') || '';
      const token = cabecera.startsWith('Bearer ') ? cabecera.slice(7).trim() : '';
      const payload = verificarToken(token, config.sesionSecreto);
      if (!payload) return res.status(401).json({ error: 'Sesión no válida o caducada' });

      const usuario = (await db.ref(`users/${payload.sub}`).once('value')).val();
      const version = usuario && Number.isInteger(usuario.sesionVersion) ? usuario.sesionVersion : 0;
      if (!usuario || usuario.activo === false || payload.ver !== version) {
        return res.status(401).json({ error: 'Sesión no válida o caducada' });
      }
      req.usuario = { uid: payload.sub, nivel: nivelDe(usuario), datos: usuario };
      return next();
    } catch (err) {
      return next(err);
    }
  }

  function requerirNivel(minimo) {
    return function comprobarNivel(req, res, next) {
      if (!req.usuario || req.usuario.nivel < minimo) {
        return res.status(403).json({ error: 'No tienes permiso para esta acción' });
      }
      return next();
    };
  }

  // POST /api/auth/logout — invalida TODAS las sesiones abiertas del usuario.
  async function logout(req, res, next) {
    try {
      await db.ref(`users/${req.usuario.uid}/sesionVersion`).transaction(v => (Number.isInteger(v) ? v : 0) + 1);
      await auditoria.registrarSeguro({ accion: 'logout', actor: req.usuario.uid, requestId: req.id });
      return res.json({ success: true });
    } catch (err) {
      return next(err);
    }
  }

  // GET /api/auth/yo — perfil del usuario de la sesión.
  function yo(req, res) {
    res.json({ usuario: perfilPublico(req.usuario.uid, req.usuario.datos) });
  }

  return { login, logout, yo, requerirSesion, requerirNivel };
}

module.exports = {
  crearAutenticacion,
  NIVEL,
  nivelDe,
  normalizarClave,
  firmarToken,
  verificarToken,
  hashLegado,
  perfilPublico
};
