// GrupoEPM: estado, deduplicación, avisos (modo test/live), fallos de la página, botón, suscripción y administración,
// con la D1 simulada, la cola simulada y la página real (extracto) servida por un fetch falso.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIX, htmlProblems, listing, detail } from '../helpers.mjs';
import worker, { slimUpdate } from '../../src/index.js';
import { jobFromListing } from '../../src/lib/offer.js';
import { makeD1 } from './d1shim.mjs';
import { makeDb } from '../../src/lib/db.js';
import { makeVault } from '../../src/lib/crypto.js';
import { Budget } from '../../src/lib/telegram.js';
import { consume, RetryLater } from '../../src/lib/consumer.js';
import { handleUpdate } from '../../src/lib/handlers.js';
import { runCron } from '../../src/lib/cron.js';
import { MAX_MSG } from '../../src/lib/util.js';

const PAGE = readFileSync(`${FIX}/gepm-convocatorias.html`, 'utf8');
const LIST = listing();
const ADMIN = '5000001';
const SUBS = { on1: 1234500001, on2: 1234500002, off: 1234500003, all: 1234500004 }; // on1/on2 activaron GrupoEPM; off y all no
const NOW0 = Date.parse('2026-11-20T15:00:00Z');
const realFetch = globalThis.fetch;

const block = (id, tail = 'Fecha de cierre viernes 27 de noviembre de 2026 - 23:59 hrs.', title = 'PROFESIONAL DE PRUEBA') =>
  `<div class="title"><div id="title-${id}" class="cmp-title"><h3 class="cmp-title__text"><a class="cmp-title__link" data-cmp-clickable href="/content/dam/x/${id}.pdf" target="_blank">${id} ${title}: ${tail}</a></h3></div></div>
<div class="text"><div id="text-${id}" class="cmp-text"><p>Se requiere una (1) persona para trabajar en la ciudad de Medellín, el cargo se desarrollará principalmente en el Edificio Inteligente EPM, sin embargo, podrá apoyar los programas y proyectos donde se requiera.</p><p><b><a href="https://login.airavirtual.com/postula/${id}?id&#61;1">¡Postúlate aquí!</a></b></p></div></div>
<div class="separator"><div class="cmp-separator"><hr/></div></div>\n`;
const H = '<h3 class="cmp-title__text">';
// La convocatoria más nueva va primero: se inserta justo antes de la primera (como hace la página real).
const withNew = (page, html) => {
  const at = page.lastIndexOf('<div class="title">', page.indexOf(H));
  return page.slice(0, at) + html + page.slice(at);
};

