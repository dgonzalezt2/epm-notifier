// Utilidades de prueba compartidas.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const FIX = resolve(here, 'fixtures');
export const listing = () => JSON.parse(readFileSync(`${FIX}/list.json`, 'utf8')).items[0].requisitionList;
export const detail = (id) => JSON.parse(readFileSync(`${FIX}/detail-${id}.json`, 'utf8')).items[0];
export const rawFixture = (name) => readFileSync(`${FIX}/${name}`, 'utf8');

// Validador del subconjunto de HTML que acepta Telegram (<b>, <i>, <a href>, <code>): etiquetas balanceadas, solo las permitidas,
// "<", ">" y "&" siempre escapados, y texto visible ≤ 4096 caracteres. Devuelve la lista de problemas (vacía = válido).
export function htmlProblems(html) {
  const problems = [];
  const stack = [];
  const ents = new Set(['amp', 'lt', 'gt', 'quot']);
  let plain = 0;
  for (let k = 0; k < html.length; ) {
    const c = html[k];
    if (c === '<') {
      const mt = /^<(\/?)(b|i|a|code)((?:\s+href="[^"<>]*")?)>/.exec(html.slice(k));
      if (!mt) {
        problems.push('etiqueta no válida: ' + html.slice(k, k + 25));
        break;
      }
      if (mt[1]) {
        if (stack.pop() !== mt[2]) problems.push('anidación incorrecta');
      } else {
        if (mt[2] === 'a' && !mt[3]) problems.push('<a> sin href');
        stack.push(mt[2]);
      }
      k += mt[0].length;
    } else if (c === '>') {
      problems.push('">" sin escapar');
      k++;
    } else if (c === '&') {
      const me = /^&([a-z]+|#\d+);/.exec(html.slice(k));
      if (!me || (!ents.has(me[1]) && !/^#/.test(me[1]))) {
        problems.push('"&" sin escapar: ' + html.slice(k, k + 10));
        k++;
      } else {
        plain++;
        k += me[0].length;
      }
    } else {
      plain++;
      k++;
    }
  }
  if (stack.length) problems.push('etiquetas sin cerrar: ' + stack.join(','));
  if (plain > 4096) problems.push(`texto de ${plain} caracteres (> 4096)`);
  return problems;
}
export const validHtml = (h) => htmlProblems(h).length === 0;
