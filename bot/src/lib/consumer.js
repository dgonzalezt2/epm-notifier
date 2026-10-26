// Consumidor de la cola: el trabajo pesado (el CPU del consumidor no está limitado a 10 ms) y el reparto de avisos.
// Cada mensaje se procesa en su propia invocación (max_batch_size = 1), con su propio presupuesto de subpeticiones.
import { fetchDetail } from './epm.js';
import { liteFromDetail, jobFromListing, buildNewOfferMessage } from './offer.js';
import { matchingProfiles } from './profiles.js';
import { isClosed } from './dates.js';
import { isGone, TelegramError } from './telegram.js';
import { adminId } from './handlers.js';
import { doBackup } from './backup.js';
import { JOB_ID_RE } from './util.js';

const CHUNK = 35; // avisos por mensaje de cola (cabe en las 50 subpeticiones de una invocación)
const HEX32 = /^[0-9a-f]{32}$/;

export class RetryLater extends Error {
  constructor(msg, delaySeconds = 30) {
    super(msg);
    this.delaySeconds = delaySeconds;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const k = next++;
        if (k >= items.length) return;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

async function processOffer(c, b) {
  const { env, db, vault, budget } = c;
  if (!JOB_ID_RE.test(String(b.id)) || !b.job) return;
  const id = String(b.id);
  const job = jobFromListing({ ...b.job, Id: id });
  const detail = await fetchDetail(env, id, { budget }); // si EPM falla, la cola reintenta
  if (!detail) throw new RetryLater('detalle vacío', 60);
  const lite = liteFromDetail(detail);
  await db.putOffer(job, lite);
  if (!b.notify) return;

  if (isClosed(lite, c.now())) {
    await db.markSeenDone(id);
    await db.event('info', `oferta ${id} ya cerrada: no se avisa`);
    return;
  }
  const html = buildNewOfferMessage(job, detail, c.now());
  const matched = new Set(matchingProfiles(job));

  // Destinatarios: chats autorizados + suscriptores cuyo perfil coincide (+ administrador).
  const recipients = new Set();
  for (const x of await db.chatsList(vault)) recipients.add(x.hash);
  let after = '';
  for (let page = 0; page < 20; page++) {
    const p = await db.subsPage(vault, after, 500);
    for (const s of p.items) if (s.all || s.profiles.some((x) => matched.has(x))) recipients.add(s.hash);
    if (p.n < 500) break;
    after = p.last;
  }
  const adminHash = await vault.chatHash(adminId(env));
  recipients.delete(adminHash);
  const hashes = [...recipients];

  const messages = [];
  for (let i = 0; i < Math.max(1, hashes.length); i += CHUNK) {
    messages.push({ body: { t: 'notify', offer: id, html, hashes: hashes.slice(i, i + CHUNK), admin: i === 0 } });
  }
  for (let i = 0; i < messages.length; i += 100) await env.JOBS.sendBatch(messages.slice(i, i + 100));
  await db.markSeenDone(id);
}

async function processNotify(c, b) {
  const { env, db, vault, tg } = c;
  if (!JOB_ID_RE.test(String(b.offer)) || typeof b.html !== 'string' || !Array.isArray(b.hashes)) return;
  const hashes = b.hashes.filter((h) => HEX32.test(h));
  const adm = adminId(env);
  const adminHash = b.admin && adm ? await vault.chatHash(adm) : null;

  // Se reclama (oferta, destinatario) ANTES de enviar: un reintento nunca repite un aviso ya enviado.
  const mine = await db.claimSent(b.offer, adminHash ? [adminHash, ...hashes] : hashes);
  const todo = [];
  if (adminHash && mine.includes(adminHash)) todo.push({ hash: adminHash, chat: adm });
  const rows = await db.chatsByHashes(vault, mine.filter((h) => h !== adminHash));
  todo.push(...rows);

  const failed = [];
  let wait = 0;
  await mapLimit(todo, 6, async (t) => {
    try {
      await tg.send(t.chat, b.html);
    } catch (e) {
      if (isGone(e)) {
        // Bloqueó el bot, borró su cuenta... se elimina su suscripción; el claim se conserva (no se reintenta).
        await db.deleteSubByHash(t.hash).catch(() => {});
        await db.event('info', 'suscriptor inaccesible: suscripción eliminada').catch(() => {});
      } else {
        failed.push(t.hash);
        if (e instanceof TelegramError && e.retryAfter) wait = Math.max(wait, e.retryAfter);
      }
    }
  });
  if (failed.length) {
    await db.releaseSent(b.offer, failed); // se podrán reintentar sin duplicar a quienes ya recibieron el aviso
    throw new RetryLater(`${failed.length} avisos sin enviar`, Math.max(wait, Number(env.RETRY_MIN_SECONDS ?? 30)));
  }
}

// Procesa un mensaje. Lanza RetryLater (o cualquier error) para que la cola lo reintente.
export async function consume(c, msg) {
  const b = msg.body;
  if (b?.t === 'offer') return processOffer(c, b);
  if (b?.t === 'notify') return processNotify(c, b);
  if (b?.t === 'backup') return doBackup(c);
}
