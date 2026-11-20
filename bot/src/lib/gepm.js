// Convocatorias de la Fundación EPM («GrupoEPM»): https://www.grupo-epm.com/fundacion-grupo-epm/trabaja-con-nosotros/convocatorias/
// Es una fuente DISTINTA del portal Oracle HCM. La página es HTML estático (Adobe Experience Manager), de la convocatoria más
// nueva a la más vieja; cada convocatoria es un <h3 class="cmp-title__text"> con enlace al PDF del perfil, seguido de su
// descripción y del enlace «¡Postúlate aquí!». Las «Notificaciones» (resultados de etapas, fe de erratas, cancelaciones) son
// bloques <div class="document"> con otro <h3> sin esa clase: no son convocatorias.
//
// Todo lo que viene de la página es contenido externo NO confiable: se lee como flujo y se corta en cuanto hay suficientes
// convocatorias, se limpia (etiquetas y entidades), se recorta y se escapa al enviarlo. Los enlaces solo se aceptan si son https y
// su host está en la lista permitida. Estas funciones son puras salvo fetchGepm (lectura de la red).
import { esc, escAttr, scrub, clipWord, norm } from './util.js';
import { closing, fmtDay, bogotaDay } from './dates.js';

export const GEPM_URL = 'https://www.grupo-epm.com/fundacion-grupo-epm/trabaja-con-nosotros/convocatorias/';
const GEPM_BASE = 'https://www.grupo-epm.com/';
const ALLOWED_HOSTS = new Set(['www.grupo-epm.com', 'login.airavirtual.com']);
export const MAX_BYTES = 160_000; // se deja de leer pasado este tamaño (la página completa pesa ~600 KB)
export const MAX_CONV = 12; // ...o tras este número de convocatorias (la más nueva va primero)
const MAX_SEGMENT = 40_000; // caracteres máximos de una convocatoria (si es mayor se recorta)
const H_OPEN = '<h3 class="cmp-title__text">';
const UA = 'epm-notifier/1.0 (+https://github.com/dgonzalezt2/epm-notifier; proyecto personal y educativo)';

export class GepmError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GepmError';
    this.code = code;
  }
}

// ---------- texto externo -> texto limpio ----------
const NAMED = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', ordm: 'º', ordf: 'ª', iexcl: '¡', iquest: '¿', ndash: '–', mdash: '—', hellip: '…',
};
// Una sola pasada: «&amp;lt;» queda como «&lt;» (texto), nunca como «<».
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? m;
  });
}
// Etiquetas fuera, entidades decodificadas, sin caracteres de control. El resultado es TEXTO: se escapa al mostrarlo.
// También se quitan los caracteres que invierten o ocultan texto (U+202E, espacios de ancho cero...): sirven para suplantar enlaces.
export const cleanText = (html) => scrub(decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/[​-‏‪-‮⁦-⁩﻿]/g, ''));

// Enlace permitido: https, host de la lista, sin credenciales ni puerto. Devuelve la URL normalizada o null.
export function safeLink(href, base = GEPM_BASE) {
  const raw = decodeEntities(href).trim();
  if (!raw || raw.length > 600) return null;
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return null;
    return u.href.length > 700 ? null : u.href;
  } catch {
    return null;
  }
}

