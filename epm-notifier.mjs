#!/usr/bin/env node
// Notificador de ofertas de empleo de EPM (Oracle HCM) -> Telegram. Sin dependencias.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HOST = 'https://hbcp.fa.us2.oraclecloud.com';
const API = `${HOST}/hcmRestApi/resources/latest`;
const SITE = 'CX_1';
const PAGE = 50;
const MAX_MSG = 4000;

// ---------- config ----------
function loadDotenv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
loadDotenv(resolve(process.cwd(), '.env'));
loadDotenv(resolve(here, '.env'));

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const GET_CHAT = args.has('--get-chat-id');
const LISTEN = args.has('--listen');
const MOCK = process.env.EPM_MOCK_DIR || null; // solo para pruebas

const cfg = {
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  chatIds: (process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean), // el primero es el administrador
  chatId: (process.env.TELEGRAM_CHAT_ID || '').split(',')[0].trim(),
  keywords: (process.env.KEYWORDS || '').split(',').map((s) => norm(s.trim())).filter(Boolean),
  stateFile: (process.env.STATE_FILE || './seen.json') + (DRY ? '.dry' : ''), // dry-run no toca el estado real
};

// Perfiles: términos relacionados (sin tildes, minúsculas). Se buscan como palabra completa en título + descripción corta.
const PROFILES = {
  sistemas: [
    'ingenieria de sistemas', 'ingeniero de sistemas', 'ingeniera de sistemas', 'analista de sistemas',
    'sistemas de informacion', 'sistemas informaticos', 'sistemas y computacion', 'ingenieria informatica',
    'informatica', 'ciencias de la computacion', 'computacion', 'ingenieria de software', 'software',
    'desarrollador', 'desarrolladora', 'programador', 'programadora', 'tecnologias de la informacion', 'ti',
    'tic', 'tecnologia de informacion', 'ciberseguridad', 'seguridad informatica', 'seguridad de la informacion',
    'analitica de datos', 'ciencia de datos', 'ingenieria de datos', 'base de datos', 'bases de datos',
    'inteligencia artificial', 'devops', 'cloud', 'nube', 'redes y telecomunicaciones', 'telematica',
    'arquitecto de soluciones', 'arquitectura de datos', 'scrum', 'ingenieria de telecomunicaciones',
  ],
  administracion: [
    'administracion de empresas', 'administrador de empresas', 'administradora de empresas', 'administracion publica',
    'administrativo', 'administrativa', 'gestion administrativa', 'gestion documental', 'secretaria', 'asistente administrativo',
    'auxiliar administrativo', 'planeacion', 'gestion empresarial', 'ingenieria administrativa', 'gestion de proyectos',
  ],
  civil: [
    'ingenieria civil', 'ingeniero civil', 'ingeniera civil', 'obras civiles', 'obra civil', 'construccion', 'interventoria',
    'topografia', 'topografo', 'arquitectura', 'arquitecto', 'arquitecta', 'hidraulica', 'hidrologia', 'geotecnia',
    'estructuras', 'acueducto', 'alcantarillado', 'saneamiento', 'presupuestos de obra',
  ],
  electrica: [
    'ingenieria electrica', 'ingeniero electrico', 'ingeniera electrica', 'electricidad', 'electrico', 'electrica',
    'electronica', 'ingenieria electronica', 'mecatronica', 'automatizacion', 'subestaciones', 'redes de distribucion',
    'transmision y distribucion', 'energia', 'protecciones', 'telemedida', 'medida de energia',
  ],
  mecanica: [
    'ingenieria mecanica', 'ingeniero mecanico', 'ingeniera mecanica', 'mecanica', 'mecanico', 'mantenimiento mecanico',
    'turbinas', 'generacion', 'plantas de generacion', 'hidromecanico', 'metalmecanica',
  ],
  industrial: [
    'ingenieria industrial', 'ingeniero industrial', 'ingeniera industrial', 'mejoramiento continuo',
    'productividad', 'logistica', 'cadena de suministro', 'gestion de la calidad', 'lean', 'investigacion de operaciones',
  ],
  ambiental: [
    'ingenieria ambiental', 'ingeniero ambiental', 'ingeniera ambiental', 'ambiental', 'medio ambiente', 'sostenibilidad',
    'gestion ambiental', 'biologia', 'biologo', 'ecologia', 'forestal', 'cuencas', 'recurso hidrico', 'residuos', 'licenciamiento ambiental',
  ],
  financiera: [
    'contaduria', 'contador', 'contadora', 'contabilidad', 'contable', 'finanzas', 'financiero', 'financiera', 'economia',
    'economista', 'tesoreria', 'presupuesto', 'tributario', 'impuestos', 'costos', 'auditoria', 'control interno', 'cartera', 'facturacion',
  ],
  juridica: [
    'derecho', 'abogado', 'abogada', 'juridico', 'juridica', 'asesoria legal', 'asuntos legales', 'contratacion', 'litigio',
    'cumplimiento normativo',
  ],
  talento: [
    'talento humano', 'recursos humanos', 'gestion humana', 'psicologia', 'psicologo', 'psicologa', 'seleccion de personal',
    'bienestar', 'formacion', 'capacitacion', 'nomina', 'relaciones laborales', 'cultura organizacional',
    'inclusion laboral', 'desarrollo humano',
  ],
  sst: [
    'seguridad y salud en el trabajo', 'salud ocupacional', 'seguridad industrial', 'sst', 'higiene industrial', 'hse',
    'riesgos laborales', 'prevencion de riesgos', 'trabajo en alturas', 'medico laboral', 'enfermeria', 'salud',
  ],
  comunicaciones: [
    'comunicacion social', 'comunicaciones', 'periodismo', 'periodista', 'mercadeo', 'marketing', 'publicidad',
    'relaciones publicas', 'contenidos', 'diseno grafico', 'comunicador', 'comunicadora', 'redes sociales',
  ],
  comercial: [
    'comercial', 'ventas', 'atencion al cliente', 'servicio al cliente', 'experiencia del cliente', 'clientes',
    'gestion comercial', 'fidelizacion',
  ],
  // --- Por cargo / nivel (basado en la nomenclatura de EPM: Profesional A/B/C, Tecnólogo, Técnico, Oficial...) ---
  profesional: ['profesional', 'profesionales', 'especialista', 'analista', 'coordinador', 'coordinadora', 'jefe'],
  tecnologo: ['tecnologo', 'tecnologa'],
  tecnico: ['tecnico', 'tecnica'],
  auxiliar: ['auxiliar', 'bachiller', 'asistente', 'operario', 'operaria', 'ayudante'],
  oficial: [
    'oficial', 'oficial de operacion y mantenimiento', 'operador', 'operadora', 'operacion y mantenimiento',
    'operacion', 'conduccion', 'despacho',
  ],
  electricista: ['electricista', 'linier', 'liniero', 'cuadrilla', 'tecnico de cuadrilla', 'mantenimiento electrico'],
  proyectos: [
    'gestion de proyectos', 'programacion de proyectos', 'proyectos de ingenieria', 'proyecto', 'proyectos',
    'obras', 'interventoria', 'infraestructura', 'bim',
  ],
};
// Perfiles de cargo/nivel: se agrupan en su propio menú y (los de nivel) se buscan solo en el título.
const CARGO_PROFILES = ['profesional', 'tecnologo', 'tecnico', 'auxiliar', 'oficial', 'electricista', 'proyectos'];
const TITLE_ONLY = new Set(['profesional', 'tecnologo', 'tecnico', 'auxiliar']);
const argVal = (name) => {
  const a = process.argv.slice(2);
  const i = a.findIndex((x) => x === name || x.startsWith(`${name}=`));
  if (i < 0) return '';
  return a[i].includes('=') ? a[i].split('=')[1] : a[i + 1] || '';
};
const profileNames = (argVal('--perfil') || process.env.PERFIL || '').split(',').map((s) => norm(s.trim())).filter(Boolean);
for (const p of profileNames) {
  if (!PROFILES[p]) {
    console.error(`Perfil desconocido "${p}". Disponibles: ${Object.keys(PROFILES).join(', ')}`);
    process.exit(2);
  }
}
const compileProfile = (p) =>
  PROFILES[p].map((t) => new RegExp(`(^|[^a-z0-9])${t.replace(/ /g, '\\s+')}([^a-z0-9]|$)`));
