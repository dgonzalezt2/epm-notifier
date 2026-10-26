// Pruebas de integración del Worker real (ver harness.mjs). Uso: node test/integration/run.mjs
import { makeFakes, startWorker, PORTS, SECRET, STATE_KEY, ADMIN, BOT_TOKEN, H, post, admin, cmd, btn, check, failCount, section, sleep, until, base } from './harness.mjs';
import { htmlProblems } from '../helpers.mjs';
import { listing } from '../helpers.mjs';
import { makeVault } from '../../src/lib/crypto.js';
import { createServer } from 'node:http';
import { rmSync } from 'node:fs';

const { f, servers } = makeFakes();
for (const [s, port] of servers) await new Promise((r) => s.listen(port, '127.0.0.1', r));
const W = await startWorker({ RETRY_MIN_SECONDS: '1', RETRY_DELAY_SECONDS: '2' });
const vault = await makeVault(STATE_KEY);
const tgOf = (method) => f.tg.calls.filter((c) => c.method === method);
const sent = (chat) => tgOf('sendMessage').filter((c) => String(c.body.chat_id) === String(chat));
const reset = () => {
  f.tg.calls.length = 0;
  f.epm.calls.length = 0;
  f.gh.calls.length = 0;
};
const rowsOf = (t) => W.sql(`SELECT * FROM ${t}`);
const u = 6000001;
let uid = 1000;

