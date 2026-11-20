// Comandos, botones, suscripciones y administración. Cada update se procesa de forma idempotente:
//  - los cambios de suscripción son absolutos ("activar X"/"desactivar X"), no alternancias, y solo escriben si cambian algo;
//  - antes de escribir se reclama el update_id (si ya se aplicó, no se repite) y se libera si algo falla;
//  - las escrituras usan control de versión (compare-and-swap) para que dos pulsaciones simultáneas no se pisen.
import { esc, MAX_MSG, maskId, sleep } from './util.js';
import { PROFILES, CARGO_PROFILES, profileLabel, areaProfiles, jobMatchesProfile } from './profiles.js';
import { formatOffer, jobFromListing } from './offer.js';
import { isClosed } from './dates.js';
import { fetchListing } from './epm.js';
import { isGone } from './telegram.js';
import { formatGepm, gepmAsJob, GEPM_URL, fmtWhen } from './gepm.js';

const btn = (text, data) => ({ text, callback_data: data });
const mainMenu = () => [
  [btn('📋 Ofertas', 'ofertas'), btn('🎯 Perfiles', 'perfiles')],
  [btn('🏢 GrupoEPM', 'gepm'), btn('🔔 Suscribirme', 'suscribir')],
  [btn('❓ Ayuda', 'ayuda')],
];
const profilesMenu = () => [[btn('🎓 Por carrera / área', 'areas')], [btn('🧱 Por cargo / nivel', 'cargos')], [btn('⬅️ Menú', 'comandos')]];
const profileGrid = (names) => {
  const rows = [];
  for (let i = 0; i < names.length; i += 2) rows.push(names.slice(i, i + 2).map((p) => btn(profileLabel(p), p)));
  rows.push([btn('⬅️ Perfiles', 'perfiles'), btn('Menú', 'comandos')]);
  return rows;
};
const backToMenu = () => [[btn('⬅️ Menú', 'comandos')]];
const backMenu = () => [[btn('🎯 Perfiles', 'perfiles'), btn('⬅️ Menú', 'comandos')]];
const shortLabel = (p) => profileLabel(p).replace(/^\S+\s/, '');

export const adminId = (env) => String(env.TELEGRAM_CHAT_ID || '').split(',')[0].trim();
const MAX_SUBS = (env) => Number(env.MAX_SUBS) || 500;

// ---------- suscripciones ----------
// `gepm`: avisos de convocatorias nuevas de la Fundación EPM (GrupoEPM). Apagado por defecto; va dentro del mismo registro cifrado.
const emptySub = (chat) => ({ chat: String(chat), all: false, profiles: [], gepm: false });
const sameSub = (a, b) => a.all === b.all && !!a.gepm === !!b.gepm && a.profiles.length === b.profiles.length && a.profiles.every((p) => b.profiles.includes(p));
const isEmpty = (s) => !s.all && !s.profiles.length && !s.gepm;

function subSummary(sub) {
  if (!sub || isEmpty(sub)) return 'Ahora mismo no recibes avisos.';
  const g = sub.gepm ? 'Recibes también las convocatorias nuevas de <b>GrupoEPM</b> (Fundación EPM).' : '';
  if (sub.all) return 'Recibes <b>todas</b> las ofertas nuevas.' + (g ? '\n' + g : '');
  if (!sub.profiles.length) return g;
  return `Recibes las ofertas nuevas de: ${sub.profiles.map((p) => esc(shortLabel(p))).join(', ')}.` + (g ? '\n' + g : '');
}
// Los botones llevan el estado DESEADO (…:1 activar, …:0 quitar), así pulsar dos veces el mismo botón no lo deshace por accidente.
function subscribeMenu(sub) {
  const s = sub || emptySub('');
  const mark = (on) => (on ? '✅ ' : '');
  const rows = [[btn(`${mark(s.all)}📣 Todas las ofertas nuevas`, `sub:all:${s.all ? 0 : 1}`)]];
  const names = Object.keys(PROFILES);
  for (let i = 0; i < names.length; i += 2) {
    rows.push(names.slice(i, i + 2).map((p) => btn(`${mark(s.profiles.includes(p))}${profileLabel(p)}`, `sub:${p}:${s.profiles.includes(p) ? 0 : 1}`)));
  }
  rows.push([btn(`${mark(s.gepm)}🏢 Avisos GrupoEPM (Fundación EPM)`, `sub:gepm:${s.gepm ? 0 : 1}`)]);
  rows.push([btn('🔕 Cancelar avisos', 'unsub'), btn('⬅️ Menú', 'comandos')]);
  return rows;
}

