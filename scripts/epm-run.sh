#!/usr/bin/env bash
# Ejecuta el notificador con el estado de la rama `state` y lo guarda de forma segura.
# Lo usa .github/workflows/epm-notifier.yml; con las variables adecuadas también sirve para probarlo en local.
#
#  - repository_dispatch (webhook de Telegram): una ejecución POR UPDATE, transaccional.
#      restaurar el estado más reciente -> aplicar la update (las respuestas quedan en cola, no se envían) ->
#      guardar con push -> SOLO si el push funcionó, enviar las respuestas.
#      Si el push es rechazado (otra ejecución guardó antes) se descarta todo y se repite sobre el estado nuevo:
#      así no hay respuestas duplicadas ni estado a medias. No se usa `git rebase`: los archivos cifrados son
#      binarios y no se pueden fusionar; reaplicar la update sobre el estado nuevo siempre es correcto.
#  - cron / manual: revisa ofertas nuevas. Sus archivos (seen.json, tgoffset, last_run) son solo suyos, así que
#      si el push choca con un webhook se parte del estado remoto y se reponen únicamente esos archivos.
#
# Estado en la rama `state`: seen.json, seen.json.tgoffset, seen.json.applied y last_run en claro;
# seen.json.subs.enc y seen.json.chats.enc CIFRADOS con STATE_KEY (el repositorio es público).
set -euo pipefail

REMOTE="${REMOTE:-origin}"
STATE_DIR="${STATE_DIR:-state-data}"
RUN_DIR="${RUN_DIR:-run}"
NODE_BIN="${NODE_BIN:-node}"
SCRIPT="${SCRIPT:-epm-notifier.mjs}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-8}"
TMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
EVENT="${GITHUB_EVENT_NAME:-schedule}"

PLAIN_FILES="seen.json seen.json.tgoffset seen.json.applied"
ENC_FILES="seen.json.subs seen.json.chats"
CRON_OWNED="seen.json seen.json.tgoffset last_run"

export STATE_FILE="${STATE_FILE:-$PWD/$RUN_DIR/seen.json}"
export OUTBOX_FILE="${OUTBOX_FILE:-$PWD/$RUN_DIR/outbox.json}"

die() {
  echo "::error::$*"
  exit 1
}
[ -n "${STATE_KEY:-}" ] || die "Falta el secret STATE_KEY (clave para cifrar suscriptores y chats). Ver README."

enc() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -pass env:STATE_KEY "$@"; }
jitter() { sleep $(((RANDOM % 4) + 1)); }

# Deja en $STATE_DIR el estado MÁS RECIENTE de la rama `state` (huérfana si no existe) y copias de trabajo en $RUN_DIR.
restore() {
  git worktree remove --force "$STATE_DIR" 2>/dev/null || true
  rm -rf "$STATE_DIR" "$RUN_DIR"
  git worktree prune
  if git ls-remote --exit-code --heads "$REMOTE" state >/dev/null 2>&1; then
    git fetch -q --depth=1 "$REMOTE" state
    git worktree add -q -f -B state "$STATE_DIR" FETCH_HEAD
  else
    echo "La rama 'state' no existe: se crea vacía (primera ejecución)."
    git worktree add -q --detach "$STATE_DIR"
    git -C "$STATE_DIR" checkout -q --orphan state
    git -C "$STATE_DIR" rm -rfq . || true
  fi

  mkdir -p "$RUN_DIR"
  for f in $PLAIN_FILES; do
    if [ -f "$STATE_DIR/$f" ]; then cp "$STATE_DIR/$f" "$RUN_DIR/$f"; fi
  done
  for f in $ENC_FILES; do
    if [ -f "$STATE_DIR/$f.enc" ]; then
      enc -d -in "$STATE_DIR/$f.enc" -out "$RUN_DIR/$f" \
        || die "No se pudo descifrar $f (¿STATE_KEY distinta a la usada al guardar?)"
    fi
  done
}

