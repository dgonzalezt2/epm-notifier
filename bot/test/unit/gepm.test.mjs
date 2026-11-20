// GrupoEPM (convocatorias de la Fundación EPM): lectura parcial, análisis de la página real, fechas, enlaces, limpieza y tarjetas.
// El fixture es un extracto REAL de la página (las 16 convocatorias más nuevas completas + segmentos reales de otras con
// formatos distintos: «Cancelado», «se abre en una pestaña nueva», sin guion en la hora, «a.m.», enlaces de hosts no permitidos…).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FIX, htmlProblems } from '../helpers.mjs';
import { parseGepm, parseClosing, safeLink, decodeEntities, cleanText, isOpenGepm, formatGepm, gepmData, reconcile, fetchGepm, GEPM_URL, MAX_CONV, MAX_BYTES, GepmError } from '../../src/lib/gepm.js';
import { MAX_MSG } from '../../src/lib/util.js';

const PAGE = readFileSync(`${FIX}/gepm-convocatorias.html`, 'utf8');
const ITEMS = parseGepm(PAGE, { complete: true });
const byId = (id) => ITEMS.items.find((i) => i.id === id);
const NOW = Date.parse('2026-11-20T15:00:00Z'); // 10:00 en Bogotá, dos días antes del cierre de la 025-26
const row = (it) => ({ id: it.id, closes: it.closes, status: it.status, data: gepmData(it) });
const bogota = (ms) => new Date(ms - 5 * 3600e3).toISOString().slice(0, 16);

// Plantilla de una convocatoria con el mismo HTML que la página real.
const block = ({ id = '026-26', title = 'PROFESIONAL DE PRUEBA', tail = 'Fecha de cierre viernes 27 de noviembre de 2026 - 23:59 hrs.', body, href = '/content/dam/x/perfil.pdf', apply = 'https://login.airavirtual.com/postula/abc?id&#61;1' } = {}) =>
  `<div class="title"><div id="title-${id}" class="cmp-title"><h3 class="cmp-title__text"><a class="cmp-title__link" data-cmp-clickable href="${href}" target="_blank">${id} ${title}: ${tail}</a></h3></div></div>
<div class="text"><div id="text-${id}" class="cmp-text">${body ?? '<p>Se requiere una (1) persona para trabajar en la ciudad de Medellín, el cargo se desarrollará principalmente en el Edificio Inteligente EPM, sin embargo, podrá apoyar los programas y proyectos donde se requiera.</p>'}<p><b><a href="${apply}">¡Postúlate aquí!</a></b></p></div></div>
<div class="separator"><div class="cmp-separator"><hr/></div></div>\n`;