// Interpreta el comando de suscripción. Devuelve una función que transforma la suscripción, o null si no es válido.
//  sub:<perfil>:1|0  /  sub:all:1|0  (absolutos)    sub:<perfil>  /  sub:all  (alternar: botones de mensajes antiguos)    unsub
export function subMutation(cmd) {
  if (cmd === 'unsub') return () => ({ all: false, profiles: [], gepm: false });
  const m = /^sub:([a-z]+)(?::([01]))?$/.exec(cmd);
  if (!m) return null;
  const [, what, want] = m;
  if (what !== 'all' && what !== 'gepm' && !PROFILES[what]) return null;
  return (s) => {
    const has = what === 'all' ? s.all : what === 'gepm' ? !!s.gepm : s.profiles.includes(what);
    const on = want === undefined ? !has : want === '1';
    if (what === 'all') return { ...s, all: on };
    if (what === 'gepm') return { ...s, gepm: on };
    return { ...s, profiles: on ? [...new Set([...s.profiles, what])] : s.profiles.filter((p) => p !== what) };
  };
}

async function changeSub(c, chatId, updateId, mutate) {
  const { db, vault, env } = c;
  let claimed = false;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt) await sleep(Math.floor(Math.random() * 25 * attempt)); // espera aleatoria: reduce choques entre escritores
      const cur = await db.getSub(vault, chatId);
      const base = cur.data ?? emptySub(chatId);
      const next = mutate({ ...base, profiles: [...base.profiles] });
      if (sameSub(base, next)) return { sub: base, changed: false }; // sin cambios: no se escribe nada
      if (cur.version === 0 && !isEmpty(next) && (await db.countSubs()) >= MAX_SUBS(env)) return { sub: base, full: true };
      if (!claimed) {
        claimed = await db.claimApplied(updateId);
        if (!claimed) return { sub: base, dup: true }; // update ya aplicada antes: no se repite
      }
      let ok;
      if (isEmpty(next)) {
        const r = await db.run('DELETE FROM subs WHERE chat_hash = ? AND version = ?', cur.hash, cur.version);
        ok = (r.meta?.changes || 0) === 1 || cur.version === 0;
      } else ok = await db.putSub(vault, chatId, next, cur.version);
      if (ok) return { sub: isEmpty(next) ? null : next, changed: true };
    }
    return { sub: (await db.getSub(vault, chatId)).data, conflict: true };
  } catch (e) {
    if (claimed) await db.releaseApplied(updateId).catch(() => {});
    throw e;
  }
}

async function showSubscription(c, chatId, messageId, sub, note = '') {
  const text = `🔔 <b>Avisos de ofertas nuevas</b>\n${subSummary(sub)}${note}\n\nToca para activar o quitar (✅ = activo). Puedes elegir varios perfiles.`;
  const kb = subscribeMenu(sub);
  if (messageId) {
    try {
      return await c.tg.edit(chatId, messageId, text, kb);
    } catch (e) {
      if (/message is not modified/i.test(e.description || '')) return;
      // el mensaje ya no se puede editar: se envía uno nuevo
    }
  }
  return c.send(chatId, text, kb);
}

// ---------- ofertas ----------
const startMs = (r) => Date.parse(r.lite?.start || r.job.PostedDate) || 0;