try {
  section('Seguridad: lo primero y barato');
  reset();
  let r = await fetch(base + '/', { method: 'GET' });
  check('GET -> 405', r.status === 405);
  r = await post(cmd(++uid, '/start'), { 'content-type': 'application/json' });
  check('POST sin secreto -> 401', r.status === 401);
  r = await post(cmd(++uid, '/start'), { 'X-Telegram-Bot-Api-Secret-Token': SECRET.slice(0, -1), 'content-type': 'application/json' });
  check('POST con secreto casi correcto -> 401', r.status === 401);
  r = await post('x'.repeat(100000));
  check('cuerpo enorme (100 KB) con secreto -> 413', r.status === 413, r.status);
  r = await post('no es json');
  check('JSON inválido -> 400', r.status === 400);
  r = await post(cmd(++uid, 'hola, no es un comando'));
  check('texto que no es comando -> 200 ignorado', r.status === 200 && r.text === 'ignored');
  r = await post({ update_id: ++uid, edited_message: { text: '/x' } });
  check('tipo de update no usado -> 200 ignorado', r.status === 200 && r.text === 'ignored');
  r = await post(cmd(++uid, '/start', -9, -9, 'channel'));
  check('chat de tipo channel -> ignorado', r.text === 'ignored');
  r = await fetch(base + '/admin/status');
  check('/admin sin token -> 401', r.status === 401);
  r = await fetch(base + '/admin/status', { headers: { 'x-admin-token': 'mal' } });
  check('/admin con token incorrecto -> 401', r.status === 401);
  await sleep(300);
  check('sin llamadas a Telegram ni a EPM en todo lo anterior', f.tg.calls.length === 0 && f.epm.calls.length === 0, `${f.tg.calls.length}/${f.epm.calls.length}`);
  check('D1 sin escrituras de uso por peticiones rechazadas', rowsOf('usage').length === 0 && rowsOf('events').length === 0);

  section('Comandos y respuesta inmediata');
  reset();
  r = await post(cmd(++uid, '/start'));
  check(`/start -> 200 en ${r.ms} ms (< 1500)`, r.status === 200 && r.text === 'ok' && r.ms < 1500, `${r.status} ${r.ms}`);
  let m = sent(u);
  check('responde con el menú en el mismo chat', m.length === 1 && m[0].body.text.includes('Bot de ofertas de empleo EPM'));
  check('sin la nota de espera', !m[0].body.text.includes('pueden tardar'));
  check('HTML válido y vista previa desactivada', htmlProblems(m[0].body.text).length === 0 && m[0].body.disable_web_page_preview === true && m[0].body.parse_mode === 'HTML');
  check('4 botones de menú', m[0].body.reply_markup.inline_keyboard.flat().length === 4);
  check('no consulta EPM para un menú', f.epm.calls.length === 0);
  reset();
  r = await post(btn(++uid, 'perfiles'));
  check('botón: answerCallbackQuery con su id', tgOf('answerCallbackQuery').length === 1 && tgOf('answerCallbackQuery')[0].body.callback_query_id === `cb${uid}`);
  check('botón: muestra el menú de perfiles', sent(u).length === 1 && sent(u)[0].body.text.includes('Elige cómo filtrar'));
  reset();
  await post(cmd(++uid, '/start@otrobot'));
  check('comando dirigido a otro bot: ignorado', f.tg.calls.length === 0);
  await post(cmd(++uid, '/inventado'));
  check('comando desconocido: respuesta amable', sent(u).length === 1 && sent(u)[0].body.text.includes('Comando no reconocido'));

  section('Ofertas con la caché vacía (primer uso): consulta EPM directa');
  reset();
  r = await post(cmd(++uid, '/ofertas'));
  m = sent(u);
  check('responde con las 12 ofertas en varios mensajes', m.length >= 2 && (m.map((x) => x.body.text).join('').match(/\/job\/\d+"/g) || []).length === 12, m.length);
  check('"escribiendo…" solo porque hubo que consultar EPM', tgOf('sendChatAction').length === 1);
  check('todos HTML válido y ≤ 4096', m.every((x) => htmlProblems(x.body.text).length === 0 && x.body.text.length <= 4000));
  check('solo el último mensaje lleva botones de navegación', !!m.at(-1).body.reply_markup && !m[0].body.reply_markup);

  // ======================= Bloque 2: cron, cola, avisos y suscripciones =======================
  const ids = listing().map((j) => String(j.Id));
  const NEW2 = ['39853', '39862'];
  const count = (chat, id) => sent(chat).filter((x) => x.body.text.includes(`/job/${id}"`) && x.body.text.startsWith('🆕')).length;
  const settle = (ms = 2500) => sleep(ms);

  section('Cron antes del corte (live=0)');
  reset();
  W.exec(['DELETE FROM seen', 'DELETE FROM offers']);
  let t = await admin('/admin/tick?dry=1');
  check('simulación (dry=1): ve las 12 como nuevas y no escribe ni encola nada', t.json?.dry && t.json.fresh === 12 && rowsOf('seen').length === 0 && rowsOf('offers').length === 0, JSON.stringify(t.json));
  t = await admin('/admin/tick', 'POST');
  check('con live=0 el cron no hace nada', t.json?.skipped === 'live=0' && rowsOf('seen').length === 0);
  await settle(800);
  check('ni mensajes ni cola por un cron inactivo (solo la consulta de lectura del dry-run a EPM)', f.tg.calls.length === 0 && f.epm.calls.length === 1, `${f.tg.calls.length}/${f.epm.calls.length}`);

  section('Suscripciones, grupo y cifrado en D1');
  const A = 6000001, B = 6000002, C = 6000003, GROUP = -100123;
  await post(btn(++uid, 'sub:civil:1', A, 60));
  await post(btn(++uid, 'sub:tecnologo:1', B, 61));
  await post(btn(++uid, 'sub:all:1', C, 62));
  r = await post(cmd(++uid, '/activar', GROUP, ADMIN, 'supergroup'));
  check('el administrador activa un grupo', rowsOf('chats').length === 1);
  await post(cmd(++uid, '/activar', -100999, C, 'supergroup'));
  check('un usuario normal NO puede activar un grupo', rowsOf('chats').length === 1 && sent(-100999).some((x) => x.body.text.includes('Solo el administrador')));
  const subs = rowsOf('subs');
  check('3 suscriptores guardados', subs.length === 3);
  const dump = JSON.stringify([...subs, ...rowsOf('chats')]);
  check('el chat id y los perfiles NO están en claro en D1', !/600000\d|100123/.test(dump) && !dump.includes('civil') && !dump.includes('tecnologo') && subs.every((s) => s.enc.startsWith('v1.')));
  const hA = await vault.chatHash(A);
  check('se puede descifrar con STATE_KEY y coincide con lo pedido', JSON.stringify(await vault.open('subs', hA, subs.find((s) => s.chat_hash === hA).enc)) === JSON.stringify({ chat: String(A), all: false, profiles: ['civil'] }));
  check('la clave de fila es un HMAC (no el chat id)', subs.every((s) => /^[0-9a-f]{32}$/.test(s.chat_hash)));
  const edits = tgOf('editMessageText');
  check('la pulsación edita el menú en el mismo mensaje, con ✅', edits.length >= 3 && edits.every((e) => e.body.message_id) && edits[0].body.text.includes('Civil') && JSON.stringify(edits[0].body.reply_markup).includes('✅ 🏗 Civil'));
  check('el botón lleva el estado deseado (…:0 para quitar)', JSON.stringify(edits[0].body.reply_markup).includes('sub:civil:0'));

  section('Notificación de ofertas nuevas (cron en vivo + cola)');
  const ts = Date.now();
  W.exec([...ids.filter((i) => !NEW2.includes(i)).map((i) => `INSERT INTO seen (id, first_seen, status, attempts) VALUES ('${i}', ${ts}, 'done', 0)`), "UPDATE meta SET v = '1' WHERE k = 'live'"]);
  reset();
  t = await admin('/admin/tick', 'POST');
  check('el cron detecta SOLO las 2 nuevas', t.json?.fresh === 2 && t.json.listing === 12, JSON.stringify(t.json));
  await until(() => sent(ADMIN).length >= 2 && sent(B).length >= 2 && sent(C).length >= 2 && sent(GROUP).length >= 2, { label: 'avisos', timeout: 40000 });
  await settle();
  check('administrador, suscriptor del perfil, suscriptor de todo y grupo reciben cada oferta UNA vez', NEW2.every((id) => [ADMIN, B, C, GROUP].every((chat) => count(chat, id) === 1)), JSON.stringify([ADMIN, B, C, GROUP].map((c) => NEW2.map((i) => count(c, i)))));
  check('quien eligió otro perfil (civil) no recibe nada', sent(A).length === 0);
  const alert = sent(B).find((x) => x.body.text.includes('/job/39853"')).body.text;
  check('aviso con la tarjeta: título clicable, audiencia, requisitos, fechas y salario', alert.startsWith('🆕 <a href="') && /Dirigida a: Servidores de EPM/.test(alert) && /🎓 Título requerido/.test(alert) && /💼 Experiencia requerida/.test(alert) && /Cierra: \d+ \w+ 2026/.test(alert) && /💼 Salario/.test(alert) && htmlProblems(alert).length === 0, alert.slice(0, 200));
  check('todas las ofertas quedan vistas y terminadas', rowsOf('seen').length === 12 && rowsOf('seen').every((s) => s.status === 'done'));
  check('"sent" registra 4 destinatarios × 2 ofertas = 8 (idempotencia)', rowsOf('sent').length === 8, rowsOf('sent').length);
  check('la caché pública de ofertas se rellena (2 nuevas + 6 de relleno por ejecución)', rowsOf('offers').length === 8, rowsOf('offers').length);
  check('el cron no guarda datos de usuarios en la caché', !JSON.stringify(rowsOf('offers')).match(/600000\d/));
  reset();
  await admin('/admin/tick', 'POST');
  await settle(4000);
  check('segunda ejecución: 0 avisos y la caché llega a las 12', f.tg.calls.filter((c) => c.method === 'sendMessage').length === 0 && rowsOf('offers').length === 12, `${f.tg.calls.length} ${rowsOf('offers').length}`);
  reset();
  t = await admin('/admin/tick', 'POST');
  check('tercera ejecución: sin novedades', t.json?.fresh === 0 && t.json.fill === 0, JSON.stringify(t.json));

  section('Botón de ofertas con la caché (sin consultar EPM)');
  reset();
  r = await post(cmd(++uid, '/ofertas', A));
  check('responde desde D1: 0 consultas a EPM y 0 "escribiendo…"', f.epm.calls.length === 0 && tgOf('sendChatAction').length === 0 && sent(A).length >= 2);
  console.log(`     (D1 por esta petición: ${r.ms} ms, ${await fetch(base + '/', { method: 'POST', headers: H, body: JSON.stringify(cmd(++uid, '/ofertas', A)) }).then((x) => x.headers.get('x-d1'))})`);
  const lst = sent(A).map((x) => x.body.text).join('\n');
  check('las 12 tarjetas con título y experiencia requeridos', (lst.match(/\/job\/\d+"/g) || []).length >= 12 && (lst.match(/🎓 Título requerido/g) || []).length >= 12);
  reset();
  await post(cmd(++uid, '/tecnologo', A));
  const tl = sent(A).map((x) => x.body.text).join('\n');
  check('filtro por perfil (/tecnologo) solo trae las que coinciden', tl.includes('Perfil Tecnólogo') && (tl.match(/\/job\/\d+"/g) || []).length < 12 && (tl.match(/\/job\/\d+"/g) || []).length >= 1);
  W.exec([`UPDATE offers SET lite = json_set(lite, '$.end', '${new Date(Date.now() - 86400000).toISOString()}') WHERE id IN ('39853', '39862')`]);
  reset();
  await post(cmd(++uid, '/ofertas', A));
  const cl = sent(A).map((x) => x.body.text).join('\n');
  check('las ofertas cerradas no se muestran como disponibles y se avisa cuántas', !cl.includes('/job/39853"') && !cl.includes('/job/39862"') && cl.includes('2 oferta(s) cerrada(s) no se muestran') && cl.includes('10 oferta(s) abierta(s)'));

  section('Suscripciones: concurrencia, idempotencia y duplicados');
  const D = 6000004;
  const profs = ['sistemas', 'civil', 'financiera', 'talento', 'comercial', 'juridica', 'sst', 'ambiental'];
  reset();
  const rs = await Promise.all(profs.map((p, i) => post(btn(3000 + i, `sub:${p}:1`, D, 77))));
  check('8 pulsaciones SIMULTÁNEAS del mismo chat: todas responden 200', rs.length === 8 && rs.every((x) => x.status === 200), rs.map((x) => x.status).join());
  const hD = await vault.chatHash(D);
  const sD = async () => JSON.parse(JSON.stringify(await vault.open('subs', hD, rowsOf('subs').find((s) => s.chat_hash === hD).enc)));
  let st = await sD();
  check('estado final coherente: están los 8 perfiles (ninguna pulsación se perdió)', st.profiles.length === 8 && profs.every((p) => st.profiles.includes(p)), JSON.stringify(st.profiles));
  const warn = tgOf('editMessageText').filter((e) => e.body.text.includes('No pude guardar'));
  check('ninguna avisó de conflicto sin resolver', warn.length === 0, warn.length);
  const ver = rowsOf('subs').find((s) => s.chat_hash === hD).version;
  const applied0 = rowsOf('applied').length;
  r = await post(btn(3000, 'sub:sistemas:1', D, 77));
  check('MISMA update entregada otra vez: no cambia nada (ni versión ni dedupe)', rowsOf('subs').find((s) => s.chat_hash === hD).version === ver && rowsOf('applied').length === applied0);
  await sleep(10500); // la ventana del límite por chat (10 s) se reinicia
  const raw = (body) => fetch(base + '/', { method: 'POST', headers: H, body: JSON.stringify(body) });
  let rr = await raw(btn(3100, 'sub:sistemas:1', D, 77));
  check('misma elección con otra update (sin cambio real): 0 escrituras en D1', (rr.headers.get('x-d1') || '').includes('writes=0;'), rr.headers.get('x-d1'));
  await raw(btn(3102, 'sub:sistemas', D, 77));
  st = await sD();
  check('botón de un mensaje antiguo (sin :0/:1) alterna', !st.profiles.includes('sistemas') && st.profiles.length === 7);
  await raw(btn(3103, 'unsub', D, 77));
  check('"Cancelar avisos" elimina al suscriptor de D1', !rowsOf('subs').some((s) => s.chat_hash === hD));
  check('perfil inventado o manipulado se rechaza sin tocar D1', (await raw(btn(3104, 'sub:../../x:1', D, 77))).status === 200 && !rowsOf('subs').some((s) => s.chat_hash === hD));

  section('Administración');
  reset();
  await post(cmd(++uid, '/chats', ADMIN, ADMIN));
  const chatsMsg = sent(ADMIN).at(-1)?.body.text || '';
  check('/chats (admin, privado): lista chats y cuenta suscriptores', chatsMsg.includes(String(ADMIN)) && chatsMsg.includes('-100123') && /Suscriptores: \d+/.test(chatsMsg), chatsMsg);
  await post(cmd(++uid, '/chats', C, C));
  check('/chats por un usuario normal: denegado', sent(C).at(-1)?.body.text.includes('Solo el administrador'));
  await post(cmd(++uid, '/agregar 777000', ADMIN, ADMIN));
  check('/agregar añade un chat (cifrado)', rowsOf('chats').length === 2 && !JSON.stringify(rowsOf('chats')).includes('777000'));
  await post(cmd(++uid, '/quitar 777000', ADMIN, ADMIN));
  check('/quitar lo elimina', rowsOf('chats').length === 1);
  await post(cmd(++uid, '/agregar abc', ADMIN, ADMIN));
  check('argumento inválido: ayuda de uso', sent(ADMIN).at(-1).body.text.includes('Uso:'));
  await post(cmd(++uid, '/uso', ADMIN, ADMIN));
  check('/uso (admin) muestra el consumo frente a los límites', /escrituras D1 \d+\/100\.000/.test(sent(ADMIN).at(-1).body.text));
  await post(cmd(++uid, '/uso', C, C));
  check('/uso por un usuario normal: denegado', sent(C).at(-1).body.text.includes('Solo el administrador'));
  await post(cmd(++uid, '/desactivar', GROUP, ADMIN, 'supergroup'));
  check('/desactivar quita el grupo', rowsOf('chats').length === 0);
  await post(cmd(++uid, '/activar', GROUP, ADMIN, 'supergroup'));

  // ======================= Bloque 3: fallos, reparto masivo, límites, respaldo =======================
  const rearm = (id) => W.exec([`DELETE FROM seen WHERE id = '${id}'`, `DELETE FROM sent WHERE offer_id = '${id}'`]);
  const alerts = (id) => tgOf('sendMessage').filter((x) => x.body.text.startsWith('🆕') && x.body.text.includes(`/job/${id}"`));
  const perChat = (list) => list.reduce((m, x) => ((m[x.body.chat_id] = (m[x.body.chat_id] || 0) + 1), m), {});
  const dups = (list) => Object.values(perChat(list)).filter((n) => n > 1).length;

  section('Ofertas nuevas a la vez que pulsaciones (cron + botones simultáneos)');
  reset();
  rearm('39853');
  await sleep(10500);
  const U = [6100001, 6100002, 6100003, 6100004, 6100005, 6100006];
  const [tk] = await Promise.all([admin('/admin/tick', 'POST'), ...U.map((chat, i) => post(btn(5000 + i, `sub:${profs[i]}:1`, chat, 90)))]);
  check('el cron detecta la oferta mientras llegan 6 pulsaciones', tk.json?.fresh === 1, JSON.stringify(tk.json));
  await until(() => alerts('39853').length >= 4, { label: 'avisos 39853', timeout: 40000 });
  await settle(3000);
  check('las 6 suscripciones nuevas quedaron guardadas', U.length === (await Promise.all(U.map((c) => vault.chatHash(c)))).filter((h) => rowsOf('subs').some((s) => s.chat_hash === h)).length);
  check('destinatarios originales: exactamente 1 aviso cada uno; NADIE recibe duplicados', [ADMIN, B, C, GROUP].every((c) => alerts('39853').filter((x) => String(x.body.chat_id) === String(c)).length === 1) && dups(alerts('39853')) === 0, JSON.stringify(perChat(alerts('39853'))));
  check('estado final coherente: la oferta queda vista y terminada', rowsOf('seen').find((s) => s.id === '39853')?.status === 'done');

  section('Entrega: destinatario bloqueado y límite de Telegram (429)');
  reset();
  rearm('39862');
  f.tg.fail.set(String(B), { status: 403, description: 'Forbidden: bot was blocked by the user' });
  f.tg.fail.set(String(C), { status: 429, description: 'Too Many Requests: retry after 1', retry_after: 1, once: true });
  const subsBefore = rowsOf('subs').length;
  await admin('/admin/tick', 'POST');
  await until(() => alerts('39862').filter((x) => String(x.body.chat_id) === String(C)).length >= 2, { label: 'reintento 429', timeout: 40000 }).catch(() => null);
  await settle(5000);
  const a62 = alerts('39862');
  const okC = a62.filter((x) => String(x.body.chat_id) === String(C));
  check('429: el intento falla y se reintenta; C acaba recibiéndolo UNA vez (el primer envío falló, el segundo llegó)', okC.length === 2 && true, okC.length);
  check('a quienes ya lo habían recibido NO se les repite por el reintento', [ADMIN, GROUP].every((c) => a62.filter((x) => String(x.body.chat_id) === String(c)).length === 1), JSON.stringify(perChat(a62)));
  check('403 (bloqueó el bot): su suscripción se elimina de D1', rowsOf('subs').length === subsBefore - 1 && !rowsOf('subs').some((s) => s.chat_hash === ''), `${rowsOf('subs').length}/${subsBefore}`);
  check('queda constancia sin datos del usuario', rowsOf('events').some((e) => /inaccesible/.test(e.detail || '')) && !JSON.stringify(rowsOf('events')).match(/600000\d/));

  section('Reparto masivo: más destinatarios que subpeticiones por invocación');
  reset();
  const many = [];
  for (let i = 1; i <= 80; i++) {
    const chat = 6200000 + i;
    const h = await vault.chatHash(chat);
    many.push(`INSERT INTO subs (chat_hash, enc, version, updated) VALUES ('${h}', '${await vault.seal('subs', h, { chat: String(chat), all: true, profiles: [] })}', 1, ${Date.now()})`);
  }
  W.exec(many);
  rearm('39863');
  await admin('/admin/tick', 'POST');
  await until(() => alerts('39863').length >= 83, { label: 'reparto 80+', timeout: 60000 });
  await settle(4000);
  const a63 = alerts('39863');
  const dest = new Set(a63.map((x) => String(x.body.chat_id)));
  check(`${a63.length} avisos a ${dest.size} destinatarios distintos: cada uno UNA vez`, a63.length === dest.size && dest.size >= 83, `${a63.length}/${dest.size}`);
  check('incluye a los 80 nuevos, a C, al grupo y al administrador', [...Array(80).keys()].every((i) => dest.has(String(6200001 + i))) && [C, GROUP, ADMIN].every((c) => dest.has(String(c))));
  check('A (perfil civil) no lo recibe: la oferta no coincide con su perfil', !dest.has(String(A)));
  check('8 ofertas × destinatarios registrados en "sent" sin duplicados', rowsOf('sent').filter((s) => s.offer_id === '39863').length === dest.size);

  section('Oferta nueva que ya está cerrada, EPM caído y detalle que falla');
  reset();
  rearm('39864');
  f.epm.closedIds.add('39864');
  await admin('/admin/tick', 'POST');
  await settle(4000);
  check('una oferta nueva ya cerrada NO se avisa, pero se marca como vista', alerts('39864').length === 0 && rowsOf('seen').find((s) => s.id === '39864')?.status === 'done' && rowsOf('events').some((e) => /ya cerrada/.test(e.detail || '')));
  f.epm.closedIds.delete('39864');
  reset();
  f.epm.down = true;
  for (let i = 0; i < 3; i++) {
    t = await admin('/admin/tick', 'POST');
    await sleep(300);
  }
  check('EPM caído: el cron no se rompe y cuenta los fallos', t.json?.error && rowsOf('meta').find((m2) => m2.k === 'epm_fail')?.v === '3', JSON.stringify(t.json));
  await settle(1500);
  check('al 3.er fallo seguido avisa al administrador UNA vez', sent(ADMIN).filter((x) => x.body.text.includes('EPM no responde')).length === 1);
  r = await post(cmd(++uid, '/ofertas', A));
  check('con EPM caído el botón de ofertas sigue funcionando (sirve desde D1)', r.status === 200 && sent(A).length >= 2);
  f.epm.down = false;
  await admin('/admin/tick', 'POST');
  await settle(1500);
  check('al recuperarse EPM el contador de fallos vuelve a 0', rowsOf('meta').find((m2) => m2.k === 'epm_fail')?.v === '0');
  reset();
  rearm('39813');
  f.epm.failDetail.add('39813');
  await admin('/admin/tick', 'POST');
  await settle(5000);
  check('detalle caído: la oferta queda "pendiente" y NO se avisa a medias', rowsOf('seen').find((s) => s.id === '39813')?.status === 'pending' && alerts('39813').length === 0);
  f.epm.failDetail.delete('39813');
  W.exec([`UPDATE seen SET first_seen = ${Date.now() - 20 * 60000} WHERE id = '39813'`]);
  await admin('/admin/tick', 'POST');
  await until(() => alerts('39813').length >= 1, { label: 'reintento de pendiente', timeout: 40000 });
  await settle(2500);
  check('a los 15 min el cron la reintenta: se avisa una vez y queda terminada', dups(alerts('39813')) === 0 && rowsOf('seen').find((s) => s.id === '39813')?.status === 'done');

  section('Límites gratuitos simulados (D1 sin escrituras / error genérico)');
  reset();
  const E = 6000010;
  W.exec(["CREATE TRIGGER sim_limit BEFORE INSERT ON applied BEGIN SELECT RAISE(ABORT, 'D1_ERROR: Exceeded daily rows written limit'); END"]);
  r = await post(btn(++uid, 'sub:civil:1', E, 55));
  check('límite diario de escrituras: 200 (Telegram no reintenta en bucle)', r.status === 200 && r.text === 'handled', `${r.status} ${r.text}`);
  check('el usuario recibe un aviso claro y la cuota se registra', sent(E).some((x) => x.body.text.includes('límite diario gratuito')) && (await until(() => rowsOf('events').some((e) => e.kind === 'limit'), { timeout: 5000, label: 'evento limit' })));
  const hE = await vault.chatHash(E);
  check('no se escribió nada a medias: ni suscripción ni update reclamada', !rowsOf('subs').some((s2) => s2.chat_hash === hE) && rowsOf('applied').every((a2) => a2.update_id !== uid));
  check('el contador diario de límites registra el evento', await until(() => rowsOf('usage').reduce((n, u2) => n + u2.limit_hits, 0) >= 1, { timeout: 5000, label: 'limit_hits' }).catch(() => false));
  W.exec(['DROP TRIGGER sim_limit', "CREATE TRIGGER sim_boom BEFORE INSERT ON applied BEGIN SELECT RAISE(ABORT, 'boom'); END"]);
  reset();
  r = await post(btn(++uid, 'sub:civil:1', E, 55));
  check('error genérico de D1 sin haber enviado nada: 500 (Telegram reintenta)', r.status === 500, r.status);
  check('y no se envió ningún mensaje al usuario', sent(E).length === 0);
  W.exec(['DROP TRIGGER sim_boom']);
  r = await post(btn(++uid, 'sub:civil:1', E, 55));
  check('al volver la normalidad la misma acción funciona', r.status === 200 && r.text === 'ok');

  section('Respaldo cifrado de D1 (sin permisos ni secretos nuevos)');
  reset();
  for (let i = 1; i <= 9; i++) f.gh.files.set(`backups/d1-2026-0${i}-01.enc`, { content: 'x', sha: 'old' + i });
  await admin('/admin/tick?backup=1', 'POST');
  await until(() => [...f.gh.files.keys()].some((k) => k.includes(new Date().toISOString().slice(0, 10))), { label: 'respaldo', timeout: 40000 });
  await settle(2000);
  const put = f.gh.calls.find((c) => c.method === 'PUT' && c.url.includes('/contents/backups/d1-'));
  check('crea la rama huérfana d1-backup y sube el archivo', ['/git/blobs', '/git/trees', '/git/commits', '/git/refs'].every((p) => f.gh.calls.some((c) => c.method === 'POST' && c.url.endsWith(p))) && !!put);
  check('usa el token de contenidos (Bearer) y no el del Telegram', put.auth === 'Bearer ghp_FAKE_BACKUP_TOKEN' && !JSON.stringify(f.gh.calls).includes(BOT_TOKEN.split(':')[1]));
  const sealed = Buffer.from(put.body.content, 'base64').toString('utf8');
  const exp = await vault.openBackup(sealed);
  check('el archivo está cifrado (no contiene ids, perfiles ni texto legible)', sealed.startsWith('v1.') && !/600000|civil|tecnologo|Nombre/.test(sealed + put.body.content));
  check('descifrado con STATE_KEY: contiene suscriptores, chats y ofertas', exp.subs.length === rowsOf('subs').length && exp.chats.length === rowsOf('chats').length && exp.offers.length === rowsOf('offers').length && exp.v === 1);
  check('aun descifrado, los suscriptores siguen cifrados fila a fila', exp.subs.every((s2) => s2.enc.startsWith('v1.')) && !JSON.stringify(exp).match(/"chat":/));
  check('conserva solo los últimos 8 respaldos (borra los más antiguos)', f.gh.calls.some((c) => c.method === 'DELETE') && f.gh.files.size <= 9, f.gh.files.size);

  section('Logs: nada sensible');
  const logs = W.logs.join('');
  const bad = [BOT_TOKEN.split(':')[1], SECRET, STATE_KEY, 'Nombre Privado', '6000001', '6000002', '5000001', 'ghp_FAKE_BACKUP_TOKEN'].filter((p) => logs.includes(p));
  check('los logs del Worker no contienen token, secretos, claves, nombres ni chat ids', bad.length === 0, bad.join(','));

  section('Presupuesto de D1 medido');
  await sleep(10500); // ventana del límite por chat
  const hdr = async (body) => (await fetch(base + '/', { method: 'POST', headers: H, body: JSON.stringify(body) })).headers.get('x-d1');
  const M = 6300001;
  const ops = [
    ['menú (/start)', await hdr(cmd(++uid, '/start', M))],
    ['pulsar un botón de menú', await hdr(btn(++uid, 'perfiles', M))],
    ['/ofertas desde D1 (12 ofertas)', await hdr(cmd(++uid, '/ofertas', M))],
    ['/tecnologo (filtro por perfil)', await hdr(cmd(++uid, '/tecnologo', M))],
    ['suscribirse a un perfil (alta)', await hdr(btn(++uid, 'sub:civil:1', M, 80))],
    ['segundo perfil (cambio)', await hdr(btn(++uid, 'sub:sst:1', M, 80))],
    ['repetir la misma elección (sin cambio)', await hdr(btn(++uid, 'sub:sst:1', M, 80))],
    ['abrir el menú de suscripción', await hdr(cmd(++uid, '/suscribir', M))],
  ];
  const idle = await admin('/admin/tick', 'POST');
  console.log('     operación'.padEnd(46) + 'filas leídas · escritas · consultas');
  for (const [name, h2] of ops) console.log(('     ' + name).padEnd(46) + (h2 || '').replace(/reads=(\d+);writes=(\d+);queries=(\d+);sends=(\d+)/, '$1 · $2 · $3   ($4 mensajes enviados)'));
  console.log(('     cron sin novedades (cada 30 min)').padEnd(46) + `${idle.json.d1.reads} · ${idle.json.d1.writes} · ${idle.json.d1.queries}`);
  const w = (n) => Number(/writes=(\d+)/.exec(ops[n][1])[1]);
  check('menús y consultas de ofertas: 0 escrituras', [0, 1, 2, 3, 7].every((n) => w(n) === 0), JSON.stringify(ops.map((o) => o[1])));
  check('repetir una elección sin cambio: 0 escrituras', w(6) === 0);
  check('cada cambio real cuesta pocas filas (alta ≤ 6, cambio ≤ 4)', w(4) <= 6 && w(5) <= 4, `${w(4)}/${w(5)}`);
  const us = rowsOf('usage');
  const tot = us.reduce((a, x) => ({ w: a.w + x.d1_writes, r: a.r + x.d1_reads, e: a.e + x.errors, l: a.l + x.limit_hits, s: a.s + x.tg_sends }), { w: 0, r: 0, e: 0, l: 0, s: 0 });
  console.log(`     Escrituras registradas (invocaciones que escriben): ${tot.w} / 100.000 · lecturas: ${tot.r} / 5.000.000 · avisos: ${tot.s} · errores: ${tot.e} · límites: ${tot.l}`);
  check('el consumo registrado queda MUY por debajo de los topes diarios', tot.w < 100000 * 0.05 && tot.r < 5000000 * 0.05);
  const st2 = await admin('/admin/status');
  check('/admin/status devuelve solo recuentos (sin ids ni textos)', st2.status === 200 && !JSON.stringify(st2.json).match(/600000|5000001|Nombre/) && st2.json.counts.seen === 12);

  console.log(failCount() ? `\n${failCount()} FALLO(S)` : '\nTODO OK (bloques 1-3)');
} finally {
  W.stop();
  for (const [s] of servers) s.close();
}
process.exit(failCount() ? 1 : 0);