describe('página real: qué es una convocatoria', () => {
  test('lee las 28 convocatorias del extracto sin encabezados ilegibles', () => {
    assert.equal(ITEMS.items.length, 28);
    assert.deepEqual(ITEMS.bad, []);
    assert.equal(ITEMS.partial, 0);
    assert.ok(ITEMS.items.every((i) => /^\d{3}-\d{2}$/.test(i.id)));
  });
  test('las «Notificación N», fe de erratas y cancelaciones NO cuentan como convocatorias', () => {
    // el extracto tiene decenas de bloques «Notificación» (con <h3> sin la clase del título): ninguno aparece como convocatoria
    assert.ok((PAGE.match(/title="Notificaci/g) || []).length > 50);
    assert.ok(ITEMS.items.every((i) => !/notificaci|errata|cancelaci/i.test(i.title)));
    assert.equal(new Set(ITEMS.items.map((i) => i.id)).size, ITEMS.items.length);
  });
  test('la vigente de hoy (025-26): título, cierre en Bogotá, personas, ciudad, lugar y enlaces', () => {
    const it = byId('025-26');
    assert.equal(it.title, 'TECNÓLOGO(A) DE COMUNICACIONES');
    assert.equal(it.status, 'dated');
    assert.equal(bogota(it.closes), '2026-11-22T23:59'); // domingo 22 de noviembre de 2026, 23:59
    assert.equal(it.people, 1);
    assert.equal(it.city, 'Medellín');
    assert.equal(it.where, 'el Edificio Inteligente EPM');
    assert.deepEqual(it.conds, []);
    assert.match(it.pdf, /^https:\/\/www\.grupo-epm\.com\/content\/dam\/.+\.pdf$/);
    assert.match(it.apply, /^https:\/\/login\.airavirtual\.com\/postula\/.+id=1795096723Wp6x2lqlQed3g6io1/); // «&#61;» ya decodificado
  });
  test('solo la 025-26 está vigente hoy; el resto está cerrado o cancelado', () => {
    assert.deepEqual(ITEMS.items.filter((i) => isOpenGepm(i, NOW)).map((i) => i.id), ['025-26']);
    // el día del cierre (hasta 23:59:59) sigue vigente; un minuto después, no
    assert.equal(isOpenGepm(byId('025-26'), Date.parse('2026-11-23T04:59:30Z')), true);
    assert.equal(isOpenGepm(byId('025-26'), Date.parse('2026-11-23T05:00:30Z')), false);
  });
  test('varias vigentes a la vez (en agosto de 2026, con orden por cierre)', () => {
    const at = Date.parse('2026-08-01T12:00:00Z');
    const open = ITEMS.items.filter((i) => isOpenGepm(i, at)).map((i) => i.id);
    assert.deepEqual(open.sort(), ['015-26', '017-26', '019-26', '020-26', '022-26', '023-26', '025-26'].sort());
  });
  test('condición «aplica para personas residentes» (Planeta Rica y Cartagena)', () => {
    assert.equal(byId('017-26').city, 'Planeta Rica, Córdoba Sur');
    assert.deepEqual(byId('017-26').conds, ['Esta vacante aplica para personas residentes del municipio relacionado']);
    assert.equal(byId('002-26').city, 'Cartagena, Bolívar Norte');
    assert.match(byId('002-26').conds[0], /residentes de la zona relacionada/);
  });
  test('«Esta convocatoria está dirigida a:» con su lista (discapacidad; colaboradores y aprendices)', () => {
    assert.deepEqual(byId('035-24').conds, ['Dirigida a: Personas con discapacidad']);
    assert.match(byId('029-24').conds[0], /^Dirigida a: Colaboradores o excolaboradores.+; Aprendices/);
    assert.ok(byId('029-24').conds[0].length <= 4 + 12 + 2 * 125 + 2); // recortado, no el párrafo entero
  });
  test('enlace de un host NO permitido: se descarta y la tarjeta sale sin él (Adobe en el PDF, kudert en «Postúlate»)', () => {
    assert.match(PAGE, /author-p98763-e1046621\.adobeaemcloud\.com/);
    assert.equal(byId('002-26').pdf, null); // enlace de Adobe
    assert.equal(byId('017-24').pdf, null);
    assert.equal(byId('001-25').apply, null); // evaluado.kudert.com
    assert.ok(ITEMS.items.every((i) => [i.pdf, i.apply].every((u) => u === null || /^https:\/\/(www\.grupo-epm\.com|login\.airavirtual\.com)\//.test(u))));
    const card = formatGepm(row(byId('001-25')), { now: NOW });
    assert.ok(!card.includes('Postúlate') && !card.includes('kudert'));
    assert.ok(!formatGepm(row(byId('002-26')), { now: NOW }).includes('adobeaemcloud'));
  });
  test('cancelaciones: por el aviso «Cancelación proceso de selección» y por el encabezado «Cancelado»', () => {
    assert.equal(byId('002-26').status, 'cancelled');
    assert.equal(byId('013-25').status, 'cancelled');
    assert.equal(byId('046-24').status, 'cancelled'); // «: Cancelado»
    for (const id of ['002-26', '013-25', '046-24']) assert.equal(isOpenGepm(byId(id), 0), false, 'nunca vigente (ni con la fecha en el futuro)');
  });
  test('formatos raros de encabezado: «se abre en una pestaña nueva», sin guion, a.m., «Cerrado» y texto partido', () => {
    assert.equal(byId('009-25').title, 'TECNÓLOGO/A DE SERVICIOS DE INFORMACIÓN'); // «…hrs.se abre en una pestaña nueva»
    assert.equal(bogota(byId('009-25').closes), '2025-02-16T23:59');
    assert.equal(bogota(byId('004-25').closes), '2025-01-22T23:59'); // «miercoles 22 de enero de 2025 23:59 hrs.» (sin tilde ni guion)
    assert.equal(bogota(byId('013-25').closes), '2025-03-11T07:00'); // «07:00 a.m.»
    assert.equal(byId('015-24').status, 'closed'); // «: se abre en una pestaña nuevaCerrado»
    assert.equal(byId('014-24').status, 'closed'); // «: Cse abre en una pestaña nuevaerrado»
    assert.equal(byId('014-24').title, 'TECNÓLOGO/A DE EDUCACIÓN ROBÓTICA');
    assert.equal(byId('009-24').status, 'closed'); // título sin enlace
    assert.equal(byId('009-24').pdf, null);
  });
  test('día con cero («01 de marzo») y número de años distintos', () => {
    assert.equal(bogota(byId('005-26').closes), '2026-03-01T23:59');
    assert.ok(byId('004-25') && byId('004-26') && byId('009-25') && byId('009-26') && byId('009-24'), '004-25/004-26 y 009-24/25/26 conviven');
  });
  test('dato que falta: no se inventa (queda null y la tarjeta dice «No especificado»)', () => {
    assert.equal(byId('008-26').where, null); // «…ciudad de Medellín , sin embargo…» (sin lugar)
    const card = formatGepm(row(byId('008-26')), { now: Date.parse('2026-04-01T12:00:00Z') });
    assert.match(card, /El cargo se desarrolla en: No especificado/);
  });
});

describe('fechas en español', () => {
  const ok = (t) => bogota(parseClosing(t).ms);
  test('formatos válidos', () => {
    assert.equal(ok('Fecha de cierre domingo 22 de noviembre de 2026 - 23:59 hrs.'), '2026-11-22T23:59');
    assert.equal(ok('Fecha de cierre 01 de marzo de 2026'), '2026-03-01T23:59'); // sin hora: fin del día
    assert.equal(parseClosing('Fecha de cierre 01 de marzo de 2026').hasTime, false);
    assert.equal(ok('Fecha de cierre lunes 5 de sept. de 2026 - 12:00 p.m.'), '2026-09-05T12:00');
    assert.equal(ok('Fecha de cierre sabado 12 de dic de 2026 - 12:30 a.m.'), '2026-12-12T00:30');
    assert.equal(ok('Fecha de cierre: viernes, 6 de Diciembre de 2025 - 17:30 hrs'), '2025-12-06T17:30');
    assert.equal(ok('FECHA DE CIERRE MARTES 3 DE FEBRERO DE 2026 - 08:05 P.M.'), '2026-02-03T20:05');
  });
  test('el nombre del día no manda: se confía en la fecha', () => {
    // el 22 de noviembre de 2026 es domingo; que diga «lunes» o «xyz» no cambia nada
    assert.equal(ok('Fecha de cierre lunes 22 de noviembre de 2026 - 23:59 hrs.'), '2026-11-22T23:59');
    assert.equal(ok('Fecha de cierre xyz 22 de noviembre de 2026 - 23:59 hrs.'), '2026-11-22T23:59');
  });
  test('fechas mal formadas -> null (nunca una fecha inventada)', () => {
    for (const t of ['Fecha de cierre 31 de febrero de 2026 - 23:59 hrs.', 'Fecha de cierre 22/11/2026', 'Fecha de cierre 32 de enero de 2026', 'Fecha de cierre 5 de brumario de 2026', 'Fecha de cierre 5 de enero de 26', 'Fecha de cierre 5 de enero de 2026 - 25:00 hrs.', 'Fecha de cierre 5 de enero de 2026 - 10:75 hrs.', 'Fecha de cierre 5 de enero de 1999', 'Cierra pronto', '', null]) assert.equal(parseClosing(t), null, String(t));
  });
  test('la hora se interpreta en Bogotá (UTC-5): 23:59 en Bogotá = 04:59 UTC del día siguiente', () => {
    assert.equal(new Date(parseClosing('Fecha de cierre 22 de noviembre de 2026 - 23:59 hrs.').ms).toISOString(), '2026-11-23T04:59:59.999Z');
  });
});

describe('enlaces: solo https y hosts permitidos', () => {
  test('acepta los dos hosts, con entidades y rutas relativas', () => {
    assert.equal(safeLink('https://login.airavirtual.com/postula/x?id&#61;1'), 'https://login.airavirtual.com/postula/x?id=1');
    assert.equal(safeLink('/content/dam/a%20b.pdf'), 'https://www.grupo-epm.com/content/dam/a%20b.pdf');
    assert.equal(safeLink('https://WWW.GRUPO-EPM.COM/x'), 'https://www.grupo-epm.com/x');
  });
  test('rechaza lo demás', () => {
    for (const u of [
      'http://login.airavirtual.com/x', // sin https
      'https://evaluado.kudert.com/FUNDACIONEPM/x',
      'https://author-p98763-e1046621.adobeaemcloud.com/linkshare.html?sh=1',
      'https://www.grupo-epm.com.evil.com/x', // host parecido
      'https://evil.com/?https://www.grupo-epm.com/',
      'https://login.airavirtual.com@evil.com/x', // credenciales falsas
      'https://user:pw@login.airavirtual.com/x',
      'https://login.airavirtual.com:8443/x',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      '//evil.com/x', // misma esquema, otro host
      'https://login.airavirtual.com/' + 'a'.repeat(700),
      '', '   ', null, undefined,
    ]) assert.equal(safeLink(u), null, String(u).slice(0, 60));
  });
});

describe('contenido externo no confiable', () => {
  test('entidades y etiquetas: se limpian y NUNCA se interpretan', () => {
    assert.equal(decodeEntities('&amp;lt;b&amp;gt; &aacute;&#233;&#xE9; &nbsp;x'), '&lt;b&gt; áéé  x');
    assert.equal(cleanText('<p>Hola <b>mundo</b><script>alert(1)</script> &lt;i&gt;x&lt;/i&gt;</p>'), 'Hola mundo alert(1) <i>x</i>');
    assert.equal(decodeEntities('&#0;&#55357;&#99999999;'), '  &#99999999;'); // inválidas -> espacio; demasiado largas -> se dejan como texto (se escapan al mostrarlas)
  });
  test('una convocatoria con HTML, entidades y caracteres especiales sale como tarjeta VÁLIDA para Telegram', () => {
    const evil = block({
      title: '<script>alert(1)</script> &lt;b&gt;TÉCNICO&lt;/b&gt; &amp; "COMILLAS" 😀 ‮ RTL \u0007 control',
      body: '<p>Se requiere una (1) persona para trabajar en la ciudad de <b>Medellín</b>, el cargo se desarrollará principalmente en el Edificio &lt;i&gt;Inteligente&lt;/i&gt; EPM &amp; Cía, sin embargo, podrá apoyar. Esta vacante aplica para personas residentes del municipio &lt;a href="https://evil.com"&gt;x&lt;/a&gt;.</p>',
      href: 'javascript:alert(1)',
      apply: 'https://login.airavirtual.com/postula/"onmouseover="x',
    });
    const p = parseGepm(evil + PAGE.slice(PAGE.indexOf('<div class="title">')), { complete: true });
    const it = p.items.find((i) => i.id === '026-26');
    assert.ok(it, 'se lee la convocatoria');
    const card = formatGepm(row(it), { isNew: true, now: NOW });
    assert.deepEqual(htmlProblems(card), []);
    // el texto malicioso puede aparecer como TEXTO escapado, pero nunca como etiqueta ni como enlace
    assert.ok(!/<script|<a href="[^"]*(evil|javascript)|onmouseover="|javascript:/.test(card), card);
    assert.ok(!/[​-‏‪-‮⁦-⁩﻿]/.test(card), 'sin caracteres que invierten o ocultan texto');
    // el PDF era «javascript:…» (se descarta: el título sale en negrita) y queda solo «Postúlate»
    assert.equal((card.match(/<a /g) || []).length, 1);
    assert.match(card, /^🆕 🏢 <b>026-26 /);
    assert.ok(card.length < MAX_MSG);
  });
  test('texto enorme: recortado, rápido y la tarjeta cabe en un mensaje', () => {
    const big = 'palabra '.repeat(80_000); // ~640 000 caracteres
    const html = block({ title: big.slice(0, 5000), body: `<p>Se requiere una (1) persona para trabajar en la ciudad de ${big.slice(0, 3000)}, el cargo se desarrollará principalmente en ${big}, sin embargo, podrá.</p>` });
    const t0 = performance.now();
    const p = parseGepm(html, { complete: true });
    const ms = performance.now() - t0;
    assert.ok(ms < 150, `análisis en ${ms.toFixed(0)} ms`);
    const it = p.items[0];
    const card = formatGepm(row(it), { now: NOW });
    assert.ok(card.length < MAX_MSG, `tarjeta de ${card.length} caracteres`);
    assert.deepEqual(htmlProblems(card), []);
  });
  test('HTML raro: etiquetas sin cerrar, atributos con «>» y mayúsculas', () => {
    const raro = block({ body: '<P CLASS="x>y">Se requiere una (1) persona para trabajar en la ciudad de Medellín, el cargo se desarrollará principalmente en la <b>Biblioteca EPM, sin embargo, podrá apoyar.<p><A HREF="https://login.airavirtual.com/postula/z">¡POSTÚLATE AQUÍ!</A>' });
    const it = parseGepm(raro, { complete: true }).items[0];
    assert.ok(it);
    assert.deepEqual(htmlProblems(formatGepm(row(it), { now: NOW })), []);
  });
  test('el «>» crudo dentro del atributo data-cmp-data-layer de la página real no rompe la lectura', () => {
    assert.match(PAGE, /data-cmp-data-layer="[^"]*&#34;[^"]*>[^"]*"/); // la página real lo trae
    assert.equal(byId('025-26').people, 1);
  });
});

describe('si la estructura cambia', () => {
  test('página vacía o sin la clase del título: 0 convocatorias (se distingue de «no hay vigentes»)', () => {
    assert.equal(parseGepm('', { complete: true }).items.length, 0);
    assert.equal(parseGepm('<html><body>Mantenimiento</body></html>', { complete: true }).items.length, 0);
    assert.equal(parseGepm(PAGE.replaceAll('cmp-title__text', 'otra-clase'), { complete: true }).items.length, 0);
  });
  test('encabezado con otro formato: no se lee y se cuenta como no reconocido (sin marcar nada)', () => {
    const p = parseGepm(block({ id: '027-26' }).replace('027-26 PROFESIONAL', 'Convocatoria 27/26 PROFESIONAL') + block({ id: '028-26', tail: 'Fecha de cierre pronto' }), { complete: true });
    assert.equal(p.items.length, 0);
    assert.equal(p.bad.length, 2);
  });
  test('una sin fecha legible y otra buena: se usa la buena y se avisa de la mala', () => {
    const p = parseGepm(block({ id: '030-26' }) + block({ id: '031-26', tail: 'Fecha de cierre 31 de febrero de 2026' }) + block({ id: '032-26' }), { complete: true });
    assert.deepEqual(p.items.map((i) => i.id), ['030-26', '032-26']);
    assert.deepEqual(p.bad, ['fecha']);
  });
  test('lectura cortada a mitad de una convocatoria: la incompleta NO se usa; las anteriores sí', () => {
    const cutAt = PAGE.indexOf('026-26') >= 0 ? 0 : 0;
    void cutAt;
    const two = block({ id: '040-26' }) + block({ id: '041-26' });
    const half = two.slice(0, two.indexOf('041-26') + 120); // 041-26 cortada justo tras su encabezado
    const p = parseGepm(half, { complete: false });
    assert.deepEqual(p.items.map((i) => i.id), ['040-26']);
    assert.equal(p.partial, 1);
    // cortada dentro del propio encabezado
    const p2 = parseGepm(two.slice(0, two.indexOf('</h3>') - 20), { complete: false });
    assert.equal(p2.items.length, 0);
  });
  test('encabezados repetidos con el mismo número: se usa el primero', () => {
    const p = parseGepm(block({ id: '050-26', title: 'PRIMERA' }) + block({ id: '050-26', title: 'SEGUNDA' }), { complete: true });
    assert.equal(p.items.length, 1);
    assert.equal(p.items[0].title, 'PRIMERA');
  });
});

describe('tarjeta', () => {
  test('la 025-26 (vigente): enlaces, cierre con cuenta atrás en Bogotá y todos los datos', () => {
    const card = formatGepm(row(byId('025-26')), { isNew: true, now: NOW });
    const lines = card.split('\n');
    assert.match(lines[0], /^🆕 🏢 <a href="https:\/\/www\.grupo-epm\.com\/content\/dam\/[^"]+\.pdf">025-26 TECNÓLOGO\(A\) DE COMUNICACIONES<\/a>$/);
    assert.equal(lines[1], '⏰ Cierra: 22 nov 2026 (en 2 días)');
    assert.equal(lines[2], '📍 Ciudad: Medellín');
    assert.equal(lines[3], '👥 Personas requeridas: 1');
    assert.equal(lines[4], '🏗️ El cargo se desarrolla en: el Edificio Inteligente EPM');
    assert.match(lines[5], /^👉 <a href="https:\/\/login\.airavirtual\.com\/postula\/[^"]+">Postúlate aquí<\/a>$/);
    assert.deepEqual(htmlProblems(card), []);
  });
  test('cuenta atrás: hoy, mañana y hora distinta de 23:59', () => {
    const it = byId('025-26');
    assert.match(formatGepm(row(it), { now: Date.parse('2026-11-22T15:00:00Z') }), /\(cierra hoy\)/);
    assert.match(formatGepm(row(it), { now: Date.parse('2026-11-21T15:00:00Z') }), /\(cierra mañana\)/);
    const am = { ...row(byId('013-25')), status: 'dated' }; // «07:00 a.m.»
    assert.match(formatGepm(am, { now: Date.parse('2025-03-01T12:00:00Z') }), /hasta las 07:00/);
  });
  test('condiciones especiales se muestran; una cancelada no se presenta como disponible', () => {
    assert.match(formatGepm(row(byId('017-26')), { now: Date.parse('2026-08-01T12:00:00Z') }), /📌 Condiciones: Esta vacante aplica para personas residentes del municipio relacionado/);
    assert.match(formatGepm(row(byId('035-24')), { now: NOW }), /📌 Condiciones: Dirigida a: Personas con discapacidad/);
    assert.match(formatGepm(row(byId('002-26')), { now: NOW }), /⏰ Proceso cancelado/);
  });
  test('sin ningún dato: «No especificado» (nada inventado) y sigue siendo HTML válido', () => {
    const card = formatGepm({ id: '999-99', closes: null, status: 'closed', data: {} }, { now: NOW });
    assert.match(card, /Ciudad: No especificado/);
    assert.match(card, /Personas requeridas: No especificado/);
    assert.match(card, /desarrolla en: No especificado/);
    assert.match(card, /Cierra: No especificada/);
    assert.deepEqual(htmlProblems(card), []);
    // datos corruptos de la base: tipos incorrectos, enlace no permitido y número de convocatoria inválido
    const bad = formatGepm({ id: '<b>', closes: 'x', status: 'dated', data: { title: 5, people: '3', conds: 'x', pdf: 'https://evil.com', apply: 'javascript:1' } }, { now: NOW });
    assert.ok(!/evil|javascript/.test(bad));
    assert.deepEqual(htmlProblems(bad), []);
  });
  test('TODAS las convocatorias reales producen HTML válido y < 4000 caracteres', () => {
    for (const it of ITEMS.items) {
      const card = formatGepm(row(it), { isNew: true, now: NOW });
      assert.deepEqual(htmlProblems(card), [], it.id);
      assert.ok(card.length < 1500, `${it.id}: ${card.length}`);
    }
  });
});

describe('decisión de qué guardar y qué avisar (reconcile)', () => {
  const saved = (it, extra = {}) => ({ id: it.id, data: JSON.stringify(gepmData(it)), closes: it.closes, status: it.status, notify: 'none', tested: 0, ...extra });
  test('primera lectura (baseline): todo como visto, sin avisar, ni la vigente', () => {
    const r = reconcile(ITEMS.items, [], NOW, { baseline: true });
    assert.equal(r.inserts.length, 28);
    assert.ok(r.inserts.every((x) => x.notify === 'none'));
  });
  test('después del baseline: una convocatoria NUEVA y vigente queda pendiente; las cerradas, canceladas o sin fecha, no', () => {
    const nueva = parseGepm(block({ id: '026-26' }), { complete: true }).items[0];
    const cerrada = parseGepm(block({ id: '027-26', tail: 'Fecha de cierre 1 de enero de 2026' }), { complete: true }).items[0];
    const cancelada = parseGepm(block({ id: '028-26', tail: 'Cancelado' }), { complete: true }).items[0];
    const r = reconcile([nueva, cerrada, cancelada], [], NOW);
    assert.deepEqual(r.inserts.map((x) => [x.item.id, x.notify]), [['026-26', 'pending'], ['027-26', 'none'], ['028-26', 'none']]);
  });
  test('una convocatoria ya guardada no se vuelve a insertar ni a avisar, aunque cambie su fecha de cierre (solo se actualiza)', () => {
    const it = byId('025-26');
    const r0 = reconcile([it], [saved(it, { notify: 'done' })], NOW);
    assert.deepEqual([r0.inserts.length, r0.updates.length, r0.demote.length], [0, 0, 0], 'igual: nada que escribir');
    const nueva = { ...it, closes: it.closes + 7 * 86400e3 }; // nueva fecha de cierre (fe de erratas)
    const r1 = reconcile([nueva], [saved(it, { notify: 'done' })], NOW);
    assert.equal(r1.inserts.length, 0);
    assert.equal(r1.updates.length, 1);
    assert.equal(r1.updates[0].closes, nueva.closes);
  });
  test('una pendiente que se cierra o se cancela antes de avisarse deja de estar pendiente', () => {
    const it = { ...byId('025-26'), status: 'cancelled' };
    const r = reconcile([it], [saved(byId('025-26'), { notify: 'pending' })], NOW);
    assert.deepEqual(r.demote, ['025-26']);
  });
});

describe('lectura por flujo (fetchGepm)', () => {
  const stream = (text, chunk = 8192, rec = {}) =>
    new ReadableStream({
      start(c) {
        this.parts = [];
        const buf = new TextEncoder().encode(text);
        for (let i = 0; i < buf.length; i += chunk) this.parts.push(buf.slice(i, i + chunk));
      },
      pull(c) {
        const p = this.parts.shift();
        if (p) {
          rec.sent = (rec.sent || 0) + p.length;
          c.enqueue(p);
        } else c.close();
      },
      cancel() {
        rec.cancelled = true;
      },
    });
  const real = globalThis.fetch;
  const withFetch = (impl, fn) => async () => {
    globalThis.fetch = impl;
    try {
      await fn();
    } finally {
      globalThis.fetch = real;
    }
  };
  const BIG = PAGE + PAGE.slice(PAGE.indexOf('<div class="title">')).repeat(2); // > 600 000 caracteres, como la página real
  const ok = (text, rec, headers = {}) => async () => new Response(stream(text, 8192, rec), { status: 200, headers: { 'content-type': 'text/html;charset=utf-8', etag: 'W/"abc"', ...headers } });

  test('corta tras MAX_CONV convocatorias: no baja la página entera y usa solo las 12 más nuevas', withFetch(ok(BIG, (globalThis.__rec = {})), async () => {
    const rec = {};
    globalThis.fetch = ok(BIG, rec);
    const page = await fetchGepm({ GEPM_URL: 'http://x.test/' });
    assert.equal(page.complete, true, 'el texto termina en un límite de convocatoria');
    assert.ok(rec.cancelled, 'se cancela el flujo');
    assert.ok(page.bytes < BIG.length / 2, `leídos ${page.bytes} de ${BIG.length}`);
    const p = parseGepm(page.text, { complete: page.complete });
    assert.equal(p.items.length, MAX_CONV);
    assert.deepEqual(p.items.slice(0, 3).map((i) => i.id), ['025-26', '023-26', '022-26']);
  }));
  test('corta por tamaño (MAX_BYTES) aunque no haya tantas convocatorias', withFetch(ok('x'.repeat(1_000_000)), async () => {
    const rec = {};
    globalThis.fetch = ok('<html>' + 'x'.repeat(1_000_000), rec);
    const page = await fetchGepm({ GEPM_URL: 'http://x.test/' });
    assert.ok(page.bytes >= MAX_BYTES && page.bytes < MAX_BYTES + 20_000);
    assert.ok(rec.cancelled);
    assert.equal(parseGepm(page.text, { complete: page.complete }).items.length, 0); // nada legible -> «estructura»
  }));
  test('página corta que termina sola: complete = true y se lee la última convocatoria', withFetch(ok(''), async () => {
    globalThis.fetch = ok(block({ id: '060-26' }) + block({ id: '061-26' }));
    const page = await fetchGepm({ GEPM_URL: 'http://x.test/' });
    assert.equal(page.complete, true);
    assert.equal(parseGepm(page.text, { complete: true }).items.length, 2);
  }));
  test('petición condicional: manda If-None-Match y el 304 evita descargar y analizar', withFetch(ok(''), async () => {
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = init.headers;
      return new Response(null, { status: 304 });
    };
    const page = await fetchGepm({ GEPM_URL: 'http://x.test/' }, { etag: 'W/"abc"' });
    assert.deepEqual(page, { notModified: true });
    assert.equal(seen['if-none-match'], 'W/"abc"');
    assert.match(seen['user-agent'], /epm-notifier/);
  }));
  test('errores: HTTP 5xx/403, red, tiempo, tipo de contenido y presupuesto de subpeticiones', async () => {
    const run = async (impl, opts) => {
      globalThis.fetch = impl;
      try {
        await fetchGepm({ GEPM_URL: 'http://x.test/' }, opts);
        return 'sin error';
      } catch (e) {
        return e instanceof GepmError ? e.code : e.name;
      } finally {
        globalThis.fetch = real;
      }
    };
    assert.equal(await run(async () => new Response('x', { status: 503 })), 'http_503');
    assert.equal(await run(async () => new Response('x', { status: 403 })), 'http_403');
    assert.equal(await run(async () => { throw new TypeError('fetch failed'); }), 'red');
    assert.equal(await run(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }), 'timeout');
    assert.equal(await run(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })), 'tipo');
    assert.equal(await run(ok('<html>'), { budget: { use() { throw new Error('presupuesto'); } } }), 'Error');
  });
  test('la URL oficial es la de la Fundación EPM', () => {
    assert.equal(GEPM_URL, 'https://www.grupo-epm.com/fundacion-grupo-epm/trabaja-con-nosotros/convocatorias/');
  });
});
