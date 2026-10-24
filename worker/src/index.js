// Cloudflare Worker: recibe el webhook de Telegram y dispara el workflow de GitHub con repository_dispatch.
//
//   Telegram --POST--> Worker --repository_dispatch--> GitHub Actions --> responde por Telegram
//
// Secrets (wrangler secret put): WEBHOOK_SECRET (el mismo secret_token de setWebhook), GH_DISPATCH_TOKEN
// (token fine-grained limitado a este repositorio) y TELEGRAM_BOT_TOKEN (solo para el aviso de "procesando").
// Este archivo no escribe NADA en logs: ni tokens ni mensajes.

// Aviso de "procesando": el job de Actions tarda ~15 s en arrancar y responder, así que el Worker avisa al instante.
const WAIT_TEXT = '⏳ Procesando… puede tardar unos segundos, ten paciencia';
const TYPING_REPEAT_MS = 4500; // "escribiendo…" dura ~5 s: se repite una vez

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
async function dispatch(env, eventType, clientPayload) {
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
        body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
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

// Llamada a Telegram "dispara y olvida": cualquier error se ignora para no alterar la respuesta del Worker.
async function telegram(env, method, payload) {
  try {
    await fetch(`${env.TELEGRAM_API || 'https://api.telegram.org'}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // sin red, timeout o rate limit: no importa, la respuesta real la envía el job
  }
}

// Un comando como "/start@otrobot" va dirigido a otro bot (grupos): se reenvía como siempre, pero sin aviso.
function targetsOtherBot(text, env) {
  const m = /^\/[A-Za-z0-9_]+@([A-Za-z0-9_]+)/.exec(text);
  return !!m && !!env.BOT_USERNAME && m[1].toLowerCase() !== env.BOT_USERNAME.toLowerCase();
}

// Botones: aviso flotante (answerCallbackQuery) + "escribiendo…". Comandos: solo "escribiendo…".
// La ruedita del botón se quita al responder el callback; por eso el texto del aviso explica la espera.
async function feedback(env, slim) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const q = slim.callback_query;
  if (!q && targetsOtherBot(slim.message.text, env)) return;
  const chatId = q ? q.message.chat.id : slim.message.chat.id;
  const typing = () => telegram(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  await Promise.all([
    q ? telegram(env, 'answerCallbackQuery', { callback_query_id: q.id, text: WAIT_TEXT, show_alert: false }) : null,
    typing(),
  ]);
  await new Promise((resolve) => setTimeout(resolve, TYPING_REPEAT_MS));
  await typing();
}

const reply = (status, body = '') => new Response(body, { status, headers: status === 405 ? { Allow: 'POST' } : undefined });

export default {
  async fetch(request, env, ctx) {
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

    // 5) Aviso de "procesando" EN PARALELO al dispatch: no lo retrasa ni cambia el resultado. Va en waitUntil solo para
    //    que las llamadas a Telegram terminen tras responder; el dispatch NO depende de waitUntil.
    ctx.waitUntil(feedback(env, slim).catch(() => {}));

    // 6) Se ESPERA a GitHub: si falla se responde 502 y Telegram reintenta la entrega (el script deduplica por update_id).
    const r = await dispatch(env, 'telegram_update', { update: slim });
    return r.ok ? reply(200, 'ok') : reply(502, `dispatch failed: HTTP ${r.status} ${r.message}`.trim());
  },

  // Disparador de respaldo (Cron Trigger de Cloudflare, ver wrangler.toml): el schedule de GitHub no es fiable, así que
  // este "tick" lanza el workflow de ofertas nuevas. Usa el mismo token (repository_dispatch con event_type propio).
  // Si coincide con el cron de GitHub no pasa nada: ambos comparten grupo de concurrency y seen.json evita avisos repetidos.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatch(env, 'cron_tick', { source: 'cloudflare-cron' }).then(() => {}, () => {}));
  },
};
