// Acceso a D1. Cada método usa pocas consultas (cada una cuesta ~0,35 ms de CPU y 20-45 ms de latencia) y cuenta
// filas leídas/escritas para el consumo diario. Todo lo que viene de la base se trata como no confiable (cleanLite...).
import { cleanLite } from './offer.js';

export const LIMIT_RE = /(daily|quota|exceed|limit)/i;
export const isLimitError = (e) => LIMIT_RE.test(String(e?.message || e));

export function makeDb(env) {
  const D = env.DB;
  const stats = { reads: 0, writes: 0, queries: 0, sends: 0, errors: 0, limit_hits: 0, updates: 0, cron_runs: 0 };
  const acct = (r) => {
    stats.queries++;
    stats.reads += r?.meta?.rows_read || 0;
    stats.writes += r?.meta?.rows_written || 0;
    return r;
  };
  const all = async (sql, ...args) => acct(await D.prepare(sql).bind(...args).all()).results;
  const first = async (sql, ...args) => (await all(sql, ...args))[0] ?? null;
  const run = async (sql, ...args) => acct(await D.prepare(sql).bind(...args).run());
  const batch = async (stmts) => {
    const rs = await D.batch(stmts);
    rs.forEach(acct);
    return rs;
  };
  const stmt = (sql, ...args) => D.prepare(sql).bind(...args);

  const db = {
    stats,
    // ---- meta ----
    async getMeta(k) {
      return (await first('SELECT v FROM meta WHERE k = ?', k))?.v ?? null;
    },
    async setMeta(k, v) {
      await run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v));
    },
    async getMetas(keys) {
      const rows = await all(`SELECT k, v FROM meta WHERE k IN (${keys.map(() => '?').join(',')})`, ...keys);
      return Object.fromEntries(rows.map((r) => [r.k, r.v]));
    },

    // ---- ofertas (datos públicos) ----
    async offers() {
      const rows = await all('SELECT id, job, lite, updated FROM offers');
      const out = [];
      for (const r of rows) {
        try {
          const job = JSON.parse(r.job);
          if (!job || typeof job !== 'object') continue;
          out.push({ id: r.id, job, lite: cleanLite(r.lite ? JSON.parse(r.lite) : null), updated: r.updated });
        } catch {
          // fila dañada: se ignora
        }
      }
      return out;
    },
    async putOffer(job, lite, now = Date.now()) {
      await run(
        'INSERT INTO offers (id, job, lite, updated) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET job = excluded.job, lite = excluded.lite, updated = excluded.updated',
        String(job.Id), JSON.stringify(job), lite ? JSON.stringify(lite) : null, now,
      );
    },
    putOfferStmt(job, lite, now = Date.now()) {
      return stmt(
        'INSERT INTO offers (id, job, lite, updated) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET job = excluded.job, lite = excluded.lite, updated = excluded.updated',
        String(job.Id), JSON.stringify(job), lite ? JSON.stringify(lite) : null, now,
      );
    },
    pruneOffersStmt(keepIds) {
      if (!keepIds.length) return stmt('DELETE FROM offers');
      return stmt(`DELETE FROM offers WHERE id NOT IN (${keepIds.map(() => '?').join(',')})`, ...keepIds);
    },

    // ---- vistas ----
    async seenRows() {
      return all('SELECT id, first_seen, status, attempts FROM seen');
    },
    seenClaimStmt(id, now, status = 'pending') {
      return stmt('INSERT OR IGNORE INTO seen (id, first_seen, status, attempts) VALUES (?, ?, ?, 0)', String(id), now, status);
    },
    async markSeenDone(id) {
      await run("UPDATE seen SET status = 'done' WHERE id = ?", String(id));
    },
    seenRetryStmt(id) {
      return stmt('UPDATE seen SET attempts = attempts + 1, first_seen = ? WHERE id = ?', Date.now(), String(id));
    },

    // ---- suscriptores (cifrados) ----
    async getSub(vault, chatId) {
      const hash = await vault.chatHash(chatId);
      const row = await first('SELECT enc, version FROM subs WHERE chat_hash = ?', hash);
      if (!row) return { hash, data: null, version: 0 };
      try {
        const data = await vault.open('subs', hash, row.enc);
        return { hash, data: normSub(data), version: row.version };
      } catch {
        return { hash, data: null, version: row.version, corrupt: true };
      }
    },
    // Cambio optimista: solo escribe si la versión no cambió. Devuelve true si se guardó.
    async putSub(vault, chatId, data, expectedVersion) {
      const hash = await vault.chatHash(chatId);
      const enc = await vault.seal('subs', hash, { chat: String(chatId), all: !!data.all, profiles: data.profiles });
      const now = Date.now();
      if (expectedVersion === 0) {
        const r = await run('INSERT OR IGNORE INTO subs (chat_hash, enc, version, updated) VALUES (?, ?, 1, ?)', hash, enc, now);
        return (r.meta?.changes || 0) === 1;
      }
      const r = await run('UPDATE subs SET enc = ?, version = version + 1, updated = ? WHERE chat_hash = ? AND version = ?', enc, now, hash, expectedVersion);
      return (r.meta?.changes || 0) === 1;
    },
    async deleteSubByHash(hash) {
      await run('DELETE FROM subs WHERE chat_hash = ?', hash);
    },
    async countSubs() {
      return (await first('SELECT COUNT(*) AS c FROM subs')).c;
    },
    // Páginas de suscriptores descifrados (el consumidor de la cola tiene CPU de sobra; 500 filas ≈ 5 ms).
    async subsPage(vault, afterHash, limit = 500) {
      const rows = await all('SELECT chat_hash, enc FROM subs WHERE chat_hash > ? ORDER BY chat_hash LIMIT ?', afterHash, limit);
      const out = [];
      for (const r of rows) {
        try {
          out.push({ hash: r.chat_hash, ...normSub(await vault.open('subs', r.chat_hash, r.enc)) });
        } catch {
          // fila ilegible (otra clave o dañada): se omite
        }
      }
      return { items: out, last: rows.length ? rows.at(-1).chat_hash : null, n: rows.length };
    },

    // ---- chats autorizados (cifrados) ----
    async isChatAuthorized(vault, chatId) {
      const hash = await vault.chatHash(chatId);
      return !!(await first('SELECT 1 AS x FROM chats WHERE chat_hash = ?', hash));
    },
    async addChat(vault, chatId) {
      const hash = await vault.chatHash(chatId);
      const enc = await vault.seal('chats', hash, { chat: String(chatId) });
      await run('INSERT OR IGNORE INTO chats (chat_hash, enc, added) VALUES (?, ?, ?)', hash, enc, Date.now());
    },
    async removeChat(vault, chatId) {
      await run('DELETE FROM chats WHERE chat_hash = ?', await vault.chatHash(chatId));
    },
    async chatsList(vault) {
      const rows = await all('SELECT chat_hash, enc FROM chats');
      const out = [];
      for (const r of rows) {
        try {
          out.push({ hash: r.chat_hash, chat: String((await vault.open('chats', r.chat_hash, r.enc)).chat) });
        } catch {
          // omitida
        }
      }
      return out;
    },
    // Descifra los chats de unos hashes (suscriptores y autorizados).
    async chatsByHashes(vault, hashes) {
      if (!hashes.length) return [];
      const ph = hashes.map(() => '?').join(',');
      const rows = await all(
        `SELECT chat_hash, enc, 'subs' AS src FROM subs WHERE chat_hash IN (${ph}) UNION ALL SELECT chat_hash, enc, 'chats' AS src FROM chats WHERE chat_hash IN (${ph})`,
        ...hashes, ...hashes,
      );
      const seen = new Set();
      const out = [];
      for (const r of rows) {
        if (seen.has(r.chat_hash)) continue;
        try {
          const o = await vault.open(r.src, r.chat_hash, r.enc);
          seen.add(r.chat_hash);
          out.push({ hash: r.chat_hash, chat: String(o.chat) });
        } catch {
          // omitida
        }
      }
      return out;
    },

    // ---- envíos (idempotencia) ----
    // Reclama (offer, hash) ANTES de enviar. Devuelve los hashes que este proceso debe enviar.
    async claimSent(offerId, hashes) {
      if (!hashes.length) return [];
      const now = Date.now();
      const rs = await batch(hashes.map((h) => stmt('INSERT OR IGNORE INTO sent (offer_id, chat_hash, ts) VALUES (?, ?, ?)', String(offerId), h, now)));
      return hashes.filter((_, i) => (rs[i].meta?.changes || 0) === 1);
    },
    async releaseSent(offerId, hashes) {
      if (!hashes.length) return;
      await batch(hashes.map((h) => stmt('DELETE FROM sent WHERE offer_id = ? AND chat_hash = ?', String(offerId), h)));
    },

    // ---- deduplicación de updates que cambian estado ----
    async claimApplied(updateId) {
      const r = await run('INSERT OR IGNORE INTO applied (update_id, ts) VALUES (?, ?)', updateId, Date.now());
      return (r.meta?.changes || 0) === 1;
    },
    async releaseApplied(updateId) {
      await run('DELETE FROM applied WHERE update_id = ?', updateId);
    },

    // ---- consumo y eventos ----
    async event(kind, detail = '') {
      stats.errors += kind === 'error' ? 1 : 0;
      await batch([
        stmt('INSERT INTO events (ts, kind, detail) VALUES (?, ?, ?)', Date.now(), kind, String(detail).slice(0, 200)),
        stmt('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - 200'),
      ]);
    },
    // Una sola escritura por invocación que ya escribe estado.
    async flushUsage() {
      const day = new Date().toISOString().slice(0, 10);
      await run(
        `INSERT INTO usage (day, updates, cron_runs, tg_sends, errors, limit_hits, d1_reads, d1_writes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET updates = updates + excluded.updates, cron_runs = cron_runs + excluded.cron_runs,
           tg_sends = tg_sends + excluded.tg_sends, errors = errors + excluded.errors, limit_hits = limit_hits + excluded.limit_hits,
           d1_reads = d1_reads + excluded.d1_reads, d1_writes = d1_writes + excluded.d1_writes + 1`,
        day, stats.updates, stats.cron_runs, stats.sends, stats.errors, stats.limit_hits, stats.reads, stats.writes,
      );
    },
    async usageRows(days = 2) {
      return all('SELECT * FROM usage ORDER BY day DESC LIMIT ?', days);
    },
    async recentEvents(n = 10) {
      return all('SELECT ts, kind, detail FROM events ORDER BY id DESC LIMIT ?', n);
    },

    // ---- mantenimiento y exportación ----
    async prune() {
      const now = Date.now();
      await batch([
        stmt('DELETE FROM sent WHERE ts < ?', now - 45 * 86400000),
        stmt('DELETE FROM applied WHERE ts < ?', now - 7 * 86400000),
        stmt("DELETE FROM usage WHERE day < date('now', '-90 days')"),
      ]);
    },
    async exportAll() {
      const [meta, seen, offers, subs, chats] = await Promise.all([
        all('SELECT k, v FROM meta'),
        all('SELECT id, first_seen, status, attempts FROM seen'),
        all('SELECT id, job, lite, updated FROM offers'),
        all('SELECT chat_hash, enc, version, updated FROM subs'),
        all('SELECT chat_hash, enc, added FROM chats'),
      ]);
      return { v: 1, at: new Date().toISOString(), meta, seen, offers, subs, chats };
    },
    stmt,
    batch,
    run,
    all,
    first,
  };
  return db;
}

function normSub(d) {
  const profiles = Array.isArray(d?.profiles) ? [...new Set(d.profiles.filter((p) => typeof p === 'string'))] : [];
  return { chat: String(d?.chat ?? ''), all: !!d?.all, profiles };
}
