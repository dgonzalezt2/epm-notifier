# Notificador de ofertas EPM → Telegram

Consulta la API REST pública de Oracle HCM que usa la página de empleo de EPM y avisa por Telegram de las ofertas nuevas. Node.js 20+, sin dependencias.

## Cómo se ve

El bot (`/start` o `/comandos`) explica qué hace y ofrece un menú con botones.

| Menú de inicio | Todas las ofertas | Elegir cómo filtrar |
|---|---|---|
| <img src="docs/screenshots/start.png" alt="Menú de inicio" width="260"> | <img src="docs/screenshots/ofertas.png" alt="Lista de ofertas abiertas" width="260"> | <img src="docs/screenshots/perfiles.png" alt="Perfiles: por carrera o por cargo" width="260"> |

| Por carrera / área | Por cargo / nivel | Ayuda |
|---|---|---|
| <img src="docs/screenshots/perfilesCarrera.png" alt="Perfiles por carrera" width="260"> | <img src="docs/screenshots/perfilesCargo.png" alt="Perfiles por cargo y resultado" width="260"> | <img src="docs/screenshots/ayuda.png" alt="Ayuda y comandos" width="260"> |

## Cómo funciona
- `GET /hcmRestApi/resources/latest/recruitingCEJobRequisitions` (finder `findReqs`, con paginación) lista las ofertas; `recruitingCEJobRequisitionDetails` da el detalle.
- Compara con los IDs de `seen.json`. **Primera ejecución**: guarda las existentes sin notificar y envía "Notificador EPM activo".
- Todas las ofertas del listado se marcan como vistas, también las que no pasan `KEYWORDS`.
- El estado se guarda (de forma atómica) después de cada oferta enviada. Si algo falla a mitad, la oferta fallida se reintenta en la siguiente ejecución y las ya enviadas no se repiten.
- Los errores se imprimen y se mandan a Telegram (sin fallar si Telegram también cae). Reintentos con backoff para red/5xx/429.

## 1. Crear el bot
1. En Telegram habla con **@BotFather** → `/newbot` → copia el token.
2. `cp .env.example .env` y pon `TELEGRAM_BOT_TOKEN`.

## 2. Obtener el chat id
- **Chat personal**: escríbele cualquier mensaje a tu bot y ejecuta `node epm-notifier.mjs --get-chat-id`. Imprime `TELEGRAM_CHAT_ID=...` (nunca el token).
- **Canal**: añade el bot como administrador, publica algo y ejecuta el mismo comando (el id empieza por `-100`).

Ponlo en `.env`.

## 3. Ejecutar
```bash
node epm-notifier.mjs             # ejecución normal
node epm-notifier.mjs --dry-run   # imprime en consola, no envía; usa seen.json.dry
```
Configuración (`.env` o variables de entorno): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `KEYWORDS` (opcional, p. ej. `ingeniero,sistemas`; ignora tildes y mayúsculas, filtra por título/ubicación), `STATE_FILE` (por defecto `./seen.json`).

### Perfiles (filtro por carrera)
```bash
node epm-notifier.mjs --perfil sistemas   # o PERFIL=sistemas en .env / variable de entorno
```
Perfiles disponibles: `sistemas`, `administracion`, `civil`, `electrica`, `mecanica`, `industrial`, `ambiental`, `financiera`, `juridica`, `talento`, `sst`, `comunicaciones`, `comercial` y `tecnico` (técnicos/tecnólogos/operarios). Se pueden combinar: `--perfil sistemas,civil`. Cada uno incluye términos afines (p. ej. `sistemas`: ingeniería de sistemas/informática/software, TI, desarrollador, datos, ciberseguridad, nube, telemática…) y los busca como palabra completa en título y descripción. Se combina con `KEYWORDS` (basta que cumpla una). Las ofertas que no pasan el filtro se marcan igualmente como vistas. Para añadir perfiles o términos, edita `PROFILES` en `epm-notifier.mjs`. En cron añade `--perfil sistemas` al comando; en K3s usa `PERFIL: sistemas` en el Secret.

### Usarlo en un grupo o con otras personas
`TELEGRAM_CHAT_ID` admite varios ids separados por coma; **el primero es el administrador** (tú). Las ofertas nuevas se envían a todos los chats autorizados y los comandos funcionan en cualquiera de ellos.

**Grupo:**
1. Añade el bot al grupo (en @BotFather puedes dejar `/setjoingroups` activado).
2. En el grupo, escribe `/activar` **siendo tú el administrador**. El grupo queda autorizado y no hace falta reiniciar.
3. Cualquier miembro puede usar `/comandos`, `/ofertas` y `/perfiles` allí. `/desactivar` lo quita.

**Otra persona (chat privado):**
1. Que le escriba `/start` al bot: recibirá "Este chat no tiene acceso" con su **ID**.
2. Tú, en tu chat privado con el bot, escribes `/agregar <id>`. `/quitar <id>` la elimina y `/chats` lista los autorizados.

Los chats añadidos así se guardan en `seen.json.chats` (junto al estado; en K3s va en el PVC). Los avisos de error solo te llegan a ti. Todos los chats reciben las mismas ofertas nuevas (el filtro `--perfil` es global); cada persona puede consultar su perfil con `/perfiles`.

### Comandos de Telegram
Escríbele al bot: `/sistemas` (ofertas abiertas del perfil), `/ofertas` (todas), `/ayuda`. Solo responde al `TELEGRAM_CHAT_ID` configurado.
- **Con cron/CronJob** los comandos se atienden en cada ejecución (hasta 20 min de retraso).
- **Respuesta inmediata**: `node epm-notifier.mjs --listen` queda activo, responde al instante y revisa ofertas nuevas cada 20 min (no uses cron a la vez). En K3s aplica `k8s/deployment.yaml` en lugar del CronJob.

Para probar con datos simulados: `EPM_MOCK_DIR=<carpeta>` lee `list-<offset>.json` y `detail-<id>.json` en vez de llamar a la API.

## 4a. Programar con cron (cada 20 min)
```cron
*/20 * * * * cd /ruta/a/EPM && /usr/bin/node epm-notifier.mjs >> notifier.log 2>&1
```

## 4b. K3s
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
El PVC (`/data/seen.json`) evita que lleguen ofertas repetidas tras cada ejecución. Con `local-path` (RWO) el job debe correr en el mismo nodo; `concurrencyPolicy: Forbid` evita solapes.

## Seguridad
El token solo vive en `.env` / Secret. `.env` y `seen.json` están en `.gitignore` y los logs enmascaran el token.
