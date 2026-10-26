// Bot EPM -> Telegram en un único Cloudflare Worker (plan gratuito) con D1.
//
//   Telegram --POST--> fetch()  : valida el secreto, procesa la update y responde (D1 + Telegram), en ~0,3-0,6 s
//   Cron */30         > scheduled(): consulta EPM, detecta ofertas nuevas y las encola
//   Cola              > queue()    : detalle de la oferta, tarjeta y reparto de avisos (CPU holgada, 50 envíos por mensaje)
//
// Secretos (wrangler secret put): TELEGRAM_BOT_TOKEN, WEBHOOK_SECRET, STATE_KEY, TELEGRAM_CHAT_ID y, opcional, GH_BACKUP_TOKEN.
// Este archivo no escribe en logs tokens, chat ids ni texto de usuarios.
import { sameSecret } from './lib/crypto.js';
import { makeContext } from './lib/context.js';
import { handleUpdate } from './lib/handlers.js';
import { runCron } from './lib/cron.js';
import { consume, RetryLater } from './lib/consumer.js';
import { isLimitError } from './lib/db.js';
import { BudgetError, makeTg } from './lib/telegram.js';

const MAX_BODY = 64 * 1024;
const CHAT_TYPES = new Set(['private', 'group', 'supergroup']);

// ---------- límite por chat (best-effort: vive en la memoria de cada instancia) ----------
// 8 updates cada 10 s por chat y 150 en total: evita que alguien dispare miles de invocaciones con un chat.
const WINDOW_MS = 10_000;
const PER_CHAT = 8;
const GLOBAL = 150;
const hits = new Map();
let globalHits = [];
export function limited(chatId, now) {
  globalHits = globalHits.filter((t) => now - t < WINDOW_MS);
  const own = (hits.get(chatId) || []).filter((t) => now - t < WINDOW_MS);
  if (globalHits.length >= GLOBAL || own.length >= PER_CHAT) {
    hits.set(chatId, own);
    return true;
  }
  own.push(now);
  globalHits.push(now);
  hits.set(chatId, own);
  if (hits.size > 5000) for (const k of hits.keys()) if (!hits.get(k).length) hits.delete(k);
  return false;
}

// ---------- saneado: solo comandos y pulsaciones de botón, con la update mínima ----------
const isInt = (x) => Number.isSafeInteger(x);
const chatOf = (c) => (c && isInt(c.id) && CHAT_TYPES.has(c.type) ? { id: c.id, type: c.type } : null);
export function slimUpdate(u) {
  if (!u || !isInt(u.update_id)) return null;
  if (u.message) {
    const m = u.message;
    const chat = chatOf(m.chat);
    if (!chat || typeof m.text !== 'string' || !m.text.startsWith('/')) return null;
    return { update_id: u.update_id, message: { chat, from: isInt(m.from?.id) ? { id: m.from.id } : undefined, text: m.text.slice(0, 256) } };
  }
  if (u.callback_query) {
    const q = u.callback_query;
    const chat = chatOf(q.message?.chat);
    if (!chat || typeof q.id !== 'string' || typeof q.data !== 'string' || !isInt(q.message?.message_id)) return null;
    return {
      update_id: u.update_id,
      callback_query: {
        id: q.id.slice(0, 64),
        data: q.data.slice(0, 64),
        from: isInt(q.from?.id) ? { id: q.from.id } : undefined,
        message: { message_id: q.message.message_id, chat },
      },
    };
  }
  return null;
}

