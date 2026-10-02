'use strict';

const crypto = require('crypto');

// ==================== AUDITORÍA ENCADENADA ====================
// Cada registro guarda el hash del anterior y una firma HMAC-SHA256.
// Si alguien borra o cambia un registro, la cadena deja de cuadrar (ver verificarCadena).
// Pendiente (fase posterior): sellar la cabeza de la cadena con una TSA RFC 3161 externa.

const RAIZ = 'auditoria';

// JSON con las claves ordenadas: el mismo objeto siempre produce el mismo texto.
function canonico(valor) {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor);
  if (Array.isArray(valor)) return '[' + valor.map(canonico).join(',') + ']';
  const claves = Object.keys(valor).filter(k => valor[k] !== undefined).sort();
  return '{' + claves.map(k => JSON.stringify(k) + ':' + canonico(valor[k])).join(',') + '}';
}

function firmar(secreto, texto) {
  return crypto.createHmac('sha256', secreto).update(texto, 'utf8').digest('hex');
}

function crearAuditoria(db, secreto) {
  async function registrar({ accion, actor = 'sistema', objetivo = null, requestId = null, detalles = {} }) {
    const fecha = new Date().toISOString();
    let entrada = null;

    const resultado = await db.ref(`${RAIZ}/cabeza`).transaction((cabeza) => {
      const seq = (cabeza && Number.isInteger(cabeza.seq) ? cabeza.seq : 0) + 1;
      const anterior = (cabeza && cabeza.hash) || 'GENESIS';
      const cuerpo = { seq, anterior, fecha, accion, actor, objetivo, requestId, detalles };
      const hash = firmar(secreto, canonico(cuerpo));
      entrada = { ...cuerpo, hash };
      return { seq, hash, fecha };
    });

    if (!resultado.committed || !entrada) {
      throw new Error('No se pudo reservar la secuencia de auditoría');
    }
    await db.ref(`${RAIZ}/registros/${entrada.seq}`).set(entrada);
    return entrada.seq;
  }

  // Nunca tumba la petición: si la auditoría falla, queda en el log de Render.
  async function registrarSeguro(evento) {
    try {
      return await registrar(evento);
    } catch (err) {
      console.error('❌ Auditoría no registrada:', evento && evento.accion, err.message);
      return null;
    }
  }

  // Recorre la cadena y devuelve el primer registro roto (o null si está íntegra).
  async function verificarCadena(limite = 1000) {
    const snap = await db.ref(`${RAIZ}/registros`).orderByKey().limitToLast(limite).once('value');
    let anterior = null;
    let revisados = 0;
    let roto = null;
    snap.forEach((hijo) => {
      const r = hijo.val();
      const { hash, ...cuerpo } = r;
      const esperado = firmar(secreto, canonico(cuerpo));
      const enlaceOk = anterior === null || r.anterior === anterior;
      if (!roto && (esperado !== hash || !enlaceOk)) roto = r.seq;
      anterior = hash;
      revisados += 1;
    });
    return { revisados, integra: roto === null, primerRegistroRoto: roto };
  }

  return { registrar, registrarSeguro, verificarCadena };
}

module.exports = { crearAuditoria, canonico };