// `withGepm` (solo los filtros de Perfiles): añade, DESPUÉS de las ofertas del portal, las convocatorias vigentes de GrupoEPM que
// cumplen el mismo filtro, con la misma regla de visibilidad que el botón 🏢 GrupoEPM (gepm_mode = test | live, para cualquier chat).
export async function sendOffers(c, chatId, label, filter = () => true, { withGepm = false } = {}) {
  const { db, env, tg, budget } = c;
  let rows = await db.offers();
  if (!rows.length) {
    // Caché vacía (recién desplegado): se consulta EPM directamente, sin detalle.
    await tg.typing(chatId).catch(() => {});
    try {
      rows = (await fetchListing(env, { budget, timeout: 10000 })).map((j) => ({ id: String(j.Id), job: jobFromListing(j), lite: null }));
    } catch {
      return c.send(chatId, '⚠️ No pude consultar las ofertas ahora. Intenta de nuevo en un rato.', mainMenu());
    }
  }
  rows = rows.filter((r) => filter(r.job)).sort((a, b) => startMs(b) - startMs(a) || Number(b.id) - Number(a.id));
  const now = c.now();
  const open = rows.filter((r) => !isClosed(r.lite, now));
  const closed = rows.length - open.length;
  const note = closed ? `\nℹ️ ${closed} oferta(s) cerrada(s) no se muestran.` : '';
  const gepm = withGepm ? (await db.gepmOpenIfActive(now)).filter((r) => filter(gepmAsJob(r))) : [];
  if (!open.length && !gepm.length) return c.send(chatId, `No hay ofertas abiertas para <b>${esc(label)}</b> en este momento.${note}`, backMenu());

  const cards = open.map((r) => formatOffer(r.job, r.lite, { now }));
  if (gepm.length) {
    // El rótulo del bloque va pegado a su primera tarjeta (nunca queda huérfano al final de un mensaje).
    const cardsG = gepm.map((r) => formatGepm(r, { now, tag: true }));
    cardsG[0] = `━━━━━━━━━━\n🏢 <b>GRUPO EPM</b>: ${gepm.length} convocatoria(s) vigente(s) de la Fundación EPM\n\n${cardsG[0]}`;
    cards.push(...cardsG);
  }
  const header = open.length ? `📋 <b>${esc(label)}</b>: ${open.length} oferta(s) abierta(s)\n` : `📋 <b>${esc(label)}</b>\n`;
  return sendCards(c, chatId, header, cards, note, backMenu(), '…hay más ofertas de las que caben aquí. Usa /perfiles para filtrar.');
}

// Envía tarjetas agrupadas en mensajes de ≤ MAX_MSG caracteres (se parten ENTRE tarjetas: nunca se corta un enlace ni una entidad).
// Respeta el presupuesto de subpeticiones; el teclado va en el último mensaje.
async function sendCards(c, chatId, header, cards, note, kb, moreText) {
  const chunks = [];
  let msg = header;
  for (const card of cards) {
    const piece = '\n' + card + '\n';
    if (msg.length + piece.length > MAX_MSG) {
      chunks.push(msg);
      msg = '';
    }
    msg += piece;
  }
  if (note) {
    if (msg.length + note.length > MAX_MSG) {
      chunks.push(msg);
      msg = '';
    }
    msg += note;
  }
  chunks.push(msg);
  const maxMsgs = Math.max(1, Math.min(chunks.length, c.budget.left - 2));
  for (let i = 0; i < maxMsgs; i++) await c.send(chatId, chunks[i], i === maxMsgs - 1 ? kb : null);
  if (maxMsgs < chunks.length) await c.send(chatId, moreText, kb);
}

// ---------- GrupoEPM: convocatorias de la Fundación EPM (leídas de la caché en D1, nunca de la página en vivo) ----------
const gepmMenu = (on) => [
  [btn(on ? '🔕 Quitar avisos GrupoEPM' : '🔔 Avisos GrupoEPM', `sub:gepm:${on ? 0 : 1}`)],
  [btn('📋 Ofertas EPM', 'ofertas'), btn('⬅️ Menú', 'comandos')],
];
const GEPM_LINK = `<a href="${GEPM_URL}">página oficial de la Fundación EPM</a>`;

