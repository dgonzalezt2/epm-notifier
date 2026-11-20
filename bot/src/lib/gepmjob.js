// Revisión de las convocatorias de la Fundación EPM (consumidor de la cola: aquí sí hay CPU de sobra; el cron solo encola «revisar»).
//
// Orden seguro del estado: se guarda lo leído (una escritura atómica) y DESPUÉS se encolan los avisos; una convocatoria solo pasa a
// «avisada» cuando sus avisos ya están en la cola. Si algo se corta en medio, la siguiente revisión la encuentra pendiente y la
// reintenta, y el reparto no puede duplicar porque cada par (convocatoria, destinatario) se reclama en D1 antes de enviar.
//
// Modo (meta `gepm_mode`): off = no hace nada · test = revisa y guarda, y el aviso de cada convocatoria nueva sale SOLO al
// administrador · live = además avisa a los suscriptores de GrupoEPM.
import { fetchGepm, parseGepm, reconcile, formatGepm, gepmData, isOpenGepm, GepmError } from './gepm.js';
import { adminId } from './handlers.js';
import { esc } from './util.js';
import { makeVault } from './crypto.js';

const CHUNK = 35; // igual que los avisos de ofertas: caben en las 50 subpeticiones de una invocación
const RETRY_MS = 15 * 60_000; // tras un fallo de red
const ALERT_COOLDOWN_MS = 12 * 3600_000; // un aviso al administrador como máximo cada 12 h

export const gepmIntervalMs = (env) => (Number(env.GEPM_EVERY_MIN) > 0 ? Number(env.GEPM_EVERY_MIN) : 60) * 60_000;

// Alerta SOLO al administrador, con enfriamiento, y sin contenido de la página ni datos de usuarios.
async function alertAdmin(c, meta, now, text) {
  if (now - Number(meta.gepm_alert || 0) < ALERT_COOLDOWN_MS) return;
  try {
    await c.tg.send(adminId(c.env), text);
    await c.db.setMeta('gepm_alert', now);
  } catch {
    // si Telegram falla, se intentará en la siguiente revisión
  }
}

async function failure(c, meta, code, now, retryMs) {
  const { db } = c;
  const n = Number(meta.gepm_fail || 0) + 1;
  await db.batch([db.metaStmt('gepm_fail', n), db.metaStmt('gepm_next', now + retryMs)]);
  await db.event('error', `GrupoEPM: ${code} (fallos seguidos: ${n})`);
  if (code === 'estructura') {
    await alertAdmin(c, meta, now, '⚠️ <b>GrupoEPM</b>: la página respondió pero no encontré ninguna convocatoria (¿cambió el formato?). No he marcado ni avisado nada. Vuelvo a revisar en 1 h.');
  } else if (n >= 3) {
    await alertAdmin(c, meta, now, `⚠️ <b>GrupoEPM</b>: no consigo leer la página desde hace ${n} revisiones seguidas (motivo: ${esc(code)}). Sigo intentándolo.`);
  }
  return { ok: false, code };
}

async function subscriberHashes(c) {
  c.vault ??= await makeVault(c.env.STATE_KEY); // solo se necesita al repartir a suscriptores (modo live)
  const out = [];
  let after = '';
  for (let page = 0; page < 20; page++) {
    const p = await c.db.subsPage(c.vault, after, 500);
    for (const s of p.items) if (s.gepm) out.push(s.hash);
    if (p.n < 500) break;
    after = p.last;
  }
  return out;
}