const profileRes = profileNames.flatMap(compileProfile);
const jobMatchesProfile = (job, p) => {
  const text = norm(TITLE_ONLY.has(p) ? job.Title : `${job.Title} ${job.ShortDescriptionStr || ''}`);
  return compileProfile(p).some((re) => re.test(text));
};

// ---------- utilidades ----------
function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const redact = (s) => (cfg.token ? String(s).split(cfg.token).join('***') : String(s));
const log = (...a) => console.log(...a.map(redact));
const logErr = (...a) => console.error(...a.map(redact));

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function htmlToText(html) {
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
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

async function withRetry(label, fn, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e.retryable === false || i === tries) break;
      const wait = 1000 * 2 ** (i - 1);
      logErr(`${label}: intento ${i}/${tries} falló (${e.message}); reintento en ${wait}ms`);
      await sleep(wait);
    }
  }
  throw last;
}

async function httpJson(url, opts) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw Object.assign(new Error(`red: ${e.cause?.code || e.message}`), { retryable: true });
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw Object.assign(new Error(`HTTP ${res.status} ${body}`), {
      retryable: res.status >= 500 || res.status === 429,
    });
  }
  try {
    return await res.json();
  } catch {
    throw Object.assign(new Error('respuesta no es JSON válido'), { retryable: false });
  }
}

