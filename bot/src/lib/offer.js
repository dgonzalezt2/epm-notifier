// Datos de una oferta: audiencia, requisitos, datos públicos (lite), tarjeta y mensaje de oferta nueva.
// El contenido de EPM es externo y no confiable: se limpia, se acota y se escapa antes de ir a Telegram.
import { norm, htmlToText, esc, escAttr, scrub, clipWord, jobUrl, MAX_MSG } from './util.js';
import { bogotaDay, plainDay, fmtDay, closing, isoOrNull } from './dates.js';

// ---------- audiencia ----------
// EPM no tiene un campo interno/externo: se usa el tipo de requisición (explícito) y, si no basta,
// la frase "Público objetivo" del texto de la oferta (heurística; se muestra el fragmento literal).
const SECTION_END = /(licencias requeridas|certificaciones requeridas|matr[ií]culas requeridas|conocimientos requeridos|observaciones generales)/i;
const SERVERS_RE = /\bservidor(?:es|as?)?\b/;
const OPEN_RE = /abiert[oa]s? a la comunidad|publico en general|convocatoria externa|cualquier persona|personas externas/;
const OTHER_CO_RE = /\b(chec|essa|cens|edeq)\b/;
export function classifyAudience(d) {
  if (norm(d?.RequisitionType) === 'privado') return { label: 'Por invitación (proceso privado)', snippet: '' };
  const text = htmlToText(d?.ExternalDescriptionStr).replace(/\s+/g, ' ');
  const m = /p[uú]blico objetivo\s*:?\s*[-–]?\s*(.*)/i.exec(text);
  let clause = m ? m[1] : '';
  const end = SECTION_END.exec(clause);
  if (end) clause = clause.slice(0, end.index);
  clause = clause.replace(/^(?:este proceso es\s+)?dirigid[oa]\s+a\s*:?\s*/i, '').replace(/^[-–:;\s]+/, '').replace(/[-–:;\s]+$/, '').trim();
  if (!clause) return { label: 'No determinado', snippet: '' };
  const snippet = clipWord(scrub(clause), 80);
  const n = norm(clause);
  const servers = SERVERS_RE.test(n);
  const open = OPEN_RE.test(n);
  if (servers && !open) {
    return OTHER_CO_RE.test(n) && !/\bepm\b/.test(n) ? { label: 'No determinado', snippet } : { label: 'Servidores de EPM', snippet };
  }
  if (open && !servers) return { label: 'Público general', snippet };
  return { label: 'No determinado', snippet };
}

// ---------- requisitos (campos explícitos del detalle: requisitionFlexFields) ----------
// Se quita el relleno administrativo (CINE-F, "Para conocer tu formación…") y se recorta en frontera de palabra.
export function reqSnippet(raw, max = 150) {
  const t = scrub(htmlToText(raw))
    .split(/\*?\s*Seg[uú]n lo descrito|\*\s*Para conocer tu formaci[oó]n|Seg[uú]n la Clasificaci[oó]n Internacional/i)[0]
    .trim()
    .replace(/[.;,\s*]+$/, '');
  return t ? clipWord(t, max) : null;
}
const flexValue = (d, re) => (d?.requisitionFlexFields || []).find((f) => re.test(norm(f.Prompt)) && f.Value)?.Value;
export function requirements(d) {
  return { t: reqSnippet(flexValue(d, /^titulo requerido/)), e: reqSnippet(flexValue(d, /^experiencia requerida/)) };
}

// ---------- datos públicos por oferta ----------
export function liteFromDetail(d) {
  if (!d) return null;
  return {
    type: String(d.RequisitionType ?? '').slice(0, 20),
    start: isoOrNull(d.ExternalPostedStartDate),
    end: isoOrNull(d.ExternalPostedEndDate),
    aud: classifyAudience(d),
    req: requirements(d),
  };
}
// Lo que viene de la base de datos también se trata como entrada no confiable: solo tipos y tamaños esperados.
export function cleanLite(x) {
  if (!x || typeof x !== 'object' || !x.aud || typeof x.aud.label !== 'string') return null;
  const s = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  return {
    type: String(x.type ?? '').slice(0, 20),
    start: isoOrNull(x.start),
    end: isoOrNull(x.end),
    aud: { label: x.aud.label.slice(0, 60), snippet: String(x.aud.snippet ?? '').slice(0, 120) },
    req: { t: s(x.req?.t, 160), e: s(x.req?.e, 160) },
  };
}
// Subconjunto del listado que se guarda: lo necesario para dibujar la tarjeta y filtrar por perfil.
export function jobFromListing(j) {
  return {
    Id: String(j.Id),
    Title: scrub(j.Title).slice(0, 200),
    PrimaryLocation: scrub(j.PrimaryLocation).slice(0, 120),
    PostedDate: String(j.PostedDate ?? '').slice(0, 10),
    ShortDescriptionStr: scrub(htmlToText(j.ShortDescriptionStr)).slice(0, 700),
  };
}

export function summarize(job, d) {
  const t = scrub(htmlToText(d?.ShortDescriptionStr || job?.ShortDescriptionStr)).replace(/^funci[oó]n b[aá]sica\s*:\s*/i, '');
  return t ? clipWord(t, 350) : '';
}

// ---------- tarjeta ----------
// Misma tarjeta para el botón de ofertas y para el aviso de oferta nueva. `lite` puede ser null (detalle no disponible).
export function formatOffer(job, lite, { isNew = false, now = Date.now(), detail = null } = {}) {
  const title = clipWord(scrub(job?.Title) || 'Oferta sin título', 120);
  const url = jobUrl(job?.Id);
  const head = (isNew ? '🆕 ' : '') + (url ? `<a href="${escAttr(url)}">${esc(title)}</a>` : `<b>${esc(title)}</b>`);
  const aud = lite?.aud || { label: 'No determinado', snippet: '' };
  const audLine = `👥 Dirigida a: ${esc(aud.label)}${aud.snippet ? ` — «${esc(aud.snippet)}»` : ''}`;
  const reqT = `🎓 Título requerido: ${esc(lite?.req?.t || 'No especificado')}`;
  const reqE = `💼 Experiencia requerida: ${esc(lite?.req?.e || 'No especificada')}`;
  const loc = clipWord(scrub(job?.PrimaryLocation ?? detail?.PrimaryLocation), 100) || 'No especificada';
  const published = (lite?.start ? fmtDay(bogotaDay(lite.start)) : fmtDay(plainDay(job?.PostedDate))) || 'No especificada';
  const c = lite?.end ? closing(lite.end, now) : { line: '⏰ Cierra: No especificada' };
  const desc = summarize(job, detail) || 'Descripción no disponible';
  return [head, audLine, reqT, reqE, `📍 ${esc(loc)}`, `📅 Publicada: ${published} · ${c.line}`, esc(desc)].join('\n');
}

// Aviso de oferta nueva: la tarjeta + salario y contrato (que no van en el botón de ofertas).
export function buildNewOfferMessage(job, d, now = Date.now()) {
  const card = formatOffer(job, liteFromDetail(d), { isNew: true, now, detail: d });
  const extra = [];
  const salario = flexValue(d, /^salario/);
  const contrato = flexValue(d, /tipo de contrato/);
  if (salario) extra.push(`Salario: ${clipWord(scrub(String(salario)), 60)}`);
  if (contrato) extra.push(`Contrato: ${clipWord(scrub(String(contrato)), 60)}`);
  const msg = extra.length ? `${card}\n\n💼 ${esc(extra.join(' · '))}` : card;
  return msg.length > MAX_MSG ? card : msg;
}