export async function processGepm(c) {
  const { env, db, budget } = c;
  const now = c.now();
  const meta = await db.getMetas(['gepm_mode', 'gepm_etag', 'gepm_init', 'gepm_fail', 'gepm_alert']);
  const mode = meta.gepm_mode;
  if (mode !== 'test' && mode !== 'live') return { skipped: 'off' };

  const rows = await db.gepmRows();
  let page;
  try {
    // Con la caché vacía no se usa la petición condicional: hace falta el cuerpo completo.
    page = await fetchGepm(env, { budget, etag: rows.length ? meta.gepm_etag || null : null });
  } catch (e) {
    return failure(c, meta, e instanceof GepmError ? e.code : 'error', now, RETRY_MS);
  }

  let parsed = null;
  if (!page.notModified) {
    parsed = parseGepm(page.text, { complete: page.complete });
    // 200 pero ninguna convocatoria legible: no se marca nada ni se avisa (≠ «no hay vigentes», que sí tiene convocatorias).
    if (!parsed.items.length) return failure(c, meta, 'estructura', now, gepmIntervalMs(env));
  }
  const baseline = meta.gepm_init !== '1';
  const plan = parsed ? reconcile(parsed.items, rows, now, { baseline }) : { inserts: [], updates: [], demote: [] };

  // 1) Lo leído se guarda en una sola escritura atómica.
  const stmts = [
    ...plan.inserts.map((x) => db.gepmInsertStmt(x.item, x.notify, now)),
    ...plan.updates.map((it) => db.gepmUpdateStmt(it, now)),
    ...plan.demote.map((id) => db.gepmNotifyStmt(id, 'pending', 'none')),
    db.metaStmt('gepm_ok', now),
    db.metaStmt('gepm_next', now + gepmIntervalMs(env)),
  ];
  // Solo se escribe lo que cambia (cada escritura cuenta para el límite diario de D1).
  if (meta.gepm_fail && meta.gepm_fail !== '0') stmts.push(db.metaStmt('gepm_fail', 0));
  if (page.etag && page.etag !== meta.gepm_etag) stmts.push(db.metaStmt('gepm_etag', page.etag));
  if (baseline) stmts.push(db.metaStmt('gepm_init', '1'));
  await db.batch(stmts);
  if (parsed?.bad.length) {
    await alertAdmin(c, meta, now, `⚠️ <b>GrupoEPM</b>: ${parsed.bad.length} encabezado(s) de convocatoria con un formato que no reconozco (se ignoran, sin avisar). ¿Cambió la página?`);
  }

  // 2) Después, los avisos pendientes (también los de revisiones anteriores que se cortaron).
  // Pendientes de avisar, calculadas en memoria (sin otra consulta a D1): las de revisiones anteriores que siguen vigentes
  // (con los datos más recientes de la página si aparecen en ella) y las que acaban de insertarse como pendientes.
  const demoted = new Set(plan.demote);
  const latest = new Map((parsed?.items ?? []).map((it) => [it.id, it]));
  const pending = [];
  for (const old of rows) {
    if (old.notify !== 'pending' || demoted.has(old.id)) continue;
    const it = latest.get(old.id);
    let data = it ? gepmData(it) : null;
    if (!data) {
      try {
        data = JSON.parse(old.data);
      } catch {
        continue; // fila dañada: se ignora
      }
    }
    const row = { id: old.id, closes: it ? it.closes : old.closes, status: it ? it.status : old.status, data, tested: old.tested };
    if (isOpenGepm(row, now)) pending.push(row);
  }
  for (const x of plan.inserts) if (x.notify === 'pending') pending.push({ id: x.item.id, closes: x.item.closes, status: x.item.status, data: gepmData(x.item), tested: 0 });
  const hashes = mode === 'live' && pending.length ? await subscriberHashes(c) : [];
  let queued = 0;
  for (const p of pending) {
    const html = formatGepm(p, { isNew: true, now });
    const key = `g:${p.id}`;
    if (mode === 'test') {
      if (p.tested) continue; // el aviso de prueba ya se encoló una vez
      await env.JOBS.send({ t: 'notify', offer: key, html, hashes: [], admin: true });
      await db.run('UPDATE gepm SET tested = 1 WHERE id = ?', p.id);
      queued++;
      continue;
    }
    const messages = [];
    for (let i = 0; i < hashes.length; i += CHUNK) messages.push({ t: 'notify', offer: key, html, hashes: hashes.slice(i, i + CHUNK), admin: false });
    for (let i = 0; i < messages.length; i += 100) await env.JOBS.sendBatch(messages.slice(i, i + 100).map((body) => ({ body })));
    await db.batch([db.gepmNotifyStmt(p.id, 'pending', 'done')]);
    queued++;
  }
  return { ok: true, notModified: !!page.notModified, found: parsed?.items.length ?? 0, bad: parsed?.bad.length ?? 0, inserted: plan.inserts.length, updated: plan.updates.length, queued, mode };
}
