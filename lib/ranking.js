'use strict';

// ==================== RANKING SEMANAL ====================
// Reglas (decididas por Yoel, 2 oct 2026):
// - Semana de lunes 00:00 a domingo 23:59 en hora de Cuba.
// - Solo participan quienes depositaron MÁS de 1000 créditos esa semana (depósitos aprobados).
// - Puesto según el TOTAL APOSTADO con saldo real (las apuestas con promo no cuentan, así un
//   premio no sirve para subir en el ranking). Empate: gana quien llegó antes a esa cifra.
// - Premios en crédito promocional: 1.º 500, 2.º 300, 3.º 100.
// - Consuelo: cada participante que perdió más de 500 en la semana (apuestas reales ya
//   liquidadas: apostado − cobrado) recibe 100 de promo.
// - El CEO revisa y entrega los premios (nada se paga solo). Entregar es idempotente.

const crypto = require('crypto');
const { centavos } = require('./apuestas');

const ZONA = 'America/Havana';
const SEMANA_MS = 7 * 24 * 60 * 60 * 1000;
const REGLAS = Object.freeze({ depositoMinimo: 1000, premios: [500, 300, 100], perdidaConsuelo: 500, premioConsuelo: 100 });

// ---------- Fechas en hora de Cuba (con horario de verano) ----------
const formato = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONA, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short'
});
function partesCuba(ts) {
  const p = Object.fromEntries(formato.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, dia: p.weekday };
}
// Diferencia entre la hora de Cuba y UTC en ese instante (ms).
function desfase(ts) {
  const p = partesCuba(ts);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ts / 1000) * 1000;
}
// Marca UTC de la medianoche cubana de una fecha local (y, m, d).
function medianocheCuba(y, m, d) {
  const aprox = Date.UTC(y, m - 1, d);
  let ts = aprox - desfase(aprox);
  ts = aprox - desfase(ts); // segunda pasada por si el cambio de hora cae cerca
  return ts;
}
const DIAS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

// Semana que contiene el instante ts: { id: 'AAAA-MM-DD' (su lunes), desde, hasta }.
function semanaDe(ts = Date.now()) {
  const p = partesCuba(ts);
  const lunes = new Date(Date.UTC(p.y, p.m - 1, p.d - DIAS[p.dia]));
  const y = lunes.getUTCFullYear(), m = lunes.getUTCMonth() + 1, d = lunes.getUTCDate();
  const desde = medianocheCuba(y, m, d);
  const sig = new Date(Date.UTC(y, m - 1, d + 7));
  const hasta = medianocheCuba(sig.getUTCFullYear(), sig.getUTCMonth() + 1, sig.getUTCDate());
  const id = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { id, desde, hasta };
}
function semanaPorId(id) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(id || ''));
  if (!m) return null;
  const s = semanaDe(medianocheCuba(+m[1], +m[2], +m[3]) + 12 * 3600000);
  return s.id === id ? s : null; // tiene que ser un lunes
}
function semanaAnterior(ts = Date.now()) {
  return semanaDe(semanaDe(ts).desde - 12 * 3600000);
}

// Nombre público: el apodo, o "Jugador-XXXX" si aún no eligió uno (nunca el nombre real).
function nombrePublico(uid, u) {
  if (u && typeof u.apodo === 'string' && u.apodo) return u.apodo;
  return 'Jugador-' + crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 4).toUpperCase();
}