export async function showGepm(c, chatId) {
  const { db } = c;
  const meta = await db.getMetas(['gepm_mode', 'gepm_ok', 'gepm_fail']);
  const head = '🏢 <b>GrupoEPM — convocatorias de la Fundación EPM</b>';
  const on = !!(await db.getSub(c.vault, chatId)).data?.gepm;
  if (meta.gepm_mode !== 'test' && meta.gepm_mode !== 'live') {
    return c.send(chatId, `${head}\nEsta sección aún no está activa. Cuando lo esté, aquí verás las convocatorias vigentes.`, backToMenu());
  }
  const now = c.now();
  const lastOk = Number(meta.gepm_ok) || 0;
  const rows = await db.gepmOpen(now);
  const notes = [];
  if (meta.gepm_mode !== 'live') notes.push('ℹ️ Los avisos automáticos de GrupoEPM aún no están activos; se enviarán cuando se habiliten.');
  if (lastOk && Number(meta.gepm_fail) >= 2 && now - lastOk > 3 * 3600_000) notes.push(`⚠️ No he podido actualizar la lista desde ${esc(fmtWhen(lastOk))} (hora de Bogotá); esto es lo último que pude leer.`);
  const note = notes.length ? '\n' + notes.join('\n') : '';
  if (!lastOk && !rows.length) {
    return c.send(chatId, `${head}\nTodavía no he podido leer la ${GEPM_LINK}. Inténtalo de nuevo más tarde.${note}`, gepmMenu(on));
  }
  if (!rows.length) {
    return c.send(chatId, `${head}\nNo hay convocatorias vigentes en este momento. Las ya cerradas no se muestran.\nÚltima revisión: ${esc(fmtWhen(lastOk))} (hora de Bogotá). Consulta la ${GEPM_LINK}.${note}`, gepmMenu(on));
  }
  const foot = `\nLas postulaciones se hacen siempre en el enlace de cada convocatoria (proyecto no oficial). ${GEPM_LINK}.${note}`;
  return sendCards(c, chatId, `${head}: ${rows.length} vigente(s)\n`, rows.map((r) => formatGepm(r, { now })), foot, gepmMenu(on), '…hay más convocatorias de las que caben aquí.');
}

// ---------- comandos ----------
export async function handleCommand(c, cmd, chat, ctx2 = {}) {
  const chatId = chat.id;
  if (cmd === 'comandos' || cmd === 'menu' || cmd === 'start') {
    return c.send(
      chatId,
      [
        '👋 <b>Bot de ofertas de empleo EPM</b>',
        'Reviso la página de empleo de EPM (Empresas Públicas de Medellín) y te aviso por aquí cuando salen ofertas nuevas.',
        '',
        '<b>¿En qué te puedo ayudar?</b>',
        '📋 <b>Ofertas</b> — ver todas las ofertas abiertas ahora',
        '🎯 <b>Perfiles</b> — filtrar por tu carrera (sistemas, civil, financiera…) o por cargo (profesional, tecnólogo, técnico…) y saber si hay algo para ti',
        '🏢 <b>GrupoEPM</b> — convocatorias vigentes de la Fundación EPM (otra fuente distinta del portal de empleo), con la opción de recibir avisos de las nuevas',
        '🔔 <b>Suscribirme</b> — recibir un aviso automático (cargo, ubicación, requisitos y enlace) cuando EPM publique ofertas nuevas, de todo o solo de tus perfiles',
        '❓ <b>Ayuda</b> — lista de comandos',
        '',
        'ℹ️ <i>Proyecto personal y educativo, no oficial ni afiliado a EPM. Las postulaciones se hacen en la página de empleo de EPM.</i>',
      ].join('\n'),
      mainMenu(),
    );
  }
  if (cmd === 'perfiles') return c.send(chatId, '🎯 <b>Elige cómo filtrar</b>\nTe digo si hay ofertas abiertas para tu perfil:', profilesMenu());
  if (cmd === 'areas') return c.send(chatId, '🎓 <b>Carrera / área</b>\nElige una:', profileGrid(areaProfiles()));
  if (cmd === 'cargos') return c.send(chatId, '🧱 <b>Cargo / nivel</b>\nElige uno:', profileGrid(CARGO_PROFILES));
  if (cmd === 'gepm' || cmd === 'grupoepm') return showGepm(c, chatId);
  if (cmd === 'suscribir') return showSubscription(c, chatId, ctx2.messageId, (await c.db.getSub(c.vault, chatId)).data);
  if (cmd === 'ayuda' || cmd === 'help') {
    return c.send(
      chatId,
      [
        '<b>Comandos</b>',
        '/comandos — menú con botones',
        '/ofertas — todas las ofertas abiertas',
        '/grupoepm — convocatorias vigentes de la Fundación EPM',
        '/perfiles — filtrar por carrera o por cargo',
        '/suscribir — elegir qué avisos de ofertas nuevas recibir',
        '/ayuda — esta ayuda',
        '',
        `También puedes escribir el perfil directo: ${Object.keys(PROFILES).map((p) => '/' + p).join(' ')}`,
      ].join('\n'),
      mainMenu(),
    );
  }
  if (cmd === 'ofertas') return sendOffers(c, chatId, 'Todas las ofertas');
  if (PROFILES[cmd]) return sendOffers(c, chatId, `Perfil ${shortLabel(cmd)}`, (job) => jobMatchesProfile(job, cmd), { withGepm: true });
  return c.send(chatId, 'Comando no reconocido. Usa /comandos.', mainMenu());
}

