// Orden seguro del estado: la oferta se marca como vista DESPUÉS de encolar; si el cron se corta, la siguiente ejecución
// la vuelve a detectar; y nada de eso puede duplicar un aviso (cada destinatario se reclama antes de enviar).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { listing, detail, FIX } from '../helpers.mjs';
import { makeD1 } from './d1shim.mjs';
import { makeDb } from '../../src/lib/db.js';
import { makeVault } from '../../src/lib/crypto.js';
import { Budget } from '../../src/lib/telegram.js';
import { runCron } from '../../src/lib/cron.js';
import { consume } from '../../src/lib/consumer.js';
import { jobFromListing } from '../../src/lib/offer.js';

const LIST = listing();
const IDS = LIST.map((j) => String(j.Id)).filter((id) => existsSync(`${FIX}/detail-${id}.json`));
const ADMIN = '5000001';
const SUBS = [1234500001, 1234500002];
const realFetch = globalThis.fetch;

async function world(freshIds) {
  const D = makeD1();
  const queue = [];
  const sends = [];
  const world = { D, queue, sends, failSend: new Set(), jobsFail: false };
  const env = {
    DB: D,
    EPM_API: 'http://epm.test',
    TELEGRAM_CHAT_ID: ADMIN,
    JOBS: {
      sendBatch: async (m) => {
        if (world.jobsFail) throw new Error('cola no disponible');
        queue.push(...m.map((x) => ({ ...x, attempts: 0 })));
      },
      send: async (m) => queue.push({ body: m.body ?? m, attempts: 0 }),
    },
  };
  const db = makeDb(env);
  const vault = await makeVault('clave-de-prueba-larga-y-aleatoria-0123456789');
  for (const s of SUBS) await db.putSub(vault, s, { all: true, profiles: [] }, 0);
  for (const id of IDS) {
    if (freshIds.includes(id)) continue;
    D.raw.prepare("INSERT INTO seen (id, first_seen, status, attempts) VALUES (?, ?, 'done', 0)").run(id, Date.now() - 36e5);
    D.raw.prepare('INSERT INTO offers (id, job, lite, updated) VALUES (?, ?, ?, ?)').run(id, JSON.stringify(jobFromListing(LIST.find((j) => String(j.Id) === id))), '{}', Date.now());
  }
  D.raw.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('live','1'), ('cmds','v2')").run();
  const ctx = () => ({
    env, db: makeDb(env), vault, budget: new Budget(45), now: () => Date.now(),
    tg: {
      send: async (chat, html) => {
        if (world.failSend.has(String(chat))) {
          world.failSend.delete(String(chat));
          throw new Error('fallo transitorio');
        }
        sends.push({ chat: String(chat), html });
      },
      call: async () => {},
    },
  });
  // Cola simulada: procesa un mensaje por invocación y reintenta (hasta 3 veces) los que fallan.
  world.drain = async () => {
    for (let guard = 0; queue.length && guard < 200; guard++) {
      const m = queue.shift();
      try {
        await consume(ctx(), m);
      } catch {
        if (++m.attempts < 3) queue.push(m);
      }
    }
  };
  world.tick = () => runCron(ctx());
  world.rows = (sql, ...a) => D.raw.prepare(sql).all(...a).map((r) => ({ ...r }));
  return world;
}