// ---------- fechas en español ----------
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function monthOf(tok) {
  const t = norm(tok).replace(/\./g, '');
  if (t === 'setiembre' || t === 'set') return 9;
  if (t.length < 3) return 0;
  const i = MONTHS.findIndex((m) => m.startsWith(t));
  return i + 1; // 0 si no es un mes
}
// «Fecha de cierre domingo 22 de noviembre de 2026 - 23:59 hrs.» -> instante (UTC) del fin de ese minuto en Bogotá.
// El nombre del día se ignora (se confía en la fecha). Sin hora, se toma el final de ese día. null si no se puede leer.
const DATE_RE = /fecha\s+de\s+cierre\s*:?\s*(?:[a-záéíóúñ]+\s*,?\s+)?(\d{1,2})\s+(?:de\s+)?([a-záéíóúñ]+)\.?,?\s+(?:de\s+|del\s+)?(\d{4})(.*)$/i;
const TIME_RE = /(\d{1,2})\s*[:.hH]\s*(\d{2})\s*(a\.?\s*m\.?|p\.?\s*m\.?)?/i;
export function parseClosing(text) {
  const m = DATE_RE.exec(String(text ?? ''));
  if (!m) return null;
  const d = +m[1];
  const mo = monthOf(m[2]);
  const y = +m[3];
  if (!mo || y < 2000 || y > 2100 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null; // 31 de febrero, etc.
  let hh = 23;
  let mm = 59;
  let hasTime = false;
  const t = TIME_RE.exec(m[4] || '');
  if (t) {
    hh = +t[1];
    mm = +t[2];
    const mer = (t[3] || '').toLowerCase().replace(/[\s.]/g, '');
    if (mm > 59 || hh > 23) return null;
    if (mer === 'pm' && hh < 12) hh += 12;
    else if (mer === 'am' && hh === 12) hh = 0;
    else if (mer && hh > 12) return null;
    hasTime = true;
  }
  // Bogotá es UTC-5 todo el año: la hora local + 5 es la hora UTC. Se incluye el minuto completo (…:59,999).
  const ms = Date.UTC(y, mo - 1, d, hh + 5, mm, 59, 999);
  return { ms, hasTime, y, mo, d };
}

// ---------- lectura de la página (flujo parcial + petición condicional) ----------
// Devuelve { notModified: true } con 304, o { text, etag, complete, bytes }. Lanza GepmError('http_NNN'|'red'|'tipo'|'redirige').
export async function fetchGepm(env, { budget, etag = null, timeout = 12000 } = {}) {
  budget?.use();
  const url = env.GEPM_URL || GEPM_URL;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html', ...(etag ? { 'if-none-match': etag } : {}) },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new GepmError(e?.name === 'TimeoutError' ? 'timeout' : 'red');
  }
  if (res.status === 304) return { notModified: true };
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new GepmError(`http_${res.status}`);
  }
  // Una redirección a otro sitio no se acepta (el contenido solo vale si viene del sitio esperado).
  if (!env.GEPM_URL && res.url && new URL(res.url).hostname !== new URL(GEPM_URL).hostname) {
    res.body?.cancel().catch(() => {});
    throw new GepmError('redirige');
  }
  if (!/text\/html/i.test(res.headers.get('content-type') || '') || !res.body) {
    res.body?.cancel().catch(() => {});
    throw new GepmError('tipo');
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;
  let heads = 0;
  let scan = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        text += dec.decode();
        complete = true;
        break;
      }
      bytes += value.length;
      text += dec.decode(value, { stream: true });
      for (let i; (i = text.indexOf(H_OPEN, scan)) >= 0; ) {
        heads++;
        scan = i + H_OPEN.length;
      }
      scan = Math.max(scan, text.length - H_OPEN.length);
      // Una cabecera de más basta para saber que las anteriores están completas.
      if (heads > MAX_CONV || bytes >= MAX_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    throw new GepmError('red');
  }
  // Se leyó de más (el último trozo puede traer varias convocatorias): se corta justo ANTES de la número MAX_CONV + 1, de modo que
  // siempre se usan exactamente las MAX_CONV más nuevas y la última queda completa (el texto termina en un límite de convocatoria).
  if (!complete) {
    let cut = -1;
    let n = 0;
    for (let i = text.indexOf(H_OPEN); i >= 0; i = text.indexOf(H_OPEN, i + H_OPEN.length)) if (++n > MAX_CONV) { cut = i; break; }
    if (cut >= 0) {
      text = text.slice(0, cut);
      complete = true;
    }
  }
  return { text, etag: res.headers.get('etag'), complete, bytes };
}

// ---------- análisis de la página ----------
const WORDS = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };
// La mirada hacia delante va ANTES de \s* para que el motor no pueda "saltársela" retrocediendo un espacio.
const CITY_RE = /en\s+la\s+ciudad\s+de\s+([^,.]+?)\s*(?:,(?!\s*(?:el\s+cargo|sin\s+embargo))\s*([^,.]+?))?\s*,\s*(?:el\s+cargo|sin\s+embargo)/i;
const WHERE_RE = /el\s+cargo\s+se\s+desarrollar[aá]\s+principalmente\s+en\s+(.+?)\s*,\s*sin\s+embargo/i;
const COND_RE = /exclusivamente|aplica\s+para|dirigid[ao]\s+a\b|residentes?\b|discapacidad/i;

function parseHeading(inner) {
  const href = /<a\b[^>]*\bhref="([^"]*)"/i.exec(inner)?.[1] ?? null;
  const txt = cleanText(inner).replace(/se abre en una pesta[ñn]a nueva/gi, '').replace(/\s+/g, ' ').trim();
  const mn = /^(\d{3})-(\d{2})\s+(.+)$/.exec(txt);
  if (!mn) return { ignore: !/fecha\s+de\s+cierre/i.test(txt), bad: 'encabezado' };
  const rest = mn[3];
  const ms = /^(.*?)\s*:\s*(Fecha\s+de\s+cierre\b.*|Cerrad[oa]\s*\.?|Cancelad[oa]\s*\.?)\s*$/i.exec(rest);
  if (!ms || !ms[1].trim()) return { bad: 'titulo' };
  const out = { id: `${mn[1]}-${mn[2]}`, title: clipWord(ms[1].trim(), 120), pdf: safeLink(href), status: 'dated', closes: null, hasTime: false };
  const tail = ms[2];
  if (/^Cancelad/i.test(tail)) out.status = 'cancelled';
  else if (/^Cerrad/i.test(tail)) out.status = 'closed';
  else {
    const c = parseClosing(tail);
    if (!c) return { bad: 'fecha' };
    out.closes = c.ms;
    out.hasTime = c.hasTime;
  }
  return { item: out };
}

