'use strict';

const crypto = require('crypto');
const net = require('net');
const cors = require('cors');

// ==================== CORS: SOLO NUESTRAS WEBS ====================
// Peticiones sin cabecera Origin (UptimeRobot, curl, servidor a servidor) se aceptan;
// la autenticación de cada ruta decide si pueden hacer algo.
function corsRestringido(origenesPermitidos) {
  const permitidos = new Set(origenesPermitidos);
  return cors({
    origin(origen, callback) {
      if (!origen || permitidos.has(origen)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600
  });
}

// ==================== CABECERAS DE SEGURIDAD ====================
function cabecerasSeguras(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Cache-Control', 'no-store');
  res.removeHeader('X-Powered-By');
  next();
}

// ==================== ID DE PETICIÓN ====================
// Cada respuesta de error lleva un ID; con él se busca el detalle en los logs de Render.
function idPeticion(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

// ==================== IP REAL DEL VISITANTE ====================
// Render recibe el tráfico a través de Cloudflare. Sin esto, req.ip puede ser la IP del
// nodo de Cloudflare (Miami para casi toda Cuba) y TODOS los cubanos compartirían el
// mismo contador de límites: bastaban 5 registros en una hora para bloquear a los demás.
// Cloudflare sobrescribe CF-Connecting-IP en cada petición, así que el cliente no la elige.
function ipCliente(req) {
  for (const cabecera of ['cf-connecting-ip', 'true-client-ip']) {
    const v = req.headers[cabecera];
    if (typeof v === 'string' && net.isIP(v.trim())) return v.trim();
  }
  return req.ip || 'desconocida';
}

// ==================== LÍMITE DE PETICIONES (memoria) ====================
// Ventana fija por clave (IP o usuario). Suficiente para una sola instancia de Render.
// soloFallos: solo cuentan las respuestas con error (≥400). Así cien personas detrás de
// la misma IP de ETECSA pueden registrarse bien, pero quien prueba códigos al azar se frena.
function limitador({ ventanaMs, maximo, clave = ipCliente, mensaje = 'Demasiadas peticiones. Intenta más tarde.', soloFallos = false }) {
  const contadores = new Map();
  const limpieza = setInterval(() => {
    const ahora = Date.now();
    for (const [k, v] of contadores) if (v.reinicio <= ahora) contadores.delete(k);
  }, ventanaMs);
  limpieza.unref();

  return function limitar(req, res, next) {
    const k = clave(req);
    const ahora = Date.now();
    let entrada = contadores.get(k);
    if (!entrada || entrada.reinicio <= ahora) {
      entrada = { cuenta: 0, reinicio: ahora + ventanaMs };
      contadores.set(k, entrada);
    }
    if (soloFallos) {
      if (entrada.cuenta >= maximo) {
        res.setHeader('Retry-After', String(Math.ceil((entrada.reinicio - ahora) / 1000)));
        return res.status(429).json({ error: mensaje });
      }
      const contada = entrada;
      res.on('finish', () => { if (res.statusCode >= 400) contada.cuenta += 1; });
      return next();
    }
    entrada.cuenta += 1;
    if (entrada.cuenta > maximo) {
      res.setHeader('Retry-After', String(Math.ceil((entrada.reinicio - ahora) / 1000)));
      return res.status(429).json({ error: mensaje });
    }
    return next();
  };
}

// ==================== ERRORES SIN FUGAS ====================
// El detalle va al log del servidor; el usuario solo ve un mensaje genérico y el ID.
function responderError(res, req, err, contexto, estado = 500) {
  console.error(`[${req.id || '-'}] ${contexto}:`, err);
  return res.status(estado).json({ error: 'Error interno del servidor', requestId: req.id });
}

function manejadorErrores(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Petición demasiado grande' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  return responderError(res, req, err, 'Error no controlado');
}

function rutaNoEncontrada(req, res) {
  res.status(404).json({ error: 'Ruta no encontrada' });
}

module.exports = {
  corsRestringido,
  cabecerasSeguras,
  idPeticion,
  ipCliente,
  limitador,
  responderError,
  manejadorErrores,
  rutaNoEncontrada
};
