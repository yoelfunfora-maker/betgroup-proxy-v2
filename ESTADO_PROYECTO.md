# Estado del proyecto — BetGroup Pro (backend real: betgroup-proxy-v2)

**Este archivo es el "mismo sitio" real que exige el Protocolo de trabajo de Fundora — cualquier sistema de IA (Claude, DeepSeek, Gemini, u otro) que trabaje aquí debe leerlo primero, y actualizarlo al final de cada sesión real.**

Última actualización: 2 de octubre de 2026.

## ⚠️ Protocolo de trabajo OBLIGATORIO para este proyecto (más estricto que el resto)

- Respaldo antes de cada cambio real
- Un cambio por commit, nunca varios amontonados
- `node -c archivo.js` (chequeo de sintaxis) ANTES de desplegar
- Nunca borrar código sin autorización explícita de Yoel
- Consolidar los comandos de bash en bloques únicos
- Autorización explícita de Yoel antes de implementar cualquier cambio real

## Stack real

**Este único servicio de Render sirve el backend Y el frontend juntos** (confirmado por Yoel, 24 ago — ⚠️ pero `servidor.js` no tiene ninguna ruta que sirva `index.html`; pendiente de aclarar desde dónde se publica realmente el frontend) — `betgroup-cuba-2024.web.app` NO se despliega vía Firebase Hosting como se creía antes, se sirve desde aquí mismo. El repo `betgroup-pro` está casi vacío y no participa del despliegue real — ver su propio ESTADO_PROYECTO.md.

Node.js/Express en Render + Firebase Realtime Database (la base de datos sí es real de Firebase, solo el hosting del sitio no).

- Servicio real de Render: `srv-d8li6lurnols73evdavg`
- URL real (backend + frontend): `betgroup-proxy-v2-8vqj.onrender.com`
- Dominio público real: `betgroup-cuba-2024.web.app` (apunta a este mismo servicio de Render)
- Archivo real del servidor: `servidor.js` (también existe `server.js`, verificar cuál está activo antes de editar)

## Qué se sabe del trabajo reciente (por confirmar con Yoel, info de memoria previa)

- Corregido bug de ruta ESPN FIFA que causaba HTTP 400 en todos los eventos del Mundial
- Sistema de respaldo de cuotas de 3 niveles: Odds API → HF Kimi-K2 en caché → respaldo matemático
- Liquidación de apuestas reactivada con notificaciones de Telegram, automática cada 30 min
- UptimeRobot configurado para evitar que Render entre en reposo
- Zona horaria de Cuba corregida a UTC-4
- V7.5: "Auth Inmune" — login sin depender de Firebase Auth (bloqueado en Cuba), vía WebSocket de RTDB, SHA256+salt+HMAC, respaldo offline en localStorage

## Pendiente real conocido

- Error de parseo de clave privada en `serviceAccountKey.json` bajo Node.js en Termux — solución propuesta: migrar a Google Cloud Functions
- `deleteUser` todavía llama a `localhost:3000` en vez de ir directo a RTDB
- 3 claves de Odds API rotan según hora del día (renovadas 1 jul) — Yoel mencionó que debería existir una cuarta clave

## Etapa 1 de seguridad — 2 oct 2026 (desplegada junto con la Etapa 3)

Autorizada por Yoel. Cambios en commits separados:

1. Claves fuera del código → `lib/config.js` + `.env.example`.
2. CORS solo para nuestras webs, cabeceras de seguridad, límite de peticiones, errores sin detalles internos (`lib/seguridad.js`).
3. Auditoría encadenada y firmada HMAC-SHA256 en `auditoria/` (`lib/auditoria.js`).
4. Login en el servidor: `POST /api/auth/login` → token de 12 h. Migra los hashes viejos a PBKDF2-SHA256 (600.000 iteraciones) en `credenciales_servidor/` y borra `hash`/`salt` de `credenciales_acceso` y `users` (`lib/autenticacion.js`).
5. Todos los endpoints exigen sesión y rol (ver tabla abajo); entradas validadas (`lib/validacion.js`).
6. Telegram sin email/teléfono/saldo; verificador Geminis02 revisa este servidor desde dentro.
7. `GET /api/admin/auditoria/verificar`.
8. `package-lock.json`, firebase-admin 11 → 14 (API modular).

### Antes de desplegar en Render (orden obligatorio)

1. Rotar TODAS las claves filtradas (Telegram, 3× Odds API, Gemini, Groq, ImgBB, UptimeRobot) — siguen en el historial de git.
2. Crear en Render las variables de `.env.example`. Obligatorias: `FIREBASE_SERVICE_ACCOUNT_B64`, `SESSION_SECRET`, `AUDIT_SECRET`. Para no dejar a nadie fuera: `LEGACY_PASSWORD_PEPPER` = el secreto viejo del login.
3. Actualizar el frontend (ver "Contrato para el frontend") y desplegar ambos a la vez: el frontend actual NO envía token y dejará de funcionar con este backend.

