'use strict';

// ==================== ANTIFRAUDE PROPIO (Etapa 10) ====================
// Basado en la investigación (informe "Mejoras BetGroup frente a casas reales"):
// lo que usan las casas reales, hecho en casa y gratis.
//
// Principios:
// - SOLO AVISA. No bloquea ni expulsa a nadie: el CEO revisa y decide. (Las reglas se calibran
//   2-4 semanas en este modo antes de pensar en bloquear nada.)
// - Privacidad: los identificadores del móvil se guardan cifrados con HMAC-SHA256 (no se
//   pueden leer ni reutilizar fuera de BetGroup). No se intenta averiguar la IP real de quien
//   usa VPN: en Cuba la VPN es normal y no suma puntos.
// - La web nunca puede leer estos datos (nodos perfilRiesgo, riesgo, dispositivosUso, huellasUso).
//
// Señales y puntos (0-100):
//   mismo móvil (identificador guardado) que otra cuenta ......... 40
//   misma cuenta bancaria de cobro que otra cuenta ................ 35
//   mismo teléfono que otra cuenta ................................ 30
//   cuentas vinculadas apostando a lados opuestos del mismo partido 30
//   retiro pedido sin haber apostado lo depositado ................ 25
//   3 o más cuentas creadas desde el mismo móvil en 24 h .......... 20
//   misma huella técnica (modelo/pantalla/navegador) .............. 10  (débil: muchos móviles iguales)
// Nivel: 0-29 normal · 30-59 revisar · 60+ alto (aviso por Telegram una vez al día).

const crypto = require('crypto');

const PUNTOS = Object.freeze({
  dispositivo: 40, banco: 35, telefono: 30, opuestas: 30, retiroSinApostar: 25, rafaga: 20, huella: 10
});
const ID_RE = /^[a-f0-9]{32}$/;
const HUELLA_RE = /^[a-f0-9]{64}$/;
const UMBRAL_REVISAR = 30;
const UMBRAL_ALTO = 60;
const DIA_MS = 24 * 60 * 60 * 1000;

function nivelDe(puntos) {
  return puntos >= UMBRAL_ALTO ? 'alto' : puntos >= UMBRAL_REVISAR ? 'revisar' : 'normal';
}

