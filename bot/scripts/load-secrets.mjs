#!/usr/bin/env node
// Carga en el Worker los secretos que ya tienes en .env (sin imprimirlos ni pasarlos por argumentos: van por entrada estándar).
//
//   node bot/scripts/load-secrets.mjs            (desde la raíz del repositorio)
//
// Equivale a ejecutar `npx wrangler secret put NOMBRE -c wrangler.local.toml` para cada uno y pegar el valor.
// Origen en .env -> nombre del secreto en el Worker:
//   TELEGRAM_BOT_TOKEN       -> TELEGRAM_BOT_TOKEN
//   TELEGRAM_WEBHOOK_SECRET  -> WEBHOOK_SECRET      (el mismo valor que ya usa el webhook actual)
//   STATE_KEY                -> STATE_KEY
//   TELEGRAM_CHAT_ID         -> TELEGRAM_CHAT_ID    (el primero es el administrador)
//   GH_BACKUP_TOKEN          -> GH_BACKUP_TOKEN     (opcional: token fine-grained con "Contents: Read and write" para los respaldos)
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(bot, '../.env');
if (!existsSync(envFile)) {
  console.error('No existe .env en la raíz del repositorio.');
  process.exit(1);
}
const env = {};
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
}
const map = [
  ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', true],
  ['TELEGRAM_WEBHOOK_SECRET', 'WEBHOOK_SECRET', true],
  ['STATE_KEY', 'STATE_KEY', true],
  ['TELEGRAM_CHAT_ID', 'TELEGRAM_CHAT_ID', true],
  ['GH_BACKUP_TOKEN', 'GH_BACKUP_TOKEN', false],
];
const config = existsSync(resolve(bot, 'wrangler.local.toml')) ? 'wrangler.local.toml' : 'wrangler.toml';
let failed = 0;
for (const [from, name, required] of map) {
  const value = env[from];
  if (!value) {
    console.log(`${required ? '✗' : '·'} ${name}: ${required ? 'falta' : 'sin valor (omitido)'} en .env (${from})`);
    if (required) failed++;
    continue;
  }
  const r = spawnSync(process.execPath, [resolve(bot, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'put', name, '-c', config], { cwd: bot, input: value, encoding: 'utf8' });
  const ok = r.status === 0 && /Success|Uploaded/i.test(r.stdout + r.stderr);
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    failed++;
    console.error((r.stdout + r.stderr).replaceAll(value, '***').split('\n').filter((l) => /error|ERROR/.test(l)).slice(0, 3).join('\n'));
  }
}
process.exit(failed ? 1 : 0);