### Contrato para el frontend

- Login: `POST /api/auth/login {email, password}` → `{token, expiraEn, usuario}`. Guardar el token en memoria/`sessionStorage`, nunca la contraseña.
- Cada llamada protegida: cabecera `Authorization: Bearer <token>`. Un 401 = volver a la pantalla de login.
- Logout: `POST /api/auth/logout`. Perfil: `GET /api/auth/yo`.
- `/api/apostar` ya no acepta `uid` (sale de la sesión).
- `/api/admin/generar-codigo` pasa de GET a POST `{rol}`; `/api/admin/aplicar-codigo {codigo}` se aplica a quien está conectado.
- `/api/usuarios/mis-referidos` ya no necesita `subadminUid` (el CEO puede seguir pasándolo).

| Acceso | Endpoints |
|---|---|
| Público | `/`, `/api/ping`, `/api/health`, `/api/fixtures`, `/api/auth/login` |
| Con sesión | `/api/apostar`, `/api/saldo/:uid` (propio), `/api/chat`, `/api/huggingface`, `/api/enriquecer`, `/api/admin/aplicar-codigo`, `/api/auth/*` |
| Subadmin+ | `/api/usuarios/mis-referidos` |
| Solo CEO | `/api/admin/*`, `/api/apuestas/liquidar`, `/api/test-reporte`, `/api/debug-reporte`, `/api/estado-sistema`, `/api/agents-status`, `/api/verificacion-geminis`, `/api/huggingface/cuotas` |

## Etapa 2 de dinero — 2 oct 2026 (desplegada junto con la Etapa 3)

`lib/apuestas.js` es el único sitio que coloca y liquida apuestas:

- Saldo descontado con transacción (sin doble gasto). Apuestas de un mismo usuario en cola.
- Cuota del servidor (caché de eventos). Si el cliente manda otra → 409 con `cuotaActual`.
- Solo eventos reales y antes de empezar (no se apuesta en vivo hasta tener cuotas en vivo de verdad).
- `config/minBet`, `maxBet`, `maxPago`, `dailyLossLimit` y `autoexcludedUntil` comprobados en el servidor. El límite diario cuenta perdidas + pendientes del día (hora de Cuba).
- Liquidación: pendiente → ganada/perdida/anulada en una transacción (sin doble pago entre automático y manual). Premio al mismo saldo con el que se apostó: **promo → promo** (decisión a confirmar por Yoel).
- La liquidación cruza por `eventoId` además de por nombre. El CEO puede enviar `resultadoGanador: "ANULADA"` para devolver lo apostado.
- Cada apuesta guarda `eventoId`, `saldoCampo`, `pago`, `pagado`, `liquidadaPor`. Las apuestas antiguas sin `saldoCampo` se pagan a `creditoReal`, como antes.
- `npm test` ejecuta las pruebas de seguridad y de dinero (Firebase simulado).

Contrato nuevo de `/api/apostar`: `{eventoId, tipo: Local|Visitante|Empate, amount, cuota (opcional, la que vio el usuario), tipoSaldo: real|promo}`. Los mercados de hándicap y totales todavía no se aceptan en el servidor (tampoco se liquidaban antes).

### Lo que la Etapa 1 NO arregla todavía

- **El frontend escribe saldos y apuestas directamente en Firebase.** Mientras las reglas de RTDB lo permitan, cualquiera puede saltarse el servidor → Etapa 3 (reglas) es imprescindible.
- ~~Doble gasto, doble pago, cuota elegida por el cliente, promo→real~~ → hecho en Etapa 2 (solo para apuestas que pasen por el servidor).
- Si el abono del premio falla justo después de marcar la apuesta como ganada, queda `pagado: false`: revisar a mano esas apuestas.
- Registro sigue siendo del lado del cliente (puede elegir su rol) → Etapa 3.
- Sellado RFC 3161 con TSA externa de la cadena de auditoría → pendiente.
- `uuid` (moderada, dependencia interna de firebase-admin) sin arreglo publicado aún.
- `server.js` y `servidor.js.bak_*` siguen en el repo (sin autorización para borrarlos).

## Incidente 2 oct 2026: llave maestra publicada en internet (RESUELTO)

