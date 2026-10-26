// Contexto de una invocación: base de datos, bóveda de cifrado, cliente de Telegram con presupuesto de subpeticiones.
import { makeDb } from './db.js';
import { makeVault } from './crypto.js';
import { Budget, makeTg } from './telegram.js';

// needVault = false: el cron no cifra ni descifra nada, así que se ahorra derivar las claves (CPU del límite de 10 ms).
export async function makeContext(env, { cap = 45, needVault = true } = {}) {
  const db = makeDb(env);
  const vault = needVault ? await makeVault(env.STATE_KEY) : null;
  const budget = new Budget(cap);
  const tg = makeTg(env, { budget, stats: db.stats });
  const c = {
    env,
    db,
    vault,
    tg,
    budget,
    sentAny: false,
    now: () => Date.now(),
    // Envío con registro de "ya se envió algo" (si luego algo falla, no conviene reintentar y repetir mensajes).
    async send(chatId, html, kb) {
      const r = await tg.send(chatId, html, kb);
      c.sentAny = true;
      return r;
    },
  };
  return c;
}
