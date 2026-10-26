# Bot EPM → Telegram en un Cloudflare Worker (100 % gratuito)

Telegram → **Cloudflare Worker + D1** (+ una cola). Sin GitHub Actions en el camino de cada pulsación: responde en décimas de segundo.
Todo funciona en el plan **gratuito** de Cloudflare, sin tarjeta.

```
Telegram ──POST──▶ fetch()      valida el secreto, procesa la update en D1 y responde (~0,1–0,6 s)
Cron */30  ──────▶ scheduled()  consulta EPM, compara con D1 y encola lo nuevo
Cola       ──────▶ queue()      detalle de la oferta, tarjeta y reparto de avisos (CPU holgada, ≤35 envíos por mensaje)
```

> Estado: **activo desde el 2026-10-26.** El webhook de Telegram apunta a este Worker y `live = 1` en D1. El sistema anterior (`worker/` + GitHub Actions)
> queda desactivado pero sin borrar. Ver [Corte](#corte-activar-el-sistema-nuevo) y [Vuelta atrás](#vuelta-atrás).

## Límites del plan gratuito (documentación de Cloudflare) y medidas reales

| Recurso | Límite gratuito | Dónde se nota |
|---|---|---|
| Peticiones al Worker | 100.000 / día | Cada update de Telegram. Se valida el secreto lo primero y se limita por chat (8 cada 10 s). |
| CPU por invocación (HTTP y Cron) | 10 ms | El cron solo compara y encola; el trabajo pesado va a la cola. |
| Subpeticiones `fetch` por invocación | 50 (comprobado: la 51.ª falla) | Un mensaje de la cola envía ≤35 avisos; el reparto va en varios mensajes. |
| D1: lecturas / escrituras | 5.000.000 / **100.000** por día | Al excederlas las consultas fallan hasta las 00:00 UTC (no se cobra). |
| D1: almacenamiento | 5 GB (500 MB por base) | Se usan unos KB. |
| D1: Time Travel | 7 días, siempre activo | Segunda capa de respaldo. |
| Cola (Queues) | 10.000 operaciones / día | ~3 operaciones por mensaje: un aviso a 500 suscriptores ≈ 40. |
| Cron Triggers | 5 por cuenta (se usa 1) | Tarda hasta 15 min en propagarse tras desplegar. |

Medido en Cloudflare con un Worker de prueba (después borrado): EPM responde desde su red (0 bloqueos en 4 pruebas); D1 ~25 ms por lectura y ~42 ms por escritura;
25 incrementos simultáneos dieron exactamente +25; el consumidor de la cola admitió 124 ms de CPU (HTTP y Cron: 10 ms); en producción procesar una oferta real cuesta 13–26 ms (la primera de una ráfaga) y 6–8 ms (las siguientes), con resultado correcto; PBKDF2 con 200.000 iteraciones **no cabe** en 10 ms
(por eso el cifrado usa HKDF); 12 ofertas procesadas de golpe cuestan 4–13 ms de CPU en frío (por eso el procesamiento va a la cola).

### Consumo de D1 por operación (medido)
| Operación | Filas leídas | Filas escritas |
|---|---|---|
| Menú, botones de menú | 0 | 0 |
| `/ofertas` (12 ofertas desde D1) | 12 | 0 |
| Suscribirse (alta) | ~3 + recuento de suscriptores | 3 |
| Cambiar de perfil | 3 | 2 |
| Repetir la misma elección | 1 | **0** |
| Cron sin novedades (48 al día) | 57 | 1 |

Con 500 suscriptores, 2.000 updates y 5 ofertas al día: ≈ 130 k lecturas (2,6 %) y ≈ 6 k escrituras (6 %). El tope realista es el de 100.000 peticiones bajo abuso.
`/uso` (solo administrador) muestra el consumo del día; `GET /admin/status` (con el secreto) devuelve recuentos.

## Esquema de D1 (`migrations/0001_init.sql`)
`meta` (live…) · `seen` (ofertas vistas) · `offers` (datos públicos de cada oferta) · `subs` y `chats` (**cifrados**, clave de fila = HMAC del chat) ·
`sent` (un aviso por oferta y destinatario) · `applied` (dedupe de updates) · `usage` y `events` (consumo y errores, sin datos de usuarios).

**Cifrado:** AES-GCM con claves derivadas de `STATE_KEY` por HKDF; el texto cifrado va atado a su fila (no se puede copiar de una fila a otra) y la clave de fila es un HMAC,
así que ni el chat id ni los perfiles elegidos están en claro en D1. Los cambios usan control de versión (compare-and-swap) con reintentos, y las elecciones son absolutas
(«activar X»/«quitar X»), por lo que repetir una pulsación no hace daño.

## Secretos (`wrangler secret put`) — nunca en el repositorio
| Secreto | Para qué |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Enviar mensajes |
| `WEBHOOK_SECRET` | Valida `X-Telegram-Bot-Api-Secret-Token` (y las rutas `/admin/*`) |
| `STATE_KEY` | Cifrado del estado y de los respaldos |
| `TELEGRAM_CHAT_ID` | Administrador (el primero de la lista) |
| `GH_BACKUP_TOKEN` | **No se usa** (respaldo automático desactivado). Solo haría falta para reactivarlo: token fine-grained con *Contents: Read and write* sobre este repo |

`node bot/scripts/load-secrets.mjs` los carga desde tu `.env` sin imprimirlos.

## Desplegar
```bash
cd bot && npm install
npx wrangler d1 create epm-bot-db          # copia el id a wrangler.local.toml (copia de wrangler.toml; ignorado por git)
npx wrangler queues create epm-bot-jobs
npx wrangler d1 migrations apply epm-bot-db -c wrangler.local.toml --remote
node scripts/migrate-state.mjs --out /tmp/migrate.sql          # lee la rama `state` (solo lectura) y la API de EPM
npx wrangler d1 execute epm-bot-db -c wrangler.local.toml --remote --file /tmp/migrate.sql
npx wrangler deploy -c wrangler.local.toml
node scripts/load-secrets.mjs
```
El `database_id` es un identificador (sin un token de tu cuenta no sirve para nada), pero se mantiene fuera del repositorio.

## Corte: activar el sistema nuevo
Orden seguido el 2026-10-26 (nunca hay dos sistemas respondiendo ni avisando a la vez). Pruebas previas, sin tocar nada: `POST /admin/tick?dry=1` y una petición firmada de `/start`.

1. **Resincronizar las ofertas vistas** con `live = 0`:
   `node bot/scripts/migrate-state.mjs --seen-only --from-ref origin/state --out <seen.sql>` y `npx wrangler d1 execute epm-bot-db -c wrangler.local.toml --remote --file <seen.sql>`
2. **Apuntar el webhook** (todavía con `live = 0`: responde pero no avisa): `node epm-notifier.mjs --set-webhook=https://epm-bot.<subdominio>.workers.dev`. Probar `/start`, un botón y `/ofertas` desde Telegram.
3. **Desactivar los disparadores viejos:** `gh workflow disable epm-notifier.yml` y `crons = []` en `worker/wrangler.toml` (`npx wrangler deploy` en `worker/`). Esperar a que termine cualquier ejecución en curso y comprobar `--webhook-info`, `/admin/status` y `gh workflow list --all`.
4. **Resincronizar de nuevo y activar:** repetir el paso 1 y `UPDATE meta SET v='1' WHERE k='live'`.
5. **Verificar** el primer tick real del cron (`wrangler tail`): sin errores, sin avisos repetidos y sin datos sensibles.

## Vuelta atrás
1. `UPDATE meta SET v='0' WHERE k='live'` (el cron nuevo deja de avisar).
2. Apuntar el webhook de nuevo al Worker viejo: `node epm-notifier.mjs --set-webhook=https://epm-notifier-webhook.<subdominio>.workers.dev`.
3. Copiar a `state` lo que el sistema nuevo ya avisó, para que el viejo no lo repita:
   `npx wrangler d1 execute epm-bot-db -c wrangler.local.toml --remote --json --command "SELECT id FROM seen" > ids.json && node bot/scripts/rollback-seen.mjs --ids ids.json --push`
4. Restaurar los disparadores viejos (`schedule`, `repository_dispatch` y el `[triggers]` del Worker viejo) y desplegar.

La rama `state` no se toca en ningún otro momento: queda como respaldo del estado anterior.

## Respaldo
**El respaldo automático semanal está desactivado** (`BACKUP_ENABLED = "0"`): ni el cron del domingo ni `/admin/tick?backup=1` encolan nada, y el consumidor ignora un mensaje `backup` aunque llegara. Motivos: el repositorio es público (los archivos cifrados quedarían en el historial para siempre y su seguridad dependería solo de `STATE_KEY`) y el token necesario (*Contents: Read and write*) también podría escribir en `main`. El código ([src/lib/backup.js](src/lib/backup.js)) se conserva y sigue cubierto por las pruebas.

Quedan dos protecciones: **Time Travel** de D1 (7 días: `npx wrangler d1 time-travel restore epm-bot-db -c wrangler.local.toml --timestamp <ISO>`) y la **copia local**.

### Copia local a demanda
```bash
node bot/scripts/backup-local.mjs            # opciones: --keep 12  --out <carpeta ignorada por git>  --db epm-bot-db  -c wrangler.local.toml
```
Ejecuta `wrangler d1 export` y guarda `bot/backups/d1-AAAA-MM-DD-HHMM.sql` (carpeta ignorada por git; el script se niega a escribir en una que no lo esté), comprueba que tiene las cinco tablas y conserva las últimas 12. Notas:
- Contiene **toda** la base: las ofertas son públicas, pero suscriptores y chats van **cifrados** con `STATE_KEY` (el chat id no aparece en claro). Aun así, trátala como sensible: no la subas a ningún sitio.
- **Sin `STATE_KEY` la copia no sirve para recuperar suscriptores.** Guárdala por separado (gestor de contraseñas).
- Mientras dura la exportación D1 bloquea las consultas (con esta base, una fracción de segundo). Conviene hacerla de vez en cuando, por ejemplo cada semana y antes de cualquier cambio de esquema.
- Es manual: no hay nada que corra solo.

### Restaurar una copia
Lo más seguro es restaurar en una base **nueva**, sin tocar la actual:
1. `npx wrangler d1 create epm-bot-restore` (anota su `database_id` en `wrangler.local.toml`, nunca en el repositorio).
2. `npx wrangler d1 execute epm-bot-restore -c wrangler.local.toml --remote --file bot/backups/d1-AAAA-MM-DD-HHMM.sql` (el archivo trae el esquema y los datos).
3. Comprueba los recuentos (`SELECT COUNT(*) FROM subs`…). Para usarla, cambia `database_name` y `database_id` en `wrangler.local.toml` y `npx wrangler deploy -c wrangler.local.toml`. La `STATE_KEY` del Worker debe ser la misma con que se cifró.
4. La base antigua no se borra hasta confirmar que todo funciona.

Restaurar sobre la base actual no funciona tal cual (las tablas ya existen); para eso usa Time Travel. La restauración se probó con una copia real en una base local vacía: mismos recuentos y `live` conservado.

### Reactivar el automático (no recomendado)
Crea un token fine-grained solo para este repositorio, con *Contents: Read and write* y caducidad corta, cárgalo con `node scripts/load-secrets.mjs` (`GH_BACKUP_TOKEN` en `.env`), pon `BACKUP_ENABLED = "1"` en `[vars]` de `wrangler.local.toml` y despliega. Cada domingo (~03:00 UTC) subirá un archivo cifrado a la rama `d1-backup` (se conservan los últimos 8); `POST /admin/tick?backup=1` lo fuerza.

## Pruebas
```bash
cd bot
npm test                    # unitarias: cifrado, fechas en Bogotá, audiencia, requisitos, tarjeta, aviso nuevo, saneado y límite
npm run test:migration      # migración del formato antiguo (OpenSSL) a D1 y vuelta atrás
npm run test:integration    # Worker real (wrangler dev: D1 y cola locales) con Telegram, EPM y GitHub simulados
```
Las de integración cubren: 401/405/413/400, tipos descartados, límite por chat, respuesta inmediata, caché vacía, cron en vivo y cola, avisos sin duplicados, 8 pulsaciones simultáneas,
cron + pulsaciones a la vez, reparto a 83 destinatarios, bloqueos (403) y 429, EPM caído, detalle que falla, ofertas ya cerradas, límites de D1 simulados, respaldo cifrado y ausencia de datos sensibles en logs.
