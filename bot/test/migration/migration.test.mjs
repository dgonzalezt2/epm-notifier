// La migración del estado: formato antiguo (OpenSSL + PBKDF2) -> D1 (AES-GCM + HKDF), y la vuelta atrás.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeVault } from '../../src/lib/crypto.js';

const here = dirname(fileURLToPath(import.meta.url));
const BOT = resolve(here, '../..');
const WRANGLER = resolve(BOT, 'node_modules/wrangler/bin/wrangler.js');
const KEY = 'clave-antigua-de-prueba-larga-y-aleatoria-0123456789ab';
const tmp = mkdtempSync(resolve(tmpdir(), 'epm-mig-'));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

// El estado "antiguo" tal como lo dejaba scripts/epm-run.sh: openssl enc -aes-256-cbc -pbkdf2 -iter 200000
const oldEncrypt = (obj, key = KEY) => {
  const r = run('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt', '-pass', 'env:STATE_KEY'], { input: Buffer.from(JSON.stringify(obj)), encoding: undefined, env: { ...process.env, STATE_KEY: key } });
  assert.equal(r.status, 0);
  return r.stdout;
};

const SEEN = ['39807', '39808', '39853', '39862'];
const SUBS = { 1234500001: { all: false, profiles: ['sistemas', 'civil'] }, 1700000002: { all: true, profiles: [] }, '-100555': { all: false, profiles: ['talento'] } };
const CHATS = ['-100123'];

