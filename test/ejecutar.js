'use strict';
// Ejecuta cada prueba en su propio proceso y falla si alguna línea empieza por ❌.
const { spawnSync } = require('child_process');
const path = require('path');

let fallos = 0;
for (const archivo of ['seguridad.prueba.js', 'dinero.prueba.js', 'permisos.prueba.js', 'liquidacion.prueba.js', 'registro.prueba.js', 'cuotas.prueba.js', 'ranking.prueba.js', 'cuotas2.prueba.js', 'antifraude.prueba.js', 'comisiones.prueba.js', 'bono.prueba.js', 'google.prueba.js', 'accesos.prueba.js', 'calendario.prueba.js', 'notificaciones.prueba.js']) {
  const r = spawnSync(process.execPath, [path.join(__dirname, archivo)], { encoding: 'utf8', timeout: 60000 });
  const lineas = (r.stdout + r.stderr).split('\n').filter(l => /^(✅|❌) /.test(l) && !/Firebase Admin|Caché|escuchando/.test(l));
  console.log(`\n== ${archivo} ==`);
  lineas.forEach(l => console.log(l));
  const malas = lineas.filter(l => l.startsWith('❌')).length;
  if (r.status !== 0 || malas > 0 || lineas.length === 0) fallos += malas || 1;
}
console.log(fallos ? `\n${fallos} prueba(s) fallaron` : '\nTodas las pruebas pasaron');
process.exit(fallos ? 1 : 0);
