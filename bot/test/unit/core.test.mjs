import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listing, detail, htmlProblems, validHtml } from '../helpers.mjs';
import { bogotaDay, plainDay, fmtDay, closing, isClosed } from '../../src/lib/dates.js';
import { classifyAudience, reqSnippet, requirements, liteFromDetail, cleanLite, formatOffer, buildNewOfferMessage, jobFromListing, summarize } from '../../src/lib/offer.js';
import { matchingProfiles, jobMatchesProfile, PROFILES } from '../../src/lib/profiles.js';
import { esc, clipWord, jobUrl, MAX_MSG } from '../../src/lib/util.js';
import { makeVault, sameSecret } from '../../src/lib/crypto.js';
import { slimUpdate, limited } from '../../src/index.js';
import { subMutation } from '../../src/lib/handlers.js';

const NOW = Date.parse('2026-10-24T15:00:00Z'); // 10:00 en Bogotá
const LIST = listing();
const job = LIST.find((j) => j.Id === '39853');

describe('fechas en America/Bogota', () => {
  const end = '2026-10-28T04:59:00+00:00'; // = 27 oct 23:59 en Bogotá
  test('conversión y formato', () => {
    assert.deepEqual(bogotaDay(end), { y: 2026, m: 10, d: 27 });
    assert.deepEqual(bogotaDay('2026-10-28T05:00:00Z'), { y: 2026, m: 10, d: 28 });
    assert.equal(bogotaDay('2026-10-28T04:59:59Z').d, 27);
    assert.equal(fmtDay(bogotaDay(end)), '27 oct 2026');
    assert.equal(fmtDay(plainDay('2026-10-22')), '22 oct 2026');
    assert.equal(bogotaDay('basura'), null);
    assert.equal(plainDay('22/10/2026'), null);
  });
  test('cuenta regresiva y cierre', () => {
    const at = (iso) => closing(end, Date.parse(iso));
    assert.equal(at('2026-10-23T15:00:00Z').line, '⏰ Cierra: 27 oct 2026 (en 4 días)');
    assert.ok(at('2026-10-26T15:00:00Z').line.endsWith('(cierra mañana)'));
    assert.ok(at('2026-10-27T15:00:00Z').line.endsWith('(cierra hoy)'));
    assert.ok(at('2026-10-28T04:58:00Z').line.endsWith('(cierra hoy)'));
    assert.equal(at('2026-10-28T04:59:00Z').closed, false); // exactamente a la hora límite aún abierta
    assert.deepEqual([at('2026-10-28T04:59:01Z').closed, at('2026-10-28T04:59:01Z').line], [true, '⏰ Cerrada el 27 oct 2026']);
    assert.ok(at('2026-10-27T05:00:00Z').line.endsWith('(cierra hoy)')); // 00:00 Bogotá del 27
    assert.ok(at('2026-10-27T04:59:59Z').line.endsWith('(cierra mañana)')); // 23:59:59 del 26
    assert.equal(closing(null).line, '⏰ Cierra: No especificada');
    assert.equal(isClosed({ end: '2026-10-01T00:00:00Z' }, NOW), true);
  });
});

describe('audiencia (heurística + campo explícito)', () => {
  test('ofertas reales de CX_1: servidores de EPM, con fragmento literal', () => {
    for (const j of LIST) {
      const a = classifyAudience(detail(j.Id));
      assert.equal(a.label, 'Servidores de EPM', j.Id);
      assert.ok(a.snippet.length > 0 && a.snippet.length <= 81 && !/licencias/i.test(a.snippet));
    }
  });
  const D = (txt, type = 'Campus') => ({ RequisitionType: type, ExternalDescriptionStr: txt });
  test('casos sintéticos', () => {
    assert.equal(classifyAudience(D('Público objetivo: Abierto a la comunidad. Licencias requeridas: N/A')).label, 'Público general');
    assert.equal(classifyAudience(D('Público objetivo: Público en general')).label, 'Público general');
    assert.equal(classifyAudience(D('Público objetivo: Servidores de EPM y abierto a la comunidad.')).label, 'No determinado');
    assert.equal(classifyAudience(D('Funciones del cargo…')).label, 'No determinado');
    assert.equal(classifyAudience(D('Público objetivo: Servidores de CHEC.')).label, 'No determinado');
    assert.equal(classifyAudience(D('Público objetivo: servidores de EPM', 'Privado')).label, 'Por invitación (proceso privado)');
    assert.equal(classifyAudience(null).label, 'No determinado');
  });
});