# Copia el resultado a $STATE_DIR y hace commit. Devuelve 0 si hubo commit y 10 si no cambió nada.
# $1 = mensaje, $2 = 1 para actualizar el latido diario (last_run).
commit_state() {
  for f in $PLAIN_FILES; do
    if [ -f "$RUN_DIR/$f" ]; then cp "$RUN_DIR/$f" "$STATE_DIR/$f"; fi
  done
  # Se vuelve a cifrar solo si el contenido cambió (el cifrado usa sal aleatoria: evita commits inútiles).
  for f in $ENC_FILES; do
    [ -f "$RUN_DIR/$f" ] || continue
    if [ -f "$STATE_DIR/$f.enc" ] \
      && enc -d -in "$STATE_DIR/$f.enc" -out "$TMP/previous" 2>/dev/null \
      && cmp -s "$TMP/previous" "$RUN_DIR/$f"; then
      continue
    fi
    enc -salt -in "$RUN_DIR/$f" -out "$STATE_DIR/$f.enc"
  done
  rm -f "$TMP/previous"

  # Latido diario: mantiene actividad en el repo para que GitHub no desactive el schedule (60 días sin actividad).
  if [ "${2:-0}" = 1 ]; then date -u +%F >"$STATE_DIR/last_run"; fi
  if [ ! -f "$STATE_DIR/README.md" ]; then
    printf '%s\n' \
      "# Estado del notificador" \
      "" \
      "Rama generada automáticamente por el workflow. No editar a mano." \
      "- seen.json: ids de ofertas ya vistas." \
      "- seen.json.tgoffset: último mensaje de Telegram leído (modo sin webhook)." \
      "- seen.json.applied: últimos update_id aplicados (evita aplicar dos veces un cambio)." \
      "- *.enc: suscriptores y chats, cifrados." \
      "- last_run: fecha de la última ejecución." \
      >"$STATE_DIR/README.md"
  fi

  git -C "$STATE_DIR" config user.name "github-actions[bot]"
  git -C "$STATE_DIR" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git -C "$STATE_DIR" add -A
  if git -C "$STATE_DIR" diff --cached --quiet; then return 10; fi
  git -C "$STATE_DIR" commit -q -m "$1"
}

push_state() { git -C "$STATE_DIR" push -q "$REMOTE" HEAD:state 2>"$TMP/push.err"; }

webhook_mode() {
  local attempt rc pushed=0
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    restore
    "$NODE_BIN" "$SCRIPT" --webhook # si falla, el job falla y no se guarda nada
    rc=0
    commit_state "state: apply update [skip ci]" 0 || rc=$?
    if [ "$rc" -eq 10 ]; then # la update no cambió el estado (consulta de solo lectura): no hay nada que guardar
      pushed=1
      break
    fi
    [ "$rc" -eq 0 ] || exit "$rc"
    if push_state; then
      pushed=1
      break
    fi
    echo "Conflicto al guardar el estado (intento $attempt/$MAX_ATTEMPTS): otra ejecución guardó antes. Se reaplica sobre el estado nuevo."
    jitter
  done
  [ "$pushed" -eq 1 ] || die "No se pudo guardar el estado tras $MAX_ATTEMPTS intentos ($(tail -n 1 "$TMP/push.err" 2>/dev/null || true))"
  # Estado guardado con éxito: ahora sí se envían las respuestas.
  "$NODE_BIN" "$SCRIPT" --flush-outbox "$OUTBOX_FILE"
}

cron_mode() {
  local attempt rc
  restore
  "$NODE_BIN" "$SCRIPT" # si falla, el job falla y no se guarda estado a medias
  rc=0
  commit_state "state: update seen.json [skip ci]" 1 || rc=$?
  if [ "$rc" -eq 10 ]; then
    echo "Sin cambios de estado."
    return 0
  fi
  [ "$rc" -eq 0 ] || exit "$rc"

  for attempt in $(seq 1 5); do
    if push_state; then return 0; fi
    echo "Conflicto al guardar el estado (intento $attempt/5): un webhook guardó antes. Se parte del estado remoto."
    rm -rf "$TMP/keep"
    mkdir -p "$TMP/keep"
    for f in $CRON_OWNED; do
      if [ -f "$STATE_DIR/$f" ]; then cp "$STATE_DIR/$f" "$TMP/keep/$f"; fi
    done
    git -C "$STATE_DIR" fetch -q --depth=1 "$REMOTE" state
    git -C "$STATE_DIR" reset -q --hard FETCH_HEAD
    for f in $CRON_OWNED; do
      if [ -f "$TMP/keep/$f" ]; then cp "$TMP/keep/$f" "$STATE_DIR/$f"; fi
    done
    git -C "$STATE_DIR" add -A
    if git -C "$STATE_DIR" diff --cached --quiet; then return 0; fi
    git -C "$STATE_DIR" commit -q -m "state: update seen.json [skip ci]"
    jitter
  done
  die "No se pudo guardar el estado tras 5 intentos ($(tail -n 1 "$TMP/push.err" 2>/dev/null || true))"
}

mkdir -p "$TMP"
case "$EVENT" in
  repository_dispatch) webhook_mode ;;
  *) cron_mode ;;
esac