function parseBody(seg) {
  const body = seg.replace(/ data-cmp-data-layer="[^"]*"/g, '').slice(0, MAX_SEGMENT);
  const sep = body.indexOf('<div class="separator">');
  const region = sep >= 0 ? body.slice(0, sep) : body;
  const docAt = region.indexOf('<div class="document">');
  const desc = docAt >= 0 ? region.slice(0, docAt) : region;
  const docs = docAt >= 0 ? region.slice(docAt) : '';

  const cancelled = [...docs.matchAll(/<p\b[^>]*class="subtitle"[^>]*>([\s\S]*?)<\/p>/gi)].some((m) => /cancelaci[oó]n/i.test(cleanText(m[1])));
  const paras = [...desc.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => cleanText(m[1])).filter(Boolean);
  const items = [...desc.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => cleanText(m[1]).replace(/^[.\s]+|[.\s]+$/g, '')).filter(Boolean);

  const main = paras.find((p) => /se\s+requieren?\b/i.test(p)) || '';
  let people = null;
  const pm = /se\s+requieren?\s+[a-záéíóúñ]+\s*\(\s*(\d{1,3})\s*\)\s*persona/i.exec(main) || null;
  if (pm) people = +pm[1];
  else {
    const pw = /se\s+requieren?\s+([a-záéíóúñ]+)\s+persona/i.exec(main);
    if (pw && WORDS[norm(pw[1])]) people = WORDS[norm(pw[1])];
  }
  const cm = CITY_RE.exec(main);
  const city = cm ? clipWord(scrub(cm[2] ? `${cm[1]}, ${cm[2]}` : cm[1]), 80) : clipWord(scrub(/ciudad\s+de\s+([^,.]{2,60})/i.exec(main)?.[1] ?? ''), 80) || null;
  const wm = WHERE_RE.exec(main);
  const where = wm ? clipWord(scrub(wm[1]), 140) : null;

  // Condiciones especiales: la lista de «Esta convocatoria está dirigida a:» y las frases que lo indican.
  const conds = [];
  const listed = /dirigida\s+a\s*:/i.test(paras.join(' ')) ? items.slice(0, 4).map((x) => clipWord(x, 120)) : [];
  if (listed.length) conds.push(`Dirigida a: ${listed.join('; ')}`);
  for (const p of paras) {
    if (/p[uú]blico\s+objetivo|post[uú]late|dirigida\s+a\s*:/i.test(p)) continue;
    for (const sent of p.split(/(?<=[.!?])\s+/)) if (COND_RE.test(sent)) conds.push(clipWord(sent.replace(/\s*\.$/, ''), 160));
  }
  const uniq = [...new Set(conds)].slice(0, 3);

  let apply = null;
  for (const a of desc.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (/post[uú]late/i.test(cleanText(a[2]))) {
      apply = safeLink(a[1]);
      break;
    }
  }
  return { cancelled, people, city, where, conds: uniq, apply };
}

// Devuelve { items, bad, headings, partial }. `complete` = la lectura llegó al final de la página (no se cortó).
export function parseGepm(text, { complete = true } = {}) {
  const starts = [];
  for (let i = text.indexOf(H_OPEN); i >= 0; i = text.indexOf(H_OPEN, i + H_OPEN.length)) starts.push(i);
  const items = [];
  const bad = [];
  const seen = new Set();
  let partial = 0;
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k] + H_OPEN.length;
    const close = text.indexOf('</h3>', from);
    if (close < 0) {
      partial++;
      continue;
    }
    const last = k === starts.length - 1;
    if (last && !complete) {
      partial++; // lectura cortada: la última convocatoria puede estar incompleta, no se usa
      continue;
    }
    const h = parseHeading(text.slice(from, close));
    if (h.ignore) continue;
    if (h.bad) {
      bad.push(h.bad);
      continue;
    }
    if (seen.has(h.item.id)) continue;
    seen.add(h.item.id);
    const body = parseBody(text.slice(close + 5, last ? text.length : starts[k + 1]));
    const it = { ...h.item, ...body };
    if (it.cancelled) it.status = 'cancelled';
    delete it.cancelled;
    items.push(it);
  }
  return { items, bad, headings: starts.length, partial };
}

// ---------- vigencia y tarjeta ----------
export const isOpenGepm = (row, now = Date.now()) => row?.status === 'dated' && Number.isFinite(row.closes) && now <= row.closes;

