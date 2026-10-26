// Utilidades puras (sin APIs de Node): texto, HTML de Telegram y límites.
export const HOST = 'https://hbcp.fa.us2.oraclecloud.com';
export const SITE = 'CX_1';
export const MAX_MSG = 4000; // Telegram admite 4096; se deja margen

export const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<\s*(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// HTML de Telegram: se escapa SIEMPRE el contenido externo.
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

// Texto externo -> una línea limpia: sin caracteres de control ni espacios repetidos.
export const scrub = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();

// Recorta en frontera de palabra con "…". Trabaja sobre texto SIN escapar (se escapa después), así nunca se parte una entidad.
export function clipWord(s, n) {
  s = String(s ?? '');
  if (s.length <= n) return s;
  let cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  if (sp > n * 0.6) cut = cut.slice(0, sp);
  cut = cut.replace(/[\s,;:.\-–—(]+$/, '');
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1); // no dejar medio carácter emoji
  return cut + '…';
}

// Logs: nunca chat ids completos.
export const maskId = (id) => `***${String(id).slice(-3)}`;

export const JOB_ID_RE = /^\d{1,12}$/;
export const jobUrl = (id) => (JOB_ID_RE.test(String(id)) ? `${HOST}/hcmUI/CandidateExperience/es/sites/${SITE}/job/${id}` : null);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