beforeEach(() => {
  globalThis.fetch = async (url) => {
    const u = decodeURIComponent(String(url));
    const m = /Id="(\d+)"/.exec(u);
    if (m) {
      const d = JSON.parse(JSON.stringify(detail(m[1])));
      d.ExternalPostedEndDate = new Date(Date.now() + 3 * 864e5).toISOString();
      return new Response(JSON.stringify({ items: [d] }));
    }
    return new Response(JSON.stringify({ items: [{ TotalJobsCount: LIST.length, requisitionList: LIST }] }));
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('cron: solo ids, comparación en memoria', () => {
  test('sin ofertas nuevas no encola ni escribe vistas; con una nueva encola solo esa', async () => {
    const w0 = await world([]);
    w0.D.trips = 0; // la preparación del escenario no cuenta
    const r0 = await w0.tick();
    assert.equal(r0.fresh, 0);
    assert.equal(w0.queue.length, 0);
    assert.ok(w0.D.trips <= 3, `viajes a D1 del cron: ${w0.D.trips}`); // metas + estado de ofertas + una escritura atómica
    const w1 = await world([IDS[0]]);
    const r1 = await w1.tick();
    assert.equal(r1.fresh, 1);
    assert.deepEqual(w1.queue.map((m) => m.body.id), [IDS[0]]);
    assert.equal(w1.rows('SELECT status FROM seen WHERE id = ?', IDS[0])[0].status, 'pending');
  });
});

describe('orden seguro del estado', () => {
  test('si la cola falla, la oferta NO se marca como vista y la siguiente ejecución la encola una sola vez', async () => {
    const w = await world([IDS[0]]);
    w.jobsFail = true;
    await assert.rejects(w.tick(), /cola no disponible/);
    assert.equal(w.rows('SELECT 1 FROM seen WHERE id = ?', IDS[0]).length, 0, 'sin marca de vista');
    assert.equal(w.queue.length, 0);
    w.jobsFail = false;
    await w.tick();
    assert.equal(w.queue.length, 1);
    await w.tick(); // una tercera ejecución ya no la detecta como nueva
    assert.equal(w.queue.length, 1);
    await w.drain();
    assert.equal(w.sends.length, SUBS.length + 1, 'administrador + suscriptores, uno cada uno');
  });

  test('corte justo después de encolar y antes de marcar: se vuelve a detectar y NO se duplica ningún aviso', async () => {
    const w = await world([IDS[0]]);
    w.D.failNextBatch = true; // la cola recibe el mensaje, pero la escritura atómica de "vistas" no llega a hacerse
    await assert.rejects(w.tick(), /corte simulado/);
    assert.equal(w.queue.length, 1, 'el mensaje sí se encoló');
    assert.equal(w.rows('SELECT 1 FROM seen WHERE id = ?', IDS[0]).length, 0);
    await w.tick(); // se vuelve a detectar -> segundo mensaje de la misma oferta
    assert.equal(w.queue.length, 2);
    await w.drain();
    const perChat = Object.groupBy(w.sends, (s) => s.chat);
    assert.equal(Object.keys(perChat).length, SUBS.length + 1);
    for (const [chat, arr] of Object.entries(perChat)) assert.equal(arr.length, 1, `chat ${chat === ADMIN ? 'admin' : 'suscriptor'} recibió ${arr.length} avisos`);
    assert.equal(w.rows('SELECT status FROM seen WHERE id = ?', IDS[0])[0].status, 'done');
    assert.equal(w.rows('SELECT COUNT(*) AS n FROM sent WHERE offer_id = ?', IDS[0])[0].n, SUBS.length + 1);
  });

  test('reintento de la cola tras un fallo parcial: solo recibe quien falló, nadie recibe dos avisos', async () => {
    const w = await world([IDS[0]]);
    await w.tick();
    w.failSend.add(String(SUBS[1])); // el primer envío a este suscriptor falla una vez
    await w.drain();
    const perChat = Object.groupBy(w.sends, (s) => s.chat);
    assert.equal(Object.keys(perChat).length, SUBS.length + 1, 'todos acabaron recibiéndolo');
    for (const arr of Object.values(perChat)) assert.equal(arr.length, 1);
  });

  test('tres ofertas nuevas a la vez: tres mensajes, un aviso por oferta y destinatario, y la siguiente ejecución no repite', async () => {
    const fresh = IDS.slice(0, 3);
    const w = await world(fresh);
    const r = await w.tick();
    assert.equal(r.fresh, 3);
    assert.equal(w.queue.length, 3);
    await w.drain();
    assert.equal(w.sends.length, 3 * (SUBS.length + 1));
    const before = w.sends.length;
    const r2 = await w.tick();
    assert.equal(r2.fresh, 0);
    assert.equal(w.queue.length, 0);
    await w.drain();
    assert.equal(w.sends.length, before);
  });
});
