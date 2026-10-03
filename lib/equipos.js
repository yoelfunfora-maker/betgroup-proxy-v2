'use strict';

// ==================== CATÁLOGO DE EQUIPOS (para elegir favoritos) ====================
// Decisión de Yoel (3 oct 2026): el equipo favorito se ELIGE de una base de datos real, no se
// escribe a mano ("Real" puede ser el Madrid, la Sociedad o el Betis). Mientras la persona escribe
// salen las coincidencias con su escudo, liga y país, y se guarda el equipo exacto (su id de ESPN).
//
// El catálogo se arma con la lista oficial de equipos de ESPN de las mismas competiciones que usa
// BetGroup. Se guarda en Firebase (catalogoEquipos) para no rehacerlo en cada reinicio y se renueva
// cada 7 días. Una sola construcción a la vez.

const VIDA_MS = 7 * 24 * 3600 * 1000;

// Orden importante: primero las ligas nacionales (un club se queda con su liga, no con la Champions).
const COMPETICIONES = Object.freeze([
  { ruta: 'soccer/esp.1', sport: 'soccer', liga: 'LaLiga', pais: 'España' },
  { ruta: 'soccer/eng.1', sport: 'soccer', liga: 'Premier League', pais: 'Inglaterra' },
  { ruta: 'soccer/ita.1', sport: 'soccer', liga: 'Serie A', pais: 'Italia' },
  { ruta: 'soccer/ger.1', sport: 'soccer', liga: 'Bundesliga', pais: 'Alemania' },
  { ruta: 'soccer/fra.1', sport: 'soccer', liga: 'Ligue 1', pais: 'Francia' },
  { ruta: 'soccer/por.1', sport: 'soccer', liga: 'Primeira Liga', pais: 'Portugal' },
  { ruta: 'soccer/ned.1', sport: 'soccer', liga: 'Eredivisie', pais: 'Países Bajos' },
  { ruta: 'soccer/mex.1', sport: 'soccer', liga: 'Liga MX', pais: 'México' },
  { ruta: 'soccer/usa.1', sport: 'soccer', liga: 'MLS', pais: 'Estados Unidos' },
  { ruta: 'soccer/bra.1', sport: 'soccer', liga: 'Brasileirão', pais: 'Brasil' },
  { ruta: 'soccer/arg.1', sport: 'soccer', liga: 'Liga Profesional', pais: 'Argentina' },
  { ruta: 'soccer/chi.1', sport: 'soccer', liga: 'Primera División', pais: 'Chile' },
  { ruta: 'soccer/nor.1', sport: 'soccer', liga: 'Eliteserien', pais: 'Noruega' },
  { ruta: 'soccer/swe.1', sport: 'soccer', liga: 'Allsvenskan', pais: 'Suecia' },
  { ruta: 'soccer/den.1', sport: 'soccer', liga: 'Superliga', pais: 'Dinamarca' },
  { ruta: 'soccer/pol.1', sport: 'soccer', liga: 'Ekstraklasa', pais: 'Polonia' },
  { ruta: 'soccer/rus.1', sport: 'soccer', liga: 'Premier Liga', pais: 'Rusia' },
  // Más ligas solo para el buscador (para que cada club salga con su país aunque no tenga cuotas).
  { ruta: 'soccer/eng.2', sport: 'soccer', liga: 'Championship', pais: 'Inglaterra' },
  { ruta: 'soccer/esp.2', sport: 'soccer', liga: 'LaLiga 2', pais: 'España' },
  { ruta: 'soccer/sco.1', sport: 'soccer', liga: 'Premiership', pais: 'Escocia' },
  { ruta: 'soccer/bel.1', sport: 'soccer', liga: 'Pro League', pais: 'Bélgica' },
  { ruta: 'soccer/tur.1', sport: 'soccer', liga: 'Süper Lig', pais: 'Turquía' },
  { ruta: 'soccer/gre.1', sport: 'soccer', liga: 'Super League', pais: 'Grecia' },
  { ruta: 'soccer/ksa.1', sport: 'soccer', liga: 'Saudi Pro League', pais: 'Arabia Saudí' },
  { ruta: 'soccer/col.1', sport: 'soccer', liga: 'Primera A', pais: 'Colombia' },
  { ruta: 'soccer/uru.1', sport: 'soccer', liga: 'Primera División', pais: 'Uruguay' },
  { ruta: 'soccer/ecu.1', sport: 'soccer', liga: 'LigaPro', pais: 'Ecuador' },
  { ruta: 'soccer/per.1', sport: 'soccer', liga: 'Liga 1', pais: 'Perú' },
  { ruta: 'soccer/par.1', sport: 'soccer', liga: 'Primera División', pais: 'Paraguay' },
  { ruta: 'soccer/ven.1', sport: 'soccer', liga: 'Liga FUTVE', pais: 'Venezuela' },
  { ruta: 'soccer/bol.1', sport: 'soccer', liga: 'División Profesional', pais: 'Bolivia' },
  { ruta: 'soccer/conmebol.libertadores', sport: 'soccer', liga: 'Copa Libertadores', pais: 'Sudamérica' },
  // Selecciones nacionales (varias competiciones para cubrirlas casi todas; se quitan repetidas).
  { ruta: 'soccer/fifa.world', sport: 'soccer', liga: 'Selección nacional', pais: 'Selecciones', seleccion: true },
  { ruta: 'soccer/uefa.nations', sport: 'soccer', liga: 'Selección nacional', pais: 'Selecciones', seleccion: true },
  { ruta: 'soccer/fifa.worldq.conmebol', sport: 'soccer', liga: 'Selección nacional', pais: 'Selecciones', seleccion: true },
  { ruta: 'soccer/concacaf.nations.league', sport: 'soccer', liga: 'Selección nacional', pais: 'Selecciones', seleccion: true },
  { ruta: 'soccer/fifa.friendly', sport: 'soccer', liga: 'Selección nacional', pais: 'Selecciones', seleccion: true },
  { ruta: 'basketball/nba', sport: 'basketball', liga: 'NBA', pais: 'Estados Unidos' },
  { ruta: 'baseball/mlb', sport: 'baseball', liga: 'MLB', pais: 'Estados Unidos' }
]);

