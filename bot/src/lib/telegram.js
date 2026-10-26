// Cliente mínimo de la API de Telegram (fetch nativo) con control de subpeticiones.
// El plan gratuito permite 50 `fetch` por invocación: Budget corta antes de que Cloudflare lo haga a la fuerza.
export class BudgetError extends Error {
  constructor() {
    super('presupuesto de subpeticiones agotado');
    this.name = 'BudgetError';
  }
}
export class Budget {
  constructor(cap = 45) {
    this.cap = cap;
    this.n = 0;
  }
  use() {
    if (++this.n > this.cap) throw new BudgetError();
  }
  get left() {
    return Math.max(0, this.cap - this.n);
  }
}

export class TelegramError extends Error {
  constructor(method, status, description, retryAfter = 0) {
    super(`Telegram ${method}: HTTP ${status} ${description}`);
    this.name = 'TelegramError';
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}
// El destinatario ya no puede recibir (bloqueó el bot, borró la cuenta, sacaron al bot del grupo...).
export const isGone = (e) =>
  e instanceof TelegramError && (e.status === 403 || /chat not found|bot was blocked|user is deactivated|kicked|not a member|upgraded to a supergroup/i.test(e.description));

export function makeTg(env, { budget = new Budget(), stats = null } = {}) {
  const base = env.TELEGRAM_API || 'https://api.telegram.org';
  async function call(method, payload) {
    budget.use();
    let res;
    try {
      res = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      // el mensaje no incluye la URL (llevaría el token)
      throw new TelegramError(method, 0, e?.name === 'TimeoutError' ? 'timeout' : 'red');
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.ok === false) throw new TelegramError(method, res.status, String(j.description || '').slice(0, 160), Number(j.parameters?.retry_after) || 0);
    return j.result;
  }
  return {
    call,
    async send(chatId, html, keyboard = null) {
      const r = await call('sendMessage', {
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
      if (stats) stats.sends++;
      return r;
    },
    edit(chatId, messageId, html, keyboard) {
      return call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      });
    },
    answer(callbackId, text = '') {
      return call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) });
    },
    typing(chatId) {
      return call('sendChatAction', { chat_id: chatId, action: 'typing' });
    },
  };
}