describe('requisitos (campos explícitos del detalle)', () => {
  test('las 12 ofertas reales traen título y experiencia, ≤150 caracteres y sin relleno CINE-F', () => {
    for (const j of LIST) {
      const r = requirements(detail(j.Id));
      assert.ok(r.t && r.e, j.Id);
      assert.ok(r.t.length <= 151 && r.e.length <= 151, j.Id);
      assert.ok(!/Seg[uú]n lo descrito|Para conocer tu formaci|Clasificaci[oó]n Internacional/i.test(r.t + r.e), j.Id);
    }
  });
  test('relleno administrativo, "No requiere", vacíos y HTML', () => {
    assert.equal(reqSnippet('Título de pregrado en Ingeniería. *Según lo descrito en la CINE-F 2013 A.C).'), 'Título de pregrado en Ingeniería');
    assert.equal(reqSnippet('No requiere'), 'No requiere');
    assert.equal(reqSnippet(''), null);
    assert.equal(reqSnippet(null), null);
    assert.equal(reqSnippet('<p>a &amp; <b>b</b></p>'), 'a & b');
    assert.ok(reqSnippet('palabra '.repeat(500)).length <= 151);
  });
});

describe('tarjeta de oferta', () => {
  const lite = liteFromDetail(detail('39853'));
  const card = formatOffer(job, lite, { isNew: true, now: NOW });
  test('título clicable, audiencia, requisitos, fechas y descripción', () => {
    assert.ok(card.startsWith('🆕 <a href="https://hbcp.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/es/sites/CX_1/job/39853">TECNÓLOGO'));
    assert.match(card, /👥 Dirigida a: Servidores de EPM — «Servidores\/as de EPM/);
    assert.match(card, /🎓 Título requerido: Título de pregrado tecnológico/);
    assert.match(card, /💼 Experiencia requerida: Cuatro \(4\) años/);
    assert.ok(card.includes('⏰ Cierra: 27 oct 2026 (en 3 días)') && card.includes('📅 Publicada: 22 oct 2026'));
    const d = card.split('\n').at(-1);
    assert.ok(!/Función Básica/i.test(d) && d.length <= 351 && d.endsWith('…'));
    assert.ok(validHtml(card), htmlProblems(card).join(';'));
  });
  test('sin datos del detalle: sale igual, con valores por defecto', () => {
    const c = formatOffer({ Id: '5', Title: 'T', ShortDescriptionStr: '' }, null, { now: NOW });
    assert.match(c, /Dirigida a: No determinado/);
    assert.match(c, /Título requerido: No especificado/);
    assert.match(c, /Experiencia requerida: No especificada/);
    assert.match(c, /Cierra: No especificada/);
    assert.ok(c.endsWith('Descripción no disponible'));
  });
  test('contenido hostil: HTML escapado, enlace íntegro y límites', () => {
    const weird = { Id: '39853', Title: '<script>alert("x")</script> A&B "c" \'d\' > <b>', PrimaryLocation: 'Bogotá <D.C.> & "X"', PostedDate: '2026-10-22', ShortDescriptionStr: 'Función Básica: <img src=x onerror=alert(1)> a < b & c > d &lt;b&gt; \u0000\u0007 fin' };
    const c = formatOffer(weird, { ...lite, aud: { label: 'No determinado', snippet: 'a <b> & "c"' }, req: { t: '<i>x</i> & "y"', e: null } }, { now: NOW });
    assert.ok(validHtml(c), htmlProblems(c).join(';'));
    assert.ok(c.startsWith('<a href="https://hbcp.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/es/sites/CX_1/job/39853">&lt;script&gt;'));
    assert.ok(!/<script|<img|onerror=/.test(c.replace(/<a href="[^"]+">|<\/a>/g, '')));
    assert.ok(!/[\u0000-\u0008]/.test(c));
    const big = formatOffer({ Id: '1', Title: 'A&B <'.repeat(200), PrimaryLocation: 'X'.repeat(500), ShortDescriptionStr: 'palabra '.repeat(5000) }, { ...lite, req: { t: 'T'.repeat(160), e: 'E'.repeat(160) } }, { now: NOW });
    assert.ok(big.length <= 1900 && validHtml(big), `len=${big.length}`);
    for (const bad of ['12a', '../../x', '1"onmouseover="x', '', null, undefined, '9'.repeat(20)]) {
      const x = formatOffer({ Id: bad, Title: 'Titulo' }, null, { now: NOW });
      assert.ok(!x.includes('<a ') && !x.includes('hcmUI') && x.startsWith('<b>Titulo</b>') && validHtml(x), JSON.stringify(bad));
    }
    assert.equal(jobUrl('39853'), 'https://hbcp.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/es/sites/CX_1/job/39853');
  });
  test('cerrada y sin fecha límite', () => {
    assert.ok(formatOffer(job, lite, { now: Date.parse('2026-10-29T00:00:00Z') }).includes('⏰ Cerrada el 27 oct 2026'));
    assert.ok(formatOffer(job, { ...lite, end: null }, { now: NOW }).includes('Cierra: No especificada'));
  });
  test('12 tarjetas reales caben en pocos mensajes y todas son HTML válido', () => {
    const cards = LIST.map((j) => formatOffer(jobFromListing(j), liteFromDetail(detail(j.Id)), { now: NOW }));
    assert.ok(cards.every(validHtml));
    assert.ok(cards.every((c) => c.length < 1800), String(Math.max(...cards.map((c) => c.length))));
  });
});

describe('aviso de oferta nueva', () => {
  test('misma tarjeta + salario y contrato, sin bloque duplicado de requisitos', () => {
    const m = buildNewOfferMessage(jobFromListing(job), detail('39853'), NOW);
    assert.ok(m.startsWith('🆕 <a href="'));
    assert.match(m, /💼 Salario: .*Contrato: /s);
    assert.ok(!m.includes('<b>Requisitos</b>'));
    assert.ok(m.includes('27 oct 2026') && !m.includes('2026-10-28'));
    assert.ok(validHtml(m) && m.length <= MAX_MSG);
  });
  test('valores enormes y detalle nulo', () => {
    const big = { ...detail('39853'), requisitionFlexFields: [{ Prompt: 'Salario', Value: '1'.repeat(5000) }, { Prompt: 'Tipo de contrato', Value: 'C&<>'.repeat(5000) }, { Prompt: 'Título requerido', Value: 'T'.repeat(60000) }] };
    const m = buildNewOfferMessage(jobFromListing(job), big, NOW);
    assert.ok(m.length <= MAX_MSG && validHtml(m));
    const n = buildNewOfferMessage(jobFromListing(job), null, NOW);
    assert.ok(n.startsWith('🆕 <a href=') && /No determinado/.test(n) && validHtml(n));
  });
});

describe('perfiles', () => {
  test('coincidencias con ofertas reales', () => {
    assert.deepEqual(matchingProfiles(job).sort(), ['oficial', 'proyectos', 'tecnologo']);
    assert.equal(jobMatchesProfile({ Title: 'INGENIERO DE SISTEMAS', ShortDescriptionStr: '' }, 'sistemas'), true);
    assert.equal(jobMatchesProfile({ Title: 'TÉCNICO REDES', ShortDescriptionStr: 'sistemas de distribución' }, 'sistemas'), false);
    assert.equal(jobMatchesProfile({ Title: 'X' }, 'inexistente'), false);
    assert.ok(Object.keys(PROFILES).length >= 20);
  });
});

describe('cifrado del estado (AES-GCM + HKDF)', () => {
  const KEY = 'clave-de-prueba-larga-y-aleatoria-0123456789abcdef';
  test('ida y vuelta, sin texto en claro, atado a la fila', async () => {
    const v = await makeVault(KEY);
    const h = await v.chatHash(1234500001);
    const blob = await v.seal('subs', h, { chat: '1234500001', all: true, profiles: ['civil'] });
    assert.ok(blob.startsWith('v1.') && !blob.includes('1234500001') && !blob.includes('civil'));
    assert.deepEqual(await v.open('subs', h, blob), { chat: '1234500001', all: true, profiles: ['civil'] });
    const blob2 = await v.seal('subs', h, { chat: '1234500001', all: true, profiles: ['civil'] });
    assert.notEqual(blob, blob2, 'IV aleatorio: dos cifrados del mismo dato difieren');
    await assert.rejects(v.open('subs', 'otro-hash', blob), 'el blob no sirve en otra fila');
    await assert.rejects(v.open('chats', h, blob), 'ni en otra tabla');
  });
  test('clave incorrecta falla sin devolver nada; manipulación detectada', async () => {
    const v = await makeVault(KEY);
    const w = await makeVault(KEY + 'x');
    const h = await v.chatHash(7);
    const blob = await v.seal('subs', h, { chat: '7' });
    await assert.rejects(w.open('subs', h, blob));
    const tampered = blob.slice(0, -4) + (blob.at(-4) === 'A' ? 'B' : 'A') + blob.slice(-3);
    await assert.rejects(v.open('subs', h, tampered));
    await assert.rejects(v.open('subs', h, 'texto cualquiera'));
  });
  test('hash del chat: estable, no reversible a simple vista, distinto por clave', async () => {
    const v = await makeVault(KEY);
    const w = await makeVault(KEY + 'x');
    const a = await v.chatHash(123456789);
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.equal(a, await v.chatHash('123456789'));
    assert.notEqual(a, await v.chatHash(123456780));
    assert.notEqual(a, await w.chatHash(123456789));
    await assert.rejects(makeVault('corta'));
  });
  test('respaldo cifrado ida y vuelta', async () => {
    const v = await makeVault(KEY);
    const s = await v.sealBackup({ a: 1, texto: 'secreto' });
    assert.ok(!s.includes('secreto'));
    assert.deepEqual(await v.openBackup(s), { a: 1, texto: 'secreto' });
  });
  test('HKDF es barato: derivar y cifrar/descifrar 500 filas en pocos ms de CPU', async () => {
    const v = await makeVault('otra-clave-de-prueba-larga-para-medir-0123456789');
    const t0 = process.cpuUsage();
    for (let i = 0; i < 500; i++) {
      const h = await v.chatHash(1000000000 + i);
      await v.open('subs', h, await v.seal('subs', h, { chat: String(i) }));
    }
    const ms = (process.cpuUsage(t0).user + process.cpuUsage(t0).system) / 1000;
    assert.ok(ms < 500, `${ms} ms`); // en Cloudflare se midieron 5 ms por 500 filas
  });
  test('comparación del secreto en tiempo constante', async () => {
    assert.equal(await sameSecret('abc', 'abc'), true);
    assert.equal(await sameSecret('abc', 'abd'), false);
    assert.equal(await sameSecret('', 'abc'), false);
  });
});

describe('webhook: saneado y límite por chat', () => {
  const cmd = (id, text, chat = { id: 1, type: 'private' }) => ({ update_id: id, message: { chat, from: { id: 1, first_name: 'X' }, text } });
  test('solo comandos y botones; sin datos personales; tipos de chat válidos', () => {
    assert.equal(slimUpdate(cmd(1, 'hola')), null);
    assert.equal(slimUpdate({ update_id: 2, edited_message: { text: '/x' } }), null);
    assert.equal(slimUpdate(cmd(3, '/start', { id: 5, type: 'channel' })), null);
    assert.equal(slimUpdate({ update_id: '1' }), null);
    const s = slimUpdate(cmd(4, '/start'));
    assert.deepEqual(s, { update_id: 4, message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/start' } });
    assert.equal(slimUpdate(cmd(5, '/' + 'a'.repeat(999))).message.text.length, 256);
    const b = slimUpdate({ update_id: 6, callback_query: { id: 'c', data: 'ofertas', from: { id: 1, first_name: 'N' }, message: { message_id: 9, chat: { id: 1, type: 'private' } } } });
    assert.equal(b.callback_query.data, 'ofertas');
    assert.ok(!JSON.stringify(b).includes('first_name'));
  });
  test('8 updates cada 10 s por chat; otros chats no se afectan', () => {
    let n = 0;
    for (let i = 0; i < 12; i++) if (!limited(777, 1000 + i)) n++;
    assert.equal(n, 8);
    assert.equal(limited(888, 1100), false);
    assert.equal(limited(777, 1000 + 10001), false, 'pasada la ventana vuelve a aceptar');
  });
});

describe('cambios de suscripción (absolutos e idempotentes)', () => {
  const base = { chat: '1', all: false, profiles: ['civil'] };
  test('activar/desactivar/alternar y validación', () => {
    assert.deepEqual(subMutation('sub:sistemas:1')(base).profiles, ['civil', 'sistemas']);
    assert.deepEqual(subMutation('sub:sistemas:1')(subMutation('sub:sistemas:1')(base)).profiles, ['civil', 'sistemas'], 'activar dos veces = igual');
    assert.deepEqual(subMutation('sub:civil:0')(base).profiles, []);
    assert.equal(subMutation('sub:all:1')(base).all, true);
    assert.deepEqual(subMutation('sub:civil')(base).profiles, [], 'botón antiguo: alterna');
    assert.deepEqual(subMutation('unsub')(base), { all: false, profiles: [] });
    assert.equal(subMutation('sub:inventado:1'), null);
    assert.equal(subMutation('sub:../x:1'), null);
    assert.equal(subMutation('ofertas'), null);
  });
});

describe('utilidades', () => {
  test('escape y recorte', () => {
    assert.equal(esc('<a href="x">&'), '&lt;a href="x"&gt;&amp;');
    assert.equal(summarize({ ShortDescriptionStr: 'Función Básica: hola' }), 'hola');
    assert.ok(clipWord('a '.repeat(200) + '😀😀😀', 100).length <= 100);
    assert.equal(cleanLite({ aud: {} }), null);
    assert.equal(cleanLite({ aud: { label: 'x'.repeat(500), snippet: 7 }, end: 'no-fecha' }).aud.label.length, 60);
  });
});
