#!/usr/bin/env node
// Vuelta atrás: copia a la rama `state` las ofertas que el sistema NUEVO ya avisó, para que el sistema viejo
// (GitHub Actions) no las repita al reactivarlo. Es el único momento en que se escribe en esa rama.
//
//   node bot/scripts/rollback-seen.mjs --ids <archivo.json>                  (muestra qué cambiaría; no escribe)
//   node bot/scripts/rollback-seen.mjs --ids <archivo.json> --push           (actualiza seen.json en `state`)
//
// Ejecútalo desde la raíz del repositorio (o pasa --repo <ruta>). <archivo.json> es el resultado de:
//   wrangler d1 execute epm-bot-db -c wrangler.local.toml --remote --json --command "SELECT id FROM seen"
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const arg = (n, d = '') => {
  const i = process.argv.indexOf(n);
  return i < 0 ? d : process.argv[i + 1] ?? '';
};
// Se opera sobre el repositorio del directorio actual (o --repo): ejecútalo desde la raíz del repo.
const repo = resolve(arg('--repo', process.cwd()));
const git = (args, opts = {}) => spawnSync('git', args, { cwd: opts.cwd || repo, encoding: 'utf8', ...opts });

const idsFile = arg('--ids');
if (!idsFile) {
  console.error('Uso: node bot/scripts/rollback-seen.mjs --ids <archivo.json> [--push] [--remote origin]');
  process.exit(2);
}
const remote = arg('--remote', 'origin');
const raw = JSON.parse(readFileSync(idsFile, 'utf8'));
const rows = (Array.isArray(raw) ? raw[0] : raw).results || [];
const d1Ids = rows.map((r) => String(r.id)).filter((id) => /^\d{1,12}$/.test(id));

git(['fetch', '-q', remote, 'state']);
const cur = git(['show', `${remote}/state:seen.json`]);
if (cur.status !== 0) {
  console.error('No se pudo leer seen.json de la rama state.');
  process.exit(1);
}
const state = JSON.parse(cur.stdout);
const before = new Set(state.seen.map(String));
const added = d1Ids.filter((id) => !before.has(id));
console.log(`ofertas en D1: ${d1Ids.length} | ya en state: ${before.size} | a añadir: ${added.length}`);
if (!process.argv.includes('--push')) {
  console.log('(simulación: no se escribió nada; usa --push para actualizar la rama state)');
  process.exit(0);
}
if (!added.length) {
  console.log('Nada que añadir.');
  process.exit(0);
}

// Se trabaja en un worktree temporal para no tocar el árbol de trabajo.
const tmp = mkdtempSync(resolve(tmpdir(), 'epm-rollback-'));
try {
  let r = git(['worktree', 'add', '-q', '--detach', tmp, `${remote}/state`]);
  if (r.status !== 0) throw new Error('worktree: ' + r.stderr);
  const next = { ...state, updated: new Date().toISOString(), seen: [...before, ...added] };
  writeFileSync(resolve(tmp, 'seen.json'), JSON.stringify(next, null, 2));
  git(['config', 'user.name', 'rollback'], { cwd: tmp });
  git(['config', 'user.email', 'rollback@users.noreply.github.com'], { cwd: tmp });
  git(['add', 'seen.json'], { cwd: tmp });
  r = git(['commit', '-q', '-m', 'state: ofertas vistas por el sistema nuevo (vuelta atrás) [skip ci]'], { cwd: tmp });
  if (r.status !== 0) throw new Error('commit: ' + r.stderr);
  r = git(['push', '-q', remote, 'HEAD:state'], { cwd: tmp });
  if (r.status !== 0) throw new Error('push: ' + r.stderr);
  console.log(`Rama state actualizada con ${added.length} ofertas.`);
} finally {
  git(['worktree', 'remove', '--force', tmp]);
  rmSync(tmp, { recursive: true, force: true });
}
