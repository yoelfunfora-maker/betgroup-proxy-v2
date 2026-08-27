# Estado del proyecto — BetGroup Pro (backend real: betgroup-proxy-v2)

**Este archivo es el "mismo sitio" real que exige el Protocolo de trabajo de Fundora — cualquier sistema de IA (Claude, DeepSeek, Gemini, u otro) que trabaje aquí debe leerlo primero, y actualizarlo al final de cada sesión real.**

Última actualización: 24 de agosto de 2026.

## ⚠️ Protocolo de trabajo OBLIGATORIO para este proyecto (más estricto que el resto)

- Respaldo antes de cada cambio real
- Un cambio por commit, nunca varios amontonados
- `node -c archivo.js` (chequeo de sintaxis) ANTES de desplegar
- Nunca borrar código sin autorización explícita de Yoel
- Consolidar los comandos de bash en bloques únicos
- Autorización explícita de Yoel antes de implementar cualquier cambio real

## Stack real

**Este único servicio de Render sirve el backend Y el frontend juntos** (confirmado por Yoel, 24 ago) — `betgroup-cuba-2024.web.app` NO se despliega vía Firebase Hosting como se creía antes, se sirve desde aquí mismo. El repo `betgroup-pro` está casi vacío y no participa del despliegue real — ver su propio ESTADO_PROYECTO.md.

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

## Reglas fijas

- Repo hermano `betgroup-proxy` (sin "-v2") tiene credenciales reales embebidas en archivos versionados — Yoel ya lo sabe, piensa eliminarlo, no requiere acción inmediata
- Antes de cerrar cualquier ronda: `node -c` sin errores, respaldo hecho, autorización explícita recibida, **y este archivo actualizado y subido**
