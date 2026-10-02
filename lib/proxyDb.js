'use strict';

// ==================== /api/db: LA BASE DE DATOS A TRAVÉS DEL SERVIDOR ====================
// El frontend ya no habla con Firebase. Su "traductor" (bg-api.js) envía aquí:
//   { op: 'leer',      ruta, consulta? }
//   { op: 'escribir',  ruta, valor }          (set; valor null = borrar)
//   { op: 'actualizar',ruta, valor: {campo: v} }
//   { op: 'agregar',   ruta, valor }          (push)
//   { op: 'comparar',  ruta, esperado, valor } (transacción optimista)
// Cada operación pasa por lib/politicas.js.

const {
  Denegado, Invalido, partir, esObjeto, crearContexto,
  LECTURA, LECTURA_PUBLICA, POR_CLAVE, puedeConsultarNodo, revisarEscritura
} = require('./politicas');

const HIJO_RE = /^[A-Za-z0-9_]{1,64}$/;
const OPS = new Set(['leer', 'escribir', 'actualizar', 'agregar', 'comparar']);

// Sustituye el marcador de hora del servidor de Firebase por la hora real.
function resolverMarcadores(v) {
  if (esObjeto(v)) {
    if (Object.keys(v).length === 1 && v['.sv'] === 'timestamp') return Date.now();
    const r = {};
    for (const [k, x] of Object.entries(v)) r[k] = resolverMarcadores(x);
    return r;
  }
  if (Array.isArray(v)) return v.map(resolverMarcadores);
  return v === undefined ? null : v;
}