// Lo que se guarda en D1 de cada convocatoria (el id, el cierre y el estado van en sus propias columnas).
export const gepmData = (it) => ({ title: it.title, people: it.people, city: it.city, where: it.where, conds: it.conds, pdf: it.pdf, apply: it.apply, hasTime: !!it.hasTime });

// Compara lo leído de la página con lo guardado y decide qué escribir. `baseline` = primera lectura: todo se guarda como visto
// (notify = 'none') sin avisar. Una convocatoria nueva ya cerrada, cancelada o sin fecha tampoco se avisa. Un cambio posterior
// (otra fecha de cierre, fe de erratas) solo actualiza los datos: nunca repite ni genera un aviso.
export function reconcile(items, rows, now, { baseline = false } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const inserts = [];
  const updates = [];
  const demote = [];
  for (const it of items) {
    const open = isOpenGepm(it, now);
    const row = byId.get(it.id);
    if (!row) {
      inserts.push({ item: it, notify: baseline || !open ? 'none' : 'pending' });
      continue;
    }
    if (row.data !== JSON.stringify(gepmData(it)) || (row.closes ?? null) !== (it.closes ?? null) || row.status !== it.status) updates.push(it);
    if (row.notify === 'pending' && !open) demote.push(it.id); // ya no vigente (cerrada o cancelada) antes de avisarse: no se avisa
  }
  return { inserts, updates, demote };
}

// Lo que viene de la base de datos también es entrada no confiable: solo tipos, tamaños y enlaces permitidos.
export function cleanGepm(x) {
  const s = (v, n) => (typeof v === 'string' && v.trim() ? clipWord(scrub(v), n) : null);
  return {
    title: s(x?.title, 120) || 'Convocatoria sin título',
    people: Number.isSafeInteger(x?.people) && x.people > 0 && x.people < 1000 ? x.people : null,
    city: s(x?.city, 80),
    where: s(x?.where, 140),
    conds: Array.isArray(x?.conds) ? x.conds.slice(0, 3).map((c) => s(c, 160)).filter(Boolean) : [],
    pdf: typeof x?.pdf === 'string' ? safeLink(x.pdf) : null,
    apply: typeof x?.apply === 'string' ? safeLink(x.apply) : null,
    hasTime: x?.hasTime === true,
  };
}

const hhmm = (ms) => {
  const t = new Date(ms - 5 * 3600 * 1000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
};

// Tarjeta de una convocatoria (mismo estilo que las de ofertas). `row` = { id, closes, status, data }.
export function formatGepm(row, { isNew = false, now = Date.now(), tag = false } = {}) {
  const d = cleanGepm(row.data);
  const id = /^\d{3}-\d{2}$/.test(String(row.id)) ? row.id : '???-??';
  const label = `${id} ${d.title}`;
  // `tag`: en los filtros de Perfiles, mezclados con ofertas del portal, cada tarjeta lleva la etiqueta de su origen.
  const head = (isNew ? '🆕 ' : '') + (tag ? '🏢 GRUPO EPM · ' : '🏢 ') + (d.pdf ? `<a href="${escAttr(d.pdf)}">${esc(label)}</a>` : `<b>${esc(label)}</b>`);
  let when;
  if (row.status === 'cancelled') when = '⏰ Proceso cancelado';
  else if (Number.isFinite(row.closes)) {
    const c = closing(new Date(row.closes).toISOString(), now);
    const hora = d.hasTime && hhmm(row.closes) !== '23:59' ? ` · hasta las ${hhmm(row.closes)}` : '';
    when = c.line + hora;
  } else when = '⏰ Cierra: No especificada';
  const lines = [
    head,
    when,
    `📍 Ciudad: ${esc(d.city || 'No especificado')}`,
    `👥 Personas requeridas: ${d.people ?? 'No especificado'}`,
    `🏗️ El cargo se desarrolla en: ${esc(d.where || 'No especificado')}`,
  ];
  if (d.conds.length) lines.push(`📌 Condiciones: ${d.conds.map(esc).join(' · ')}`);
  if (d.apply) lines.push(`👉 <a href="${escAttr(d.apply)}">Postúlate aquí</a>`);
  return lines.join('\n');
}

// La convocatoria con la forma que esperan los perfiles de profiles.js (mismas palabras clave que las ofertas del portal):
// el título y, en lugar de la descripción corta, el lugar donde se desarrolla el cargo (la tarjeta no guarda más texto).
export const gepmAsJob = (row) => {
  const d = cleanGepm(row.data);
  return { Title: d.title, ShortDescriptionStr: d.where || '' };
};

// Fecha corta del último análisis (para los mensajes de estado).
export const fmtWhen = (ms) => (Number.isFinite(ms) ? `${fmtDay(bogotaDay(ms))} ${hhmm(ms)}` : 'nunca');