async function world() {
  const D = makeD1();
  const w = { D, queue: [], sends: [], tgSends: [], epmDetailStatus: 200, edits: [], now: NOW0, page: PAGE, etag: 'W/"v1"', fetches: { gepm: 0, epm: 0 }, pageStatus: 200, failSend: new Set(), jobsFail: 0 };
  const env = {
    DB: D,
    EPM_API: 'http://epm.test',
    GEPM_URL: 'http://gepm.test/page',
    TELEGRAM_CHAT_ID: ADMIN,
    BOT_USERNAME: 'epmofertasbot',
    // para las pruebas que pasan por el manejador real de la cola (src/index.js)
    TELEGRAM_BOT_TOKEN: '12345:FAKEFAKEFAKE',
    TELEGRAM_API: 'http://tg.test',
    STATE_KEY: 'clave-de-prueba-larga-y-aleatoria-0123456789',
    JOBS: {
      sendBatch: async (m) => {
        if (w.jobsFail > 0) {
          w.jobsFail--;
          throw new Error('cola no disponible');
        }
        w.queue.push(...m.map((x) => ({ ...x, attempts: 0 })));
      },
      send: async (m) => {
        if (w.jobsFail > 0) {
          w.jobsFail--;
          throw new Error('cola no disponible');
        }
        w.queue.push({ body: m.body ?? m, attempts: 0 });
      },
    },
  };
  w.env = env;
  w.db = makeDb(env);
  w.vault = await makeVault('clave-de-prueba-larga-y-aleatoria-0123456789');
  const sub = (chat, data) => w.db.putSub(w.vault, chat, { all: false, profiles: [], gepm: false, ...data }, 0);
  await sub(SUBS.on1, { gepm: true });
  await sub(SUBS.on2, { gepm: true, profiles: ['sistemas'] });
  await sub(SUBS.off, { profiles: ['sistemas'] });
  await sub(SUBS.all, { all: true });
  await w.db.addChat(w.vault, -100777); // chat autorizado (recibe las ofertas de Oracle, NO GrupoEPM)
  D.raw.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('live','1'), ('cmds','v2')").run();
  w.D.trips = 0;

  w.ctx = () => {
    const budget = new Budget(45);
    const tg = {
      send: async (chat, html, kb) => {
        if (w.failSend.has(String(chat))) {
          w.failSend.delete(String(chat));
          throw new Error('fallo transitorio');
        }
        w.sends.push({ chat: String(chat), html, kb });
        return { message_id: 1 };
      },
      edit: async (chat, id, html, kb) => w.edits.push({ chat: String(chat), html, kb }),
      answer: async () => {},
      typing: async () => {},
      call: async () => {},
    };
    const c = { env, db: makeDb(env), vault: w.vault, budget, tg, now: () => w.now, sentAny: false };
    c.send = async (chat, html, kb) => (c.sentAny = true, tg.send(chat, html, kb));
    return c;
  };
  w.setMode = (m) => w.D.raw.prepare("INSERT INTO meta (k, v) VALUES ('gepm_mode', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(m);
  w.meta = (k) => w.D.raw.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
  w.rows = () => w.D.raw.prepare('SELECT id, status, notify, tested, closes FROM gepm ORDER BY id').all().map((r) => ({ ...r }));
  w.row = (id) => w.rows().find((r) => r.id === id);
  w.check = () => consume(w.ctx(), { body: { t: 'gepm' } });
  w.drain = async () => {
    for (let guard = 0; w.queue.length && guard < 300; guard++) {
      const m = w.queue.shift();
      try {
        await consume(w.ctx(), m);
      } catch (e) {
        assert.ok(e instanceof RetryLater || e instanceof Error);
        if (++m.attempts < 4) w.queue.push(m);
      }
    }
  };
  w.sendsTo = (chat) => w.sends.filter((s) => s.chat === String(chat));
  w.gepmMsgs = () => w.queue.filter((m) => m.body.t === 'notify' && String(m.body.offer).startsWith('g:'));
  // Una update de Telegram ya saneada, como la entrega el Worker a handleUpdate.
  let uid = 100;
  w.sayIn = (chat, type, from, text) => handleUpdate(w.ctx(), { update_id: ++uid, message: { chat: { id: Number(chat), type }, from: { id: Number(from) }, text } });
  w.say = (chat, text) => handleUpdate(w.ctx(), { update_id: ++uid, message: { chat: { id: Number(chat), type: 'private' }, from: { id: Number(chat) }, text } });
  w.press = (chat, data) => handleUpdate(w.ctx(), { update_id: ++uid, callback_query: { id: 'cb' + uid, data, from: { id: Number(chat) }, message: { message_id: 7, chat: { id: Number(chat), type: 'private' } } } });
  return w;
}

let W;
beforeEach(async () => {
  W = await world();
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('http://gepm.test')) {
      W.fetches.gepm++;
      if (W.pageStatus === 'throw') throw new TypeError('fetch failed');
      if (W.pageStatus !== 200) return new Response('error', { status: W.pageStatus });
      if (init.headers?.['if-none-match'] && init.headers['if-none-match'] === W.etag) return new Response(null, { status: 304 });
      return new Response(W.page, { status: 200, headers: { 'content-type': 'text/html;charset=utf-8', etag: W.etag } });
    }
    if (u.startsWith('http://tg.test')) {
      const body = JSON.parse(init.body || '{}');
      W.tgSends.push({ method: u.split('/').pop(), chat: String(body.chat_id), text: body.text });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    W.fetches.epm++;
    const dm = /Id="(\d+)"/.exec(decodeURIComponent(u));
    if (dm) {
      if (W.epmDetailStatus !== 200) return new Response('{}', { status: W.epmDetailStatus });
      const d = JSON.parse(JSON.stringify(detail(dm[1])));
      d.ExternalPostedEndDate = new Date(NOW0 + 3 * 864e5).toISOString();
      return new Response(JSON.stringify({ items: [d] }));
    }
    return new Response(JSON.stringify({ items: [{ TotalJobsCount: LIST.length, requisitionList: LIST }] }));
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('modo apagado y primera lectura', () => {
  test('modo off (por defecto): no descarga nada ni escribe', async () => {
    assert.equal(W.meta('gepm_mode'), 'off'); // la migración lo deja apagado
    assert.deepEqual(await W.check(), { skipped: 'off' });
    assert.equal(W.fetches.gepm, 0);
    assert.equal(W.rows().length, 0);
  });
  test('primera lectura en modo test: guarda TODAS como vistas sin avisar (ni la vigente) y recuerda el ETag', async () => {
    W.setMode('test');
    const r = await W.check();
    assert.equal(r.ok, true);
    assert.equal(r.inserted, 12, 'solo las 12 más nuevas (la lectura se corta ahí)');
    assert.equal(r.queued, 0);
    assert.equal(W.queue.length, 0);
    assert.ok(W.rows().every((x) => x.notify === 'none' && x.tested === 0));
    assert.equal(W.meta('gepm_init'), '1');
    assert.equal(W.meta('gepm_etag'), 'W/"v1"');
    assert.equal(W.meta('gepm_fail') ?? '0', '0', 'sin fallos (no se escribe el contador mientras es 0)');
    assert.equal(Number(W.meta('gepm_ok')), NOW0);
    assert.equal(W.sends.length, 0);
  });
  test('primera lectura en modo LIVE tampoco avisa de lo que ya estaba (baseline)', async () => {
    W.setMode('live');
    await W.check();
    assert.equal(W.queue.length, 0);
    assert.equal(W.sends.length, 0);
    assert.equal(W.rows().filter((x) => x.notify === 'pending').length, 0);
  });
  test('segunda revisión con la página sin cambios: petición condicional -> 304, sin analizar ni escribir filas', async () => {
    W.setMode('test');
    await W.check();
    const before = JSON.stringify(W.rows());
    const r = await W.check();
    assert.equal(r.notModified, true);
    assert.equal(W.fetches.gepm, 2);
    assert.equal(JSON.stringify(W.rows()), before);
  });
});

describe('modo test: los avisos solo salen al administrador', () => {
  beforeEach(async () => {
    W.setMode('test');
    await W.check(); // baseline
  });
  test('una convocatoria nueva y vigente: un solo aviso, solo al administrador, y no se repite', async () => {
    W.page = withNew(PAGE, block('026-26'));
    W.etag = 'W/"v2"';
    const r = await W.check();
    assert.equal(r.inserted, 1);
    assert.equal(r.queued, 1);
    assert.deepEqual(W.gepmMsgs().map((m) => [m.body.offer, m.body.admin, m.body.hashes.length]), [['g:026-26', true, 0]]);
    assert.equal(W.row('026-26').notify, 'pending', 'sigue pendiente de avisar a los suscriptores');
    assert.equal(W.row('026-26').tested, 1);
    await W.drain();
    assert.equal(W.sendsTo(ADMIN).length, 1);
    assert.match(W.sendsTo(ADMIN)[0].html, /026-26 PROFESIONAL DE PRUEBA/);
    assert.equal(W.sends.length, 1, 'ningún suscriptor, ni chat autorizado, recibió nada');
    // otra revisión (la página cambió de ETag pero no de contenido): no se vuelve a encolar el aviso de prueba
    W.etag = 'W/"v3"';
    const r2 = await W.check();
    assert.equal(r2.queued, 0);
    assert.equal(W.queue.length, 0);
  });
  test('aunque haya suscriptores con GrupoEPM activado, en modo test no reciben nada', async () => {
    W.page = withNew(PAGE, block('026-26'));
    W.etag = 'W/"v2"';
    await W.check();
    await W.drain();
    for (const chat of Object.values(SUBS)) assert.equal(W.sendsTo(chat).length, 0, String(chat));
    assert.equal(W.sendsTo(-100777).length, 0);
  });
  test('una pendiente que se cancela antes de pasar a live deja de estar pendiente y no se avisa nunca', async () => {
    W.page = withNew(PAGE, block('026-26'));
    W.etag = 'W/"v2"';
    await W.check();
    W.page = withNew(PAGE, block('026-26', 'Cancelado'));
    W.etag = 'W/"v3"';
    await W.check();
    assert.equal(W.row('026-26').notify, 'none');
    W.setMode('live');
    W.etag = 'W/"v4"';
    await W.check();
    assert.equal(W.queue.filter((m) => m.body.offer === 'g:026-26' && m.body.hashes.length).length, 0);
  });
});

describe('modo live: solo quien activó GrupoEPM, una vez', () => {
  beforeEach(async () => {
    W.setMode('live');
    await W.check(); // baseline
  });
  const publish = (id = '026-26', n = 2) => {
    W.page = withNew(W.page, block(id));
    W.etag = `W/"v${n}"`;
  };
  test('avisa SOLO a los suscriptores con el interruptor encendido (no a «todas las ofertas» ni a perfiles ni a chats autorizados)', async () => {
    publish();
    await W.check();
    await W.drain();
    assert.equal(W.sendsTo(SUBS.on1).length, 1);
    assert.equal(W.sendsTo(SUBS.on2).length, 1);
    assert.equal(W.sendsTo(SUBS.off).length, 0);
    assert.equal(W.sendsTo(SUBS.all).length, 0);
    assert.equal(W.sendsTo(-100777).length, 0);
    assert.equal(W.sendsTo(ADMIN).length, 0, 'el administrador no activó el interruptor');
    assert.equal(W.row('026-26').notify, 'done');
    assert.match(W.sendsTo(SUBS.on1)[0].html, /^🆕 🏢 <a href="https:\/\/www\.grupo-epm\.com\/content\/dam\/x\/026-26\.pdf">026-26 PROFESIONAL DE PRUEBA<\/a>/);
    assert.deepEqual(htmlProblems(W.sendsTo(SUBS.on1)[0].html), []);
    assert.ok(W.sendsTo(SUBS.on1)[0].html.length < MAX_MSG);
  });
  test('la misma convocatoria en dos revisiones seguidas se avisa una sola vez', async () => {
    publish();
    await W.check();
    W.etag = 'W/"v9"'; // la página cambió de ETag (p. ej. una notificación nueva), pero la convocatoria es la misma
    await W.check();
    await W.check();
    await W.drain();
    assert.equal(W.sendsTo(SUBS.on1).length, 1);
    assert.equal(W.sendsTo(SUBS.on2).length, 1);
    assert.equal(W.D.raw.prepare("SELECT COUNT(*) n FROM sent WHERE offer_id = 'g:026-26'").get().n, 2);
  });
  test('un cambio posterior (nueva fecha de cierre / fe de erratas) actualiza los datos pero NO duplica el aviso', async () => {
    publish();
    await W.check();
    await W.drain();
    const antes = W.sends.length;
    W.page = W.page.replace('viernes 27 de noviembre de 2026', 'domingo 29 de noviembre de 2026'); // nueva fecha
    W.etag = 'W/"v5"';
    const r = await W.check();
    assert.equal(r.updated, 1);
    assert.equal(r.queued, 0);
    await W.drain();
    assert.equal(W.sends.length, antes);
    assert.equal(new Date(W.row('026-26').closes - 5 * 3600e3).toISOString().slice(0, 10), '2026-11-29');
  });
  test('el administrador recibe el aviso en live solo si activó GrupoEPM; y no se duplica si ya lo recibió en modo test', async () => {
    await W.db.putSub(W.vault, ADMIN, { all: false, profiles: [], gepm: true }, 0);
    W.setMode('test');
    publish();
    await W.check(); // aviso de prueba al administrador
    await W.drain();
    assert.equal(W.sendsTo(ADMIN).length, 1);
    W.setMode('live');
    W.etag = 'W/"v6"';
    await W.check();
    await W.drain();
    assert.equal(W.sendsTo(ADMIN).length, 1, 'ya lo tenía: no se repite');
    assert.equal(W.sendsTo(SUBS.on1).length, 1);
  });
  test('reintento de la cola con fallo parcial: solo se repite a quien falló, nadie recibe dos avisos', async () => {
    publish();
    await W.check();
    W.failSend.add(String(SUBS.on2)); // el primer envío a on2 falla una vez
    await W.drain();
    assert.equal(W.sendsTo(SUBS.on1).length, 1);
    assert.equal(W.sendsTo(SUBS.on2).length, 1);
  });
  test('muchos suscriptores: se reparte en mensajes de ≤ 35 y cada uno recibe un solo aviso', async () => {
    for (let i = 0; i < 80; i++) await W.db.putSub(W.vault, 2000000000 + i, { all: false, profiles: [], gepm: true }, 0);
    publish();
    await W.check();
    const msgs = W.gepmMsgs();
    assert.ok(msgs.length >= 3 && msgs.every((m) => m.body.hashes.length <= 35));
    await W.drain();
    const per = Object.groupBy(W.sends, (s) => s.chat);
    assert.equal(Object.keys(per).length, 82);
    assert.ok(Object.values(per).every((a) => a.length === 1));
  });
  test('corte DESPUÉS de guardar y ANTES de encolar: la siguiente revisión la encuentra pendiente y avisa una sola vez', async () => {
    publish();
    W.jobsFail = 1; // la cola falla justo al encolar el aviso
    await assert.rejects(W.check(), /cola no disponible/);
    assert.equal(W.row('026-26').notify, 'pending', 'guardada pero sin avisar: no se pierde');
    assert.equal(W.queue.length, 0);
    W.etag = 'W/"v7"';
    await W.check();
    await W.check();
    await W.drain();
    assert.equal(W.sendsTo(SUBS.on1).length, 1);
    assert.equal(W.row('026-26').notify, 'done');
  });
  test('corte ANTES de guardar: no queda nada marcado y la siguiente revisión la procesa completa, sin duplicar', async () => {
    publish();
    W.D.failNextBatch = true;
    await assert.rejects(W.check(), /corte simulado/);
    assert.equal(W.row('026-26'), undefined);
    assert.equal(W.queue.length, 0);
    await W.check();
    await W.drain();
    assert.equal(W.sendsTo(SUBS.on1).length, 1);
  });
  test('las que ya estaban cerradas, canceladas o sin fecha nunca se avisan, aunque aparezcan nuevas en la lista', async () => {
    W.page = withNew(W.page, block('027-26', 'Cancelado') + block('028-26', 'Cerrado') + block('029-26', 'Fecha de cierre 1 de enero de 2026 - 23:59 hrs.'));
    W.etag = 'W/"v8"';
    const r = await W.check();
    assert.equal(r.inserted, 3);
    assert.equal(r.queued, 0);
    assert.ok(['027-26', '028-26', '029-26'].every((id) => W.row(id).notify === 'none'));
  });
  test('texto malicioso de la página: el aviso llega escapado y válido para Telegram', async () => {
    W.page = withNew(W.page, block('030-26', 'Fecha de cierre viernes 27 de noviembre de 2026 - 23:59 hrs.', '&lt;script&gt;alert(1)&lt;/script&gt; &amp; <b>negrita</b> "x"'));
    W.etag = 'W/"v10"';
    await W.check();
    await W.drain();
    const html = W.sendsTo(SUBS.on1)[0].html;
    assert.deepEqual(htmlProblems(html), []);
    assert.ok(!/<script/.test(html));
  });
});

describe('si la página falla o cambia de estructura', () => {
  beforeEach(async () => {
    W.setMode('live');
    await W.check(); // baseline correcto
  });
  test('200 pero ninguna convocatoria legible: no marca nada, no avisa a suscriptores y avisa SOLO al administrador, una vez', async () => {
    const filas = JSON.stringify(W.rows());
    W.page = '<html><body><h1>Sitio en mantenimiento</h1></body></html>';
    W.etag = 'W/"roto"';
    const r = await W.check();
    assert.deepEqual([r.ok, r.code], [false, 'estructura']);
    assert.equal(JSON.stringify(W.rows()), filas, 'ninguna fila cambió');
    assert.equal(W.meta('gepm_fail'), '1');
    assert.equal(W.queue.length, 0);
    assert.equal(W.sends.length, 1);
    assert.equal(W.sends[0].chat, ADMIN);
    assert.match(W.sends[0].html, /GrupoEPM/);
    assert.ok(!W.sends[0].html.includes('mantenimiento'), 'no se copia contenido de la página');
    // otra revisión fallida dentro del enfriamiento: no repite el aviso
    await W.check();
    await W.check();
    assert.equal(W.sends.length, 1);
    assert.equal(W.meta('gepm_fail'), '3');
    // pasadas 12 h vuelve a avisar (una vez)
    W.now += 13 * 3600_000;
    await W.check();
    assert.equal(W.sends.length, 2);
    assert.equal(W.sendsTo(SUBS.on1).length, 0);
    // el ETag NO se actualiza con una página rota: al recuperarse se vuelve a leer completa
    assert.equal(W.meta('gepm_etag'), 'W/"v1"');
  });
  test('recuperación: la página vuelve a estar bien -> se reinicia el contador y se procesa lo que haya', async () => {
    W.page = '<html></html>';
    W.etag = 'W/"roto"';
    await W.check();
    assert.equal(W.meta('gepm_fail'), '1');
    W.page = withNew(PAGE, block('026-26'));
    W.etag = 'W/"v2"';
    const r = await W.check();
    assert.equal(r.ok, true);
    assert.equal(W.meta('gepm_fail'), '0');
    await W.drain();
    assert.equal(W.sendsTo(SUBS.on1).length, 1, 'lo publicado mientras estuvo roto se avisa al recuperarse');
  });
  test('HTTP 503 / sin red: reintenta en 15 min, cuenta los fallos y avisa al administrador a la 3.ª vez seguida', async () => {
    const filas = JSON.stringify(W.rows());
    W.pageStatus = 503;
    await W.check();
    await W.check();
    assert.equal(W.sends.length, 0, 'aún no (1.º y 2.º fallo)');
    assert.equal(Number(W.meta('gepm_next')), W.now + 15 * 60_000);
    W.pageStatus = 'throw';
    await W.check();
    assert.equal(W.sends.length, 1);
    assert.equal(W.sends[0].chat, ADMIN);
    assert.match(W.sends[0].html, /3 revisiones seguidas/);
    assert.equal(JSON.stringify(W.rows()), filas);
    assert.match(W.D.raw.prepare("SELECT detail FROM events WHERE kind = 'error' ORDER BY id DESC LIMIT 1").get().detail, /^GrupoEPM: red \(fallos seguidos: 3\)$/);
  });
  test('encabezados que no reconoce junto a otros buenos: se procesa lo bueno y se avisa al administrador (sin marcar lo malo)', async () => {
    W.page = withNew(PAGE, block('031-26') + block('032-26', 'Fecha de cierre 31 de febrero de 2026'));
    W.etag = 'W/"v2"';
    const r = await W.check();
    assert.equal(r.ok, true);
    assert.equal(r.bad, 1);
    assert.ok(W.row('031-26'));
    assert.equal(W.row('032-26'), undefined);
    assert.equal(W.sendsTo(ADMIN).length, 1);
    assert.match(W.sendsTo(ADMIN)[0].html, /no reconozco/);
  });
});

describe('el cron solo encola «revisar»: nunca descarga la página', () => {
  const cron = () => runCron({ env: W.env, db: makeDb(W.env), budget: new Budget(45), tg: { send: async () => {}, call: async () => {} } });
  test('con GrupoEPM apagado no encola nada', async () => {
    await cron();
    assert.equal(W.queue.filter((m) => m.body.t === 'gepm').length, 0);
    assert.equal(W.fetches.gepm, 0);
  });
  test('en modo test/live encola UNA revisión cuando toca y reserva la siguiente (no la repite el tick siguiente)', async () => {
    W.setMode('test');
    W.D.raw.prepare("INSERT INTO meta (k, v) VALUES ('gepm_next', '0') ON CONFLICT(k) DO UPDATE SET v = excluded.v").run();
    const r = await cron();
    assert.equal(r.gepm, true);
    assert.equal(W.queue.filter((m) => m.body.t === 'gepm').length, 1);
    assert.equal(W.fetches.gepm, 0, 'el cron no toca la página de GrupoEPM');
    assert.ok(Number(W.meta('gepm_next')) > Date.now(), 'revisión siguiente reservada');
    const r2 = await cron();
    assert.equal(r2.gepm, false);
    assert.equal(W.queue.filter((m) => m.body.t === 'gepm').length, 1);
  });
  test('cuántas consultas a D1 gasta el cron no cambia (la bandera viaja en la misma consulta de metadatos)', async () => {
    W.D.trips = 0;
    await cron();
    assert.ok(W.D.trips <= 3, `viajes a D1: ${W.D.trips}`);
  });
});

describe('botón 🏢 GrupoEPM (lee la caché de D1, nunca la página en vivo)', () => {
  test('sección apagada: lo dice claramente', async () => {
    await W.press(SUBS.on1, 'gepm');
    assert.match(W.sends.at(-1).html, /aún no está activa/);
    assert.equal(W.fetches.gepm, 0);
  });
  test('con convocatoria vigente: la tarjeta, el interruptor y la nota del modo de prueba; sin tocar la página', async () => {
    W.setMode('test');
    await W.check();
    const llamadas = W.fetches.gepm;
    await W.press(SUBS.off, 'gepm');
    const m = W.sends.at(-1);
    assert.match(m.html, /1 vigente\(s\)/);
    assert.match(m.html, /025-26 TECNÓLOGO\(A\) DE COMUNICACIONES/);
    assert.match(m.html, /Cierra: 22 nov 2026 \(en 2 días\)/);
    assert.ok(!/ 023-26 /.test(m.html), 'las cerradas no se muestran');
    assert.match(m.html, /avisos automáticos de GrupoEPM aún no están activos/);
    assert.deepEqual(htmlProblems(m.html), []);
    assert.ok(m.html.length < MAX_MSG);
    assert.equal(W.fetches.gepm, llamadas, 'el botón NO descarga la página');
    assert.equal(m.kb[0][0].callback_data, 'sub:gepm:1');
    await W.press(SUBS.on1, 'gepm');
    assert.equal(W.sends.at(-1).kb[0][0].callback_data, 'sub:gepm:0');
    assert.match(W.sends.at(-1).kb[0][0].text, /Quitar/);
  });
  test('en live no aparece la nota de «avisos aún no activos»', async () => {
    W.setMode('live');
    await W.check();
    await W.press(SUBS.off, 'gepm');
    assert.ok(!/aún no están activos/.test(W.sends.at(-1).html));
  });
  test('sin vigentes (leída bien) ≠ no pude leer la página', async () => {
    W.setMode('test');
    await W.check();
    W.now = Date.parse('2026-11-25T15:00:00Z'); // ya cerró la 025-26
    await W.press(SUBS.off, 'gepm');
    assert.match(W.sends.at(-1).html, /No hay convocatorias vigentes/);
    assert.ok(!/No he podido|Todavía no/.test(W.sends.at(-1).html));
    // nunca se ha podido leer
    const w2 = await world();
    w2.setMode('test');
    await w2.press(SUBS.off, 'gepm');
    assert.match(w2.sends.at(-1).html, /Todavía no he podido leer/);
    assert.ok(!/No hay convocatorias vigentes/.test(w2.sends.at(-1).html));
  });
  test('si la lectura falla desde hace rato, avisa de que es lo último que pudo leer', async () => {
    W.setMode('test');
    await W.check();
    W.pageStatus = 503;
    await W.check();
    await W.check();
    W.now += 4 * 3600_000;
    await W.press(SUBS.off, 'gepm');
    assert.match(W.sends.at(-1).html, /No he podido actualizar la lista desde 20 nov 2026 10:00/);
    assert.match(W.sends.at(-1).html, /025-26/);
  });
  test('muchas vigentes: se reparten en mensajes de ≤ 4000 caracteres sin cortar ninguna tarjeta', async () => {
    W.setMode('test');
    await W.check();
    for (let i = 0; i < 20; i++) W.D.raw.prepare("INSERT INTO gepm (id, data, closes, status, notify, first_seen, updated) VALUES (?, ?, ?, 'dated', 'none', 1, 1)").run(`1${String(i).padStart(2, '0')}-26`, JSON.stringify({ title: 'CARGO '.repeat(15), city: 'Medellín', people: 1, where: 'el Edificio', conds: ['Esta vacante aplica para personas residentes del municipio relacionado'], pdf: 'https://www.grupo-epm.com/x.pdf', apply: 'https://login.airavirtual.com/postula/x' }), NOW0 + 86400e3);
    await W.press(SUBS.off, 'gepm');
    assert.ok(W.sends.length >= 2);
    for (const m of W.sends) {
      assert.ok(m.html.length <= MAX_MSG, `${m.html.length}`);
      assert.deepEqual(htmlProblems(m.html), []);
    }
  });
  test('/grupoepm y /gepm hacen lo mismo que el botón', async () => {
    W.setMode('test');
    await W.check();
    await W.say(SUBS.off, '/grupoepm');
    await W.say(SUBS.off, '/gepm');
    assert.equal(W.sends.filter((s) => /025-26/.test(s.html)).length, 2);
  });
  test('el menú principal tiene el botón 🏢 GrupoEPM', async () => {
    await W.say(SUBS.off, '/start');
    const botones = W.sends.at(-1).kb.flat();
    assert.ok(botones.some((b) => b.callback_data === 'gepm' && /GrupoEPM/.test(b.text)));
    assert.equal(botones.length, 5);
  });
});

describe('interruptor «Avisos GrupoEPM» y suscripciones existentes', () => {
  test('apagado por defecto: ninguna suscripción migrada lo trae encendido', async () => {
    for (const chat of Object.values(SUBS)) {
      const s = (await W.db.getSub(W.vault, chat)).data;
      assert.equal(s.gepm, chat === SUBS.on1 || chat === SUBS.on2, String(chat));
    }
    const nuevo = (await W.db.getSub(W.vault, 1999999999)).data;
    assert.equal(nuevo, null, 'quien no está suscrito no tiene nada');
  });
  test('una suscripción CIFRADA ANTES de esta función (sin el campo) se lee con gepm = false y no se rompe', async () => {
    const hash = await W.vault.chatHash(1888888888);
    const enc = await W.vault.seal('subs', hash, { chat: '1888888888', all: true, profiles: ['civil'] }); // formato antiguo
    W.D.raw.prepare('INSERT INTO subs (chat_hash, enc, version, updated) VALUES (?, ?, 1, 1)').run(hash, enc);
    const s = (await W.db.getSub(W.vault, 1888888888)).data;
    assert.deepEqual(s, { chat: '1888888888', all: true, profiles: ['civil'], gepm: false });
    // y al activar GrupoEPM se conserva todo lo demás
    await W.press(1888888888, 'sub:gepm:1');
    assert.deepEqual((await W.db.getSub(W.vault, 1888888888)).data, { chat: '1888888888', all: true, profiles: ['civil'], gepm: true });
  });
  test('activar y desactivar: absoluto, idempotente, y el menú muestra su estado', async () => {
    await W.press(SUBS.off, 'sub:gepm:1');
    assert.equal((await W.db.getSub(W.vault, SUBS.off)).data.gepm, true);
    assert.match(W.edits.at(-1).html, /Recibes también las convocatorias nuevas de <b>GrupoEPM<\/b>/);
    assert.ok(W.edits.at(-1).kb.flat().some((b) => b.callback_data === 'sub:gepm:0' && b.text.startsWith('✅')));
    const version = W.D.raw.prepare('SELECT version FROM subs WHERE chat_hash = ?').get(await W.vault.chatHash(SUBS.off)).version;
    await W.press(SUBS.off, 'sub:gepm:1'); // pulsar dos veces
    assert.equal(W.D.raw.prepare('SELECT version FROM subs WHERE chat_hash = ?').get(await W.vault.chatHash(SUBS.off)).version, version, 'sin cambios: no escribe');
    await W.press(SUBS.off, 'sub:gepm:0');
    assert.equal((await W.db.getSub(W.vault, SUBS.off)).data.gepm, false);
    assert.deepEqual((await W.db.getSub(W.vault, SUBS.off)).data.profiles, ['sistemas'], 'los perfiles no se tocan');
  });
  test('quien solo activa GrupoEPM (sin ofertas) queda suscrito; «Cancelar avisos» lo apaga todo', async () => {
    await W.press(1777777777, 'sub:gepm:1');
    const s = (await W.db.getSub(W.vault, 1777777777)).data;
    assert.deepEqual([s.all, s.profiles, s.gepm], [false, [], true]);
    assert.match(W.edits.at(-1).html, /Recibes también las convocatorias nuevas/);
    assert.ok(!/Ahora mismo no recibes avisos/.test(W.edits.at(-1).html));
    await W.press(1777777777, 'unsub');
    assert.equal((await W.db.getSub(W.vault, 1777777777)).data, null, 'sin nada activo, el registro se elimina');
  });
  test('cambiar «todas las ofertas» o un perfil no apaga GrupoEPM', async () => {
    await W.press(SUBS.on1, 'sub:all:1');
    assert.deepEqual([(await W.db.getSub(W.vault, SUBS.on1)).data.all, (await W.db.getSub(W.vault, SUBS.on1)).data.gepm], [true, true]);
    await W.press(SUBS.on1, 'sub:all:0');
    assert.equal((await W.db.getSub(W.vault, SUBS.on1)).data.gepm, true);
  });
});

describe('administración de GrupoEPM', () => {
  test('/gepmodo: solo el administrador, en privado; valida el argumento y cambia el modo', async () => {
    await W.say(SUBS.off, '/gepmodo live');
    assert.match(W.sends.at(-1).html, /Comando no reconocido/);
    assert.equal(W.meta('gepm_mode'), 'off');
    await W.say(ADMIN, '/gepmodo prendido');
    assert.match(W.sends.at(-1).html, /Uso: \/gepmodo/);
    assert.equal(W.meta('gepm_mode'), 'off');
    await W.say(ADMIN, '/gepmodo test');
    assert.equal(W.meta('gepm_mode'), 'test');
    assert.equal(W.meta('gepm_next'), '0', 'la próxima revisión se encola enseguida');
    await W.say(ADMIN, '/gepmodo live');
    assert.equal(W.meta('gepm_mode'), 'live');
    await W.say(ADMIN, '/gepmodo off');
    assert.equal(W.meta('gepm_mode'), 'off');
  });
  test('/gepmodo sin argumento muestra el estado (modo, última lectura, vigentes y pendientes)', async () => {
    W.setMode('test');
    await W.check();
    await W.say(ADMIN, '/gepmodo');
    const t = W.sends.at(-1).html;
    assert.match(t, /modo: <b>test<\/b>/);
    assert.match(t, /Guardadas: 12 · vigentes: 1 · pendientes de avisar: 0/);
    assert.match(t, /20 nov 2026 10:00/);
  });
  test('/gepmprueba NNN-AA: vista previa SOLO para el administrador (no avisa a nadie ni reclama envíos)', async () => {
    W.setMode('test');
    await W.check();
    await W.say(ADMIN, '/gepmprueba 025-26');
    const mine = W.sendsTo(ADMIN);
    assert.equal(mine.length, 2);
    assert.match(mine[1].html, /^🆕 🏢 <a href=.+025-26 TECNÓLOGO\(A\) DE COMUNICACIONES/);
    assert.equal(W.sends.length, 2);
    assert.equal(W.D.raw.prepare('SELECT COUNT(*) n FROM sent').get().n, 0);
    await W.say(ADMIN, '/gepmprueba 999-99');
    assert.match(W.sends.at(-1).html, /No encuentro la convocatoria/);
    await W.say(SUBS.off, '/gepmprueba 025-26');
    assert.match(W.sends.at(-1).html, /Comando no reconocido/);
  });
});

describe('reparto: claves de envío', () => {
  test('el consumidor acepta la clave g:NNN-AA y rechaza claves inventadas', async () => {
    await consume(W.ctx(), { body: { t: 'notify', offer: 'g:abc', html: 'x', hashes: [], admin: true } });
    await consume(W.ctx(), { body: { t: 'notify', offer: "g:001-26'; DROP TABLE sent;--", html: 'x', hashes: [], admin: true } });
    assert.equal(W.sends.length, 0);
    await consume(W.ctx(), { body: { t: 'notify', offer: 'g:001-26', html: 'hola', hashes: [], admin: true } });
    assert.equal(W.sendsTo(ADMIN).length, 1);
    await consume(W.ctx(), { body: { t: 'notify', offer: 'g:001-26', html: 'hola', hashes: [], admin: true } });
    assert.equal(W.sendsTo(ADMIN).length, 1, 'el mismo par (convocatoria, destinatario) no se repite');
  });
  test('la clave de una convocatoria no choca con la de una oferta de Oracle', async () => {
    await consume(W.ctx(), { body: { t: 'notify', offer: '1', html: 'oracle', hashes: [], admin: true } });
    await consume(W.ctx(), { body: { t: 'notify', offer: 'g:001-26', html: 'gepm', hashes: [], admin: true } });
    assert.equal(W.sendsTo(ADMIN).length, 2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Autorización: /gepmodo y /gepmprueba solo desde el chat privado del administrador
// ---------------------------------------------------------------------------------------------------------------------
describe('autorización de /gepmodo y /gepmprueba', () => {
  const estado = (w) => JSON.stringify([w.D.raw.prepare('SELECT * FROM meta ORDER BY k').all(), w.D.raw.prepare('SELECT COUNT(*) n FROM gepm').get(), w.D.raw.prepare('SELECT COUNT(*) n FROM applied').get(), w.D.raw.prepare('SELECT COUNT(*) n FROM subs').get()]);
  test('cualquier otro chat recibe EXACTAMENTE lo mismo que un comando desconocido, sin cambios de estado ni confirmar que existen', async () => {
    W.setMode('test');
    await W.check(); // hay convocatorias en la caché: /gepmprueba tendría qué mostrar
    await W.say(SUBS.off, '/comandoinventado');
    const ref = W.sends.at(-1);
    assert.match(ref.html, /Comando no reconocido/);
    const intentos = [
      ['usuario normal, privado: /gepmodo live', () => W.say(SUBS.off, '/gepmodo live')],
      ['usuario normal, privado: /gepmodo (estado)', () => W.say(SUBS.off, '/gepmodo')],
      ['usuario normal, privado: /gepmprueba', () => W.say(SUBS.off, '/gepmprueba 025-26')],
      ['suscriptor con GrupoEPM activado', () => W.say(SUBS.on1, '/gepmodo off')],
      ['chat autorizado (grupo)', () => W.sayIn(-100777, 'supergroup', SUBS.all, '/gepmodo live')],
      ['el ADMINISTRADOR, pero escribiendo desde un grupo', () => W.sayIn(-100500, 'supergroup', ADMIN, '/gepmodo live')],
      ['el ADMINISTRADOR desde un grupo: /gepmprueba', () => W.sayIn(-100500, 'group', ADMIN, '/gepmprueba 025-26')],
      ['usuario normal con @nombre del bot', () => W.say(SUBS.off, '/gepmodo@epmofertasbot live')],
      ['botón forjado (callback_data) de un usuario normal', () => W.press(SUBS.off, 'gepmodo live')],
      ['botón forjado de un usuario normal: gepmprueba', () => W.press(SUBS.off, 'gepmprueba 025-26')],
    ];
    for (const [nombre, go] of intentos) {
      const antes = estado(W);
      const enviados = W.sends.length;
      await go();
      assert.equal(W.sends.length, enviados + 1, nombre + ': una sola respuesta');
      const resp = W.sends.at(-1);
      assert.equal(resp.html, ref.html, nombre + ': mismo texto que un comando desconocido');
      assert.equal(JSON.stringify(resp.kb), JSON.stringify(ref.kb), nombre + ': mismo teclado');
      assert.equal(estado(W), antes, nombre + ': no cambia nada en D1');
      assert.equal(W.meta('gepm_mode'), 'test', nombre + ': el modo sigue igual');
    }
    assert.ok(!W.sends.some((s) => s.chat === String(SUBS.off) && s.html.includes('025-26')), 'ninguna tarjeta se filtró al usuario normal');
  });
  test('y el administrador, en su chat privado, sí puede', async () => {
    W.setMode('test');
    await W.check();
    await W.say(ADMIN, '/gepmodo');
    assert.match(W.sends.at(-1).html, /modo: <b>test<\/b>/);
    await W.say(ADMIN, '/gepmprueba 025-26');
    assert.match(W.sends.at(-1).html, /025-26/);
    await W.say(ADMIN, '/gepmodo off');
    assert.equal(W.meta('gepm_mode'), 'off');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Aislamiento en la cola: una revisión de GrupoEPM que falla no frena ni bloquea las ofertas del portal
// (se prueba con el manejador REAL de la cola, src/index.js, y mensajes sueltos como los entrega Cloudflare: lotes de 1)
// ---------------------------------------------------------------------------------------------------------------------
describe('aislamiento en la cola: GrupoEPM no frena a las ofertas del portal', () => {
  const OFFER = LIST.find((j) => String(j.Id) === '39853') || LIST[0];
  const offerMsg = () => ({ t: 'offer', id: String(OFFER.Id), job: jobFromListing(OFFER), notify: true });
  // Un mensaje como lo recibe el consumidor: con su contador de intentos y las dos formas de responder.
  const deliver = async (body, attempts = 1) => {
    const m = { body, attempts, acked: false, retried: null, ack() { this.acked = true; }, retry(o) { this.retried = o; } };
    await worker.queue({ messages: [m] }, W.env);
    return m;
  };
  const drainViaWorker = async () => {
    const res = [];
    for (let guard = 0; W.queue.length && guard < 50; guard++) res.push(await deliver(W.queue.shift().body));
    return res;
  };
  const rompeGepm = (mensaje = 'D1 error simulado') => {
    const orig = W.D.prepare;
    W.D.prepare = (sql) => {
      if (/FROM gepm/.test(sql) || /INTO gepm/.test(sql) || /UPDATE gepm/.test(sql)) throw new Error(mensaje);
      return orig(sql);
    };
  };
  const quiet = console.error;
  beforeEach(() => {
    console.error = () => {};
  });
  afterEach(() => {
    console.error = quiet;
  });

  test('la revisión falla (D1 roto solo para su tabla): UN reintento a los 5 min, y las ofertas siguen procesándose y avisando', async () => {
    W.setMode('test');
    rompeGepm();
    const g1 = await deliver({ t: 'gepm' });
    assert.deepEqual([g1.acked, g1.retried], [false, { delaySeconds: 300 }]);
    // en la misma cola, una oferta del portal: se procesa y se avisa con normalidad
    const o1 = await deliver(offerMsg());
    assert.deepEqual([o1.acked, o1.retried], [true, null], 'la oferta no se reintenta ni se retrasa');
    const reparto = await drainViaWorker();
    assert.ok(reparto.length >= 1 && reparto.every((m) => m.acked && m.retried === null), 'el reparto de avisos de la oferta también va bien');
    const recibieron = new Set(W.tgSends.filter((s) => s.method === 'sendMessage').map((s) => s.chat));
    assert.ok(recibieron.has(ADMIN) && recibieron.has(String(SUBS.all)) && recibieron.has('-100777'), 'avisos de la oferta entregados: ' + [...recibieron]);
    // el reintento de la revisión: sigue fallando y SE DESCARTA (no hay segundo reintento)
    const g2 = await deliver({ t: 'gepm' }, 2);
    assert.deepEqual([g2.acked, g2.retried], [true, null]);
    assert.equal(W.queue.length, 0, 'la revisión no encoló nada por su cuenta');
  });
  test('reintentos ACOTADOS: aunque Cloudflare siga entregándolo, a lo sumo 2 intentos, sin bucle y sin encolar mensajes', async () => {
    W.setMode('test');
    rompeGepm();
    let intentos = 0;
    let m;
    do {
      intentos++;
      m = await deliver({ t: 'gepm' }, intentos);
    } while (m.retried && intentos < 20);
    assert.equal(intentos, 2);
    assert.equal(W.queue.length, 0);
  });
  test('tras fallar, la próxima revisión se aplaza (≥ 1 h): el cron no la vuelve a encolar enseguida', async () => {
    W.setMode('test');
    rompeGepm();
    await deliver({ t: 'gepm' });
    assert.ok(Number(W.meta('gepm_next')) > Date.now() + 55 * 60_000, 'aplazada una hora');
    assert.match(W.D.raw.prepare("SELECT detail FROM events WHERE kind = 'error' ORDER BY id DESC LIMIT 1").get().detail, /^GrupoEPM: revisión fallida/);
    await runCron({ env: W.env, db: makeDb(W.env), budget: new Budget(45), tg: { send: async () => {}, call: async () => {} } });
    assert.equal(W.queue.filter((m) => m.body.t === 'gepm').length, 0);
  });
  test('si el fallo es un límite diario de D1: se descarta sin reintentar y se aplaza una hora', async () => {
    W.setMode('test');
    rompeGepm('D1 daily limit exceeded');
    const g = await deliver({ t: 'gepm' });
    assert.deepEqual([g.acked, g.retried], [true, null]);
    assert.ok(Number(W.meta('gepm_next')) > Date.now() + 55 * 60_000);
    assert.equal(W.D.raw.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'limit'").get().n, 1);
  });
  test('una oferta del portal que falla sigue con SU política (reintento a los 60 s) y no afecta a GrupoEPM', async () => {
    W.setMode('test');
    W.epmDetailStatus = 500; // EPM no entrega el detalle
    const o = await deliver(offerMsg());
    assert.deepEqual([o.acked, o.retried], [false, { delaySeconds: 60 }]);
    const g = await deliver({ t: 'gepm' }); // en la misma cola, la revisión de GrupoEPM funciona
    assert.equal(g.acked, true);
    assert.equal(W.rows().length, 12);
    assert.equal(W.meta('gepm_ok') != null, true);
  });
  test('GrupoEPM nunca se mezcla con las ofertas: cada mensaje es una invocación aparte (lotes de 1) y los reintentos del plan están acotados', () => {
    const toml = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8');
    assert.match(toml, /max_batch_size = 1/);
    assert.match(toml, /max_retries = 3/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// /gepmprueba con el mensaje REAL de Telegram (con entities, from, date...) pasando por el saneado del Worker
// ---------------------------------------------------------------------------------------------------------------------
describe('/gepmprueba: tres respuestas distintas y lectura del argumento', () => {
  // Un mensaje tal como lo entrega Telegram a un comando con argumento.
  const real = (text, { chat = Number(ADMIN), from = Number(ADMIN) } = {}) => ({
    update_id: 700000 + Math.floor(Math.random() * 1e5),
    message: {
      message_id: 321,
      from: { id: from, is_bot: false, first_name: 'Administrador', language_code: 'es' },
      chat: { id: chat, first_name: 'Administrador', type: 'private' },
      date: 1795167000,
      text,
      entities: [{ offset: 0, length: text.split(' ')[0].length, type: 'bot_command' }],
    },
  });
  const run = async (text, opts) => {
    const slim = slimUpdate(real(text, opts));
    assert.ok(slim, 'el Worker deja pasar el mensaje');
    assert.equal(slim.message.text, text);
    return handleUpdate(W.ctx(), slim);
  };
  const last = () => W.sends.at(-1)?.html;

  test('caché VACÍA (aún no hubo revisión): lo dice, con «025-26» y con el @nombre del bot', async () => {
    W.setMode('test');
    assert.equal(W.rows().length, 0);
    for (const t of ['/gepmprueba 025-26', '/gepmprueba@epmofertasbot 025-26', '/gepmprueba   025-26  ', '/GepmPrueba@EPMOfertasBot 025-26']) {
      await run(t);
      assert.equal(last(), 'Aún no hay convocatorias en la caché (la primera revisión se hace en la próxima hora).', t);
    }
    assert.equal(W.sends.length, 4);
  });
  test('con la caché llena: «025-26» (con y sin @nombre del bot) muestra la vista previa solo al administrador', async () => {
    W.setMode('test');
    await W.check();
    for (const t of ['/gepmprueba 025-26', '/gepmprueba@epmofertasbot 025-26']) {
      const antes = W.sends.length;
      await run(t);
      assert.equal(W.sends.length, antes + 2, t);
      assert.match(W.sends.at(-2).html, /Vista previa del aviso/);
      assert.match(last(), /^🆕 🏢 <a href=.+025-26 TECNÓLOGO\(A\) DE COMUNICACIONES/);
      assert.ok(W.sends.slice(antes).every((s) => s.chat === ADMIN));
    }
  });
  test('convocatoria que no está (caché con datos): «No encuentro esa convocatoria»', async () => {
    W.setMode('test');
    await W.check();
    await run('/gepmprueba 999-99');
    assert.equal(last(), 'No encuentro la convocatoria <code>999-99</code> en la caché.');
    await run('/gepmprueba@epmofertasbot 001-20');
    assert.equal(last(), 'No encuentro la convocatoria <code>001-20</code> en la caché.');
    assert.deepEqual(htmlProblems(last()), []);
  });
  test('formato inválido: uso con un ejemplo (sin argumento, mal escrito o con texto de más)', async () => {
    W.setMode('test');
    await W.check();
    for (const t of ['/gepmprueba', '/gepmprueba@epmofertasbot', '/gepmprueba 25-26', '/gepmprueba 025-2', '/gepmprueba 0251-26', '/gepmprueba abc', '/gepmprueba 025_26', '/gepmprueba <b>']) {
      await run(t);
      assert.equal(last(), 'Uso: /gepmprueba NNN-AA (por ejemplo, <code>025-26</code>).', t);
    }
  });
  test('los tres casos también con la caché vacía: el formato inválido se detecta antes que «no hay caché»', async () => {
    W.setMode('test');
    await run('/gepmprueba nada');
    assert.match(last(), /^Uso:/);
    await run('/gepmprueba 025-26');
    assert.match(last(), /^Aún no hay convocatorias en la caché/);
  });
  test('un comando dirigido a OTRO bot no se atiende, y un usuario normal sigue viendo «Comando no reconocido»', async () => {
    W.setMode('test');
    const antes = W.sends.length;
    const r = await run('/gepmprueba@otrobot 025-26');
    assert.deepEqual(r, { ignored: true });
    assert.equal(W.sends.length, antes);
    await run('/gepmprueba@epmofertasbot 025-26', { chat: Number(SUBS.off), from: Number(SUBS.off) });
    assert.match(last(), /Comando no reconocido/);
  });
});
