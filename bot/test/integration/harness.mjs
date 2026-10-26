// Infraestructura de las pruebas de integración: Worker real (wrangler dev --local, con D1 y cola locales) + Telegram,
// EPM y GitHub simulados. Los fixtures son datos públicos reales de EPM; las fechas límite se desplazan para que las
// ofertas estén "abiertas" cuando se ejecuta la prueba.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listing, detail } from '../helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');
const WRANGLER = resolve(ROOT, 'node_modules/wrangler/bin/wrangler.js');

export const SECRET = 'prueba-' + 'secreto-'.repeat(6);
export const BOT_TOKEN = '12345:FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'; // falso, con otra forma que un token real
export const STATE_KEY = 'clave-de-estado-de-prueba-larga-y-aleatoria-0123456789';
export const ADMIN = 5000001;
export const PORTS = { worker: 8811, epm: 9811, tg: 9812, gh: 9813 };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn, { timeout = 15000, every = 150, label = '' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout esperando: ' + label);
    await sleep(every);
  }
}

// ---------- servidores simulados ----------
export function makeFakes() {
  const f = {
    epm: { down: false, ids: listing().map((j) => String(j.Id)), failDetail: new Set(), calls: [], closedIds: new Set(), delayMs: 0 },
    tg: { calls: [], fail: new Map(), n: 100 },
    gh: { calls: [], branch: false, files: new Map() },
  };

  const epmSrv = http.createServer((req, res) => {
    f.epm.calls.push(req.url);
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    setTimeout(() => {
      if (f.epm.down) return send(503, { error: 'caído' });
      const u = decodeURIComponent(req.url);
      const dm = /Id="(\d+)"/.exec(u);
      if (dm) {
        const id = dm[1];
        if (f.epm.failDetail.has(id)) return send(500, {});
        if (!f.epm.ids.includes(id)) return send(200, { items: [] });
        const d = JSON.parse(JSON.stringify(detail(id)));
        const day = 86400000;
        const end = f.epm.closedIds.has(id) ? Date.now() - 2 * day : Date.now() + 3 * day;
        d.ExternalPostedEndDate = new Date(end).toISOString();
        return send(200, { items: [d] });
      }
      if (u.includes('recruitingCEJobRequisitions?')) {
        const all = listing().filter((j) => f.epm.ids.includes(String(j.Id)));
        const offset = Number(/offset=(\d+)/.exec(u)?.[1] || 0);
        const page = all.slice(offset, offset + 50);
        return send(200, { items: [{ TotalJobsCount: all.length, requisitionList: page }] });
      }
      send(404, {});
    }, f.epm.delayMs);
  });

  const tgSrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = b ? JSON.parse(b) : {};
      f.tg.calls.push({ t: Date.now(), method, body, url: req.url });
      const chat = body.chat_id;
      const fail = f.tg.fail.get(String(chat));
      res.setHeader('content-type', 'application/json');
      if (fail && (method === 'sendMessage' || method === 'sendChatAction')) {
        if (fail.once) f.tg.fail.delete(String(chat));
        res.statusCode = fail.status;
        return res.end(JSON.stringify({ ok: false, error_code: fail.status, description: fail.description, parameters: fail.retry_after ? { retry_after: fail.retry_after } : undefined }));
      }
      res.end(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: f.tg.n++ } : true }));
    });
  });

  const ghSrv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = b ? JSON.parse(b) : {};
      f.gh.calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const out = (code, o) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
      const u = req.url;
      if (req.method === 'GET' && u.includes('/git/ref/heads/d1-backup')) return f.gh.branch ? out(200, { ref: 'x' }) : out(404, { message: 'Not Found' });
      if (req.method === 'POST' && u.endsWith('/git/blobs')) return out(201, { sha: 'blob1' });
      if (req.method === 'POST' && u.endsWith('/git/trees')) return out(201, { sha: 'tree1' });
      if (req.method === 'POST' && u.endsWith('/git/commits')) return out(201, { sha: 'commit1' });
      if (req.method === 'POST' && u.endsWith('/git/refs')) return (f.gh.branch = true), out(201, {});
      const cm = /\/contents\/(backups\/[^?]+)/.exec(u);
      if (cm && req.method === 'PUT') return f.gh.files.set(cm[1], { content: body.content, sha: 's' + f.gh.files.size }), out(201, {});
      if (cm && req.method === 'GET') return f.gh.files.has(cm[1]) ? out(200, { sha: f.gh.files.get(cm[1]).sha }) : out(404, {});
      if (u.includes('/contents/backups?')) return out(200, [...f.gh.files].map(([p, v]) => ({ name: p.split('/').pop(), path: p, sha: v.sha })));
      if (cm && req.method === 'DELETE') return f.gh.files.delete(cm[1]), out(200, {});
      out(404, {});
    });
  });
  return { f, servers: [[epmSrv, PORTS.epm], [tgSrv, PORTS.tg], [ghSrv, PORTS.gh]] };
}

