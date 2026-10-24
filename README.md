# Notificador de ofertas EPM → Telegram

[![EPM Notifier](https://github.com/dgonzalezt2/epm-notifier/actions/workflows/epm-notifier.yml/badge.svg)](https://github.com/dgonzalezt2/epm-notifier/actions/workflows/epm-notifier.yml)

Consulta la API REST pública de Oracle HCM que usa la página de empleo de EPM y avisa por Telegram de las ofertas nuevas. Node.js 20+, sin dependencias. Se ejecuta con **GitHub Actions** cada 30 minutos, sin servidores ni depender de ningún computador encendido.

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
> ⏱️ El bot no corre de forma permanente: GitHub Actions lo ejecuta cada 30 minutos. Los avisos de ofertas nuevas y las respuestas a los botones pueden tardar hasta ~30 minutos (ver [Cómo funciona](#cómo-funciona)).

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

## Cómo funciona

El bot **no corre de forma permanente**. [GitHub Actions](.github/workflows/epm-notifier.yml) lo ejecuta automáticamente **cada 30 minutos** (cron). En cada ejecución:

1. **Restaura el estado** desde la rama `state`.
2. **Atiende** los mensajes y botones que llegaron a Telegram desde la ejecución anterior.
3. **Consulta la API de EPM** (`recruitingCEJobRequisitions`, con paginación) y compara con los ids ya vistos.
4. **Notifica por Telegram** las ofertas nuevas: a los chats autorizados y a los suscriptores, según el perfil que eligieron. Por cada oferta pide el detalle (`recruitingCEJobRequisitionDetails`) y envía título, ubicación, fecha, resumen, requisitos y enlace.
5. **Guarda el estado** en la rama `state`, solo si todo terminó bien.

Por eso funciona aunque mi computador esté apagado: Telegram solo entrega mensajes, el código lo ejecuta GitHub.

- **Primera ejecución** (sin `seen.json`): guarda las ofertas existentes **sin notificarlas** y envía "Notificador EPM activo".
- Todas las ofertas del listado se marcan como vistas, también las que no pasan `KEYWORDS`.
- Si hay un error (HTTP, parseo, Telegram), se imprime y se avisa al administrador por Telegram. Hay reintentos con *backoff* para errores de red, 5xx y 429.
- **Si el script falla, el job falla de forma visible** (código ≠ 0) y **no se guarda estado**: nunca queda un `seen.json` a medias.
- `concurrency` impide que corran dos ejecuciones a la vez y `timeout-minutes: 5` corta las que se cuelgan.

### El estado vive en la rama `state`

Es una rama huérfana que crea y actualiza el propio workflow (no se edita a mano). No se usa `actions/cache` porque se borra tras 7 días sin uso.

| Archivo | Contenido | En el repo público |
|---|---|---|
| `seen.json` | ids de ofertas ya vistas | en claro |
| `seen.json.tgoffset` | último mensaje de Telegram procesado | en claro |
| `seen.json.subs.enc` | suscriptores (chat ids y perfiles) | **cifrado** |
| `seen.json.chats.enc` | chats autorizados | **cifrado** |
| `last_run` | fecha de la última ejecución | en claro |

`last_run` se actualiza como máximo una vez al día: así el repositorio mantiene actividad y GitHub no desactiva el schedule por inactividad (60 días).

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

Con la CLI de GitHub (te pide el valor sin mostrarlo):
```bash
gh secret set TELEGRAM_BOT_TOKEN
gh secret set TELEGRAM_CHAT_ID
gh secret set STATE_KEY
gh variable set KEYWORDS --body "ingeniero,sistemas"   # opcional
```
Los secretos solo se pasan a los pasos que los necesitan (nunca a nivel de job completo) y GitHub los enmascara en los logs; además el script oculta el token y enmascara los chat ids en lo que imprime.

### Lanzarlo a mano y verificar que funciona

1. Ve a **Actions → EPM Notifier → Run workflow** (o `gh workflow run epm-notifier.yml` y `gh run watch`).
2. En la primera ejecución debe llegarte a Telegram **"✅ Notificador EPM activo"** y en el log verás `Primera ejecución: N ofertas registradas`. Aparece la rama `state` con un commit `state: update seen.json [skip ci]`.
3. Lánzalo una **segunda vez**: el log dice `Listado: N ofertas, 0 nuevas`, no llega ninguna notificación repetida y, si no hubo cambios, el paso de guardado imprime `Sin cambios de estado`.

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
- **Respuesta a comandos y botones con retraso:** el bot solo "escucha" cuando corre el workflow, así que `/ofertas`, `/perfiles` o *Suscribirme* pueden tardar hasta ~30 minutos en responder (Telegram conserva los mensajes pendientes 24 horas). Para respuesta inmediata necesitas un proceso siempre activo (ver [alternativas](#alternativas-de-despliegue)).
- **Minutos de Actions:** en repos **públicos** son ilimitados. En repos **privados** hay 2.000 min gratis al mes y cada ejecución cuenta al menos 1 minuto; por eso son 30 minutos y no 15 o 20 (48 ejecuciones al día ≈ 1.440 min al mes).
- Si la API de EPM rechazara las IPs de GitHub, el job fallaría de forma visible y se avisaría por Telegram.

### Repositorio público: qué implica

- El código y la rama `state` son visibles para todos. La rama contiene solo ids de ofertas, un contador de Telegram y una fecha; los **suscriptores y chats van cifrados** (AES-256-CBC con PBKDF2) con `STATE_KEY`.
- Los **Secrets no son visibles** y no se pasan a *forks* ni a *pull requests* de terceros.
- Los **logs de Actions también son públicos**: por eso el script no imprime tokens ni chat ids completos (solo `***` y los 3 últimos dígitos).

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
Con GitHub Actions los comandos y botones se atienden en cada ejecución (cada ~30 min). Si necesitas respuesta inmediata, usa `node epm-notifier.mjs --listen` (proceso siempre activo, ver abajo).

## Alternativas de despliegue

GitHub Actions es la forma recomendada. Estas alternativas guardan su propio estado local (no lo comparten con la rama `state`): **no las uses a la vez que el workflow con el mismo bot**, porque se pelean por los mensajes de Telegram y duplican avisos. Si pruebas una, desactiva antes el workflow (Actions → EPM Notifier → *Disable workflow*).

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
El token solo vive en GitHub Secrets (o en `.env` para pruebas locales). `.env` y `seen.json*` están en `.gitignore`: el estado nunca va a la rama `main`, solo a `state`. Los logs enmascaran el token y los chat ids. Si sospechas que el token se filtró, revócalo con @BotFather (`/revoke`) y actualiza el Secret.
