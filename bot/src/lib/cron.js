// Revisión periódica de ofertas (Cron Trigger). Es ligera a propósito (límite de 10 ms de CPU): consulta el listado,
// lo compara con D1 y encola el trabajo pesado (detalle, tarjeta, reparto de avisos) para el consumidor de la cola.
import { fetchListing } from './epm.js';
import { jobFromListing } from './offer.js';
import { adminId } from './handlers.js';

const MAX_FILL = 6; // ofertas ya vistas sin datos en caché que se rellenan por ejecución
const PENDING_MS = 15 * 60 * 1000; // una oferta "pendiente" tanto tiempo se vuelve a encolar
const MAX_ATTEMPTS = 3;

async function registerCommands(c) {
  const { tg } = c;
  await tg.call('setMyDescription', {
    description:
      '👋 Escribe /start para activar las notificaciones y ver las ofertas de empleo de EPM.\n\n' +
      'Proyecto personal y educativo, no oficial: no está afiliado a EPM. Las postulaciones se hacen siempre en la página de empleo de EPM.',
  });
  await tg.call('setMyShortDescription', { short_description: 'Avisos de ofertas de empleo de EPM. Proyecto personal, no oficial.' });
  await tg.call('setMyCommands', {
    commands: [
      { command: 'comandos', description: 'Menú con botones' },
      { command: 'ofertas', description: 'Ver ofertas activas' },
      { command: 'perfiles', description: 'Elegir carrera o cargo y ver sus ofertas' },
      { command: 'suscribir', description: 'Recibir avisos de ofertas nuevas' },
      { command: 'ayuda', description: 'Ayuda' },
    ],
  });
}

// dry = true: calcula y devuelve qué haría, sin escribir ni encolar (sirve para probar antes del corte).
export async function runCron(c, { dry = false, forceBackup = false } = {}) {
  const { env, db, budget } = c;
  const meta = await db.getMetas(['live', 'cmds', 'epm_fail', 'last_backup']);
  if (meta.live !== '1' && !dry) return { skipped: 'live=0' };

  let jobs;
  try {
    jobs = await fetchListing(env, { budget });
  } catch (e) {
    if (dry) return { error: `EPM: ${e.message}` };
    const n = Number(meta.epm_fail || 0) + 1;
    await db.setMeta('epm_fail', n);
    await db.event('error', `EPM no respondió (${e.message}); fallos seguidos: ${n}`);
    db.stats.cron_runs = 1;
    // tras ~1,5 h sin respuesta se avisa al administrador, una sola vez
    if (n === 3) await c.tg.send(adminId(env), '⚠️ <b>EPM no responde</b> desde hace ~1,5 h (3 revisiones seguidas). Sigo intentándolo cada 30 min.').catch(() => {});
    await db.flushUsage().catch(() => {});
    return { error: e.message, fails: n };
  }

  const [seenRows, offerRows] = await Promise.all([db.seenRows(), db.all('SELECT id FROM offers')]);
  const seen = new Map(seenRows.map((r) => [r.id, r]));
  const haveOffer = new Set(offerRows.map((r) => r.id));
  const now = Date.now();
  const byId = new Map(jobs.map((j) => [String(j.Id), j]));

  const fresh = jobs.filter((j) => !seen.has(String(j.Id)));
  const retry = seenRows.filter((r) => r.status === 'pending' && byId.has(r.id) && now - r.first_seen > PENDING_MS && r.attempts < MAX_ATTEMPTS);
  const fill = jobs.filter((j) => seen.get(String(j.Id))?.status === 'done' && !haveOffer.has(String(j.Id))).slice(0, MAX_FILL);

  const msgs = [
    ...fresh.map((j) => ({ body: { t: 'offer', id: String(j.Id), job: jobFromListing(j), notify: true } })),
    ...retry.map((r) => ({ body: { t: 'offer', id: r.id, job: jobFromListing(byId.get(r.id)), notify: true } })),
    ...fill.map((j) => ({ body: { t: 'offer', id: String(j.Id), job: jobFromListing(j), notify: false } })),
  ];

  const d = new Date(now);
  const today = d.toISOString().slice(0, 10);
  const backupDue = forceBackup || (d.getUTCDay() === 0 && d.getUTCHours() === 3 && d.getUTCMinutes() < 30 && meta.last_backup !== today);
  const summary = { listing: jobs.length, fresh: fresh.length, retry: retry.length, fill: fill.length, backupDue, ids: { fresh: fresh.map((j) => String(j.Id)) } };
  if (dry) return { dry: true, ...summary };

  // 1) primero se encola (si falla, la oferta sigue sin marcarse y se reintenta en la siguiente ejecución)
  if (msgs.length) for (let i = 0; i < msgs.length; i += 100) await env.JOBS.sendBatch(msgs.slice(i, i + 100));
  if (backupDue) await env.JOBS.send({ t: 'backup' });

  // 2) después se reclaman en una sola escritura atómica
  const stmts = [
    ...fresh.map((j) => db.seenClaimStmt(j.Id, now)),
    ...retry.map((r) => db.seenRetryStmt(r.id)),
  ];
  // Si EPM devolviera un listado vacío por error, no se vacía la caché de ofertas.
  if (jobs.length) stmts.push(db.pruneOffersStmt([...byId.keys()]));
  if (meta.epm_fail && meta.epm_fail !== '0') stmts.push(db.stmt("UPDATE meta SET v = '0' WHERE k = 'epm_fail'"));
  if (backupDue) {
    stmts.push(db.stmt("INSERT INTO meta (k, v) VALUES ('last_backup', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", today));
  }
  if (stmts.length) await db.batch(stmts);
  if (backupDue) await db.prune();

  if (meta.cmds !== 'v2') {
    try {
      await registerCommands(c);
      await db.setMeta('cmds', 'v2');
    } catch (e) {
      await db.event('error', `registro de comandos: ${e.message}`);
    }
  }
  db.stats.cron_runs = 1;
  await db.flushUsage();
  return { ...summary, d1: { reads: db.stats.reads, writes: db.stats.writes, queries: db.stats.queries } };
}