const sinAcentos = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
function normalizar(t) {
  return sinAcentos(t).toLowerCase().replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// Palabras que no cuentan como "inicial" (así "B" encuentra "FC Barcelona" por la B).
const PREFIJOS = new Set(['fc', 'cf', 'sc', 'ac', 'cd', 'ca', 'club', 'de', 'the', 'real', 'afc', 'ss', 'as', 'us', 'sv', 'vfb', 'vfl', 'rc', 'rcd', 'sd', 'ud', 'cs', 'se', 'ec']);

const textoSeguro = (t, max) => String(t == null ? '' : t).replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, max);
const urlSegura = (u) => (typeof u === 'string' && /^https:\/\/a\.espncdn\.com\/[A-Za-z0-9/_.\-]+$/.test(u) ? u : null);

// Convierte la respuesta de ESPN /teams en equipos del catálogo.
function equiposDeEspn(datos, comp) {
  const lista = (((datos || {}).sports || [])[0] || {}).leagues || [];
  const equipos = ((lista[0] || {}).teams || []).map(x => x && x.team).filter(Boolean);
  return equipos.map(t => {
    const espnId = String(t.id || '').replace(/[^0-9]/g, '');
    const nombre = textoSeguro(t.displayName || t.name, 60);
    if (!espnId || !nombre) return null;
    const logo = urlSegura(((t.logos || [])[0] || {}).href) || urlSegura(t.logo);
    return {
      id: `${comp.sport}:${espnId}`,
      espnId, sport: comp.sport, nombre,
      corto: textoSeguro(t.shortDisplayName || '', 40) || null,
      abrev: textoSeguro(t.abbreviation || '', 8) || null,
      logo, liga: comp.liga, pais: comp.seleccion ? 'Selecciones' : comp.pais, ruta: comp.ruta
    };
  }).filter(Boolean);
}