// ---------- Worker ----------
export async function startWorker(extraVars = {}) {
  const persist = resolve(tmpdir(), 'epm-bot-it-' + process.pid);
  rmSync(persist, { recursive: true, force: true });
  mkdirSync(persist, { recursive: true });
  const vars = {
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    WEBHOOK_SECRET: SECRET,
    STATE_KEY,
    TELEGRAM_CHAT_ID: String(ADMIN),
    GH_BACKUP_TOKEN: 'ghp_FAKE_BACKUP_TOKEN',
    BACKUP_ENABLED: '1', // en producción está desactivado; aquí se prueba que el código sigue funcionando
    EPM_API: `http://127.0.0.1:${PORTS.epm}`,
    TELEGRAM_API: `http://127.0.0.1:${PORTS.tg}`,
    GITHUB_API: `http://127.0.0.1:${PORTS.gh}`,
    ...extraVars,
  };
  writeFileSync(resolve(ROOT, '.dev.vars'), Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  const mig = spawnSync(process.execPath, [WRANGLER, 'd1', 'migrations', 'apply', 'epm-bot-db', '--local', '--persist-to', persist], { cwd: ROOT, encoding: 'utf8' });
  if (mig.status !== 0) throw new Error('migraciones locales fallaron:\n' + (mig.stdout + mig.stderr).slice(-600));
  const logs = [];
  const p = spawn(process.execPath, [WRANGLER, 'dev', '--local', '--persist-to', persist, '--port', String(PORTS.worker), '--ip', '127.0.0.1', '--test-scheduled'], { cwd: ROOT });
  p.stdout.on('data', (d) => logs.push(String(d)));
  p.stderr.on('data', (d) => logs.push(String(d)));
  for (let i = 0; i < 90; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORTS.worker}/`, { method: 'POST' });
      break;
    } catch {
      await sleep(1000);
    }
    if (i === 89) throw new Error('wrangler dev no arrancó:\n' + logs.join('').slice(-800));
  }
  const dbFile = () => {
    const dir = resolve(persist, 'v3/d1/miniflare-D1DatabaseObject');
    const f = existsSync(dir) ? readdirSync(dir).find((x) => x.endsWith('.sqlite')) : null;
    return f ? resolve(dir, f) : null;
  };
  // Lectura directa de la base local (solo lectura) para comprobar el estado real.
  const sql = (q, ...args) => {
    const file = dbFile();
    if (!file) return [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return db.prepare(q).all(...args);
    } finally {
      db.close();
    }
  };
  const stop = () => {
    p.kill();
    spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { shell: true });
    rmSync(resolve(ROOT, '.dev.vars'), { force: true });
  };
  // Escritura directa en la base local (preparar estados de prueba): lote de sentencias vía archivo.
  const exec = (statements) => {
    const file = resolve(persist, 'exec.sql');
    writeFileSync(file, [].concat(statements).join(';\n') + ';\n');
    const r = spawnSync(process.execPath, [WRANGLER, 'd1', 'execute', 'epm-bot-db', '--local', '--persist-to', persist, '--file', file], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('exec falló: ' + (r.stdout + r.stderr).slice(-400));
  };
  return { logs, sql, exec, stop, persist, dbFile, wrangler: (args) => spawnSync(process.execPath, [WRANGLER, ...args], { cwd: ROOT, encoding: 'utf8' }) };
}

export const base = `http://127.0.0.1:${PORTS.worker}`;
export const H = { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'content-type': 'application/json' };
export const post = async (body, headers = H, path = '/') => {
  const t0 = Date.now();
  const r = await fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: r.status, text: await r.text(), ms: Date.now() - t0 };
};
export const admin = async (path, method = 'GET') => {
  const r = await fetch(base + path, { method, headers: { 'x-admin-token': SECRET } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
export const cmd = (id, text, chat = 6000001, from = chat, type = 'private') => ({ update_id: id, message: { message_id: 1, chat: { id: chat, type }, from: { id: from, first_name: 'Nombre Privado' }, text } });
export const btn = (id, data, chat = 6000001, msgId = 50) => ({ update_id: id, callback_query: { id: 'cb' + id, from: { id: chat, first_name: 'Nombre Privado' }, data, message: { message_id: msgId, chat: { id: chat, type: 'private' } } } });

let failures = 0;
export const check = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(cond ? '  ok  ' : '  FAIL', label, cond ? '' : String(extra).slice(0, 400));
};
export const failCount = () => failures;
export const section = (t) => console.log('\n== ' + t);