// ---------- administración ----------
async function handleAdmin(c, cmd, rest, chat, isAdmin) {
  const { db, vault, env } = c;
  const reply = (t, kb = null) => c.send(chat.id, t, kb);
  const deny = async (t) => (await reply(t), true);
  if (cmd === 'activar' || cmd === 'desactivar') {
    if (!isAdmin) return deny('Solo el administrador puede hacer esto.');
    if (chat.type === 'private') return deny('Usa este comando dentro de un grupo donde esté el bot.');
    if (cmd === 'activar') {
      await db.addChat(vault, chat.id);
      await reply('✅ Grupo activado. Recibirá las ofertas nuevas y cualquiera aquí puede usar /comandos.', mainMenu());
    } else {
      await db.removeChat(vault, chat.id);
      await reply('🔕 Grupo desactivado.');
    }
    return true;
  }
  if (cmd === 'gepmodo' || cmd === 'gepmprueba') {
    // Cualquier otro chat (usuarios, grupos, incluso el administrador desde un grupo) recibe lo mismo que un comando desconocido:
    // ni se confirma que existan estos comandos.
    if (!isAdmin || chat.type !== 'private') return false;
    if (cmd === 'gepmprueba') {
      const id = (rest[0] || '').trim();
      // Tres casos distintos: formato inválido, caché vacía (aún no hubo ninguna revisión) y convocatoria que no está.
      if (!/^\d{3}-\d{2}$/.test(id)) return deny('Uso: /gepmprueba NNN-AA (por ejemplo, <code>025-26</code>).');
      const row = await db.gepmRow(id);
      if (!row) {
        const n = (await db.first('SELECT COUNT(*) AS n FROM gepm'))?.n ?? 0;
        return deny(n ? `No encuentro la convocatoria <code>${esc(id)}</code> en la caché.` : 'Aún no hay convocatorias en la caché (la primera revisión se hace en la próxima hora).');
      }
      await reply('🧪 <i>Vista previa del aviso (solo para ti):</i>');
      await reply(formatGepm(row, { isNew: true, now: c.now() }));
      return true;
    }
    const want = (rest[0] || '').toLowerCase();
    if (want) {
      if (!['off', 'test', 'live'].includes(want)) return deny('Uso: /gepmodo off | test | live');
      await db.setMeta('gepm_mode', want);
      if (want !== 'off') await db.setMeta('gepm_next', '0'); // que el próximo cron encole una revisión ya
      await reply(
        want === 'live'
          ? '🟢 GrupoEPM en modo <b>live</b>: las convocatorias nuevas se avisan a quienes activaron los avisos.'
          : want === 'test'
            ? '🧪 GrupoEPM en modo <b>test</b>: se revisa y guarda la página; los avisos salen solo a ti.'
            : '⚫ GrupoEPM <b>apagado</b>: no se revisa la página ni se avisa nada.',
      );
      return true;
    }
    const m = await db.getMetas(['gepm_mode', 'gepm_ok', 'gepm_fail', 'gepm_next']);
    const cnt = await db.first("SELECT COUNT(*) AS n, SUM(notify = 'pending') AS p FROM gepm");
    const open = (await db.gepmOpen(c.now())).length;
    await reply(
      [
        `<b>GrupoEPM</b> — modo: <b>${esc(m.gepm_mode || 'off')}</b>`,
        `Última lectura correcta: ${esc(fmtWhen(Number(m.gepm_ok) || NaN))} (Bogotá) · fallos seguidos: ${esc(m.gepm_fail || '0')}`,
        `Guardadas: ${cnt?.n ?? 0} · vigentes: ${open} · pendientes de avisar: ${cnt?.p ?? 0}`,
        '',
        'Cambiar: /gepmodo off | test | live · Vista previa: /gepmprueba NNN-AA',
      ].join('\n'),
    );
    return true;
  }
  if (cmd === 'agregar' || cmd === 'quitar' || cmd === 'chats' || cmd === 'uso') {
    if (!isAdmin || chat.type !== 'private') return deny('Solo el administrador, en chat privado con el bot.');
    if (cmd === 'chats') {
      const list = await db.chatsList(vault);
      const adm = adminId(env);
      const lines = [adm, ...list.map((x) => x.chat).filter((x) => x !== adm)].map((x) => `• <code>${esc(x)}</code>${x === adm ? ' (admin)' : ''}`);
      await reply(`<b>Chats con acceso</b>\n${lines.join('\n')}\n\n🔔 Suscriptores: ${await db.countSubs()}`);
      return true;
    }
    if (cmd === 'uso') {
      const [rows, ev] = await Promise.all([db.usageRows(2), db.recentEvents(5)]);
      const fmt = (r) => `${r.day}: escrituras D1 ${r.d1_writes}/100.000, lecturas ${r.d1_reads}/5.000.000, avisos ${r.tg_sends}, cron ${r.cron_runs}, errores ${r.errors}, límites ${r.limit_hits}`;
      await reply(`<b>Consumo</b>\n${rows.map((r) => esc(fmt(r))).join('\n') || 'sin datos aún'}\n\n<b>Últimos eventos</b>\n${ev.map((e) => esc(`${new Date(e.ts).toISOString().slice(5, 16)} ${e.kind} ${e.detail || ''}`)).join('\n') || 'ninguno'}`);
      return true;
    }
    const target = (rest[0] || '').trim();
    if (!/^-?\d+$/.test(target)) return deny(`Uso: /${cmd} &lt;id numérico del chat&gt;`);
    if (cmd === 'agregar') {
      await db.addChat(vault, target);
      await reply(`✅ Chat <code>${esc(target)}</code> agregado.`);
    } else {
      await db.removeChat(vault, target);
      await reply(`🔕 Chat <code>${esc(target)}</code> quitado.`);
    }
    return true;
  }
  return false;
}