// Búsqueda: primero los que EMPIEZAN por lo escrito, luego los que tienen una palabra que empieza
// así; con 3 letras o más, también los que lo contienen en medio. Pura: se prueba con datos conocidos.
function buscarEn(catalogo, q, limite = 50) {
  const n = normalizar(q);
  if (!n) return [];
  const res = [];
  for (const e of catalogo) {
    const nom = normalizar(e.nombre);
    const palabras = nom.split(' ');
    const sinPrefijo = palabras.filter(p => !PREFIJOS.has(p)).join(' ');
    const extra = [e.corto, e.abrev].filter(Boolean).map(normalizar);
    let puntos = null;
    if (nom.startsWith(n) || sinPrefijo.startsWith(n) || extra.some(x => x.startsWith(n))) puntos = 0;
    else if (palabras.some(p => p.startsWith(n)) || (n.includes(' ') && nom.includes(' ' + n))) puntos = 1;
    else if (n.length >= 3 && nom.includes(n)) puntos = 2;
    if (puntos !== null) res.push({ e, puntos, nom: sinPrefijo || nom });
  }
  res.sort((a, b) => a.puntos - b.puntos || a.nom.localeCompare(b.nom, 'es'));
  return res.slice(0, limite).map(r => r.e);
}

function crearCatalogoEquipos({ db, fetchESPN, log = console, ahora = () => Date.now() }) {
  let catalogo = null;       // { equipos, porId, actualizado }
  let construyendo = null;

  function indexar(equipos, actualizado) {
    const porId = new Map(equipos.map(e => [e.id, e]));
    catalogo = { equipos, porId, actualizado };
    return catalogo;
  }

  async function construir() {
    const vistos = new Map();
    let fallos = 0;
    for (const comp of COMPETICIONES) {
      try {
        const datos = await fetchESPN(`${comp.ruta}/teams`);
        for (const e of equiposDeEspn(datos, comp)) if (!vistos.has(e.id)) vistos.set(e.id, e);
      } catch (err) { fallos++; }
    }
    const equipos = [...vistos.values()];
    if (equipos.length < 50) throw new Error(`Catálogo incompleto (${equipos.length} equipos, ${fallos} fallos)`);
    const actualizado = ahora();
    await db.ref('catalogoEquipos').set({ equipos, actualizado }).catch(e => log.warn('No se pudo guardar el catálogo de equipos:', e.message));
    log.log(`Catálogo de equipos: ${equipos.length} equipos de ${COMPETICIONES.length - fallos} competiciones`);
    return indexar(equipos, actualizado);
  }

  // Devuelve el catálogo listo (de memoria, de Firebase o construyéndolo). Una sola construcción.
  async function obtener() {
    if (catalogo && ahora() - catalogo.actualizado < VIDA_MS) return catalogo;
    if (!catalogo) {
      try {
        const g = (await db.ref('catalogoEquipos').once('value')).val();
        if (g && Array.isArray(g.equipos) && g.equipos.length) {
          indexar(g.equipos, Number(g.actualizado) || 0);
          if (ahora() - catalogo.actualizado < VIDA_MS) return catalogo;
        }
      } catch (e) { /* se construye */ }
    }
    if (!construyendo) construyendo = construir().finally(() => { construyendo = null; });
    // Si ya hay uno (viejo), se usa mientras se renueva por detrás.
    if (catalogo) { construyendo.catch(() => {}); return catalogo; }
    return construyendo;
  }

  async function buscar(q, limite) { return buscarEn((await obtener()).equipos, q, limite); }
  async function porIds(ids) {
    const c = await obtener();
    return ids.map(id => c.porId.get(id)).filter(Boolean);
  }
  const listo = () => Boolean(catalogo);

  return { obtener, buscar, porIds, listo };
}

module.exports = { crearCatalogoEquipos, buscarEn, equiposDeEspn, normalizar, COMPETICIONES };
