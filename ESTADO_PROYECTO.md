# Estado del proyecto — BetGroup Pro (repo único: betgroup-proxy-v2)

**Este archivo es el "mismo sitio" real que exige el Protocolo de trabajo de Fundora — cualquier sistema de IA (Claude, DeepSeek, Gemini, u otro) que trabaje aquí debe leerlo primero, y actualizarlo al final de cada sesión real.**

Última actualización: 2 de octubre de 2026 (auditoría completa de seguridad).

## ⚠️ Protocolo de trabajo OBLIGATORIO para este proyecto (más estricto que el resto)

- Respaldo antes de cada cambio real
- Un cambio por commit, nunca varios amontonados
- `node -c archivo.js` (chequeo de sintaxis) ANTES de desplegar
- Nunca borrar código sin autorización explícita de Yoel
- Consolidar los comandos de bash en bloques únicos
- Autorización explícita de Yoel antes de implementar cualquier cambio real

## Repos: este es el único que se conserva

| Repo | Estado |
|---|---|
| `betgroup-proxy-v2` (este) | **Repo único.** Backend (`servidor.js`) + copia limpia del frontend en `frontend/index.html` |
| `betgroup-proxy` | Backend viejo + frontend del 26 jun **con claves y datos personales**. Ya rescatado aquí → archivar/eliminar |
| `betgroup-pro` | README vacío. Nada que rescatar → eliminar |

Dato rescatado de `betgroup-pro`: su documento decía "Despliegue real vía `firebase deploy --only hosting`".

## Stack real (verificado contra el código, 2 oct 2026)

- **Backend:** Node.js/Express en Render. Servicio `srv-d8li6lurnols73evdavg`, URL `betgroup-proxy-v2-8vqj.onrender.com`. Arranca `servidor.js` (`npm start`).
- **Base de datos:** Firebase Realtime Database `betgroup-cuba-2024-default-rtdb`.
- **Frontend:** `betgroup-cuba-2024.web.app`. **Corrección del documento anterior:** el código de este backend NO sirve páginas web (no hay `express.static` ni `index.html` en todo su historial). Lo más probable es que el frontend se publique con `firebase deploy --only hosting` desde una carpeta local (Termux). Esa carpeta tiene archivos que no están en ningún repo (`buscador-ceo.js`, `logo_fifa.png`, `logo_nba.png`, `icon.png`, `logo.png`…).
- **Pendiente de Yoel:** subir aquí la carpeta real del frontend (la versión en vivo puede ser más nueva que `frontend/index.html`) y aplicarle los mismos arreglos.

## Variables de entorno (Render → Environment)

Ver `.env.example`. Sin `ADMIN_API_KEY`, las rutas de administración quedan cerradas (503). Sin `TELEGRAM_*`, `ODDS_API_KEYS` o `IMGBB_API_KEY`, esas funciones se desactivan sin romper el resto.

Rutas protegidas con la cabecera `x-admin-key`: `/api/apostar`, `/api/apuestas/liquidar`, `/api/admin/*`, `/api/usuarios/mis-referidos`, `/api/agents-status`, `/api/verificacion-geminis`, `/api/estado-sistema`, `/api/test-reporte`, `/api/debug-reporte`. El frontend no usa ninguna de ellas.

Rutas públicas que usa el frontend: `/api/saldo/:uid`, `/api/enriquecer`, `/api/huggingface`, y las nuevas `/api/notificar`, `/api/notificar-foto`, `/api/subir-imagen` (todas con límite de peticiones por IP).

## Hecho en la auditoría del 2 oct 2026

- Claves sacadas del código (Telegram, 3 de Odds API, Gemini, Groq, ImgBB, UptimeRobot). **Las antiguas siguen expuestas en repos públicos: hay que rotarlas.**
- Candado de administrador en las rutas peligrosas (antes cualquiera podía reiniciar la base de datos, hacerse CEO o liquidar apuestas).
- `/api/apostar`: monto negativo y cuota inventada bloqueados; descuento con transacción atómica.
- Errores sin detalles internos; avisos de Telegram sin email ni teléfono; chat sin inyección de prompt.
- Fotos de comprobantes sin metadatos EXIF/GPS (`limpiarMetadatos.js`).
- Frontend: fuera la cuenta real precargada, las claves, el código muerto y 22 copias duplicadas; protección XSS con `esc()`.
- Eliminados `server.js` y `servidor.js.bak_20260601_193450` (siguen en el historial de git).

## Pendiente real (decisión de Yoel pendiente — "punto 5")

Estos puntos dependen de decidir el modelo del proyecto y NO se tocaron:

- **Reglas de Firebase y login:** el "Login Inmune" lee el hash de la contraseña desde la base de datos antes de iniciar sesión, y el navegador escribe saldos directamente. Cerrar las reglas sin un login en el servidor rompería la app; es un cambio de arquitectura.
- **Motor de apuestas:** liquidación (solo cubre 6 rutas de ESPN), cruce de nombres de equipos (Manchester City/United), cuotas en vivo de 12 h, cuotas generadas por IA o al azar, saldo promo que se paga como real, varios caminos de liquidación sin bloqueo entre ellos, `liquidarApuestaUI` en el navegador.
- **Contraseñas:** SHA-256 de una sola pasada con un "secreto" que está en el frontend (`HMAC_SECRET`). Cambiarlo invalida todos los logins; requiere migración.
- `serviceAccountKey.json` en Termux (error de parseo) — la solución propuesta era migrar a Google Cloud Functions.

## Reglas fijas

- Antes de cerrar cualquier ronda: `node -c` sin errores, respaldo hecho, autorización explícita recibida, **y este archivo actualizado y subido**.
