'use strict';

// Firebase falso en memoria + arranque de servidor.js para las pruebas.
// Imita lo importante del SDK real: transacciones que primero se llaman con null,
// consultas orderByChild/equalTo/startAt/limit y actualizaciones multi-ruta.

const Module = require('module');
const path = require('path');

const raiz = {};
const partes = p => String(p).split('/').filter(Boolean);
const copiar = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function get(p) {
  let n = raiz;
  for (const k of partes(p)) {
    if (n === null || typeof n !== 'object') return null;
    n = n[k];
  }
  return n === undefined ? null : copiar(n);
}

function set(p, v) {
  const ks = partes(p);
  if (!ks.length) { Object.keys(raiz).forEach(k => delete raiz[k]); Object.assign(raiz, v || {}); return; }
  let n = raiz;
  for (const k of ks.slice(0, -1)) {
    if (typeof n[k] !== 'object' || n[k] === null) n[k] = {};
    n = n[k];
  }
  if (v === null || v === undefined) delete n[ks.at(-1)];
  else n[ks.at(-1)] = copiar(v);
}

function snap(v, clave = null, orden = null) {
  return {
    key: clave,
    val: () => copiar(v),
    exists: () => v !== null && v !== undefined,
    numChildren: () => (v && typeof v === 'object' ? Object.keys(v).length : 0),
    forEach(cb) {
      if (!v || typeof v !== 'object') return;
      for (const k of (orden || Object.keys(v))) cb(snap(v[k], k));
    }
  };
}

let contadorPush = 0;
function ref(p = '') {
  const q = {};
  const r = {
    key: partes(p).at(-1) || null,
    async once() {
      let v = get(p);
      if (v && typeof v === 'object' && (q.child || q.key || q.limit)) {
        let filas = Object.entries(v);
        if (q.child) {
          filas = filas.filter(([, x]) => x && typeof x === 'object');
          if ('equalTo' in q) filas = filas.filter(([, x]) => x[q.child] === q.equalTo);
          if ('startAt' in q) filas = filas.filter(([, x]) => x[q.child] >= q.startAt);
          filas.sort((a, b) => (a[1][q.child] > b[1][q.child] ? 1 : -1));
        }
        if (q.limit) filas = q.limit.ultimo ? filas.slice(-q.limit.n) : filas.slice(0, q.limit.n);
        v = filas.length ? Object.fromEntries(filas) : null;
        return snap(v, r.key, filas.map(f => f[0]));
      }
      return snap(v, r.key);
    },
    async set(v) { set(p, v); },
    async update(o) { for (const [k, v] of Object.entries(o)) set(p ? `${p}/${k}` : k, v); },
    async remove() { set(p, null); },
    async transaction(fn) {
      const real = get(p);
      let res = fn(null);
      if (res === undefined) return { committed: false, snapshot: snap(null) };
      if (real !== null && JSON.stringify(res) !== JSON.stringify(real)) {
        res = fn(get(p));
        if (res === undefined) return { committed: false, snapshot: snap(real) };
      }
      set(p, res === null ? null : res);
      return { committed: true, snapshot: snap(get(p)) };
    },
    orderByChild(c) { q.child = c; return r; },
    orderByKey() { q.key = true; return r; },
    equalTo(v) { q.equalTo = v; return r; },
    startAt(v) { q.startAt = v; return r; },
    endAt(v) { q.endAt = v; return r; },
    limitToLast(n) { q.limit = { n, ultimo: true }; return r; },
    limitToFirst(n) { q.limit = { n, ultimo: false }; return r; },
    push() { contadorPush += 1; return ref(`${p}/-P${String(contadorPush).padStart(6, '0')}`); }
  };
  return r;
}

function arrancar({ puerto, env = {}, axiosGet } = {}) {
  const original = Module._load;
  const axiosReal = require('axios');
  const axiosFalso = Object.assign(Object.create(axiosReal), {
    get: async (url) => { if (axiosGet) return axiosGet(url); throw new Error('sin red'); },
    post: async () => { throw new Error('sin red'); }
  });
  const httpsReal = require('https');
  const EventEmitter = require('events');
  const httpsFalso = {
    ...httpsReal,
    get: () => new EventEmitter(),
    request: (opt, cb) => {
      const req = new EventEmitter();
      req.setTimeout = () => {}; req.destroy = () => {};
      req.end = () => { const res = new EventEmitter(); cb(res); setImmediate(() => { res.emit('data', '{"events":[]}'); res.emit('end'); }); };
      return req;
    }
  };
  Module._load = function cargar(pedido, ...resto) {
    if (pedido === 'firebase-admin/app') return { initializeApp() {}, cert: () => ({}) };
    if (pedido === 'firebase-admin/database') return { getDatabase: () => ({ ref }) };
    if (pedido === 'axios') return axiosFalso;
    if (pedido === 'https') return httpsFalso;
    return original.call(this, pedido, ...resto);
  };
  const fetchReal = global.fetch;
  global.fetch = async () => { throw new Error('sin red en pruebas'); };
  Object.assign(process.env, {
    PORT: String(puerto),
    FIREBASE_SERVICE_ACCOUNT_B64: Buffer.from('{}').toString('base64'),
    SESSION_SECRET: 's'.repeat(40),
    AUDIT_SECRET: 'a'.repeat(40),
    LEGACY_PASSWORD_PEPPER: 'BetGroup-S3cr3t0-2026'
  }, env);
  require(path.join(__dirname, '..', 'servidor.js'));
  const base = `http://127.0.0.1:${puerto}`;
  async function llamar(metodo, url, cuerpo, token) {
    const r = await fetchReal(base + url, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
    let j = null;
    try { j = await r.json(); } catch { /* sin cuerpo */ }
    return [r.status, j];
  }
  return { llamar };
}

function ok(condicion, mensaje) {
  console.log(`${condicion ? '✅' : '❌'} ${mensaje}`);
}

module.exports = { get, set, arrancar, ok };
