// Prueba de la Etapa 6: registro desde Cuba (IPs compartidas, Cloudflare, mensajes claros)
// y fotos de luchadores de MMA. Ejecutar: npm test
'use strict';

const { get, set, arrancar, ok } = require('./simulador');

// 30 códigos libres: más que el antiguo límite de 5 registros por hora.
for (let i = 1; i <= 30; i++) set(`codigosAcceso/CUBA-${i}`, { code: `CUBA-${i}`, createdBy: 'BG_ceo', usado: false, rol: 'member' });

// Una velada de UFC tal como la manda ESPN: una foto como {href}, otra sin foto (solo ID).
const velada = {
  leagues: [{ name: 'UFC', logos: [{ href: 'https://a.espncdn.com/ufc.png' }] }],
  events: [{
    id: '600001', date: '2026-10-05T02:00Z', status: { type: { state: 'pre' } },
    competitions: [{
      status: { type: { state: 'pre' } },
      competitors: [
        { id: '3022677', homeAway: 'home', athlete: { id: '3022677', displayName: 'Luchador Uno', headshot: { href: 'https://a.espncdn.com/foto-uno.png' } } },
        { id: '4350812', homeAway: 'away', athlete: { id: '4350812', displayName: 'Luchador Dos' } }
      ]
    }]
  }]
};
const fetchReal = global.fetch; // el simulador corta la red; guardamos la de verdad para hablar con el servidor local
arrancar({
  puerto: 3995,
  env: { ODDS_API_KEYS: '' },
  espn: (ruta) => (/mma/.test(ruta) ? JSON.stringify(velada) : null)
});

// Petición "desde Cuba": todas pasan por el mismo nodo de Cloudflare, cada una con su IP real.
async function desde(ip, url, cuerpo) {
  const r = await fetchReal('http://127.0.0.1:3995' + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify(cuerpo)
  });
  return [r.status, await r.json().catch(() => null)];
}
const persona = (i, extra = {}) => ({
  nombre: `Persona ${i}`, telefono: `53 5${String(i).padStart(7, '0')}`,
  email: `persona${i}@nauta.cu`, password: 'clave-segura-1', codigo: `CUBA-${i}`, apodo: `Fiera_${i}`, ...extra
});

(async () => {
  try {
    await new Promise(r => setTimeout(r, 500));
    let s, j;

    // ---- 12 personas detrás de la MISMA IP de ETECSA se registran sin bloquearse ----
    let bien = 0;
    for (let i = 1; i <= 12; i++) { [s] = await desde('152.206.1.1', '/api/auth/registro', persona(i)); if (s === 200) bien++; }
    ok(bien === 12, `12 registros correctos desde la misma IP (antes se bloqueaba al 6.º) → ${bien}`);

    // ---- Mensajes claros, uno por cada dato mal escrito ----
    [s, j] = await desde('152.206.1.2', '/api/auth/registro', persona(13, { email: 'sin-arroba' }));
    ok(s === 400 && /correo no es válido/.test(j.error), 'correo mal escrito: lo dice claramente → ' + j.error);
    [s, j] = await desde('152.206.1.2', '/api/auth/registro', persona(13, { telefono: '12' }));
    ok(s === 400 && /Teléfono no válido/.test(j.error), 'teléfono corto: lo dice claramente');
    [s, j] = await desde('152.206.1.2', '/api/auth/registro', persona(13, { codigo: 'NO-EXISTE' }));
    ok(s === 400 && /no existe o ya se usó/.test(j.error), 'código inexistente: lo dice claramente');
    [s, j] = await desde('152.206.1.2', '/api/auth/registro', persona(13, { password: 'corta' }));
    ok(s === 400 && /8 caracteres/.test(j.error), 'contraseña corta: lo dice claramente');

    // ---- Lo que estropea el móvil al copiar y pegar se corrige solo ----
    [s] = await desde('152.206.1.2', '/api/auth/registro', persona(13, { email: ' Persona13@Nauta.cu ', codigo: 'cuba- 13 ' }));
    ok(s === 200, 'correo con mayúscula/espacios y código con espacio en medio se aceptan → ' + s);
    ok(get('users') && Object.values(get('users')).some(u => u.email === 'persona13@nauta.cu'), 'el correo se guarda en minúsculas');
    const [sl] = await desde('152.206.1.2', '/api/auth/login', { identificador: 'PERSONA13@nauta.cu', password: 'clave-segura-1' });
    ok(sl === 200, 'inicia sesión escribiendo el correo con mayúsculas');

    // ---- Correo repetido: le dice que inicie sesión ----
    [s, j] = await desde('152.206.1.2', '/api/auth/registro', persona(14, { email: 'persona1@nauta.cu', apodo: 'Fiera_otra' }));
    ok(s === 409 && /Iniciar sesión/.test(j.error), 'correo ya registrado: le indica iniciar sesión');

    // ---- Quien prueba códigos al azar sí se frena (solo cuentan los fallos) ----
    let frenado = false;
    for (let i = 0; i < 25; i++) {
      [s] = await desde('200.0.0.66', '/api/auth/registro', persona(20, { codigo: 'AZAR-' + i, email: `azar${i}@x.cu`, apodo: `Azar_${i}` }));
      if (s === 429) { frenado = i; break; }
    }
    ok(frenado === 20, 'adivinar códigos se frena tras 20 fallos → intento ' + frenado);
    [s] = await desde('200.0.0.67', '/api/auth/registro', persona(21));
    ok(s === 200, 'otra persona (otra IP real) no paga el castigo del atacante → ' + s);

    // ---- Versión del servidor para el script de publicación ----
    const v = await (await fetchReal('http://127.0.0.1:3995/api/version')).json();
    ok(v.version === 'etapa8', 'el servidor anuncia su versión (etapa8)');

    // ---- Fotos de los luchadores de MMA ----
    let evs = [];
    for (let i = 0; i < 20 && !evs.length; i++) {
      const f = await (await fetchReal('http://127.0.0.1:3995/api/fixtures')).json();
      evs = (Array.isArray(f) ? f : f.events || f.data || []).filter(e => /mma/i.test(e.sport));
      if (!evs.length) await new Promise(r => setTimeout(r, 300));
    }
    const pelea = evs[0] || {};
    ok(pelea.homeLogo === 'https://a.espncdn.com/foto-uno.png', 'foto del luchador que ESPN manda como {href} → ' + pelea.homeLogo);
    ok(pelea.awayLogo === 'https://a.espncdn.com/i/headshots/mma/players/full/4350812.png', 'foto del luchador sin foto: se arma con su ID de ESPN → ' + pelea.awayLogo);
  } catch (e) {
    ok(false, 'error inesperado: ' + e.message);
  }
  process.exit(0);
})();