function crearRanking({ db, auditoria, notificarTelegram, escaparHtml }) {
  // Depósitos aprobados por usuario dentro de la semana (los dos tipos de depósito).
  async function depositosDeSemana(sem) {
    const [deps, sols] = await Promise.all([
      db.ref('depositos').once('value'), db.ref('solicitudesDeposito').once('value')
    ]);
    const porUsuario = {};
    const sumar = (uid, monto, cuando) => {
      if (typeof uid !== 'string' || !(cuando >= sem.desde && cuando < sem.hasta)) return;
      porUsuario[uid] = centavos((porUsuario[uid] || 0) + (Number(monto) || 0));
    };
    for (const d of Object.values(deps.val() || {})) {
      if (d && d.estado === 'approved') sumar(d.userId, d.monto, Number(d.aprobadoEn || d.fecha));
    }
    for (const s of Object.values(sols.val() || {})) {
      if (s && s.estado === 'aprobado') sumar(s.userId, s.monto, Number(s.aprobadoEn || s.creadoEn));
    }
    return porUsuario;
  }

  // Calcula la tabla completa de una semana (para el CEO; incluye uid y datos internos).
  async function calcular(sem) {
    const [depositos, apuestasSnap, usuariosSnap] = await Promise.all([
      depositosDeSemana(sem), db.ref('apuestas').once('value'), db.ref('users').once('value')
    ]);
    const usuarios = usuariosSnap.val() || {};
    const apuestas = apuestasSnap.val() || {};
    const filas = [];
    for (const [uid, deposito] of Object.entries(depositos)) {
      const u = usuarios[uid];
      if (!u) continue;
      let apostado = 0, apostadoLiquidado = 0, cobrado = 0, ultima = 0;
      const delUsuario = Object.values(apuestas[uid] || {})
        .filter(b => b && b.tipoSaldo !== 'promo' && b.saldoCampo !== 'creditoPromo'
          && Number(b.fecha) >= sem.desde && Number(b.fecha) < sem.hasta && b.estado !== 'anulada')
        .sort((a, b) => a.fecha - b.fecha);
      for (const b of delUsuario) {
        const monto = Number(b.monto) || 0;
        apostado += monto;
        ultima = Number(b.fecha);
        if (b.estado === 'ganada' || b.estado === 'perdida') {
          apostadoLiquidado += monto;
          cobrado += Number(b.pago) || 0;
        }
      }
      filas.push({
        uid, apodo: nombrePublico(uid, u), nombre: u.nombre || null, telefono: u.telefono || null,
        depositado: deposito, apostado: centavos(apostado), perdidaNeta: centavos(apostadoLiquidado - cobrado),
        elegible: deposito > REGLAS.depositoMinimo, ultimaApuesta: ultima || null
      });
    }
    const clasificados = filas.filter(f => f.elegible && f.apostado > 0)
      .sort((a, b) => b.apostado - a.apostado || a.ultimaApuesta - b.ultimaApuesta);
    clasificados.forEach((f, i) => { f.posicion = i + 1; });
    const premios = [];
    clasificados.slice(0, REGLAS.premios.length).forEach((f, i) => {
      premios.push({ uid: f.uid, apodo: f.apodo, motivo: `puesto ${i + 1}`, monto: REGLAS.premios[i] });
    });
    for (const f of filas) {
      if (f.elegible && f.perdidaNeta > REGLAS.perdidaConsuelo) {
        premios.push({ uid: f.uid, apodo: f.apodo, motivo: 'consuelo (perdió más de 500)', monto: REGLAS.premioConsuelo });
      }
    }
    return { semana: sem.id, desde: sem.desde, hasta: sem.hasta, reglas: REGLAS, clasificados, noElegibles: filas.filter(f => !f.elegible), premios };
  }

  // Lo que ve cualquier usuario: top 10 con apodo y lo apostado, y su propia situación.
  async function publico(uid) {
    const sem = semanaDe();
    const t = await calcular(sem);
    const mia = t.clasificados.find(f => f.uid === uid) || [...t.noElegibles, ...t.clasificados].find(f => f.uid === uid) || null;
    return {
      semana: sem.id, termina: sem.hasta, reglas: REGLAS,
      top: t.clasificados.slice(0, 10).map(f => ({ posicion: f.posicion, apodo: f.apodo, apostado: f.apostado })),
      yo: {
        posicion: mia && mia.posicion ? mia.posicion : null,
        depositado: mia ? mia.depositado : 0,
        apostado: mia ? mia.apostado : 0,
        // Hay que depositar MÁS de 1000: si lleva 1000 justos, aún no participa.
        participa: Boolean(mia && mia.elegible),
        faltaParaParticipar: Math.max(0, centavos(REGLAS.depositoMinimo - (mia ? mia.depositado : 0)))
      }
    };
  }

  // El CEO entrega los premios de una semana YA TERMINADA. Solo una vez por semana.
  async function entregar(sem, actor, requestId) {
    if (sem.hasta > Date.now()) throw Object.assign(new Error('Esa semana aún no ha terminado'), { estado: 409 });
    const tabla = await calcular(sem);
    let cerrado = false;
    const tx = await db.ref(`rankingPremios/${sem.id}`).transaction((r) => {
      cerrado = false;
      if (r && r.entregado) return undefined;
      cerrado = true;
      return { ...(r || {}), entregado: true, entregadoPor: actor, entregadoEn: Date.now(), premios: tabla.premios };
    });
    if (!tx.committed || !cerrado) throw Object.assign(new Error('Los premios de esa semana ya se entregaron'), { estado: 409 });
    for (const p of tabla.premios) {
      await db.ref(`users/${p.uid}/creditoPromo`).transaction(a => centavos((Number(a) || 0) + p.monto));
      await db.ref(`users/${p.uid}/ultimoPremioRanking`).set({ semana: sem.id, monto: p.monto, motivo: p.motivo, fecha: Date.now() });
    }
    await auditoria.registrarSeguro({ accion: 'ranking_premios_entregados', actor, objetivo: sem.id, requestId, detalles: { premios: tabla.premios.map(p => ({ uid: p.uid, monto: p.monto, motivo: p.motivo })) } });
    const lista = tabla.premios.map(p => `• ${escaparHtml(p.apodo)}: ${p.monto} promo (${escaparHtml(p.motivo)})`).join('\n') || '• (sin ganadores)';
    await notificarTelegram(`🏆 <b>Premios del ranking entregados</b>\nSemana del ${sem.id}\n${lista}`);
    return { semana: sem.id, premios: tabla.premios };
  }

  // Cada lunes: avisa al CEO de los ganadores de la semana pasada (una sola vez).
  async function avisarSemanaTerminada() {
    const sem = semanaAnterior();
    let toca = false;
    await db.ref(`rankingPremios/${sem.id}/avisado`).transaction((v) => { toca = !v; return v ? undefined : true; });
    if (!toca) return false;
    const t = await calcular(sem);
    const lista = t.premios.map(p => `• ${escaparHtml(p.apodo)}: ${p.monto} promo (${escaparHtml(p.motivo)})`).join('\n') || '• Nadie cumplió las condiciones';
    await notificarTelegram(`🏆 <b>Ranking semanal terminado</b> (semana del ${sem.id})\n${lista}\n\nRevísalo en el panel del CEO y pulsa «Entregar premios».`);
    return true;
  }

  return { calcular, publico, entregar, avisarSemanaTerminada };
}

module.exports = { crearRanking, semanaDe, semanaPorId, semanaAnterior, nombrePublico, REGLAS, SEMANA_MS };