- El frontend se publica desde el móvil de Yoel (`~/betgroup-hosting`, Termux, `firebase deploy`), NO desde Render. Copia privada en el repo `betgroup-frontend`.
- `firebase.json` tenía `"public": "."` → Firebase Hosting servía la carpeta entera: `serviceAccountKey.json`, `accounts.txt`, `proxies.txt`, `.bak`, etc.
- Arreglo: `"public": "publico"` (solo los 21 archivos de la web) y nuevo `firebase deploy --only hosting`. Verificado: esos archivos ya no se sirven.
- Llave de cuenta de servicio rotada: nueva clave `0d587a42…`, cargada en Render (`FIREBASE_SERVICE_ACCOUNT_B64`) vía API, servidor reiniciado y verificado (health OK, lectura Firebase 200). Claves viejas borradas en Google Cloud (confirmado por Yoel).
- **Reglas de RTDB (`database.rules.json`) con `.read: true` y `.write: true` en todos los nodos** → siguiente trabajo (Etapa 3).
- ⚠️ Nunca publicar ni subir la carpeta `betgroup-hosting` entera. Nunca `git push --force` desde ella: su `main` local (d65b0e1) no coincide con GitHub.

## Etapa 3 — reglas cerradas, todo por el servidor (DESPLEGADA 2 oct 2026, 04:19 hora de Cuba)

Publicada por Yoel con `publicar_todo.sh`: variables en Render (200), servidor en `main` y arrancado, web nueva en Hosting (copia en `publico.bak_20261002_041831`), reglas cerradas. Verificado: `users.json` público → Permission denied; `bg-api.js` en línea; `/api/fixtures` con 32 partidos.

**Arquitectura nueva:** Firebase Auth está bloqueado en Cuba, así que las reglas de RTDB no pueden distinguir usuarios. Por eso las reglas quedan `".read": false, ".write": false` y TODO pasa por el servidor:

- Frontend (repo privado `betgroup-frontend`, rama `claude/upbeat-cerf-rpytdm`): `bg-api.js` sustituye al SDK de Firebase con un objeto compatible que envía cada operación a `POST /api/db`. Casi todo `index.html` sigue igual.
- `lib/politicas.js` decide por rol y por fila: miembro (lo suyo + nombre y datos bancarios de su subadmin), subadmin (su equipo: por `referidoPorUid`, por su `codigoInvitacion` o por códigos que generó), director (depósitos), CEO (todo). Saldo, rol y credenciales no se escriben nunca por `/api/db`.
- `lib/operaciones.js`: `/api/depositos/:id/aprobar|rechazar`, `/api/solicitudes-deposito/:id/aprobar|rechazar` (director+), `/api/admin/ajustar-saldo|asignar-rol|restablecer-clave` (CEO), `/api/auth/registro`, `/api/auth/recuperar`, `/api/notificar`.
- Login con email o teléfono; usuarios antiguos de Firebase Auth se migran en su primer acceso (`FIREBASE_WEB_API_KEY`).
- `/api/fixtures` es la única fuente de partidos/cuotas (incluye cuotas del bot de `mercados/` y boxeo).
- Pruebas: `npm test` (49 + 52 de permisos) y `test/navegador.e2e.js` (Playwright, 13 comprobaciones en Chromium real).

### Orden de publicación (scripts en `betgroup-frontend/publicar/`)
`publicar_todo.sh` hace los 4 pasos seguidos y se detiene si uno falla. Por separado:
1. `1_configurar_render.sh` — variables de entorno en Render (las claves mantenidas se extraen del código antiguo público).
2. Fusionar la rama de este repo en `main` → Render despliega el servidor.
3. `2_publicar_web.sh` — web nueva (con copia de seguridad de `publico`).
4. `3_cerrar_reglas.sh` — reglas cerradas (con copia de las antiguas).
- Emergencia: `revertir.sh`.

## Etapa 4 — liquidación completa (DESPLEGADA 2 oct 2026, 13:09 hora de Cuba; web en Hosting, copia en publico.bak_20261002_130903)

- `lib/mercados.js`: 1X2, hándicap (`Handicap <equipo> (±N)`) y más/menos (`Over/Under N`). Cuota del servidor y resolución con marcador; línea exacta = devolución.
- Liquidación automática (cada 30 min o `POST /api/admin/liquidar-ahora`): todas las competiciones de `DEPORTES`, consultando ESPN en la fecha de cada partido (las apuestas guardan `ruta` y `horaInicio`). Tenis/UFC por ganador. Cancelado → se devuelve; aplazado → se devuelve tras 48 h.
- Manual (CEO): `/api/apuestas/liquidar` con `marcador: "2-1"`, `resultadoGanador` o `ANULADA`. Tarjeta en el panel CEO.
- Sin cuotas inventadas (IA/azar eliminadas): partido sin cuota real = bloqueado.
- Emparejamiento de cuotas: exige los dos equipos; ya no borra "city"/"united".
- `/api/admin/eliminar-usuario`: borrado completo (no si hay saldo o apuestas pendientes).
- Pruebas: `npm test` (4 archivos) y `test/navegador.e2e.js` (16 comprobaciones).
- Pendiente conocido: caché de cuotas de The Odds API de 12 h (cuota gratuita limitada); como solo se apuesta antes del partido, es aceptable.