// ---------- API EPM ----------
async function apiGet(path, mockName) {
  if (MOCK) return JSON.parse(readFileSync(resolve(MOCK, mockName), 'utf8'));
  return withRetry('EPM', () => httpJson(`${API}/${path}`, { headers: { accept: 'application/json' } }));
}

async function fetchListing() {
  const all = [];
  for (let offset = 0; ; offset += PAGE) {
    const finder = `findReqs;siteNumber=${SITE},limit=${PAGE},offset=${offset},sortBy=POSTING_DATES_DESC`;
    const data = await apiGet(
      `recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`,
      `list-${offset}.json`,
    );
    const head = data?.items?.[0];
    if (!head || !Array.isArray(head.requisitionList)) {
      throw new Error('estructura inesperada: falta items[0].requisitionList');
    }
    all.push(...head.requisitionList);
    const total = Number(head.TotalJobsCount ?? 0);
    if (head.requisitionList.length === 0 || all.length >= total) break;
  }
  const seen = new Set();
  return all.filter((j) => j?.Id != null && !seen.has(j.Id) && seen.add(j.Id));
}

async function fetchDetail(id) {
  const data = await apiGet(
    `recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${encodeURIComponent(id)}%22,siteNumber=${SITE}`,
    `detail-${id}.json`,
  );
  return data?.items?.[0] ?? null;
}

// ---------- mensaje ----------
const flex = (d, re) =>
  (d?.requisitionFlexFields || []).find((f) => re.test(norm(f.Prompt)) && f.Value)?.Value;

function buildMessage(job, d) {
  const url = `${HOST}/hcmUI/CandidateExperience/es/sites/${SITE}/job/${encodeURIComponent(job.Id)}`;
  const desc = htmlToText(d?.ExternalDescriptionStr) || htmlToText(d?.ShortDescriptionStr || job.ShortDescriptionStr);
  const summary = clip(htmlToText(d?.ShortDescriptionStr || job.ShortDescriptionStr) || desc, 900);

  const reqs = [];
  const quals = htmlToText(d?.ExternalQualificationsStr);
  if (quals) reqs.push(quals);
  const titulo = flex(d, /titulo requerido/);
  const exp = flex(d, /^experiencia requerida/);
  if (titulo) reqs.push(`Título: ${htmlToText(titulo).replace(/\n+/g, ' ')}`);
  if (exp) reqs.push(`Experiencia: ${htmlToText(exp).replace(/\n+/g, ' ')}`);
  const reqText = clip(reqs.join('\n'), 1200);

  const extra = [];
  const salario = flex(d, /^salario/);
  const contrato = flex(d, /tipo de contrato/);
  if (salario) extra.push(`Salario: ${salario}`);
  if (contrato) extra.push(`Contrato: ${contrato}`);
  const cierre = d?.ExternalPostedEndDate?.slice(0, 10);
  if (cierre) extra.push(`Cierra: ${cierre}`);

  const parts = [
    `🆕 <b>${esc(job.Title)}</b>`,
    `📍 ${esc(job.PrimaryLocation || d?.PrimaryLocation || 'N/D')}`,
    `📅 Publicada: ${esc(job.PostedDate || d?.ExternalPostedStartDate?.slice(0, 10) || 'N/D')}`,
  ];
  if (extra.length) parts.push(esc(extra.join(' · ')));
  if (summary) parts.push('', `<b>Resumen</b>\n${esc(summary)}`);
  if (reqText) parts.push('', `<b>Requisitos</b>\n${esc(reqText)}`);
  const link = `\n🔗 <a href="${esc(url)}">Ver oferta</a>`;

  let msg = parts.join('\n') + '\n' + link;
  if (msg.length > MAX_MSG) {
    // recorta la sección más larga hasta caber (el escape ya está aplicado, recortamos antes de escapar)
    const over = msg.length - MAX_MSG + 20;
    const trimmed = clip(summary, Math.max(100, summary.length - over));
    parts[parts.findIndex((p) => p.startsWith('<b>Resumen</b>'))] = `<b>Resumen</b>\n${esc(trimmed)}`;
    msg = parts.join('\n') + '\n' + link;
    if (msg.length > MAX_MSG) msg = parts.slice(0, 4).join('\n') + '\n' + link;
  }
  return msg;
}

