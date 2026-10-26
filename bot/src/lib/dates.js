// Fechas en America/Bogota. Colombia no tiene horario de verano: es UTC-5 todo el año.
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const BOGOTA_OFFSET_MS = -5 * 3600 * 1000;

// Día de calendario en Bogotá de un instante (ISO con zona o milisegundos). null si no es válido.
export function bogotaDay(iso) {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const t = new Date(ms + BOGOTA_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
// PostedDate del listado es solo "AAAA-MM-DD": ya es una fecha de calendario, no se desplaza.
export function plainDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
export const fmtDay = (x) => (x ? `${x.d} ${MONTHS[x.m - 1]} ${x.y}` : null);
const dayNumber = (x) => Math.floor(Date.UTC(x.y, x.m - 1, x.d) / 86400000);
export const isoOrNull = (s) => (Number.isFinite(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : null);

// Línea y estado del cierre. `end` es el instante real (p. ej. 2026-10-28T04:59:00Z = 27 oct 23:59 en Bogotá).
export function closing(endIso, now = Date.now()) {
  const end = Date.parse(endIso);
  if (!Number.isFinite(end)) return { closed: false, line: '⏰ Cierra: No especificada' };
  const date = fmtDay(bogotaDay(end));
  if (now > end) return { closed: true, line: `⏰ Cerrada el ${date}` };
  const diff = dayNumber(bogotaDay(end)) - dayNumber(bogotaDay(now));
  const when = diff <= 0 ? 'cierra hoy' : diff === 1 ? 'cierra mañana' : `en ${diff} días`;
  return { closed: false, line: `⏰ Cierra: ${date} (${when})` };
}
export const isClosed = (lite, now = Date.now()) => !!lite?.end && now > Date.parse(lite.end);