function primitivo(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function aplicarConsulta(ref, c) {
  if (!c) return ref;
  if (!esObjeto(c)) throw new Invalido('Consulta inválida');
  let q = ref;
  if (c.orderBy === 'key') q = q.orderByKey();
  else if (c.orderBy === 'child') {
    if (!HIJO_RE.test(c.child || '')) throw new Invalido('Consulta inválida');
    q = q.orderByChild(c.child);
  } else if (c.orderBy !== undefined) throw new Invalido('Consulta inválida');
  for (const f of ['equalTo', 'startAt', 'endAt']) {
    if (c[f] !== undefined) {
      if (!primitivo(c[f])) throw new Invalido('Consulta inválida');
      q = q[f](c[f]);
    }
  }
  for (const f of ['limitToFirst', 'limitToLast']) {
    if (c[f] !== undefined) {
      const n = Number(c[f]);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Invalido('Consulta inválida');
      q = q[f](n);
    }
  }
  return q;
}

// Lee una instantánea y conserva el orden de la consulta.
function aObjetoOrdenado(snap) {
  const valor = snap.val();
  if (!esObjeto(valor)) return { valor, orden: null };
  const orden = [];
  snap.forEach((h) => { orden.push(h.key); });
  return { valor, orden };
}

function extraer(obj, resto) {
  let v = obj;
  for (const k of resto) {
    if (!esObjeto(v)) return null;
    v = v[k];
    if (v === undefined) return null;
  }
  return v === undefined ? null : v;
}

function crearProxyDb({ db, auditoria }) {
  async function leer(ctx, segs, consulta) {
    const [nodo, clave, ...resto] = segs;
    if (!puedeConsultarNodo(nodo)) throw new Denegado();

    if (LECTURA_PUBLICA.has(nodo)) {
      return aObjetoOrdenado(await aplicarConsulta(db.ref(segs.join('/')), consulta).once('value'));
    }
    const filtro = LECTURA[nodo];

    // Colección completa (o consultada): se filtra fila por fila.
    if (!clave) {
      const { valor, orden } = aObjetoOrdenado(await aplicarConsulta(db.ref(nodo), consulta).once('value'));
      if (!esObjeto(valor)) return { valor: null, orden: null };
      const salida = {};
      const ordenSalida = [];
      for (const k of (orden || Object.keys(valor))) {
        const visible = await filtro(ctx, k, valor[k]);
        if (visible !== null && visible !== undefined) { salida[k] = visible; ordenSalida.push(k); }
      }
      return { valor: ordenSalida.length ? salida : null, orden: ordenSalida };
    }

    // Dentro de una fila cuya visibilidad depende solo de la clave (ej. apuestas/{uid}).
    if (POR_CLAVE.has(nodo)) {
      const permitido = await filtro(ctx, clave, true);
      if (permitido === null) throw new Denegado();
      return aObjetoOrdenado(await aplicarConsulta(db.ref(segs.join('/')), consulta).once('value'));
    }

    // Resto: se lee la fila entera, se decide y se devuelve solo la parte pedida.
    if (consulta) throw new Invalido('Consulta no soportada en esta ruta');
    const fila = (await db.ref(`${nodo}/${clave}`).once('value')).val();
    if (fila === null) return { valor: null, orden: null };
    const visible = await filtro(ctx, clave, fila);
    if (visible === null) throw new Denegado();
    const valor = extraer(visible, resto);
    return { valor, orden: esObjeto(valor) ? Object.keys(valor) : null };
  }

  // Convierte cualquier operación de escritura en una lista de escrituras atómicas revisadas.
  async function prepararEscrituras(ctx, segs, op, valor) {
    if (op === 'actualizar') {
      if (!esObjeto(valor) || Object.keys(valor).length === 0 || Object.keys(valor).length > 50) throw new Invalido();
      const lista = [];
      for (const [k, v] of Object.entries(valor)) {
        const sub = segs.concat(partir(k));
        lista.push([sub.join('/'), await revisarEscritura(ctx, db, sub, resolverMarcadores(v))]);
      }
      return lista;
    }
    if (op === 'agregar') {
      const clave = db.ref(segs.join('/')).push().key;
      const sub = segs.concat(clave);
      return [[sub.join('/'), await revisarEscritura(ctx, db, sub, resolverMarcadores(valor), { esPush: true })]];
    }
    return [[segs.join('/'), await revisarEscritura(ctx, db, segs, resolverMarcadores(valor))]];
  }

  async function manejar(req, res) {
    try {
      const { op, ruta, consulta, valor, esperado } = req.body || {};
      if (!OPS.has(op)) throw new Invalido('Operación desconocida');
      const segs = partir(ruta);
      const ctx = crearContexto(db, req.usuario);

      if (op === 'leer') return res.json(await leer(ctx, segs, consulta));

      if (op === 'comparar') {
        // Transacción optimista: solo escribe si el valor actual es el que vio el cliente.
        const [[ruta1, nuevo]] = await prepararEscrituras(ctx, segs, 'escribir', valor);
        const esperadoJson = JSON.stringify(esperado === undefined ? null : esperado);
        let aplicado = false;
        const tx = await db.ref(ruta1).transaction((cur) => {
          aplicado = false;
          // Primera llamada con null sin caché: devolver null obliga a Firebase a leer el valor real.
          if (cur === null && esperadoJson !== 'null') return null;
          if (JSON.stringify(cur === undefined ? null : cur) !== esperadoJson) return undefined;
          aplicado = true;
          return nuevo;
        });
        if (tx.committed && aplicado) {
          await auditoria.registrarSeguro({ accion: 'db_comparar', actor: req.usuario.uid, objetivo: ruta1, requestId: req.id });
        }
        return res.json({ ok: true, aplicado: tx.committed && aplicado, valor: tx.snapshot.val() });
      }

      const escrituras = await prepararEscrituras(ctx, segs, op, valor);
      const multi = {};
      for (const [r, v] of escrituras) multi[r] = v;
      await db.ref().update(multi);

      // Toda escritura queda en la cadena de auditoría (sin el contenido, solo rutas).
      await auditoria.registrarSeguro({
        accion: `db_${op}`, actor: req.usuario.uid, objetivo: escrituras.map(e => e[0]).join(',').slice(0, 300), requestId: req.id
      });
      const nuevaClave = op === 'agregar' ? escrituras[0][0].split('/').pop() : undefined;
      return res.json({ ok: true, clave: nuevaClave });
    } catch (err) {
      if (err instanceof Denegado || err instanceof Invalido) {
        return res.status(err.estado).json({ error: err.message });
      }
      console.error(`[${req.id}] /api/db:`, err);
      return res.status(500).json({ error: 'Error interno del servidor', requestId: req.id });
    }
  }

  return { manejar, leer };
}

module.exports = { crearProxyDb, resolverMarcadores };
