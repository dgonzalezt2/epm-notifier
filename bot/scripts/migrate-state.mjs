#!/usr/bin/env node
// Migra el estado de la rama `state` (formato antiguo: OpenSSL AES-256-CBC + PBKDF2) a D1 (AES-GCM con HKDF).
//
//   node bot/scripts/migrate-state.mjs --out <archivo.sql> [--from-ref origin/state | --from-dir <carpeta>] [--offers live|skip]
//   node bot/scripts/migrate-state.mjs --out <archivo.sql> --seen-only        (resincroniza solo las ofertas vistas, p. ej. justo antes del corte)
//
// Lee STATE_KEY del entorno (o de .env en la raíz del repo). NO modifica la rama `state`: solo la lee (git show).
// Genera un archivo SQL que se aplica con: wrangler d1 execute <base> -c wrangler.local.toml --remote --file <archivo.sql>
// El SQL contiene solo blobs cifrados y ofertas públicas; los chat ids no aparecen en claro. Tampoco se imprimen.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeVault } from '../src/lib/crypto.js';
import { liteFromDetail, jobFromListing } from '../src/lib/offer.js';
import { fetchListing, fetchDetail } from '../src/lib/epm.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const arg = (name, def = '') => {
  const i = process.argv.indexOf(name);
  return i < 0 ? def : process.argv[i + 1] ?? '';
};
const flag = (name) => process.argv.includes(name);

function loadDotenv() {
  const f = resolve(repo, '.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
}

// Archivo de la rama `state` (o de una carpeta, en pruebas) como Buffer; null si no existe.
function readState(name) {
  const dir = arg('--from-dir');
  if (dir) {
    const f = resolve(dir, name);
    return existsSync(f) ? readFileSync(f) : null;
  }
  const r = spawnSync('git', ['show', `${arg('--from-ref', 'origin/state')}:${name}`], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

// Formato antiguo: openssl enc -aes-256-cbc -pbkdf2 -iter 200000. La clave viaja por entorno, nunca por argumentos.
function oldDecrypt(buf, stateKey) {
  const r = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-pass', 'env:STATE_KEY'], {
    input: buf,
    env: { ...process.env, STATE_KEY: stateKey },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error('No se pudo descifrar el estado antiguo (¿STATE_KEY distinta a la usada al guardar?)');
  return JSON.parse(r.stdout.toString('utf8'));
}

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

loadDotenv();
const out = arg('--out');
if (!out) {
  console.error('Uso: node bot/scripts/migrate-state.mjs --out <archivo.sql> [--from-ref origin/state | --from-dir <carpeta>] [--offers live|skip] [--seen-only]');
  process.exit(2);
}
const stateKey = process.env.STATE_KEY;
if (!stateKey) {
  console.error('Falta STATE_KEY (en el entorno o en .env).');
  process.exit(2);
}

const sql = [];
const summary = {};
const now = Date.now();

// 1) Ofertas vistas (en claro en la rama state).
const seenBuf = readState('seen.json');
if (!seenBuf) {
  console.error('No se encontró seen.json en el estado de origen.');
  process.exit(1);
}
const seenIds = JSON.parse(seenBuf.toString('utf8')).seen.map(String).filter((id) => /^\d{1,12}$/.test(id));
for (const id of seenIds) sql.push(`INSERT OR IGNORE INTO seen (id, first_seen, status, attempts) VALUES (${q(id)}, ${now}, 'done', 0)`);
summary.seen = seenIds.length;

if (!flag('--seen-only')) {
  const vault = await makeVault(stateKey);

  // 2) Suscriptores y chats autorizados (cifrados en la rama state).
  const subsBuf = readState('seen.json.subs.enc');
  const subs = subsBuf ? oldDecrypt(subsBuf, stateKey) : {};
  let nSubs = 0;
  for (const [chat, s] of Object.entries(subs)) {
    if (!/^-?\d+$/.test(chat)) continue;
    const hash = await vault.chatHash(chat);
    const enc = await vault.seal('subs', hash, { chat, all: !!s.all, profiles: Array.isArray(s.profiles) ? s.profiles.filter((p) => typeof p === 'string') : [] });
    sql.push(`INSERT OR REPLACE INTO subs (chat_hash, enc, version, updated) VALUES (${q(hash)}, ${q(enc)}, 1, ${now})`);
    nSubs++;
  }
  summary.subs = nSubs;

  const chatsBuf = readState('seen.json.chats.enc');
  const chats = chatsBuf ? oldDecrypt(chatsBuf, stateKey) : [];
  let nChats = 0;
  for (const chat of chats.map(String)) {
    if (!/^-?\d+$/.test(chat)) continue;
    const hash = await vault.chatHash(chat);
    sql.push(`INSERT OR REPLACE INTO chats (chat_hash, enc, added) VALUES (${q(hash)}, ${q(await vault.seal('chats', hash, { chat }))}, ${now})`);
    nChats++;
  }
  summary.chats = nChats;

  // 3) Caché de ofertas: se reconstruye desde la API de EPM con el código nuevo (incluye los requisitos).
  if (arg('--offers', 'live') === 'live') {
    const env = { EPM_API: process.env.EPM_API };
    const jobs = await fetchListing(env);
    let n = 0;
    for (const j of jobs) {
      let lite = null;
      try {
        lite = liteFromDetail(await fetchDetail(env, j.Id));
      } catch {
        // sin detalle: el cron la completará
      }
      sql.push(`INSERT OR REPLACE INTO offers (id, job, lite, updated) VALUES (${q(String(j.Id))}, ${q(JSON.stringify(jobFromListing(j)))}, ${q(lite ? JSON.stringify(lite) : null)}, ${now})`);
      n++;
    }
    summary.offers = n;
  }
}

writeFileSync(out, sql.join(';\n') + ';\n');
console.log(`SQL generado: ${out}`);
console.log(Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join(' | '));