## Etapa 5 — diseño (DESPLEGADA 2 oct 2026, 13:56 hora de Cuba; copia en publico.bak_20261002_135616)

- Capa única `<style id="diseno-v2">` al final del `<head>` de `index.html` (manda sobre los estilos antiguos repetidos). Paleta: fondo #0B0E14, tarjetas #141923, oro #D4AF37 solo en saldo y "Apostar".
- Letra Inter servida desde `publico/fuentes/` (Google Fonts suele estar bloqueado en Cuba).
- Cabecera fija con saldo, navegación abajo, tarjeta de partido con escudos originales enfrentados y logo de liga, boleto con monto libre (atajos y validación contra saldo, maxBet y maxPago).
- Boceto aprobado por Yoel: https://claude.ai/artifact/JMcQKrAHA94WVHSc3Hc9TG

## Etapa 6 — registro desde Cuba y fotos de MMA (DESPLEGADA 2 oct 2026, 14:34 hora de Cuba; copia en publico.bak_20261002_143417; Render confirmado detrás de Cloudflare)

Queja: en Cuba costaba mucho registrarse y entrar. Causas encontradas y arreglos:
- **Límite por IP mal medido:** Render llega a través de Cloudflare; `req.ip` podía ser la IP del nodo de Cloudflare (Miami), compartida por casi toda Cuba. Con 5 registros/hora por IP, al 6.º se bloqueaba a todos. Ahora `ipCliente()` (lib/seguridad.js) usa `CF-Connecting-IP`; registro: 20 intentos **fallidos**/hora por IP (los correctos no cuentan) + tope global de 300 fallos/hora; recuperar con su propio límite (10/h).
- **Servidor dormido (Render gratis):** tarda hasta 1 min en despertar y la web daba "Failed to fetch". `bg-api.js` ahora lo despierta al abrir la web (`BG.despertar`), avisa en pantalla, tiene tiempo límite de 70 s y mensajes en español. Los POST nunca se reintentan solos (no se gasta el código dos veces).
- **Formulario confuso:** decía "mín. 6 caracteres" y se exigían 8; mensajes genéricos. Ahora etiquetas visibles, ejemplos (nauta.cu), "Mostrar contraseña", un mensaje por campo, correo/código se limpian solos (mayúsculas y espacios) y al crear la cuenta entra directamente.
- **Sesión perdida por cortes:** un fallo de red al reabrir la app borraba la sesión; ahora solo se borra con 401.
- **Carga lenta:** Chart.js y jsPDF con `defer`, Font Awesome sin bloquear; `firebase.json` con `no-cache` en html/js para no servir la web vieja.
- **Fallo oculto arreglado:** `eliminarUsuario` no estaba guardado en `lib/operaciones.js` (la ruta en producción daba 500).
- **Fotos MMA:** ESPN ya manda la foto del luchador (`athlete.headshot`, a veces `{href}`); si falta, `https://a.espncdn.com/i/headshots/mma/players/full/<id>.png`. La tarjeta la muestra en círculo; si no carga, iniciales.
- Nueva ruta `GET /api/version` → `{version:'etapa6'}` (la usa `publicar_web.sh`).
- Pruebas: `npm test` (5 archivos, + `registro.prueba.js`), `test/navegador.e2e.js` y `test/registro.e2e.js` (9 comprobaciones en navegador con servidor dormido simulado).

## Etapa 7 — cuotas de ligas con nombre "raro" en ESPN (DESPLEGADA 2 oct 2026; verificado con diagnóstico: Independiente vs Instituto 2.47/2.97/3.21)

Caso: "Independiente vs Instituto" (Argentina) salía sin cuota.
- La competición de The Odds API se elegía por el NOMBRE de liga de ESPN. "Argentine Liga Profesional" no contiene "argentina", "Spanish LALIGA" no contiene "la liga", "Brazilian Serie A" caía en Italia... y todo acababa pidiendo `soccer_epl`. Ahora `ODDS_POR_RUTA` usa la ruta de ESPN (`soccer/arg.1` → `soccer_argentina_primera_division`); liga desconocida → no se pide nada (ahorra créditos).
- Región: fútbol fuera de EE. UU./México/Premier usa casas europeas (`regions=eu`), mismo coste.
- Nombres: "Instituto" ⊂ "Instituto de Córdoba", "CA Independiente" = "Independiente" (palabras vacías fuera), siempre exigiendo los dos equipos y la misma hora (±3 h). Se elige la mejor coincidencia, no la primera.
- `GET /api/admin/diagnostico-cuotas?q=<equipo>` (solo CEO) y `publicar/diagnostico_cuotas.sh` en el repo de la web: muestra competición, candidatos, parecido y créditos restantes de The Odds API.
- Pruebas: `test/cuotas.prueba.js` (9 comprobaciones; con el código anterior fallan 5).

