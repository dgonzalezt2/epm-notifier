#!/usr/bin/env node
// Copia de seguridad LOCAL de la base D1 (sin subir nada a GitHub): `wrangler d1 export` a una carpeta ignorada por git.
//
//   node bot/scripts/backup-local.mjs [--out <carpeta>] [--keep <n>] [--db epm-bot-db] [-c wrangler.local.toml]
//
// Por defecto escribe en bot/backups/d1-AAAA-MM-DD-HHMM.sql y conserva las últimas 12. El archivo contiene la base completa:
// las ofertas son datos públicos, pero suscriptores y chats van cifrados con STATE_KEY (sin esa clave no se pueden leer).
// Trátalo como sensible: no lo subas a ningún sitio y guarda STATE_KEY aparte. Cómo restaurar: bot/README.md, sección «Respaldo».
// Nota: mientras dura la exportación D1 bloquea las consultas (con esta base, una fracción de segundo).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const bot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (names, def = '') => {
  for (const n of [].concat(names)) {
    const i = process.argv.indexOf(n);
    if (i >= 0) return process.argv[i + 1] ?? def;
  }
  return def;
};
const db = arg('--db', 'epm-bot-db');
const config = arg(['-c', '--config'], 'wrangler.local.toml');
const outDir = resolve(arg('--out', resolve(bot, 'backups')));
const keep = Math.max(1, Number(arg('--keep', '12')) || 12);
const fail = (m) => {
  console.error('✖ ' + m);
  process.exit(1);
};

if (!existsSync(resolve(bot, config))) fail(`Falta ${config} en bot/ (copia wrangler.toml, pon tu database_id; está ignorado por git).`);
mkdirSync(outDir, { recursive: true });

// La carpeta de salida NO debe poder subirse al repositorio por accidente.
const probe = spawnSync('git', ['check-ignore', '-q', resolve(outDir, 'x.sql')], { cwd: bot });
if (probe.error?.code !== 'ENOENT' && probe.status === 1) fail(`La carpeta ${outDir} no está ignorada por git. Añádela a .gitignore o usa --out bot/backups.`);

const now = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
const file = resolve(outDir, `d1-${stamp}.sql`);

const wr = resolve(bot, 'node_modules/wrangler/bin/wrangler.js');
if (!existsSync(wr)) fail('Falta wrangler: ejecuta `npm install` en bot/.');
const r = spawnSync(process.execPath, [wr, 'd1', 'export', db, '-c', config, '--remote', '--output', file], { cwd: bot, encoding: 'utf8' });
if (r.status !== 0 || !existsSync(file)) {
  rmSync(file, { force: true });
  fail('wrangler d1 export falló:\n' + String(r.stderr || r.stdout).split('\n').filter((l) => /error|✘|ERROR/i.test(l)).slice(0, 4).join('\n'));
}

// Comprobación mínima: tiene las tablas y no está vacío (nunca se imprime su contenido).
const sql = readFileSync(file, 'utf8');
const tables = ['meta', 'seen', 'offers', 'subs', 'chats'];
const missing = tables.filter((t) => !new RegExp(`CREATE TABLE\\s+"?${t}"?`, 'i').test(sql));
if (missing.length) {
  rmSync(file, { force: true });
  fail(`El archivo exportado no tiene las tablas: ${missing.join(', ')}. Se ha descartado.`);
}
const rows = Object.fromEntries(tables.map((t) => [t, (sql.match(new RegExp(`^INSERT INTO "?${t}"?[ (]`, 'gim')) || []).length]));

// Se conservan solo las últimas `keep` copias.
const all = readdirSync(outDir).filter((f) => /^d1-\d{4}-\d{2}-\d{2}-\d{4}\.sql$/.test(f)).sort();
for (const f of all.slice(0, Math.max(0, all.length - keep))) rmSync(resolve(outDir, f), { force: true });

console.log(`✔ Copia guardada: ${relative(process.cwd(), file) || file} (${(statSync(file).size / 1024).toFixed(1)} KB)`);
console.log(`  filas: ${tables.map((t) => `${t}=${rows[t]}`).join(' · ')}`);
console.log(`  copias conservadas: ${Math.min(all.length, keep)} (máx. ${keep}) en ${outDir}`);