// ---------- una update ----------
// `update` ya viene saneada (solo comandos y botones). c = { env, db, vault, tg, budget, send, now }.
export async function handleUpdate(c, update) {
  const m = update.message;
  const cq = update.callback_query;
  const chat = m?.chat || cq?.message?.chat;
  if (!chat) return { ignored: true };
  const isAdmin = String((m?.from || cq?.from)?.id) === adminId(c.env);

  let cmd;
  let rest = [];
  if (m) {
    const mt = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/s.exec(m.text.trim());
    if (!mt) return { ignored: true };
    if (mt[2] && c.env.BOT_USERNAME && mt[2].toLowerCase() !== c.env.BOT_USERNAME.toLowerCase()) return { ignored: true }; // comando para otro bot
    cmd = mt[1].toLowerCase();
    rest = (mt[3] || '').split(/\s+/).filter(Boolean);
  } else {
    cmd = String(cq.data || '').toLowerCase();
  }

  // Respuesta inmediata al botón (quita la ruedita); corre en paralelo con el resto.
  const ack = cq ? c.tg.answer(cq.id).catch(() => {}) : null;
  try {
    const mut = subMutation(cmd);
    if (mut) {
      const r = await changeSub(c, chat.id, update.update_id, mut);
      const note = r.full ? '\n⚠️ El cupo de suscriptores está lleno por ahora.' : r.conflict ? '\n⚠️ No pude guardar el cambio; vuelve a intentarlo.' : '';
      await showSubscription(c, chat.id, cq?.message?.message_id, r.sub, note);
      return { cmd: 'sub', changed: !!r.changed };
    }
    if (m && (await handleAdmin(c, cmd, rest, chat, isAdmin))) return { cmd: 'admin' };
    await handleCommand(c, cmd, chat, { messageId: cq?.message?.message_id });
    return { cmd };
  } finally {
    if (ack) await ack;
  }
}

// Destinatarios que ya no pueden recibir se eliminan (lo usa el consumidor de la cola).
export { isGone, maskId };
