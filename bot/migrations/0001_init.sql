-- Esquema D1 del bot EPM. Solo datos públicos de ofertas en claro; chats y suscripciones, cifrados (AES-GCM).

-- Banderas y marcas de control: live ('0' hasta el corte), cmds (versión del menú registrado), last_cron, epm_fail...
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- Ofertas ya vistas por el cron. status: 'pending' (en proceso) | 'done'. Evita avisar una oferta dos veces.
CREATE TABLE IF NOT EXISTS seen (
  id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',
  attempts INTEGER NOT NULL DEFAULT 0
);

-- Caché de datos PÚBLICOS de cada oferta: subconjunto del listado (job) y datos del detalle (lite) en JSON.
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  lite TEXT,
  updated INTEGER NOT NULL
);

-- Suscriptores. chat_hash = HMAC del chat id; enc = {chat, all, profiles} cifrado. version permite cambios optimistas.
CREATE TABLE IF NOT EXISTS subs (
  chat_hash TEXT PRIMARY KEY,
  enc TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated INTEGER NOT NULL
);

-- Chats autorizados (reciben todas las ofertas nuevas), cifrados igual que los suscriptores.
CREATE TABLE IF NOT EXISTS chats (
  chat_hash TEXT PRIMARY KEY,
  enc TEXT NOT NULL,
  added INTEGER NOT NULL
);

-- Un aviso por oferta y destinatario: se reclama la fila ANTES de enviar.
CREATE TABLE IF NOT EXISTS sent (
  offer_id TEXT NOT NULL,
  chat_hash TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (offer_id, chat_hash)
) WITHOUT ROWID;

-- update_id de comandos que cambian estado (deduplicación).
CREATE TABLE IF NOT EXISTS applied (
  update_id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL
);

-- Consumo diario (solo actividad que escribe estado; las peticiones totales se ven en el panel de Cloudflare).
CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  updates INTEGER NOT NULL DEFAULT 0,
  cron_runs INTEGER NOT NULL DEFAULT 0,
  tg_sends INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  limit_hits INTEGER NOT NULL DEFAULT 0,
  d1_reads INTEGER NOT NULL DEFAULT 0,
  d1_writes INTEGER NOT NULL DEFAULT 0
);

-- Errores y avisos de límites, sin datos de usuarios (rotativa, ~200 filas).
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);

-- Hasta el corte, el cron del Worker no avisa nada.
INSERT OR IGNORE INTO meta (k, v) VALUES ('live', '0');