## Etapa 8 — ranking semanal, apodo, promo y fotos sin metadatos (DESPLEGADA 2 oct 2026, ~15:30 hora de Cuba)

Decisiones de Yoel: ranking por TOTAL APOSTADO (saldo real) entre quienes depositan MÁS de 1000 en la semana (lunes-domingo, hora de Cuba); premios promo 500/300/100; consuelo de 100 promo a cada participante que perdió más de 500 (supuesto: también exige el depósito >1000); el CEO revisa y entrega. Promo: cuota mínima 1.50 y si gana SOLO la ganancia va al saldo real (antes: promo → promo). Apodo obligatorio y público; el nombre real nunca se muestra.
- `lib/ranking.js` (+ `GET /api/ranking`, `GET /api/admin/ranking`, `POST /api/admin/ranking/entregar`, aviso por Telegram cada lunes, `rankingPremios/<lunes>` evita doble pago).
- `lib/apuestas.js`: `reglaPromo: 'ganancia-a-real'` en apuestas promo nuevas; las antiguas pendientes siguen la regla vieja. `config/promoCuotaMinima` (por defecto 1.5).
- Apodo: `apodos/<clave>` = uid (único, sin el nombre real, cambio 1 vez/semana), `POST /api/perfil/apodo`; campos protegidos en `/api/db`.
- Fotos: la web redibuja la foto (sin EXIF/GPS) y `POST /api/imagen` la limpia otra vez en memoria (`lib/imagenes.js`) y la sube con `IMGBB_API_KEY` (opcional en Render; sin ella, plan B directo ya sin metadatos).
- Créditos de The Odds API: copia en Firebase `cacheCuotas/` (Render ya no repaga al despertar) y solo ligas con partidos en 48 h. El 2 oct quedaban 146 de 500.
- Arreglo: la web nunca enviaba `tipoSaldo`, así que el promo no se podía usar.
- Pruebas: `test/ranking.prueba.js` (27) y `test/etapa8.e2e.js` (11 en navegador).
- Riesgo pendiente: los comprobantes en ImgBB son públicos para quien tenga el enlace.

### Después de la Etapa 8 (2 oct 2026; web publicada 15:42, copia en publico.bak_20261002_154219)
- Botón "+ mercados": `.bg-cuotas[hidden]{display:none!important}` (display:grid anulaba hidden).
- Alias de clubes ESPN↔The Odds API (Inter, Sporting CP, Lyon, Rennes, Brest, Atlético-MG, Athletico-PR, København, Legia) y letras ø/æ/ł/ß/đ.
- Diagnóstico: `diagnostico_cuotas.sh sincuota` lista todos los partidos sin cuota con un `motivo` en palabras.
- Quitados (autorizado por Yoel) 4 `<script>` a archivos inexistentes: buscador-ceo.js, google-auth.js, local-cache.js, fix_saldo.js.
- Archivos que sí existen solo en el teléfono (copia en la rama `archivos-telefono` del repo privado): modo_cuba.js (bloqueo por IP si `config/modoCuba`), cookies.js, filtro.js, eventos.js, service-worker.js. Ninguno afecta al login.
- **Créditos de The Odds API: 130 de 500 el 2 oct.** El plan gratis no alcanza para ~17 ligas × 3 mercados. Las cuotas se piden solo 48 h antes del partido; la web lo dice ("Las cuotas se abren 2 días antes"). Decisión pendiente de Yoel: plan de 30 $/mes o reducir ligas/mercados.

## Etapa 9 — más partidos con cuota, gratis (DESPLEGADA 2 oct 2026; web publicada 16:36, copia en publico.bak_20261002_163603)