const reply = (status, body = '', extra = {}) =>
  new Response(body, { status, headers: { ...(status === 405 ? { Allow: 'POST' } : {}), ...extra } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// Aviso al usuario cuando se alcanza un límite gratuito (D1, subpeticiones): sin bucles de reintento.
const LIMIT_TEXT = '⚠️ El servicio llegó a su límite diario gratuito. Se restablece a las 00:00 UTC (7:00 p. m. en Colombia); vuelve a intentarlo después.';

async function handleWebhook(request, env, ctx) {
  // 1) Autenticación ANTES de leer el cuerpo y de tocar nada más: barata y en tiempo constante.
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!env.WEBHOOK_SECRET || !(await sameSecret(got, env.WEBHOOK_SECRET))) return reply(401);

  // 2) Cuerpo acotado y JSON válido.
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return reply(413);
  let update;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return reply(413);
    update = JSON.parse(text);
  } catch {
    return reply(400);
  }

  // 3) Solo lo que usa el bot (lo demás: 200 para que Telegram no lo reintente).
  const slim = slimUpdate(update);
  if (!slim) return reply(200, 'ignored');

  // 4) Límite por chat.
  const chat = (slim.message?.chat || slim.callback_query.message.chat).id;
  if (limited(chat, Date.now())) {
    // Un botón sin respuesta se queda con la "ruedita": se avisa con un texto corto (una sola llamada, sin tocar D1).
    if (slim.callback_query) ctx.waitUntil(makeTg(env).answer(slim.callback_query.id, '⏳ Demasiado rápido: espera unos segundos').catch(() => {}));
    return reply(200, 'rate-limited');
  }

  // 5) Procesar. Se responde 200 DESPUÉS de procesar: si algo falla antes de enviar nada, 5xx y Telegram reintenta.
  let c;
  try {
    c = await makeContext(env);
    c.db.stats.updates = 1;
    await handleUpdate(c, slim);
    if (c.db.stats.writes > 0) ctx.waitUntil(c.db.flushUsage().catch(() => {}));
    // Contadores de D1 de esta petición (sin datos): sirven para medir y vigilar el consumo frente a los límites diarios.
    const st = c.db.stats;
    return reply(200, 'ok', { 'x-d1': `reads=${st.reads};writes=${st.writes};queries=${st.queries};sends=${st.sends}` });
  } catch (e) {
    const limit = isLimitError(e) || e instanceof BudgetError;
    // Si ya se envió algo, no se reintenta (repetiría mensajes). Tampoco se reintenta un límite diario (no se arregla antes de las 00:00 UTC).
    if (limit && c && !c.sentAny) await c.tg.send(chat, LIMIT_TEXT).catch(() => {});
    if (c) {
      c.db.stats.errors += 1;
      if (limit) c.db.stats.limit_hits += 1;
      // Se registra el evento (solo el tipo de error: el mensaje podría contener datos) y el contador diario.
      ctx.waitUntil(c.db.event(limit ? 'limit' : 'error', e?.name || 'Error').then(() => c.db.flushUsage()).catch(() => {}));
    }
    console.error('webhook:', e?.name || 'Error');
    return limit || c?.sentAny ? reply(200, 'handled') : reply(500);
  }
}

// ---------- administración (mismo secreto que el webhook; solo cuenta datos, nunca ids) ----------
async function handleAdmin(request, env, url) {
  const tok = request.headers.get('x-admin-token') || '';
  if (!env.WEBHOOK_SECRET || !(await sameSecret(tok, env.WEBHOOK_SECRET))) return reply(401);
  const c = await makeContext(env, { needVault: false });
  if (url.pathname === '/admin/status') {
    const n = async (t) => (await c.db.first(`SELECT COUNT(*) AS c FROM ${t}`)).c;
    const [meta, usage, events] = await Promise.all([c.db.getMetas(['live', 'cmds', 'epm_fail', 'last_backup']), c.db.usageRows(3), c.db.recentEvents(10)]);
    return json({
      meta,
      counts: { seen: await n('seen'), offers: await n('offers'), subs: await n('subs'), chats: await n('chats'), sent: await n('sent') },
      usage,
      events: events.map((e) => ({ ts: e.ts, kind: e.kind, detail: e.detail })),
    });
  }
  if (url.pathname === '/admin/tick') return json(await runCron(c, { dry: url.searchParams.get('dry') === '1', forceBackup: url.searchParams.get('backup') === '1' }));
  return reply(404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/admin/')) return handleAdmin(request, env, url);
    if (request.method !== 'POST') return reply(405);
    if (url.pathname !== '/') return reply(404);
    return handleWebhook(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const c = await makeContext(env, { needVault: false });
        try {
          await runCron(c);
        } catch (e) {
          const limit = isLimitError(e) || e instanceof BudgetError;
          await c.db.event(limit ? 'limit' : 'error', `cron: ${e?.name || 'Error'}`).catch(() => {});
          console.error('cron:', e?.name || 'Error');
        }
      })(),
    );
  },

  async queue(batch, env) {
    for (const msg of batch.messages) {
      const c = await makeContext(env);
      try {
        await consume(c, msg);
        msg.ack();
        if (c.db.stats.writes > 0) await c.db.flushUsage().catch(() => {});
      } catch (e) {
        const limit = isLimitError(e) || e instanceof BudgetError;
        console.error('cola:', e?.name || 'Error');
        // Un límite diario no se arregla reintentando enseguida: se espera más.
        const delay = e instanceof RetryLater ? e.delaySeconds : limit ? 3600 : Number(env.RETRY_DELAY_SECONDS ?? 60);
        if (msg.attempts >= 4) await c.db.event('error', `mensaje descartado (${msg.body?.t || '?'}): ${e?.name || 'Error'}`).catch(() => {});
        msg.retry({ delaySeconds: delay });
      }
    }
  },
};
