# Notificador de ofertas EPM → Telegram

[![EPM Notifier](https://github.com/dgonzalezt2/epm-notifier/actions/workflows/epm-notifier.yml/badge.svg)](https://github.com/dgonzalezt2/epm-notifier/actions/workflows/epm-notifier.yml)

Consulta la API REST pública de Oracle HCM que usa la página de empleo de EPM y avisa por Telegram de las ofertas nuevas. Node.js 20+, sin dependencias. Corre en **GitHub Actions** (cron cada 30 minutos para las ofertas nuevas) y los comandos y botones responden en **~15–30 segundos** gracias a un **Cloudflare Worker**. 100 % gratis, sin servidores y sin depender de ningún computador encendido.

## Pruébalo

<p align="center">
  <a href="https://t.me/epmofertasbot"><img src="docs/qr-bot.png" alt="QR de @epmofertasbot" width="240"></a>
  <br>
  <b><a href="https://t.me/epmofertasbot">Abrir @epmofertasbot en Telegram</a></b>
  <br>
  <sub>Escanea el QR con la cámara de tu celular o toca el enlace</sub>
</p>

1. Pulsa **Iniciar / Start**.
2. Toca **🎯 Perfiles** para ver si hay ofertas de tu carrera o cargo.
3. Toca **🔔 Suscribirme** y elige *todas las ofertas* o solo tus perfiles: te avisará cuando EPM publique algo nuevo.

> El bot solo guarda el id de tu chat para enviarte los avisos. Puedes cancelarlos cuando quieras desde el mismo menú.
> ⚠️ Proyecto personal y educativo, **no oficial ni afiliado a EPM** (ver [Aviso legal](#aviso-legal)). Las ofertas se postulan siempre en la página de empleo de EPM.
> ⏱️ El bot no corre de forma permanente: los comandos y botones responden en ~15–30 s (el arranque de un job de GitHub Actions) y las ofertas nuevas se avisan en la siguiente revisión, cada ~30 minutos (ver [Cómo funciona](#cómo-funciona)).

## Aviso legal

- Este es un **proyecto personal, educativo y sin fines de lucro**, hecho para mantenerme al tanto de las ofertas laborales de EPM.
- **No está afiliado, patrocinado ni respaldado por EPM (Empresas Públicas de Medellín).** No tengo ningún derecho sobre EPM ni sobre su nombre, marca o logotipo, que pertenecen a sus titulares. Las menciones a EPM son únicamente para indicar de dónde proviene la información.
- No copia ni redistribuye el sitio de EPM: consulta la misma API pública que usa su página de empleo y solo reenvía datos básicos de cada oferta (título, ubicación, fecha, un resumen breve y requisitos) con **enlace a la fuente oficial**. Toda postulación se hace en la página oficial de EPM.
- Sin garantías: la información puede estar desactualizada o incompleta. Verifica siempre en el sitio oficial. Desconfía de cualquier oferta que te pida dinero.
- Si eres titular de derechos y quieres que algo se modifique o se retire, abre un *issue* en este repositorio y se atenderá.

## Cómo se ve

> 🔍 Toca o haz clic en cualquier imagen para verla en tamaño completo.

### 1. Primer ingreso

Al abrir el bot por primera vez, Telegram muestra qué hace y el botón **Iniciar**.

<p align="center">
  <a href="docs/screenshots/bienvenida.png"><img src="docs/screenshots/bienvenida.png" alt="Primer ingreso: descripción del bot y botón Iniciar" width="380"></a>
</p>

### 2. Menú de inicio

Con `/start` (o `/comandos`) el bot se presenta y ofrece un menú con botones: **Ofertas**, **Perfiles**, **Suscribirme** y **Ayuda**.

<p align="center">
  <a href="docs/screenshots/start1.png"><img src="docs/screenshots/start1.png" alt="Menú de inicio tras /start" width="700"></a>
</p>

### 3. Todas las ofertas

**📋 Ofertas** (o `/ofertas`) lista las ofertas abiertas con cargo, ubicación, fecha y enlace a la página oficial de EPM.

<p align="center">
  <a href="docs/screenshots/ofertas.png"><img src="docs/screenshots/ofertas.png" alt="Lista de ofertas abiertas" width="700"></a>
</p>

### 4. Cómo filtrar

**🎯 Perfiles** (o `/perfiles`) permite filtrar por carrera o por cargo y responde si hay ofertas para ti.

<p align="center">
  <a href="docs/screenshots/perfiles.png"><img src="docs/screenshots/perfiles.png" alt="Perfiles: por carrera o por cargo" width="700"></a>
</p>

### 5. Por carrera / área

Sistemas, civil, eléctrica, financiera, jurídica, talento humano y más.

<p align="center">
  <a href="docs/screenshots/perfilesCarrera.png"><img src="docs/screenshots/perfilesCarrera.png" alt="Perfiles por carrera" width="700"></a>
</p>

### 6. Por cargo / nivel

Profesional, tecnólogo, técnico, oficial de operación y mantenimiento, electricista… Si hay coincidencias, las lista; si no, te lo dice.

<p align="center">
  <a href="docs/screenshots/perfilesCargo.png"><img src="docs/screenshots/perfilesCargo.png" alt="Perfiles por cargo y resultado" width="700"></a>
</p>

### 7. Suscribirse a avisos

**🔔 Suscribirme** (o `/suscribir`): elige *todas las ofertas* o uno o varios perfiles (✅ = activo) y recibe un aviso automático cuando EPM publique algo nuevo. Se cancela con **🔕 Cancelar avisos**.

<p align="center">
  <a href="docs/screenshots/suscribirse.png"><img src="docs/screenshots/suscribirse.png" alt="Suscripción a avisos por perfil" width="700"></a>
</p>

### 8. Ayuda

`/ayuda` lista los comandos disponibles.

<p align="center">
  <a href="docs/screenshots/ayuda.png"><img src="docs/screenshots/ayuda.png" alt="Ayuda y comandos" width="700"></a>
</p>

## Qué muestra cada oferta

Cada oferta (en el botón **📋 Ofertas**, en los perfiles y en el aviso de oferta nueva) usa la misma tarjeta:

```
🆕 TECNÓLOGO-TECNÓLOGA OPERACIÓN MANTENIMIENTO Y SERVICIOS     ← el título es el enlace a la oferta
👥 Dirigida a: Servidores de EPM — «Servidores/as de EPM que hacen parte de la Gerencia…»
📍 Medellín, Antioquia, Colombia
📅 Publicada: 22 oct 2026 · ⏰ Cierra: 27 oct 2026 (en 3 días)
Realizar actividades técnicas, operativas y administrativas requerida en los procesos de…
```

El 🆕 aparece solo en el aviso de oferta nueva, que además añade el salario, el contrato y los requisitos.

- **Título clicable.** El enlace se arma con el ID validado de la oferta y la plantilla pública de EPM; nunca con una URL que venga dentro del contenido de EPM. La vista previa del enlace está desactivada para que varias ofertas no llenen el chat de tarjetas.
- **Descripción breve.** Campo `ShortDescriptionStr` de EPM (texto plano), unos 350 caracteres, cortado en frontera de palabra.
- **Fechas en hora de Bogotá (UTC−5).** EPM entrega la fecha límite como `…T04:59:00Z`, que en Colombia son las **23:59 del día anterior**; por eso se convierte antes de mostrarla. Se indica «cierra hoy», «cierra mañana» o «en N días». Las ofertas **ya cerradas no se presentan como disponibles**: se omiten del botón (con un aviso de cuántas son) y no se notifican.
- **Si falta algún dato:** sin fecha límite se muestra «No especificada»; si el detalle de EPM no responde, la tarjeta sale igual con los datos del listado, «No determinado» y la descripción del listado (o «Descripción no disponible»).

### ¿Cómo se determina «Dirigida a»?

La API de EPM **no tiene un campo que distinga ofertas internas de externas**. Se combina lo que sí hay:

| Fuente | Resultado | Fiabilidad |
|---|---|---|
| `RequisitionType = Privado` (campo explícito) | «Por invitación (proceso privado)» | Alta |
| Frase «Público objetivo» del texto de la oferta que menciona «servidores» | «Servidores de EPM» | Heurística |
| …que dice «abierto a la comunidad» o «público en general» | «Público general» | Heurística |
| Ambas cosas, ninguna, o servidores de otra empresa (CHEC, ESSA…) | «No determinado» | — |

Cuando la etiqueta sale del texto, se muestra el **fragmento literal** entre «…» para que cualquiera pueda comprobarlo. Con las 20 ofertas que la API publicaba el 2026-10-24 el resultado coincide con lo que dice cada oferta (12 de servidores, 1 abierta a la comunidad, 7 por invitación), pero son pocas y las redactó el mismo equipo: si EPM cambia la redacción, la etiqueta puede caer en «No determinado» o equivocarse, y por eso el fragmento siempre acompaña a la etiqueta. Varias ofertas del Programa de Inclusión Laboral van dirigidas a *personas con discapacidad que ya son servidores*; el fragmento lo deja claro.

> **Alcance:** el bot vigila el sitio «EPM Sitio» (`CX_1`), que el 2026-10-24 tenía 12 de las 20 ofertas que expone la API. Las otras 8 están en sitios privados (por invitación) o de filiales (CHEC, ESSA…) y no se vigilan. Por eso «Público general» casi no aparece hoy.

> Las capturas de «Cómo se ve» son anteriores a esta tarjeta y muestran el formato previo de las ofertas.

## Cómo funciona

El bot **no corre de forma permanente**: lo ejecuta [GitHub Actions](.github/workflows/epm-notifier.yml) cuando hace falta, y funciona aunque mi computador esté apagado (Telegram solo entrega mensajes; el código lo ejecuta GitHub).

```
 Comandos y botones (respuesta en ~15–30 s)
 Telegram ──webhook──▶ Cloudflare Worker ──repository_dispatch──▶ GitHub Actions ──▶ Telegram
                        valida el secret,                         una ejecución por       responde y
                        reduce la update                          comando o botón         guarda el estado

 Ofertas nuevas (y respaldo de comandos)
 Cron cada 30 min ──▶ GitHub Actions ──▶ API de EPM ──▶ avisos por Telegram ──▶ guarda el estado
```

**Ejecución por cron (cada 30 minutos):**
1. **Restaura el estado** desde la rama `state`.
2. **Consulta la API de EPM** (`recruitingCEJobRequisitions`, con paginación) y compara con los ids ya vistos. También guarda en `state` los datos públicos de cada oferta (audiencia y fechas, `seen.json.offers`) para que el botón de ofertas no tenga que pedir el detalle de EPM oferta por oferta (~0,45 s cada una).
3. **Notifica por Telegram** las ofertas nuevas: a los chats autorizados y a los suscriptores, según el perfil que eligieron. Por cada oferta pide el detalle (`recruitingCEJobRequisitionDetails`) y envía título, ubicación, fecha, resumen, requisitos y enlace.
4. **Guarda el estado** en la rama `state`, solo si todo terminó bien.
5. **Respaldo de comandos:** con el webhook sano no lee mensajes; si Telegram no consigue entregarlos, recoge los pendientes (ver [Si el Worker falla](#si-el-worker-falla)).

**Ejecución por comando o botón (webhook):** el Worker dispara el workflow con la update; el script la procesa, guarda el estado y envía la respuesta. No consulta la API de EPM.

- **Primera ejecución** (sin `seen.json`): guarda las ofertas existentes **sin notificarlas** y envía "Notificador EPM activo".
- Todas las ofertas del listado se marcan como vistas, también las que no pasan `KEYWORDS`.
- Si hay un error (HTTP, parseo, Telegram), se imprime y se avisa al administrador por Telegram. Hay reintentos con *backoff* para errores de red, 5xx y 429.
- **Si el script falla, el job falla de forma visible** (código ≠ 0) y **no se guarda estado**: nunca queda un `seen.json` a medias.
- `timeout-minutes: 5` corta las ejecuciones que se cuelgan; el cron y las ejecuciones manuales nunca corren a la vez.

### El estado vive en la rama `state`

Es una rama huérfana que crea y actualiza el propio workflow (no se edita a mano). No se usa `actions/cache` porque se borra tras 7 días sin uso.

| Archivo | Contenido | En el repo público |
|---|---|---|
| `seen.json` | ids de ofertas ya vistas | en claro |
| `seen.json.offers` | datos públicos de cada oferta: audiencia y fechas (sin descripción larga) | en claro |
| `seen.json.applied` | últimos `update_id` aplicados (evita aplicar dos veces un cambio) | en claro |
| `seen.json.tgoffset` | último mensaje leído con `getUpdates` (solo modo sin webhook y respaldo) | en claro |
| `seen.json.subs.enc` | suscriptores (chat ids y perfiles) | **cifrado** |
| `seen.json.chats.enc` | chats autorizados | **cifrado** |
| `last_run` | fecha de la última ejecución | en claro |

`last_run` se actualiza como máximo una vez al día: así el repositorio mantiene actividad y GitHub no desactiva el schedule por inactividad (60 días).

## Respuesta rápida con Cloudflare Worker

> ⚡ **Novedad (2026-10-24):** los comandos y botones ahora responden en **~15–30 segundos** (antes, hasta ~30 minutos). Sigue siendo **100 % gratis** (Cloudflare Workers + GitHub Actions) y **no depende de ningún computador encendido**.

Antes, el bot solo leía los mensajes de Telegram cuando corría el cron. Ahora Telegram avisa por *webhook* a un [Worker de Cloudflare](worker/src/index.js), que dispara el workflow al instante con `repository_dispatch`. El cron de 30 minutos sigue siendo el respaldo y el que avisa de las ofertas nuevas.

### ¿Por qué las respuestas tardan unos segundos?

El bot no está «encendido» esperando: **se despierta bajo demanda**, y por eso es gratis. Cada pulsación hace este recorrido:

1. **Telegram avisa al Cloudflare Worker** (instantáneo).
2. **El Worker valida la petición** y dispara un `repository_dispatch` en GitHub (~0,5 s).
3. **GitHub Actions asigna una máquina virtual nueva**, descarga el código, prepara Node y descifra el estado (~10–25 s: es el paso lento).
4. **El script procesa la acción**, guarda el estado en la rama `state` y responde por Telegram.

Medido el 2026-10-24: **11–25 s por ejecución, mediana 15 s**. Si varias personas pulsan a la vez, cada pulsación dispara su propia ejecución (se ven en la pestaña Actions) y se procesan en paralelo.

### Aviso de «procesando»

Para que nadie piense que el bot se colgó, el Worker avisa **antes** de que arranque el job, en paralelo al dispatch y sin retrasarlo:

- **Botones:** aviso flotante «⏳ Procesando… puede tardar unos segundos, ten paciencia» y «escribiendo…» en la cabecera del chat (repetido una vez a los ~4,5 s).
- **Comandos:** «escribiendo…» (con la misma repetición).
- **Menú principal:** nota fija «⏳ Las respuestas pueden tardar unos segundos. ¡Gracias por la paciencia!».
- **No se avisa** para updates que el Worker descarta, chats que superan el límite ni comandos dirigidos a otros bots. Si Telegram falla al avisar, el dispatch y la respuesta del Worker no cambian.

**¿Por qué un aviso flotante y no la ruedita del botón?** Telegram muestra una ruedita en el botón hasta que el bot responde al callback (`answerCallbackQuery`, que solo puede llamarse una vez). Responder desde el job significa hacerlo 10–25 s después: la ruedita podría cortarse sola por tiempo (Telegram no documenta el límite exacto) y el usuario no vería ningún texto. Por eso el Worker responde al instante con el aviso flotante: la ruedita desaparece enseguida, pero hay un mensaje claro, y el «escribiendo…» cubre el resto de la espera. La llamada tardía del job queda como respaldo inofensivo (falla en silencio si el Worker ya respondió).

El aviso necesita el secret `TELEGRAM_BOT_TOKEN` en el Worker (`npx wrangler secret put TELEGRAM_BOT_TOKEN`).

### Garantías de diseño

- **Una ejecución por update**, cada una con su propio grupo de `concurrency`. GitHub conserva solo *una* ejecución pendiente por grupo y cancela las más viejas, así que con un grupo común varias pulsaciones seguidas se perderían.
- **Estado transaccional.** Cada ejecución restaura el estado más reciente, aplica la update (las respuestas quedan en cola, sin enviarse), guarda con `git push` y **solo si el push funcionó** envía las respuestas. Si otra ejecución guardó antes (push rechazado), descarta todo y repite sobre el estado nuevo, hasta 8 veces. Así no hay respuestas duplicadas ni estado a medias. No se usa `git rebase`: los archivos cifrados son binarios y no se pueden fusionar.
- **Deduplicación por `update_id`** para los cambios de estado (suscripciones y administración), en caso de que Telegram reenvíe una update.
- **Sin pérdidas ante fallos:** el Worker *espera* la respuesta de GitHub y, si falla, responde 5xx para que Telegram reintente la entrega.
- **Límite por chat** en el Worker (8 updates cada 10 s) para que nadie dispare cientos de ejecuciones.
- El Worker solo reenvía comandos (`/…`) y pulsaciones de botón, con una update mínima (ids y texto del comando). No registra nada en logs.

### Desplegar el Worker

```bash
cd worker && npm install                 # única dependencia: wrangler
npx wrangler login                       # cuenta gratuita de Cloudflare
npx wrangler deploy                      # publica https://<worker>.<subdominio>.workers.dev
npx wrangler secret put WEBHOOK_SECRET   # el mismo valor que TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GH_DISPATCH_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN   # aviso de "procesando"
```

1. **Token de GitHub** (`GH_DISPATCH_TOKEN`): *Settings → Developer settings → Fine-grained tokens*. Propietario: tu usuario; **Only select repositories** → solo este repo; permiso **Contents: Read and write** (Metadata read-only se añade solo) y ningún otro. **Caducidad corta (p. ej. 90 días)**.
2. **Secret del webhook:** una cadena aleatoria larga, por ejemplo `openssl rand -hex 32`. Se guarda en el Worker (`WEBHOOK_SECRET`), en GitHub (`TELEGRAM_WEBHOOK_SECRET`) y, para registrar el webhook, en tu `.env`.
3. **Vacía los pendientes** antes del primer registro (ejecuta una vez el workflow en el modo anterior); con `drop_pending_updates=false` todo lo acumulado en 24 h se entregaría de golpe.
4. **Registra el webhook** (lee token y secret de tu entorno y no los imprime):
   ```bash
   node epm-notifier.mjs --set-webhook=https://<tu-worker>.<subdominio>.workers.dev
   node epm-notifier.mjs --webhook-info     # activo: sí | pendientes: 0
   ```
5. **Comprueba el rechazo:** un `POST` sin el header `X-Telegram-Bot-Api-Secret-Token` correcto debe devolver **401** y no disparar ningún workflow.

Los `secret put` guardan los valores cifrados en Cloudflare: nunca van en `wrangler.toml` ni en el repositorio. En `wrangler.toml` solo hay valores públicos (el nombre del repo).

### Secrets necesarios (solo nombres)

| Dónde | Nombre | Para qué |
|---|---|---|
| Worker (Cloudflare) | `WEBHOOK_SECRET` | Valida el header `X-Telegram-Bot-Api-Secret-Token` |
| Worker (Cloudflare) | `GH_DISPATCH_TOKEN` | Token fine-grained que dispara el `repository_dispatch` |
| Worker (Cloudflare) | `TELEGRAM_BOT_TOKEN` | Solo para el aviso de «procesando» (`answerCallbackQuery` y `sendChatAction`) |
| GitHub Actions | `TELEGRAM_WEBHOOK_SECRET` | Opcional: permite al cron volver a registrar el webhook solo |
| GitHub Actions | `WEBHOOK_URL` | Opcional: URL del Worker, para el mismo fin |

Los de GitHub son opcionales: sin ellos, si el webhook falla el cron lo desactiva, atiende los pendientes y te avisa, pero no lo vuelve a registrar.

### Rotar los secretos

- **Token de GitHub:** crea uno nuevo con la misma configuración → `npx wrangler secret put GH_DISPATCH_TOKEN` → revoca el anterior. Antes de que caduque: si vence, el Worker responde `502 dispatch failed: HTTP 401` y el cron recoge los pendientes (usa el `GITHUB_TOKEN` del job, no ese token).
- **Secret del webhook:** genera uno nuevo → `npx wrangler secret put WEBHOOK_SECRET` → `gh secret set TELEGRAM_WEBHOOK_SECRET` → actualiza tu `.env` → `node epm-notifier.mjs --set-webhook=<url>`.
- **Token del bot:** `/revoke` en @BotFather, actualiza el Secret `TELEGRAM_BOT_TOKEN` y vuelve a registrar el webhook.

### Desactivar el webhook (volver al modo solo-cron)

```bash
node epm-notifier.mjs --delete-webhook   # conserva los mensajes pendientes
```
Con el webhook desactivado, el cron vuelve a leer los mensajes con `getUpdates` (los comandos tardan hasta ~30 min, como antes) y no lo reactiva por su cuenta. Mientras haya webhook activo, `getUpdates` y `--listen` no funcionan (Telegram responde 409).

### Si el Worker falla

- **Ofertas nuevas:** no dependen del Worker; el cron las sigue enviando.
- **Worker o GitHub caídos, o token vencido:** Telegram reintenta la entrega y conserva los mensajes pendientes hasta 24 h. En su siguiente ejecución, el cron detecta `pending_update_count > 0` con un error reciente, **desactiva el webhook sin perder pendientes, reenvía cada mensaje al workflow como `repository_dispatch` (con el `GITHUB_TOKEN` del job, hasta 50 por corrida), vuelve a registrar el webhook** si hay `WEBHOOK_URL` y `TELEGRAM_WEBHOOK_SECRET`, y te avisa por Telegram.
- Para diagnosticar, el Worker responde `502` con el código y el mensaje públicos de GitHub (por ejemplo `HTTP 403 Resource not accessible by personal access token`, que indica permisos del token insuficientes).

## Configuración

Necesitas un bot (en Telegram, con **@BotFather** → `/newbot` → copia el token) y tu chat id (escríbele al bot y ejecuta en local `node epm-notifier.mjs --get-chat-id`; solo muestra el id, nunca el token).

En el repositorio: **Settings → Secrets and variables → Actions**.

| Nombre | Tipo | Obligatorio | Para qué sirve |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Secret | Sí | Token del bot |
| `TELEGRAM_CHAT_ID` | Secret | Sí | Chat del administrador (admite varios ids separados por coma; el primero es el administrador) |
| `STATE_KEY` | Secret | Sí | Clave para cifrar suscriptores y chats en la rama `state`. Genérala con `openssl rand -base64 32` y guárdala: **si cambia o se pierde, no se pueden descifrar** `subs`/`chats` y las suscripciones se pierden |
| `KEYWORDS` | Variable | No | Palabras clave separadas por coma; filtra por título/ubicación (sin tildes ni mayúsculas) |
| `PERFIL` | Variable | No | Perfil(es) para el filtro de los chats autorizados, p. ej. `sistemas` o `sistemas,civil` (ver [Perfiles](#perfiles-filtro-por-carrera)) |
| `TELEGRAM_WEBHOOK_SECRET`, `WEBHOOK_URL` | Secret | No | Respaldo del webhook: permiten al cron volver a registrarlo solo (ver [Respuesta rápida](#respuesta-rápida-con-cloudflare-worker)) |

Con la CLI de GitHub (te pide el valor sin mostrarlo):
```bash
gh secret set TELEGRAM_BOT_TOKEN
gh secret set TELEGRAM_CHAT_ID
gh secret set STATE_KEY
gh variable set KEYWORDS --body "ingeniero,sistemas"   # opcional
```
El Worker de Cloudflare tiene sus propios secretos (ver [Respuesta rápida](#respuesta-rápida-con-cloudflare-worker)).
Los secretos solo se pasan a los pasos que los necesitan (nunca a nivel de job completo) y GitHub los enmascara en los logs; además el script oculta el token y enmascara los chat ids en lo que imprime.

### Lanzarlo a mano y verificar que funciona

1. Ve a **Actions → EPM Notifier → Run workflow** (o `gh workflow run epm-notifier.yml` y `gh run watch`).
2. En la primera ejecución debe llegarte a Telegram **"✅ Notificador EPM activo"** y en el log verás `Primera ejecución: N ofertas registradas`. Aparece la rama `state` con un commit `state: update seen.json [skip ci]`.
3. Lánzalo una **segunda vez**: el log dice `Listado: N ofertas, 0 nuevas`, no llega ninguna notificación repetida y, si no hubo cambios, el paso de guardado imprime `Sin cambios de estado`.

4. Con el webhook activo, escribe `/start` al bot: debe llegar el menú en menos de un minuto y aparecer en **Actions** una ejecución disparada por `repository_dispatch`.

Para ver el estado guardado: `git fetch origin state && git show origin/state:seen.json`.

### Correrlo en local (pruebas)

```bash
cp .env.example .env              # rellena TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID
node epm-notifier.mjs --dry-run   # imprime en consola, no envía nada; usa seen.json.dry
node epm-notifier.mjs             # ejecución real
```
> ⚠️ Una ejecución real en local usa el **mismo bot**: lee los mensajes pendientes de Telegram y tiene su propio `seen.json`, así que puede duplicar notificaciones o atender comandos antes que el workflow. Para pruebas usa `--dry-run`. Con datos simulados: `EPM_MOCK_DIR=<carpeta>` lee `list-<offset>.json` y `detail-<id>.json` en vez de llamar a la API.

Variables de entorno (`.env` o entorno): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `KEYWORDS` (opcional), `STATE_FILE` (por defecto `./seen.json`), `PERFIL` (opcional) y `MAX_SUBS` (opcional).

### Limitaciones

- **Los schedules de GitHub no son exactos:** pueden retrasarse minutos, y más en horas pico. El mínimo permitido es 5 minutos; para ofertas laborales 30 minutos es suficiente.
- **Comandos y botones: 11–25 s por ejecución (mediana 15 s, medido el 2026-10-24)**, no instantáneos: es el arranque del job de Actions. Dentro del bot se avisa con el aviso de «procesando». Cada comando o botón es una ejecución de Actions: aparecen en la pestaña Actions y consumen sus [límites gratuitos](https://docs.github.com/actions/administering-github-actions/usage-limits-billing-and-administration) (en repos públicos los minutos son ilimitados, pero hay un máximo de trabajos simultáneos). Si el Worker o GitHub fallan, el cron recoge los pendientes (ver [Si el Worker falla](#si-el-worker-falla)).
- **Datos que pueden faltar:** la fecha límite y la audiencia solo vienen en el detalle de cada oferta. Si EPM no responde, la tarjeta sale con «No especificada» / «No determinado». «Dirigida a» es en parte una heurística (ver [Qué muestra cada oferta](#qué-muestra-cada-oferta)).
- **Alcance:** solo se vigila el sitio `CX_1` («EPM Sitio»): 12 de las 20 ofertas que expone la API el 2026-10-24. Los sitios privados y de filiales no se vigilan.
- **Límites gratuitos de Cloudflare:** el plan Workers Free permite un número diario de peticiones (consulta el límite vigente en la documentación de Cloudflare); este bot usa muy pocas. Además hay un límite propio por chat (8 updates cada 10 s) para evitar abusos.
- **Minutos de Actions:** en repos **públicos** son ilimitados. En repos **privados** hay 2.000 min gratis al mes y cada ejecución cuenta al menos 1 minuto; por eso son 30 minutos y no 15 o 20 (48 ejecuciones al día ≈ 1.440 min al mes).
- Si la API de EPM rechazara las IPs de GitHub, el job fallaría de forma visible y se avisaría por Telegram.

### Repositorio público: qué implica

- El código y la rama `state` son visibles para todos. La rama contiene solo ids de ofertas, un contador de Telegram y una fecha; los **suscriptores y chats van cifrados** (AES-256-CBC con PBKDF2) con `STATE_KEY`.
- Los **Secrets no son visibles** y no se pasan a *forks* ni a *pull requests* de terceros.
- Los **logs de Actions también son públicos**: por eso el script no imprime tokens ni chat ids completos (solo `***` y los 3 últimos dígitos). La update de Telegram tampoco pasa por `env:` (GitHub imprime ese bloque en el log): el script la lee del archivo del evento. Se verificó que los logs no contienen tokens, claves ni ids ni textos de usuarios.
- La URL del Worker no es un secreto, pero solo acepta peticiones con el header secreto correcto (cualquier otra recibe 401).

## Uso del bot: perfiles, suscripciones y comandos

### Perfiles (filtro por carrera)
```bash
node epm-notifier.mjs --perfil sistemas   # o PERFIL=sistemas en .env / variable de entorno
```
Perfiles disponibles: `sistemas`, `administracion`, `civil`, `electrica`, `mecanica`, `industrial`, `ambiental`, `financiera`, `juridica`, `talento`, `sst`, `comunicaciones`, `comercial` y `tecnico` (técnicos/tecnólogos/operarios). Se pueden combinar: `--perfil sistemas,civil`. Cada uno incluye términos afines (p. ej. `sistemas`: ingeniería de sistemas/informática/software, TI, desarrollador, datos, ciberseguridad, nube, telemática…) y los busca como palabra completa en título y descripción. Se combina con `KEYWORDS` (basta que cumpla una). Las ofertas que no pasan el filtro se marcan igualmente como vistas. Para añadir perfiles o términos, edita `PROFILES` en `epm-notifier.mjs`. En GitHub Actions crea la variable `PERFIL` (p. ej. `sistemas`); en cron añade `--perfil sistemas` al comando; en K3s usa `PERFIL: sistemas` en el Secret.

### Usuarios, suscripciones y grupos
Hay dos tipos de chats:

- **Público (cualquiera):** puede consultar (`/ofertas`, `/perfiles`, `/sistemas`…) y **suscribirse** con `/suscribir` (botón 🔔). Cada chat elige *todas las ofertas* o uno o varios perfiles y solo recibe lo suyo. Las suscripciones se guardan en `seen.json.subs` (solo el id del chat y los perfiles elegidos); si alguien bloquea el bot, su suscripción se elimina sola. Límite de suscriptores: `MAX_SUBS` (500 por defecto).
- **Administrador y chats autorizados:** `TELEGRAM_CHAT_ID` admite varios ids separados por coma y **el primero es el administrador** (tú). Los chats autorizados reciben todas las ofertas nuevas (respetando `--perfil`/`KEYWORDS` si los usas) y los avisos de error solo te llegan a ti.

**Grupo:** añade el bot al grupo. Cualquier miembro puede consultar y suscribir *el grupo* con los botones. Si como administrador escribes `/activar` en el grupo, queda autorizado (recibe todo); `/desactivar` lo quita.

**Administración** (solo tú, en privado con el bot): `/agregar <id>`, `/quitar <id>` y `/chats` (lista los autorizados y cuenta los suscriptores). Los autorizados añadidos así se guardan en `seen.json.chats`. Con GitHub Actions, `seen.json.subs` y `seen.json.chats` se guardan **cifrados** en la rama `state`; en K3s van en el PVC.

### Comandos de Telegram
Escríbele al bot: `/comandos` (menú), `/ofertas` (todas), `/perfiles`, `/suscribir`, `/sistemas` (ofertas abiertas de un perfil), `/ayuda`.
Con el webhook activo los comandos y botones se atienden en ~15–30 s (ver [Respuesta rápida](#respuesta-rápida-con-cloudflare-worker)). Sin webhook se atienden en cada ejecución del cron (~30 min), o al instante con `node epm-notifier.mjs --listen` (proceso siempre activo; no funciona mientras haya un webhook registrado).

## Alternativas de despliegue

GitHub Actions es la forma recomendada. Estas alternativas guardan su propio estado local (no lo comparten con la rama `state`): **no las uses a la vez que el workflow con el mismo bot**, porque se pelean por los mensajes de Telegram y duplican avisos. Si pruebas una, desactiva antes el workflow (Actions → EPM Notifier → *Disable workflow*) y el webhook (`node epm-notifier.mjs --delete-webhook`).

### Cron local (cada 20 min)
```cron
*/20 * * * * cd /ruta/a/EPM && /usr/bin/node epm-notifier.mjs >> notifier.log 2>&1
```

### K3s (y respuesta inmediata con `--listen`)
```bash
docker build -t epm-notifier:latest .
# K3s usa containerd: importa la imagen (o súbela a tu registro y ajusta k8s/cronjob.yaml)
docker save epm-notifier:latest | sudo k3s ctr images import -

kubectl create secret generic epm-notifier \
  --from-literal=TELEGRAM_BOT_TOKEN='...' --from-literal=TELEGRAM_CHAT_ID='...'
# (o copia k8s/secret.example.yaml a k8s/secret.yaml, edítalo y aplícalo)
kubectl apply -f k8s/pvc.yaml -f k8s/cronjob.yaml

kubectl create job --from=cronjob/epm-notifier epm-test   # ejecución manual
kubectl logs job/epm-notifier-test
```
El PVC (`/data/seen.json`) evita que lleguen ofertas repetidas tras cada ejecución. Con `local-path` (RWO) el job debe correr en el mismo nodo; `concurrencyPolicy: Forbid` evita solapes. Para responder a comandos y botones al instante, aplica `k8s/deployment.yaml` (ejecuta `--listen`: responde al momento y revisa ofertas cada 20 min) en lugar del CronJob.

## Seguridad
El token solo vive en GitHub Secrets (o en `.env` para pruebas locales). `.env` y `seen.json*` están en `.gitignore`: el estado nunca va a la rama `main`, solo a `state`. Los logs enmascaran el token y los chat ids. Si sospechas que el token se filtró, revócalo con @BotFather (`/revoke`) y actualiza el Secret. El token de GitHub del Worker es *fine-grained*, limitado a este repositorio, con el permiso mínimo (Contents: Read and write) y caducidad corta; los secretos del Worker se cargan con `wrangler secret put` y nunca van en el repositorio.

## Historial de cambios

- **2026-10-24 — Ofertas con título clicable, descripción breve, audiencia (servidores EPM / público general), fecha de publicación y fecha límite.** Una sola tarjeta para el botón de ofertas y para el aviso de oferta nueva, con fechas en hora de Bogotá, ofertas cerradas fuera del botón y una caché pública de audiencia y fechas en la rama `state`. Se corrigió un error del aviso de oferta nueva, que mostraba la fecha límite un día tarde por usarla en UTC.
- **2026-10-24 — Aviso de procesamiento:** aviso flotante en botones, «escribiendo…» en comandos y botones, y nota en el menú, enviados por el Worker antes de que arranque el job.
- **2026-10-24 — Respuesta rápida con Cloudflare Worker.** Se agregó un Worker de Cloudflare que recibe el webhook de Telegram y dispara el workflow con `repository_dispatch`: los comandos y botones pasan de responder en hasta ~30 minutos a **~15–30 segundos**, sin costo. El estado se guarda ahora de forma transaccional (una ejecución por update, reintento ante conflictos y deduplicación por `update_id`), y el cron de 30 minutos queda como respaldo y para los avisos de ofertas nuevas. Los logs de Actions ya no incluyen ids de chat ni comandos de usuarios.
- **2026-10-24 — Ejecución con GitHub Actions.** El bot dejó de depender de un computador encendido: corre en GitHub Actions cada 30 minutos y guarda el estado en la rama `state` (suscriptores y chats cifrados).
- **2026-10-24 — Suscripciones públicas y perfiles por cargo.** Cualquier persona puede consultar y suscribirse a todas las ofertas o a perfiles concretos; menú con botones, administración de grupos y aviso legal.