function crearAntifraude({ db, secreto, notificarTelegram, escaparHtml }) {
  const hmac = (v) => crypto.createHmac('sha256', secreto).update(String(v)).digest('hex').slice(0, 40);

  // El móvil envía su identificador al entrar (una vez por sesión).
  async function registrarDispositivo({ uid, id, huella, pais }) {
    if (!ID_RE.test(String(id || '')) || !HUELLA_RE.test(String(huella || ''))) return false;
    const hId = hmac('d:' + id);
    const hHuella = hmac('h:' + huella);
    const ahora = Date.now();
    const anterior = (await db.ref(`perfilRiesgo/${uid}`).once('value')).val() || {};
    await db.ref().update({
      [`dispositivosUso/${hId}/${uid}`]: ahora,
      [`huellasUso/${hHuella}/${uid}`]: ahora,
      [`perfilRiesgo/${uid}`]: {
        dispositivos: { ...(anterior.dispositivos || {}), [hId]: ahora },
        huellas: { ...(anterior.huellas || {}), [hHuella]: ahora },
        pais: typeof pais === 'string' && /^[A-Z]{2}$/.test(pais) ? pais : (anterior.pais || null),
        visto: ahora
      }
    });
    return true;
  }

  // Calcula el riesgo de TODOS los usuarios a la vez (comparten los mismos datos de partida).
  async function evaluarTodos() {
    const [usuariosS, perfilesS, dispS, huellasS, apuestasS, retirosS, depsS, depsSubS] = await Promise.all([
      'users', 'perfilRiesgo', 'dispositivosUso', 'huellasUso', 'apuestas', 'solicitudesRetiro', 'solicitudesDeposito', 'depositos'
    ].map(n => db.ref(n).once('value')));
    const usuarios = usuariosS.val() || {};
    const perfiles = perfilesS.val() || {};
    const disp = dispS.val() || {};
    const huellas = huellasS.val() || {};
    const apuestas = apuestasS.val() || {};
    const retiros = retirosS.val() || {};
    const depositos = [...Object.values(depsS.val() || {}).filter(d => d && d.estado === 'aprobado').map(d => ({ uid: d.userId, monto: Number(d.monto) || 0, t: Number(d.aprobadoEn || d.creadoEn) || 0 })),
      ...Object.values(depsSubS.val() || {}).filter(d => d && d.estado === 'approved').map(d => ({ uid: d.userId, monto: Number(d.monto) || 0, t: Number(d.aprobadoEn || d.fecha) || 0 }))];

    const senales = {}; // uid → [{codigo, texto, puntos, con:[uid]}]
    const anotar = (uid, codigo, texto, con = []) => {
      if (!usuarios[uid]) return;
      const lista = senales[uid] || (senales[uid] = []);
      const previa = lista.find(s => s.codigo === codigo);
      if (previa) { previa.con = [...new Set([...previa.con, ...con])]; return; }
      lista.push({ codigo, texto, puntos: PUNTOS[codigo], con });
    };
    const grupos = (mapa) => Object.values(mapa).map(g => Object.keys(g || {})).filter(u => u.length > 1);

    // 1) Mismo móvil / misma huella
    for (const uids of grupos(disp)) for (const u of uids) anotar(u, 'dispositivo', 'Comparte el mismo móvil con otra cuenta', uids.filter(x => x !== u));
    // La huella solo cuenta si no es ya el MISMO móvil (si no, se sumaría dos veces lo mismo).
    const mismoMovil = (u, x) => ((senales[u] || []).find(s => s.codigo === 'dispositivo') || { con: [] }).con.includes(x);
    for (const uids of grupos(huellas)) for (const u of uids) {
      const otros = uids.filter(x => x !== u && !mismoMovil(u, x));
      if (otros.length) anotar(u, 'huella', 'Móvil técnicamente idéntico a otra cuenta (puede ser casualidad)', otros);
    }

    // 2) Mismo teléfono y misma cuenta bancaria
    const porTel = {}, porBanco = {};
    for (const [uid, u] of Object.entries(usuarios)) {
      const tel = String(u && u.telefono || '').replace(/\D/g, '').slice(-8);
      if (tel.length >= 6) (porTel[tel] = porTel[tel] || []).push(uid);
      const cuenta = String(u && u.datosBancarios && u.datosBancarios.cuenta || '').replace(/\D/g, '');
      if (cuenta.length >= 6) (porBanco[cuenta] = porBanco[cuenta] || []).push(uid);
    }
    for (const uids of Object.values(porTel).filter(l => l.length > 1)) for (const u of uids) anotar(u, 'telefono', 'Mismo teléfono que otra cuenta', uids.filter(x => x !== u));
    for (const uids of Object.values(porBanco).filter(l => l.length > 1)) for (const u of uids) anotar(u, 'banco', 'Misma cuenta bancaria de cobro que otra cuenta', uids.filter(x => x !== u));

    // 3) Ráfaga de cuentas nuevas desde el mismo móvil (24 h)
    for (const g of Object.values(disp)) {
      const uids = Object.keys(g || {});
      if (uids.length < 3) continue;
      const altas = uids.map(u => Number(usuarios[u] && usuarios[u].fecha_registro) || 0).filter(Boolean).sort((a, b) => a - b);
      for (let i = 0; i + 2 < altas.length; i++) {
        if (altas[i + 2] - altas[i] <= DIA_MS) { for (const u of uids) anotar(u, 'rafaga', '3 o más cuentas creadas desde el mismo móvil en 24 h', uids.filter(x => x !== u)); break; }
      }
    }

    // 4) Cuentas vinculadas apostando a lados opuestos del mismo partido
    const vinculos = {};
    for (const [uid, lista] of Object.entries(senales)) {
      for (const s of lista) if (['dispositivo', 'telefono', 'banco'].includes(s.codigo)) for (const o of s.con) (vinculos[uid] = vinculos[uid] || new Set()).add(o);
    }
    for (const [uid, otros] of Object.entries(vinculos)) {
      const mias = Object.values(apuestas[uid] || {}).filter(Boolean);
      for (const o of otros) {
        const suyas = Object.values(apuestas[o] || {}).filter(Boolean);
        const opuesta = mias.some(a => suyas.some(b => a.eventoId && a.eventoId === b.eventoId && a.tipo && b.tipo && a.tipo !== b.tipo));
        if (opuesta) anotar(uid, 'opuestas', 'Apuesta al lado contrario que una cuenta vinculada en el mismo partido', [o]);
      }
    }

    // 5) Retiro pendiente sin haber apostado lo depositado (lavado: depositar → retirar)
    for (const r of Object.values(retiros)) {
      if (!r || r.estado !== 'pendiente' || !usuarios[r.userId]) continue;
      const desde = Date.now() - 30 * DIA_MS;
      const depositado = depositos.filter(d => d.uid === r.userId && d.t >= desde).reduce((a, d) => a + d.monto, 0);
      const apostado = Object.values(apuestas[r.userId] || {}).filter(b => b && b.tipoSaldo !== 'promo' && Number(b.fecha) >= desde).reduce((a, b) => a + (Number(b.monto) || 0), 0);
      if (depositado > 0 && apostado < depositado) anotar(r.userId, 'retiroSinApostar', `Pide retirar habiendo apostado ${apostado} de ${depositado} depositados (30 días)`);
    }

    // Resultado por usuario + avisos
    const ahora = Date.now();
    const resultado = {};
    const nuevosAltos = [];
    const previos = (await db.ref('riesgo').once('value')).val() || {};
    for (const [uid, lista] of Object.entries(senales)) {
      const puntos = Math.min(100, lista.reduce((a, s) => a + s.puntos, 0));
      const nivel = nivelDe(puntos);
      const ultimoAviso = Number(previos[uid] && previos[uid].avisadoEn) || 0;
      const avisar = nivel === 'alto' && ahora - ultimoAviso > DIA_MS;
      resultado[uid] = { puntos, nivel, senales: lista, pais: (perfiles[uid] && perfiles[uid].pais) || null, actualizado: ahora, avisadoEn: avisar ? ahora : (ultimoAviso || null) };
      if (avisar) nuevosAltos.push(uid);
    }
    await db.ref('riesgo').set(resultado);
    if (nuevosAltos.length) {
      const lineas = nuevosAltos.slice(0, 10).map(uid => {
        const u = usuarios[uid] || {};
        return `• ${escaparHtml(u.apodo || u.nombre || uid)}: ${resultado[uid].puntos} pts — ${escaparHtml(resultado[uid].senales.map(s => s.texto).join('; '))}`;
      }).join('\n');
      await notificarTelegram(`🛡️ <b>Riesgo alto (antifraude)</b>\n${lineas}\n\nRevísalo en el panel del CEO antes de aprobar retiros o premios. No se ha bloqueado a nadie.`);
    }
    return resultado;
  }

  // Lista para el CEO (ordenada por puntos), con nombres para poder revisar.
  async function listado() {
    const [r, u] = await Promise.all([db.ref('riesgo').once('value'), db.ref('users').once('value')]);
    const usuarios = u.val() || {};
    const nombre = (uid) => { const x = usuarios[uid] || {}; return { uid, apodo: x.apodo || null, nombre: x.nombre || null, telefono: x.telefono || null }; };
    return Object.entries(r.val() || {})
      .map(([uid, v]) => ({ ...nombre(uid), ...v, senales: (v.senales || []).map(s => ({ ...s, con: (s.con || []).map(nombre) })) }))
      .sort((a, b) => b.puntos - a.puntos);
  }

  return { registrarDispositivo, evaluarTodos, listado, nivelDe, PUNTOS };
}

module.exports = { crearAntifraude, nivelDe, PUNTOS };