Decisión de Yoel: seguir gratis (el sistema aún no da ganancia). Yoel usa 3-4 claves de The Odds API en cuentas distintas por franja horaria; se le advirtió que sus términos lo prohíben y pueden cerrarlas todas. No se amplió esa rotación.
- Regresión de la Etapa 8 corregida: el horizonte de 48 h dejaba sin cuota la jornada siguiente. Ahora 8 días; copia de 12 h si la liga juega en 48 h, 24 h si no.
- Ahorro: hándicap y más/menos solo en EPL, LaLiga, Serie A, Bundesliga, Ligue 1, Argentina, NBA y MLB; el resto solo 1X2 (1 crédito).
- Emparejamiento más fuerte: con la misma hora (±3 h), un equipo seguro (≥ 0.9) y el otro ≥ 0.4 → mismo partido (p. ej. "Central Córdoba (Santiago del Estero)" / "Central Cordoba SdE").
- Respaldo legal y gratuito: `lib/apiFootball.js` (API-Football, 100 consultas/día, una cuenta). Solo para fútbol que quedó sin cuota; 1X2 + más/menos; copia 24 h en `cacheCuotasAF/`; si falla, no reintenta en 1 h. Clave en `API_FOOTBALL_KEY` (Render) o `secretos/apiFootball` (guardada con `publicar/clave_api_football.sh` → `POST /api/admin/clave-api-football`, que la prueba con /status).
- Los IDs de liga y la temporada de API-Football salen de su documentación; verificar con el diagnóstico tras la primera ejecución real.
- Fallo corregido (caso Genoa-Fiorentina): se usaba solo la 1.ª casa de apuestas; si no tenía 1X2 el partido quedaba sin cuota. Ahora `casaCombinada()` toma cada mercado de la primera casa que lo ofrece. Las copias viejas caducan solas en 12-24 h (no se gastan créditos en refrescarlas antes).
- Sin cuota y sin arreglo posible: pretemporada NBA (la API solo trae temporada regular), amistosos internacionales (no conectados), peleas de UFC que la API no ofrece.
- **Decisión de Yoel (2 oct): no usar API-Football por ahora.** El código queda inactivo: sin clave no hace ninguna consulta. Se activa solo si un día se guarda la clave.
- Pruebas: `test/cuotas2.prueba.js` (14).

## Etapa 10 — app instalable, presentación y antifraude (2 oct 2026)

- **App (PWA):** `manifest.json` completo, iconos en `iconos/` (generados con Chromium desde SVG), `sw.js` (página y bg-api.js: primero Internet, sin conexión la última copia; iconos/fuentes en caché; no toca la API), tarjeta "¿Te avisamos?" (ya no se pide permiso de golpe), avisos de apuesta resuelta, depósito y premio del ranking (en la app siempre; en la barra si hay permiso). Las notificaciones con la app CERRADA necesitarían Web Push (servidores de Google, poco fiables desde Cuba): no se hizo.
- `service-worker.js` (el "limpiador" antiguo) sigue igual; el nuevo es `sw.js`.
- **Presentación:** SVG + CSS (~3 KB, ~2,4 s), una vez por sesión, se salta tocando, desactivada con "reducir movimiento".
- **Antifraude (`lib/antifraude.js`), solo avisa:** señales mismo móvil (40), misma cuenta bancaria (35), mismo teléfono (30), apuestas opuestas entre vinculadas (30), retiro sin apostar lo depositado (25), ráfaga de 3+ altas por móvil en 24 h (20), huella idéntica (10). Niveles 30 revisar / 60 alto (Telegram 1 vez al día). Cada 6 h + botón del CEO. Identificadores cifrados con HMAC (AUDIT_SECRET); nodos `riesgo`, `perfilRiesgo`, `dispositivosUso`, `huellasUso` inaccesibles desde /api/db. País de Cloudflare solo informativo (VPN no suma). Rutas: `POST /api/dispositivo`, `GET /api/admin/riesgo`, `POST /api/admin/riesgo/recalcular`.
- Calibrar 2-4 semanas antes de pensar en bloquear.
- **Logo ORIGINAL sin retocar** (decisión de Yoel: no redibujar la marca): iconos = `icon192.png`/`icon512.png` originales del teléfono (copia en la rama `archivos-telefono/externos/imagenes`), logo grande original visible también dentro de la app, presentación con la imagen original; lema "Plataforma de entretenimiento deportivo" (pedido de Yoel: no decir "apuestas deportivas").
- **Referidos y ganancias del subadmin (fallo corregido):** el registro ya ligaba bien (`referidoPorUid` = quien generó el código), pero el panel del subadmin solo contaba en su recaudado/comisión a los miembros del código fijo antiguo. Ahora `bgFiltrarMiembros()` cuenta referidoPorUid + código fijo + códigos generados. Prueba `test/referidos.e2e.js` (con el código viejo: 100 en vez de 300).
- Pruebas: `test/antifraude.prueba.js` (17), `test/app.e2e.js` (12 en navegador).
- Casino: **aplazado por Yoel** (2 oct). Solo lo quiere por API, sin juegos propios. Investigado: no hay API gratis con dinero real (agregadores = contrato + licencia + excluyen Cuba). Única opción gratis: lobby demo con fichas ficticias (Slots Launch, plan Free; token en el servidor). Nada construido.

