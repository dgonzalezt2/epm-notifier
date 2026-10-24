// Cloudflare Worker: recibe el webhook de Telegram y dispara el workflow de GitHub con repository_dispatch.
//
//   Telegram --POST--> Worker --repository_dispatch--> GitHub Actions --> responde por Telegram
//
// Secrets (wrangler secret put): WEBHOOK_SECRET (el mismo secret_token de setWebhook) y GH_DISPATCH_TOKEN
// (token fine-grained limitado a este repositorio). Este archivo no escribe NADA en logs: ni tokens ni mensajes.

const MAX_BODY = 64 * 1024;
const CHAT_TYPES = new Set(['private', 'group', 'supergroup']);

// Límite por chat (best-effort: vive en la memoria de cada instancia del Worker). Evita que alguien dispare
// cientos de ejecuciones con un chat. 8 updates cada 10 s permite pulsar varios botones seguidos.
const WINDOW_MS = 10_000;
const PER_CHAT = 8;
const GLOBAL = 150;
const hits = new Map();
let globalHits = [];

function limited(chatId, now) {
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

const isInt = (x) => Number.isSafeInteger(x);
const chatOf = (c) => (c && isInt(c.id) && CHAT_TYPES.has(c.type) ? { id: c.id, type: c.type } : null);

// Reduce la update a lo que usa el bot: comandos ("/...") y pulsaciones de botón. Todo lo demás se descarta.
export function slimUpdate(u) {
  if (!u || !isInt(u.update_id)) return null;
  if (u.message) {
    const m = u.message;
    const chat = chatOf(m.chat);
    if (!chat || typeof m.text !== 'string' || !m.text.startsWith('/')) return null;
    return {
      update_id: u.update_id,
      message: { chat, from: isInt(m.from?.id) ? { id: m.from.id } : undefined, text: m.text.slice(0, 256) },
    };
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

// Comparación en tiempo constante (compara los hashes SHA-256, que siempre miden lo mismo).
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// Devuelve { ok, status, message }. ok = GitHub aceptó el evento (204). Un reintento solo ante fallos de red, 5xx o 429.
// status/message (códigos HTTP y texto público de GitHub, nunca secretos) sirven para diagnosticar un 502.
async function dispatch(env, update) {
  const url = `${env.GITHUB_API || 'https://api.github.com'}/repos/${env.GITHUB_REPO}/dispatches`;
  let last = { ok: false, status: 0, message: 'sin respuesta de GitHub' };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'epm-notifier-webhook',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ event_type: 'telegram_update', client_payload: { update } }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 204) return { ok: true, status: 204, message: '' };
      let message = '';
      try {
        message = String((await res.json()).message || '').slice(0, 120);
      } catch {
        // cuerpo no JSON
      }
      last = { ok: false, status: res.status, message };
      if (res.status < 500 && res.status !== 429) return last; // 401/403/404/422: reintentar no sirve
    } catch {
      last = { ok: false, status: 0, message: 'red caída o timeout' };
    }
  }
  return last;
}

const reply = (status, body = '') => new Response(body, { status, headers: status === 405 ? { Allow: 'POST' } : undefined });

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return reply(405);

    // 1) Autenticación ANTES de leer el cuerpo: sin el secret correcto no se hace nada más.
    const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (!env.WEBHOOK_SECRET || !(await sameSecret(got, env.WEBHOOK_SECRET))) return reply(401);

    // 2) Cuerpo acotado y JSON válido.
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > MAX_BODY) return reply(413);
    let update;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return reply(413);
      update = JSON.parse(text);
    } catch {
      return reply(400);
    }

    // 3) Solo lo que usa el bot. Lo demás se responde 200 para que Telegram no lo reintente.
    const slim = slimUpdate(update);
    if (!slim) return reply(200, 'ignored');

    // 4) Límite por chat: se descarta el exceso (200, sin reintento).
    const chatId = (slim.message?.chat || slim.callback_query.message.chat).id;
    if (limited(chatId, Date.now())) return reply(200, 'rate-limited');

    // 5) Se ESPERA a GitHub: si falla se responde 502 y Telegram reintenta la entrega (el script deduplica por update_id).
    const r = await dispatch(env, slim);
    return r.ok ? reply(200, 'ok') : reply(502, `dispatch failed: HTTP ${r.status} ${r.message}`.trim());
  },
};
