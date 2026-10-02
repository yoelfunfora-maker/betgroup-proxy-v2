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

## Etapa 1 de seguridad — 2 oct 2026 (rama `claude/upbeat-cerf-rpytdm`, SIN desplegar)

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

## Etapa 2 de dinero — 2 oct 2026 (misma rama, SIN desplegar)

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

## Reglas fijas

- Repo hermano `betgroup-proxy` (sin "-v2") tiene credenciales reales embebidas en archivos versionados — Yoel ya lo sabe, piensa eliminarlo, no requiere acción inmediata
- Antes de cerrar cualquier ronda: `node -c` sin errores, respaldo hecho, autorización explícita recibida, **y este archivo actualizado y subido**