## Etapa 11 — comisiones de la red (2 oct 2026, servidor desplegado; web pendiente de publicar)

Decisiones de Yoel: rangos visibles **Agente** (rol interno `subadmin`) y **Supervisor** (rol interno `director`); "si la casa no gana no hay salario"; todo se junta y se paga **una vez por semana**.
- `lib/comisiones.js`: ganancia semanal de la red de cada agente (apuestas reales liquidadas en la semana: apostado − pagado; promo ganada cuenta como gasto). Agente 5/10/15/20/25 % según activos (0-5/6-15/16-30/31-50/+50); supervisor 5 % de la ganancia de sus agentes; tope 30 % → casa ≥ 70 %. Semana negativa: 0 comisión y arrastre (`comisionesArrastre/<agente>`).
- El CEO cierra cada semana terminada (en orden, una sola vez) → `comisionesSemana/<lunes>` + Telegram. Asigna agentes a supervisores (`users/<agente>/supervisorUid`, campo protegido).
- El cierre diario del agente ya NO descuenta comisión (neto = ganancia del día); la comisión llega con el cierre semanal. Los % "editables" del panel CEO (que no se usaban) se sustituyeron por la tarjeta de comisiones semanales; `guardarComisiones` y `config/comisiones` siguen existiendo sin uso.
- Pruebas: `test/comisiones.prueba.js` (17), `test/comisiones.e2e.js` (6), `test/referidos.e2e.js` actualizado.

## Etapa 12 — mínimos, tutorial y bono de inscripción (2 oct 2026)

- **Mínimos** (decisión de Yoel): depósito mínimo 500 CUP (servidor + web; cambiable en `config/depositoMinimoCUP`), apuesta mínima 100.
- **Tutorial por rango** (solo web): jugador (7 pasos), agente (6), supervisor (2), CEO (6). Sale solo la primera vez con cada rango (recordado en el móvil: `localStorage bg_tutorial_<rango>`) y se repite con el botón **?** de la cabecera. La tarjeta "¿Te avisamos?" espera a que se cierre. Prueba: `test/tutorial.e2e.js`.
- **Bono de inscripción**: toda cuenta NUEVA recibe 100 de crédito promocional (`config/bonoInscripcion`; 0 lo apaga, tope 1000) y queda marcada con `bonoInscripcion`. Esas cuentas **no pueden retirar** hasta haber depositado (aprobado) al menos 500 CUP (`config/bonoDepositoParaRetirar`) o cualquier depósito en MLC. El servidor lleva `depositadoCUP`/`depositadoMLC` al aprobar cada depósito (campos protegidos). Las cuentas antiguas no cambian. Las reglas del promo siguen: cuota mínima 1.50 y solo la ganancia pasa a saldo real; esa ganancia cuenta como gasto en la comisión del agente (el agente no gana con bonos).
- Antiabuso: cada cuenta necesita un código de invitación de un solo uso y el antifraude marca cuentas que comparten móvil.
- **Jugador activo** (para el escalón de comisión del agente) = hizo al menos una apuesta con dinero REAL liquidada en la semana. Las apuestas con bono/promo no cuentan (evita subir de escalón con cuentas falsas que solo juegan el bono). Decisión de Yoel, 2 oct 2026.
- Pruebas: `test/bono.prueba.js` (13), `test/registro.e2e.js` ampliado; `navegador.e2e.js` corregido al mínimo de 500. Versión del servidor: `etapa12`.

## Pago por inyección (2 oct 2026, decisión de Yoel)

- El agente cobra, además de su % por ganancia, un **3 % FIJO de la inyección neta semanal** de su red: depósitos aprobados (`depositos` approved + `solicitudesDeposito` aprobado) − retiros pedidos no rechazados (`solicitudesRetiro`), en la semana lunes-domingo (Cuba). Solo de jugadores activos (apostaron dinero real). Neta negativa = 0.
- Solo se paga si la red dejó ganancia esa semana (neto > 0 tras arrastre): "si la casa no gana no hay salario". El supervisor no cobra de la inyección (sigue con su 5 % de la ganancia).
- Un **supervisor con jugadores propios sigue cobrando por ellos como agente** (% por ganancia + 3 % de inyección) además de su 5 % de equipo (decisión de Yoel). En la tabla del CEO aparece como «(supervisor)».
- `lib/comisiones.js` (`inyeccionJugador`, `PCT_INYECCION`); campos `depositado`, `retirado`, `inyeccionNeta`, `comisionInyeccion`, `totalAgente`. Paneles del agente y del CEO y desglose de Telegram actualizados. Prueba en `test/comisiones.prueba.js`.

