// Respaldo semanal de D1: exportación CIFRADA (AES-GCM con una clave derivada de STATE_KEY) a la rama `d1-backup`
// del repositorio, usando la API de contenidos de GitHub. Reutiliza un token con permiso "Contents: Read and write"
// (GH_BACKUP_TOKEN); sin él, el respaldo se omite y solo queda Time Travel de D1 (7 días en el plan gratuito).
const BRANCH = 'd1-backup';
const KEEP = 8;

async function gh(c, method, path, body) {
  const { env, budget } = c;
  budget.use();
  const res = await fetch(`${env.GITHUB_API || 'https://api.github.com'}/repos/${env.GITHUB_REPO}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.GH_BACKUP_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'epm-bot-backup',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, j };
}

async function ensureBranch(c) {
  const ref = await gh(c, 'GET', `/git/ref/heads/${BRANCH}`);
  if (ref.ok) return;
  if (ref.status !== 404) throw new Error(`respaldo: GitHub ${ref.status} al leer la rama`);
  // Rama huérfana (sin el código del repositorio): blob -> árbol -> commit sin padres -> referencia.
  const blob = await gh(c, 'POST', '/git/blobs', { content: 'Respaldos cifrados de la base D1 (AES-GCM). No editar a mano.\n', encoding: 'utf-8' });
  const tree = await gh(c, 'POST', '/git/trees', { tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob.j.sha }] });
  const commit = await gh(c, 'POST', '/git/commits', { message: 'Crea la rama de respaldos', tree: tree.j.sha, parents: [] });
  const made = await gh(c, 'POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: commit.j.sha });
  if (!made.ok) throw new Error(`respaldo: no se pudo crear la rama (${made.status})`);
}

export async function doBackup(c) {
  const { env, db, vault } = c;
  if (!env.GH_BACKUP_TOKEN || !env.GITHUB_REPO) {
    await db.event('info', 'respaldo omitido: falta GH_BACKUP_TOKEN');
    return;
  }
  const sealed = await vault.sealBackup(await db.exportAll()); // "v1.<base64>" (ASCII)
  await ensureBranch(c);
  const day = new Date().toISOString().slice(0, 10);
  const path = `backups/d1-${day}.enc`;
  const existing = await gh(c, 'GET', `/contents/${path}?ref=${BRANCH}`);
  const put = await gh(c, 'PUT', `/contents/${path}`, {
    message: `respaldo ${day}`,
    content: btoa(sealed),
    branch: BRANCH,
    ...(existing.ok && existing.j.sha ? { sha: existing.j.sha } : {}),
  });
  if (!put.ok) throw new Error(`respaldo: GitHub ${put.status} al guardar`);

  // Se conservan los últimos KEEP respaldos.
  const list = await gh(c, 'GET', `/contents/backups?ref=${BRANCH}`);
  if (list.ok && Array.isArray(list.j)) {
    const old = list.j.filter((f) => /^d1-\d{4}-\d{2}-\d{2}\.enc$/.test(f.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, -KEEP);
    for (const f of old.slice(0, 3)) await gh(c, 'DELETE', `/contents/${f.path}`, { message: `elimina ${f.name}`, sha: f.sha, branch: BRANCH });
  }
  await db.event('info', `respaldo guardado (${day})`);
}
