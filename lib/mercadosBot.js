'use strict';

// ==================== CUOTAS DEL BOT (nodo mercados) ====================
// Antes el navegador mezclaba estas cuotas con las de ESPN/The Odds API.
// Ahora lo hace el servidor, para que la cuota que ve el usuario sea
// exactamente la que el servidor acepta al apostar.

function normalizarEquipo(nombre) {
  if (!nombre) return '';
  return String(nombre).toLowerCase().trim()
    .replace(/\b(fc|cf|sc|cd|at|real|club|s\.a\.|s\.d\.)\b/gi, '')
    .replace(/universidad central/gi, 'ucv')
    .replace(/independiente del valle/gi, 'idv')
    .replace(/ind\. del valle/gi, 'idv')
    .replace(/\(.*?\)/g, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function similitud(a, b) {
  const x = a.split(' ').filter(Boolean);
  const y = b.split(' ').filter(Boolean);
  if (!x.length || !y.length) return 0;
  const comunes = x.filter(w => y.includes(w)).length;
  const union = new Set([...x, ...y]).size;
  return union === 0 ? 0 : comunes / union;
}

function cuotaValida(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 1 ? Math.round(n * 100) / 100 : null;
}

// eventos: lista del servidor (ESPN + The Odds API). mercados: nodo mercados de Firebase.
function fusionarCuotasBot(eventos, mercados, margen = 0.20) {
  const ahora = Date.now();
  const vigentes = Object.values(mercados || {}).filter(e => e && e.homeTeam && e.awayTeam && e.cuotas
    && (!e.expiraEn || e.expiraEn > ahora));

  const indice = {};
  for (const e of vigentes) {
    const h = normalizarEquipo(e.homeTeam);
    const a = normalizarEquipo(e.awayTeam);
    const tiempo = new Date(e.commenceTime || 0).getTime();
    indice[`${h}|${a}`] = { cuotas: e.cuotas, tiempo, invertido: false };
    indice[`${a}|${h}`] = { cuotas: e.cuotas, tiempo, invertido: true };
    if (e.espnId) indice[`ESPN_${e.espnId}`] = { cuotas: e.cuotas, tiempo, invertido: false };
  }

  function buscar(ev) {
    const l = normalizarEquipo(ev.local);
    const v = normalizarEquipo(ev.visitante);
    const exacto = indice[`ESPN_${ev.id}`] || indice[`${l}|${v}`];
    if (exacto) return exacto;
    // Coincidencia aproximada: misma franja de 45 min y nombres parecidos (≥80%).
    // Ya NO se usa "primeras 5 letras": cruzaba Manchester City con Manchester United.
    const t = new Date(ev.horaInicio || 0).getTime();
    let mejor = null;
    let mejorPuntaje = 0;
    for (const [k, d] of Object.entries(indice)) {
      if (k.startsWith('ESPN_') || d.invertido) continue;
      if (Math.abs(t - d.tiempo) / 60000 > 45) continue;
      const [h, a] = k.split('|');
      const p = (similitud(l, h) + similitud(v, a)) / 2;
      if (p > 0.8 && p > mejorPuntaje) { mejorPuntaje = p; mejor = d; }
    }
    return mejor;
  }

  const salida = eventos.map((ev) => {
    const bot = buscar(ev);
    if (bot) {
      const c = bot.cuotas;
      // Si el bot tiene el partido al revés (local/visitante), se intercambian.
      const local = cuotaValida(bot.invertido ? c.visitante : c.local);
      const visitante = cuotaValida(bot.invertido ? c.local : c.visitante);
      if (local && visitante) {
        return { ...ev, cuota_local: local, cuota_visitante: visitante, cuota_empate: cuotaValida(c.empate) || ev.cuota_empate || null, fuenteCuotas: 'bot', bloqueado: false };
      }
    }
    const tiene = cuotaValida(ev.cuota_local) && cuotaValida(ev.cuota_visitante);
    return { ...ev, bloqueado: !tiene };
  });

  // Boxeo: solo existe en el bot (ESPN no lo trae).
  const ids = new Set(eventos.map(e => String(e.id)));
  for (const e of vigentes) {
    if (e.sport !== 'boxing' || ids.has(String(e.id))) continue;
    const local = cuotaValida((Number(e.cuotas.local) || 1.8) * (1 - margen));
    const visitante = cuotaValida((Number(e.cuotas.visitante) || 1.8) * (1 - margen));
    if (!e.id || !local || !visitante) continue;
    salida.push({
      id: String(e.id), sport: 'boxing', liga: 'Boxeo', local: e.homeTeam, visitante: e.awayTeam,
      estado: 'scheduled', horaInicio: e.commenceTime || null,
      cuota_local: local, cuota_visitante: visitante, cuota_empate: null, fuenteCuotas: 'bot', bloqueado: false
    });
  }
  return salida;
}

module.exports = { fusionarCuotasBot, normalizarEquipo };