## Entrar con Google + Cloudflare Turnstile (2-3 oct 2026) — DESPLEGADO (servidor etapa13, 3 oct 2026)

Revisión previa: el "Entrar con Google" antiguo nunca funcionó en la versión en vivo (cargaba `google-auth.js`, que no existe; ningún botón llamaba a `doGoogleSignIn`) y era inseguro (creaba la cuenta escribiendo directo en la BD). Nunca hubo Turnstile en el código; cualquier desafío de Cloudflare estaría en su panel.
- `lib/accesoExterno.js`: verificación del ID token de Google con node:crypto (RS256 con las claves oficiales de Google, en caché; iss, aud, exp, email_verified) y comprobación de Turnstile.
- `POST /api/auth/google`: cuenta vinculada → entra; correo @gmail.com con cuenta → se vincula; persona nueva → pide apodo, teléfono y CÓDIGO DE INVITACIÓN (mismo registro, bono y reglas). Vínculos en `googleCuentas/<sub>` (ilegible desde la web); `googleSub` es campo protegido.
- Registro normal: casilla Turnstile. Si Cloudflare dice robot → rechazo; si la casilla no carga (Cuba) → pasa con su código y queda `registro_sin_turnstile` en la auditoría; `config/turnstileObligatorio = true` la hace obligatoria.
- `GET /api/auth/opciones` dice a la web qué mostrar. Todo APAGADO hasta definir en Render: `GOOGLE_CLIENT_ID`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`.
- **Vincular Google es OBLIGATORIO** (decisión de Yoel): quien entró sin Google puede usar la app mientras Google no responda; la web vigila la conexión (evento online + reintento cada 3 min, máx. 10) y en cuanto Google carga muestra una pantalla completa sin "Ahora no" (solo vincular o cerrar sesión). `POST /api/auth/google/vincular` (con sesión; reserva atómica de `googleCuentas/<sub>`; no permite tomar el Google de otro ni cambiarlo). Google exige un toque de confirmación: no puede hacerse en silencio. La obligación es de la web (el servidor no puede saber si Google carga en ese móvil).
- Pruebas: `test/google.prueba.js` (30), `test/google.e2e.js` (17, incluye Google/Cloudflare bloqueados y la vinculación obligatoria al volver la conexión).
- Claves creadas por Yoel y puestas en Render (GOOGLE_CLIENT_ID del proyecto betgroup-cuba-2024; Turnstile con los hostnames web.app y firebaseapp.com). Servidor desplegado; falta publicar la web y probar en el móvil. Las funciones antiguas `doGoogleSignIn`/`showGoogleRegForm`/`completarGoogleReg` siguen en index.html sin uso (no se borran sin autorización).

## Cierre de la sesión del 2 oct 2026 — pendiente para la próxima

1. **Publicar la web de las Etapas 10, 11 y 12** (el servidor estará en `etapa12`): `git -C ~/bg-frontend-privado fetch -q origin claude/upbeat-cerf-rpytdm && git -C ~/bg-frontend-privado checkout -q -B etapa3 origin/claude/upbeat-cerf-rpytdm && bash ~/bg-frontend-privado/publicar/publicar_web.sh` (copia también sw.js, manifest.json e iconos/).
2. Tras publicar: instalar la app desde Chrome, aceptar avisos, revisar "Riesgo de fraude" y que los subadmins vean a todos sus referidos.
3. Lunes: primer aviso del ranking semanal por Telegram → revisar antifraude antes de "Entregar premios".
4. Vigilar créditos de The Odds API (`diagnostico_cuotas.sh sincuota`).
5. Casino (aplazado) y panel CEO/subadmin con el diseño nuevo (opcional).

## Decisiones de Yoel (2 oct 2026)

- **Las claves filtradas NO se rotan** (decisión de Yoel, riesgo aceptado). Se cargan tal cual en las variables de entorno de Render. Siguen visibles en el historial público de git.
- **Saldo promocional** (actualizado en la Etapa 8): cuota mínima 1.50 y solo la GANANCIA pasa a saldo real. Bono de inscripción de 100 (Etapa 12) con retiro bloqueado hasta depositar 500 CUP.

## Reglas fijas

- Repo hermano `betgroup-proxy` (sin "-v2") tiene credenciales reales embebidas en archivos versionados — Yoel ya lo sabe, piensa eliminarlo, no requiere acción inmediata
- Antes de cerrar cualquier ronda: `node -c` sin errores, respaldo hecho, autorización explícita recibida, **y este archivo actualizado y subido**