// ---------- Telegram ----------
async function tgCall(method, payload) {
  return withRetry('Telegram', async () => {
    const r = await httpJson(`https://api.telegram.org/bot${cfg.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw Object.assign(new Error(`Telegram: ${r.description}`), { retryable: false });
    return r;
  });
}

async function sendTelegram(html, chatId = cfg.chatId, keyboard = null) {
  if (DRY) {
    log('----- [dry-run] mensaje -----\n' + html.replace(/<[^>]+>/g, '') + '\n-----------------------------');
    return;
  }
  await tgCall('sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

async function notifyError(err) {
  logErr('ERROR:', err?.stack || err);
  if (DRY || !cfg.token || !cfg.chatId) return;
  try {
    await sendTelegram(`⚠️ <b>Error en notificador EPM</b>\n${esc(clip(redact(err?.message || err), 500))}`);
  } catch (e) {
    logErr('No se pudo avisar el error por Telegram:', e.message);
  }
}

// ---------- estado ----------
function loadState() {
  if (!existsSync(cfg.stateFile)) return null;
  const s = JSON.parse(readFileSync(cfg.stateFile, 'utf8'));
  if (!Array.isArray(s?.seen)) throw new Error(`STATE_FILE inválido: ${cfg.stateFile}`);
  return new Set(s.seen.map(String));
}
function saveState(set) {
  const tmp = `${cfg.stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify({ updated: new Date().toISOString(), seen: [...set] }, null, 2));
  renameSync(tmp, cfg.stateFile); // escritura atómica
}

// ---------- chat id helper ----------
async function showChatId() {
  if (!cfg.token) throw new Error('Falta TELEGRAM_BOT_TOKEN en .env');
  const r = await withRetry('Telegram', () => httpJson(`https://api.telegram.org/bot${cfg.token}/getUpdates`));
  const chats = new Map();
  for (const u of r.result || []) {
    const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (c) chats.set(c.id, `${c.type} ${c.title || c.username || c.first_name || ''}`.trim());
  }
  if (!chats.size) {
    log('No hay mensajes. Escríbele algo al bot (o añádelo al canal y publica algo) y vuelve a ejecutar con --get-chat-id.');
    return;
  }
  for (const [id, label] of chats) log(`TELEGRAM_CHAT_ID=${id}   (${label})`);
}

// ---------- main ----------
function matchesKeywords(job) {
  if (!cfg.keywords.length && !profileRes.length) return true;
  const hay = norm(`${job.Title} ${job.PrimaryLocation} ${(job.secondaryLocations || []).map((l) => l.Name || '').join(' ')}`);
  if (cfg.keywords.some((k) => hay.includes(k))) return true;
  const text = norm(`${job.Title} ${job.ShortDescriptionStr || ''}`);
  return profileRes.some((re) => re.test(text));
}

// ---------- comandos y menú de Telegram ----------
// Comandos: /comandos (menú), /ofertas, /perfiles, /ayuda. Además cada perfil sigue siendo un comando (/sistemas, ...).
const offsetFile = `${cfg.stateFile}.tgoffset`;
const loadOffset = () => {
  try {
    return Number(readFileSync(offsetFile, 'utf8')) || 0;
  } catch {
    return 0;
  }
};
const saveOffset = (n) => writeFileSync(offsetFile, String(n));

const PROFILE_LABELS = {
  sistemas: '💻 Sistemas',
  administracion: '🗂 Administración',
  civil: '🏗 Civil',
  electrica: '⚡ Eléctrica',
  mecanica: '⚙️ Mecánica',
  industrial: '🏭 Industrial',
  ambiental: '🌿 Ambiental',
  financiera: '💰 Financiera',
  juridica: '⚖️ Jurídica',
  talento: '🤝 Talento humano',
  sst: '🦺 SST',
  comunicaciones: '📣 Comunicaciones',
  comercial: '🛒 Comercial',
  profesional: '🎓 Profesional (A/B/C)',
  tecnologo: '🛠 Tecnólogo',
  tecnico: '🔧 Técnico',
  auxiliar: '📎 Auxiliar / Bachiller',
  oficial: '🏢 Oficial operación y mant.',
  electricista: '🔌 Electricista / Linier',
  proyectos: '📐 Gestión de proyectos',
};
const profileLabel = (p) => PROFILE_LABELS[p] || p;
const btn = (text, data) => ({ text, callback_data: data });

const mainMenu = () => [
  [btn('📋 Ofertas', 'ofertas'), btn('🎯 Perfiles', 'perfiles')],
  [btn('🔔 Suscribirme', 'suscribir'), btn('❓ Ayuda', 'ayuda')],
];
const profilesMenu = () => [
  [btn('🎓 Por carrera / área', 'areas')],
  [btn('🧱 Por cargo / nivel', 'cargos')],
  [btn('⬅️ Menú', 'comandos')],
];
const profileGrid = (names) => {
  const rows = [];
  for (let i = 0; i < names.length; i += 2) rows.push(names.slice(i, i + 2).map((p) => btn(profileLabel(p), p)));
  rows.push([btn('⬅️ Perfiles', 'perfiles'), btn('Menú', 'comandos')]);
  return rows;
};
const areaProfiles = () => Object.keys(PROFILES).filter((p) => !CARGO_PROFILES.includes(p));
const backMenu = () => [[btn('🎯 Perfiles', 'perfiles'), btn('⬅️ Menú', 'comandos')]];

async function replyListing(chatId, label, jobs) {
  if (!jobs.length) {
    return sendTelegram(`No hay ofertas abiertas para <b>${esc(label)}</b> en este momento.`, chatId, backMenu());
  }
  let msg = `📋 <b>${esc(label)}</b>: ${jobs.length} oferta(s) abierta(s)\n`;
  for (const j of jobs) {
    const url = `${HOST}/hcmUI/CandidateExperience/es/sites/${SITE}/job/${encodeURIComponent(j.Id)}`;
    const line = `\n• <a href="${esc(url)}">${esc(j.Title)}</a>\n   📍 ${esc(j.PrimaryLocation || 'N/D')} · 📅 ${esc(j.PostedDate || 'N/D')}\n`;
    if (msg.length + line.length > MAX_MSG) {
      await sendTelegram(msg, chatId);
      msg = '';
    }
    msg += line;
  }
  if (msg) await sendTelegram(msg, chatId, backMenu());
}

// ---------- suscripciones: cualquiera puede suscribirse y elegir qué avisos recibir ----------
// <STATE_FILE>.subs guarda { "<chatId>": { all: bool, profiles: [perfil, ...] } }. Solo se guarda el id del chat.
const subsFile = `${cfg.stateFile}.subs`;
const MAX_SUBS = Number(process.env.MAX_SUBS) || 500;
const loadSubs = () => {
  try {
    return JSON.parse(readFileSync(subsFile, 'utf8'));
  } catch {
    return {};
  }
};
const saveSubs = (subs) => {
  const tmp = `${subsFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(subs));
  renameSync(tmp, subsFile);
};

// what: 'all' | 'none' | nombre de perfil. Devuelve la suscripción resultante, 'full' si no hay cupo o null si no es válido.
function toggleSub(id, what) {
  const subs = loadSubs();
  const key = String(id);
  const s = subs[key] || { all: false, profiles: [] };
  if (what === 'all') s.all = !s.all;
  else if (what === 'none') {
    s.all = false;
    s.profiles = [];
  } else if (PROFILES[what]) {
    s.profiles = s.profiles.includes(what) ? s.profiles.filter((p) => p !== what) : [...s.profiles, what];
  } else return null;
  if (!s.all && !s.profiles.length) delete subs[key];
  else {
    if (!subs[key] && Object.keys(subs).length >= MAX_SUBS) return 'full';
    subs[key] = s;
  }
  saveSubs(subs);
  return s;
}
function dropSub(id) {
  const subs = loadSubs();
  if (subs[String(id)]) {
    delete subs[String(id)];
    saveSubs(subs);
    log(`Suscripción eliminada (chat inaccesible): ${id}`);
  }
}

function subSummary(id) {
  const s = loadSubs()[String(id)];
  if (!s) return 'Ahora mismo no recibes avisos.';
  if (s.all) return 'Recibes <b>todas</b> las ofertas nuevas.';
  return `Recibes las ofertas nuevas de: ${s.profiles.map((p) => esc(profileLabel(p).replace(/^\S+\s/, ''))).join(', ')}.`;
}
function subscribeMenu(id) {
  const s = loadSubs()[String(id)] || { all: false, profiles: [] };
  const mark = (on) => (on ? '✅ ' : '');
  const rows = [[btn(`${mark(s.all)}📣 Todas las ofertas nuevas`, 'sub:all')]];
  const names = Object.keys(PROFILES);
  for (let i = 0; i < names.length; i += 2) {
    rows.push(names.slice(i, i + 2).map((p) => btn(`${mark(s.profiles.includes(p))}${profileLabel(p)}`, `sub:${p}`)));
  }
  rows.push([btn('🔕 Cancelar avisos', 'unsub'), btn('⬅️ Menú', 'comandos')]);
  return rows;
}

async function handleSubscription(cmd, chatId, ctx) {
  let note = '';
  if (cmd !== 'suscribir') {
    const r = toggleSub(chatId, cmd === 'unsub' ? 'none' : cmd.slice(4));
    if (r === 'full') note = '\n⚠️ El cupo de suscriptores está lleno por ahora.';
  }
  const text = `🔔 <b>Avisos de ofertas nuevas</b>\n${subSummary(chatId)}${note}\n\nToca para activar o quitar (✅ = activo). Puedes elegir varios perfiles.`;
  const kb = subscribeMenu(chatId);
  if (ctx.messageId) {
    try {
      return await tgCall('editMessageText', {
        chat_id: chatId,
        message_id: ctx.messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: kb },
      });
    } catch (e) {
      logErr('No se pudo editar el menú de suscripción:', e.message);
    }
  }
  return sendTelegram(text, chatId, kb);
}

// Destinatarios de una oferta nueva: chats autorizados (si pasa el filtro global) + suscriptores cuyo perfil coincide.
function recipientsFor(job) {
  const out = new Set();
  if (matchesKeywords(job)) {
    const chats = allChats();
    (chats.length ? chats : DRY ? ['dry'] : []).forEach((c) => out.add(String(c)));
  }
  for (const [id, s] of Object.entries(loadSubs())) {
    if (s.all || (s.profiles || []).some((p) => PROFILES[p] && jobMatchesProfile(job, p))) out.add(id);
  }
  return [...out];
}

// Envía a cada destinatario; falla solo si no llegó a ninguno. Quita suscriptores que bloquearon el bot.
async function deliver(html, recipients) {
  let ok = 0;
  let lastErr;
  for (const c of recipients) {
    try {
      await sendTelegram(html, c);
      ok++;
    } catch (e) {
      lastErr = e;
      logErr(`No se pudo enviar a ${c}:`, e.message);
      if (/blocked|chat not found|deactivated|kicked|not a member/i.test(e.message)) dropSub(c);
    }
    await sleep(60); // límite de Telegram: ~30 mensajes/s
  }
  if (!ok) throw lastErr;
  return ok;
}

// Cache de 60 s del listado para las consultas de usuarios (evita saturar la API de EPM).
let listingCache = { at: 0, jobs: null };
async function cachedListing() {
  if (listingCache.jobs && Date.now() - listingCache.at < 60000) return listingCache.jobs;
  const jobs = await fetchListing();
  listingCache = { at: Date.now(), jobs };
  return jobs;
}

// cmd: nombre sin "/" (viene de un comando escrito o del callback_data de un botón)
// ctx.messageId: mensaje del botón pulsado (permite editar el menú de suscripción en el sitio)
async function handleCommand(cmd, chatId, ctx = {}) {
  cmd = cmd.toLowerCase();
  if (cmd === 'comandos' || cmd === 'menu' || cmd === 'start') {
    return sendTelegram(
      [
        '👋 <b>Bot de ofertas de empleo EPM</b>',
        'Reviso la página de empleo de EPM (Empresas Públicas de Medellín) y te aviso por aquí cuando salen ofertas nuevas.',
        '',
        '<b>¿En qué te puedo ayudar?</b>',
        '📋 <b>Ofertas</b> — ver todas las ofertas abiertas ahora',
        '🎯 <b>Perfiles</b> — filtrar por tu carrera (sistemas, civil, financiera…) o por cargo (profesional, tecnólogo, técnico…) y saber si hay algo para ti',
        '🔔 <b>Suscribirme</b> — recibir un aviso automático (cargo, ubicación, requisitos y enlace) cuando EPM publique ofertas nuevas, de todo o solo de tus perfiles',
        '❓ <b>Ayuda</b> — lista de comandos',
        '',
        'ℹ️ <i>Proyecto personal y educativo, no oficial ni afiliado a EPM. Las postulaciones se hacen en la página de empleo de EPM.</i>',
      ].join('\n'),
      chatId,
      mainMenu(),
    );
  }
  if (cmd === 'perfiles') {
    return sendTelegram('🎯 <b>Elige cómo filtrar</b>\nTe digo si hay ofertas abiertas para tu perfil:', chatId, profilesMenu());
  }
  if (cmd === 'areas') {
    return sendTelegram('🎓 <b>Carrera / área</b>\nElige una:', chatId, profileGrid(areaProfiles()));
  }
  if (cmd === 'cargos') {
    return sendTelegram('🧱 <b>Cargo / nivel</b>\nElige uno:', chatId, profileGrid(CARGO_PROFILES));
  }
  if (cmd === 'suscribir' || cmd === 'unsub' || cmd.startsWith('sub:')) {
    return handleSubscription(cmd, chatId, ctx);
  }
  if (cmd === 'ayuda' || cmd === 'help') {
    return sendTelegram(
      [
        '<b>Comandos</b>',
        '/comandos — menú con botones',
        '/ofertas — todas las ofertas abiertas',
        '/perfiles — filtrar por carrera o por cargo',
        '/suscribir — elegir qué avisos de ofertas nuevas recibir',
        '/ayuda — esta ayuda',
        '',
        `También puedes escribir el perfil directo: ${Object.keys(PROFILES).map((p) => '/' + p).join(' ')}`,
      ].join('\n'),
      chatId,
      mainMenu(),
    );
  }
  if (cmd !== 'ofertas' && !PROFILES[cmd]) {
    return sendTelegram('Comando no reconocido. Usa /comandos.', chatId, mainMenu());
  }
  try {
    const jobs = await cachedListing();
    if (cmd === 'ofertas') return await replyListing(chatId, 'Todas las ofertas', jobs);
    return await replyListing(chatId, `Perfil ${profileLabel(cmd).replace(/^\S+\s/, '')}`, jobs.filter((j) => jobMatchesProfile(j, cmd)));
  } catch (e) {
    logErr(`Comando /${cmd} falló:`, e.message);
    await sendTelegram('⚠️ No pude consultar las ofertas ahora. Intenta de nuevo en un rato.', chatId, mainMenu());
  }
}

// ---------- chats autorizados (administrador + grupos/personas añadidos) ----------
// TELEGRAM_CHAT_ID admite varios ids separados por coma; el primero es el administrador.
// Los añadidos con /activar o /agregar se guardan en <STATE_FILE>.chats.
const chatsFile = `${cfg.stateFile}.chats`;
const extraChats = () => {
  try {
    return JSON.parse(readFileSync(chatsFile, 'utf8')).map(String);
  } catch {
    return [];
  }
};
const saveExtraChats = (list) => writeFileSync(chatsFile, JSON.stringify([...new Set(list)]));
const allChats = () => [...new Set([...cfg.chatIds, ...extraChats()])];

// Menú desplegable que Telegram muestra al escribir "/" (se registra una vez por proceso).
let commandsRegistered = false;
let botName = '';
async function registerCommands() {
  if (commandsRegistered || DRY) return;
  commandsRegistered = true;
  try {
    botName = ((await tgCall('getMe', {})).result?.username || '').toLowerCase();
    // Texto que se ve en el chat vacío (sobre el botón "Iniciar") y en el perfil del bot.
    await tgCall('setMyDescription', {
      description:
        '👋 Escribe /start para activar las notificaciones y ver las ofertas de empleo de EPM.\n\n' +
        'Proyecto personal y educativo, no oficial: no está afiliado a EPM. Las postulaciones se hacen siempre en la página de empleo de EPM.',
    });
    await tgCall('setMyShortDescription', { short_description: 'Avisos de ofertas de empleo de EPM. Proyecto personal, no oficial.' });
    await tgCall('setMyCommands', {
      commands: [
        { command: 'comandos', description: 'Menú con botones' },
        { command: 'ofertas', description: 'Ver ofertas activas' },
        { command: 'perfiles', description: 'Elegir carrera o cargo y ver sus ofertas' },
        { command: 'suscribir', description: 'Recibir avisos de ofertas nuevas' },
        { command: 'ayuda', description: 'Ayuda' },
      ],
    });
  } catch (e) {
    logErr('No se pudo registrar el menú de comandos:', e.message);
  }
}

// Comandos de administración. Devuelve true si el comando era de este tipo (se haya ejecutado o no).
async function handleAdminCommand(cmd, rest, chat, isAdmin) {
  const reply = (t, kb = null) => sendTelegram(t, chat.id, kb);
  const deny = async (t) => {
    await reply(t);
    return true;
  };
  const id = String(chat.id);
  if (cmd === 'activar' || cmd === 'desactivar') {
    if (!isAdmin) return deny('Solo el administrador puede hacer esto.');
    if (chat.type === 'private') return deny('Usa este comando dentro de un grupo donde esté el bot.');
    if (cmd === 'activar') {
      saveExtraChats([...extraChats(), id]);
      log(`Chat activado: ${id}`);
      await reply('✅ Grupo activado. Recibirá las ofertas nuevas y cualquiera aquí puede usar /comandos.', mainMenu());
    } else {
      saveExtraChats(extraChats().filter((c) => c !== id));
      log(`Chat desactivado: ${id}`);
      await reply('🔕 Grupo desactivado.');
    }
    return true;
  }
  if (cmd === 'agregar' || cmd === 'quitar' || cmd === 'chats') {
    if (!isAdmin || chat.type !== 'private') return deny('Solo el administrador, en chat privado con el bot.');
    if (cmd === 'chats') {
      await reply(`<b>Chats con acceso</b>\n${allChats().map((c) => `• <code>${esc(c)}</code>${c === cfg.chatId ? ' (admin)' : ''}`).join('\n')}\n\n🔔 Suscriptores: ${Object.keys(loadSubs()).length}`);
      return true;
    }
    const target = (rest[0] || '').trim();
    if (!/^-?\d+$/.test(target)) return deny(`Uso: /${cmd} &lt;id numérico del chat&gt;`);
    if (cmd === 'agregar') {
      saveExtraChats([...extraChats(), target]);
      await reply(`✅ Chat <code>${esc(target)}</code> agregado.`);
    } else {
      saveExtraChats(extraChats().filter((c) => c !== target));
      await reply(`🔕 Chat <code>${esc(target)}</code> quitado.`);
    }
    return true;
  }
  return false;
}

// Procesa mensajes y botones pendientes (las consultas están abiertas a cualquier chat).
async function pollCommands(timeout = 0) {
  await registerCommands();
  let offset = loadOffset();
  const allowed = encodeURIComponent(JSON.stringify(['message', 'callback_query']));
  const r = await withRetry('Telegram', () =>
    httpJson(`https://api.telegram.org/bot${cfg.token}/getUpdates?offset=${offset}&timeout=${timeout}&allowed_updates=${allowed}`),
  );
  for (const u of r.result || []) {
    offset = u.update_id + 1;
    try {
      const m = u.message;
      const cq = u.callback_query;
      const chat = m?.chat || cq?.message?.chat;
      if (!chat) continue;
      const isAdmin = String((m?.from || cq?.from)?.id) === cfg.chatId;
      if (m?.text?.startsWith('/')) {
        const [rawCmd, ...rest] = m.text.slice(1).split(/\s+/);
        const [name, target] = rawCmd.split('@');
        if (target && botName && target.toLowerCase() !== botName) continue; // comando dirigido a otro bot
        const cmd = name.toLowerCase();
        log(`Comando recibido: /${cmd} (chat ${chat.id})`);
        if (await handleAdminCommand(cmd, rest, chat, isAdmin)) continue;
        await handleCommand(cmd, chat.id);
      } else if (cq) {
        log(`Botón pulsado: ${cq.data} (chat ${chat.id})`);
        await tgCall('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
        await handleCommand(String(cq.data || ''), chat.id, { messageId: cq.message.message_id });
      }
    } catch (e) {
      logErr('Error atendiendo actualización:', e.message);
    } finally {
      saveOffset(offset);
    }
  }
}

async function listen() {
  const EVERY = 20 * 60 * 1000;
  let lastCheck = 0;
  let lastErrNotice = 0;
  log('Escuchando comandos de Telegram (y revisando ofertas cada 20 min)...');
  for (;;) {
    try {
      if (Date.now() - lastCheck >= EVERY) {
        lastCheck = Date.now();
        await checkNew();
      }
      await pollCommands(20);
    } catch (e) {
      if (Date.now() - lastErrNotice > 30 * 60 * 1000) {
        lastErrNotice = Date.now();
        await notifyError(e);
      } else {
        logErr('ERROR:', e.message);
      }
      await sleep(30000);
    }
  }
}

async function main() {
  if (GET_CHAT) return showChatId();
  if (!DRY && (!cfg.token || !cfg.chatId)) {
    throw new Error(
      !cfg.token
        ? 'Falta TELEGRAM_BOT_TOKEN (ver .env.example)'
        : 'Falta TELEGRAM_CHAT_ID. Escríbele al bot y ejecuta: node epm-notifier.mjs --get-chat-id',
    );
  }
  if (LISTEN) return listen();
  if (!DRY) {
    try {
      await pollCommands(0);
    } catch (e) {
      logErr('Comandos no procesados:', e.message);
    }
  }
  return checkNew();
}

async function checkNew() {
  const jobs = await fetchListing();
  const prev = loadState();
  const seen = prev ?? new Set();

  if (prev === null) {
    jobs.forEach((j) => seen.add(String(j.Id)));
    await sendTelegram(`✅ <b>Notificador EPM activo</b>\nOfertas actuales registradas sin notificar: ${jobs.length}.`);
    saveState(seen);
    log(`Primera ejecución: ${jobs.length} ofertas registradas.`);
    return;
  }

  const fresh = jobs.filter((j) => !seen.has(String(j.Id)));
  log(`Listado: ${jobs.length} ofertas, ${fresh.length} nuevas.`);
  let failed = null;
  for (const job of fresh) {
    try {
      const recipients = recipientsFor(job);
      if (recipients.length) {
        let detail = null;
        try {
          detail = await fetchDetail(job.Id);
        } catch (e) {
          logErr(`Detalle ${job.Id} no disponible, uso datos del listado: ${e.message}`);
        }
        const delivered = await deliver(buildMessage(job, detail), recipients);
        log(`Notificada ${job.Id} a ${delivered}/${recipients.length}: ${job.Title}`);
      } else {
        log(`Sin destinatarios ${job.Id}: ${job.Title}`);
      }
      seen.add(String(job.Id));
      saveState(seen); // guarda tras cada oferta: un fallo a medias no genera duplicados
    } catch (e) {
      failed = e; // no se marca como vista: se reintenta en la próxima ejecución
      break;
    }
  }
  if (failed) throw failed;
}

main().catch(async (e) => {
  await notifyError(e);
  process.exitCode = 1;
});