describe('migración del estado a D1', () => {
  const stateDir = resolve(tmp, 'state');
  before(() => {
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(resolve(stateDir, 'seen.json'), JSON.stringify({ updated: 'x', seen: SEEN }));
    writeFileSync(resolve(stateDir, 'seen.json.subs.enc'), oldEncrypt(SUBS));
    writeFileSync(resolve(stateDir, 'seen.json.chats.enc'), oldEncrypt(CHATS));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  test('el SQL no deja ningún chat id ni perfil en claro y la clave nunca va en argumentos', () => {
    const out = resolve(tmp, 'ok.sql');
    const r = run(process.execPath, [resolve(BOT, 'scripts/migrate-state.mjs'), '--out', out, '--from-dir', stateDir, '--offers', 'skip'], { env: { ...process.env, STATE_KEY: KEY } });
    assert.equal(r.status, 0, r.stderr);
    const sql = readFileSync(out, 'utf8');
    assert.ok(!/1234500001|1700000002|100555|100123/.test(sql + r.stdout + r.stderr), 'chat ids en claro');
    assert.ok(!/sistemas|civil|talento/.test(sql), 'perfiles en claro');
    assert.match(r.stdout, /seen: 4 \| subs: 3 \| chats: 1/);
  });

  test('aplicado a una D1 local, el estado importado coincide con el original', async () => {
    const persist = resolve(tmp, 'd1');
    const mig = run(process.execPath, [WRANGLER, 'd1', 'migrations', 'apply', 'epm-bot-db', '--local', '--persist-to', persist], { cwd: BOT });
    assert.equal(mig.status, 0, mig.stdout + mig.stderr);
    const apply = run(process.execPath, [WRANGLER, 'd1', 'execute', 'epm-bot-db', '--local', '--persist-to', persist, '--file', resolve(tmp, 'ok.sql')], { cwd: BOT });
    assert.equal(apply.status, 0, apply.stdout + apply.stderr);
    const dir = resolve(persist, 'v3/d1/miniflare-D1DatabaseObject');
    const db = new DatabaseSync(resolve(dir, readdirSync(dir).find((f) => f.endsWith('.sqlite'))), { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT id FROM seen ORDER BY id').all().map((r) => r.id), [...SEEN].sort());
      assert.ok(db.prepare('SELECT status FROM seen').all().every((r) => r.status === 'done'));
      const vault = await makeVault(KEY);
      const rows = db.prepare('SELECT chat_hash, enc FROM subs').all();
      assert.equal(rows.length, 3);
      const got = {};
      for (const r of rows) {
        const d = await vault.open('subs', r.chat_hash, r.enc);
        assert.equal(await vault.chatHash(d.chat), r.chat_hash, 'la clave de fila corresponde al chat');
        got[d.chat] = { all: d.all, profiles: d.profiles };
      }
      assert.deepEqual(got, SUBS);
      const ch = db.prepare('SELECT chat_hash, enc FROM chats').all();
      assert.deepEqual(await Promise.all(ch.map(async (r) => (await vault.open('chats', r.chat_hash, r.enc)).chat)), CHATS);
      assert.equal(db.prepare('SELECT v FROM meta WHERE k = ?').get('live').v, '0', 'el corte no activa nada: live sigue en 0');
    } finally {
      db.close();
    }
  });

  test('con una clave incorrecta falla sin generar SQL', () => {
    const out = resolve(tmp, 'bad.sql');
    const r = run(process.execPath, [resolve(BOT, 'scripts/migrate-state.mjs'), '--out', out, '--from-dir', stateDir, '--offers', 'skip'], { env: { ...process.env, STATE_KEY: KEY + 'x' } });
    assert.notEqual(r.status, 0);
    assert.ok(!existsSync(out), 'no debe escribirse un SQL parcial');
    assert.match(r.stderr, /No se pudo descifrar/);
  });

  test('--seen-only solo resincroniza las ofertas vistas (idempotente)', () => {
    const out = resolve(tmp, 'seen.sql');
    const r = run(process.execPath, [resolve(BOT, 'scripts/migrate-state.mjs'), '--out', out, '--from-dir', stateDir, '--seen-only'], { env: { ...process.env, STATE_KEY: KEY } });
    assert.equal(r.status, 0, r.stderr);
    const sql = readFileSync(out, 'utf8');
    assert.ok(sql.split('\n').filter(Boolean).every((l) => l.startsWith('INSERT OR IGNORE INTO seen')));
  });
});

describe('vuelta atrás: copiar a `state` lo que avisó el sistema nuevo', () => {
  test('añade solo las ofertas que faltan, conserva el resto y es idempotente', () => {
    const origin = resolve(tmp, 'origin.git');
    const work = resolve(tmp, 'work');
    run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    run('git', ['clone', '-q', origin, work]);
    const g = (...a) => run('git', a, { cwd: work });
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(resolve(work, 'f.txt'), 'x');
    g('add', '.');
    g('commit', '-qm', 'main');
    g('push', '-q', 'origin', 'main');
    g('checkout', '-q', '--orphan', 'state');
    g('rm', '-rfq', '.');
    writeFileSync(resolve(work, 'seen.json'), JSON.stringify({ updated: 'x', seen: ['1', '2', '3'] }));
    g('add', '.');
    g('commit', '-qm', 'state');
    g('push', '-q', 'origin', 'state');
    g('checkout', '-q', 'main');

    const ids = resolve(tmp, 'ids.json');
    writeFileSync(ids, JSON.stringify([{ results: [{ id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }, { id: 'no-numerico' }] }]));
    const script = resolve(BOT, 'scripts/rollback-seen.mjs');
    let r = run(process.execPath, [script, '--ids', ids], { cwd: work });
    assert.match(r.stdout, /a añadir: 2/);
    assert.match(r.stdout, /simulación/);
    g('fetch', '-q', 'origin', 'state');
    assert.deepEqual(JSON.parse(g('show', 'origin/state:seen.json').stdout).seen, ['1', '2', '3'], 'la simulación no escribe');

    r = run(process.execPath, [script, '--ids', ids, '--push'], { cwd: work });
    assert.equal(r.status, 0, r.stderr);
    g('fetch', '-q', 'origin', 'state');
    assert.deepEqual(JSON.parse(g('show', 'origin/state:seen.json').stdout).seen, ['1', '2', '3', '4', '5']);
    assert.match(g('log', '-1', '--format=%s', 'origin/state').stdout, /vuelta atrás/);

    r = run(process.execPath, [script, '--ids', ids, '--push'], { cwd: work });
    assert.match(r.stdout, /a añadir: 0/);
    g('fetch', '-q', 'origin', 'state');
    assert.equal(g('rev-list', '--count', 'origin/state').stdout.trim(), '2', 'segunda ejecución: sin commit nuevo');
  });
});
