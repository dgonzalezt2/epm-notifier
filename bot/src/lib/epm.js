// API pública de Oracle HCM que usa la página de empleo de EPM (sitio CX_1).
import { SITE, JOB_ID_RE } from './util.js';
import { BudgetError } from './telegram.js';

const DEFAULT_API = 'https://hbcp.fa.us2.oraclecloud.com/hcmRestApi/resources/latest';
const PAGE = 50;

export class EpmError extends Error {
  constructor(msg, status = 0) {
    super(msg);
    this.name = 'EpmError';
    this.status = status;
  }
}

async function get(env, path, budget, timeout) {
  budget?.use();
  let res;
  try {
    res = await fetch(`${env.EPM_API || DEFAULT_API}/${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new EpmError(e?.name === 'TimeoutError' ? 'timeout' : 'red');
  }
  if (!res.ok) throw new EpmError(`HTTP ${res.status}`, res.status);
  try {
    return await res.json();
  } catch {
    throw new EpmError('respuesta no es JSON válido', res.status);
  }
}

// Listado completo (con paginación). Solo ofertas con ID numérico válido.
export async function fetchListing(env, { budget, timeout = 15000 } = {}) {
  const all = [];
  for (let offset = 0; offset < 500; offset += PAGE) {
    const finder = `findReqs;siteNumber=${SITE},limit=${PAGE},offset=${offset},sortBy=POSTING_DATES_DESC`;
    const data = await get(env, `recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=${finder}`, budget, timeout);
    const head = data?.items?.[0];
    if (!head || !Array.isArray(head.requisitionList)) throw new EpmError('estructura inesperada: falta items[0].requisitionList');
    all.push(...head.requisitionList);
    const total = Number(head.TotalJobsCount ?? 0);
    if (head.requisitionList.length === 0 || all.length >= total) break;
  }
  const seen = new Set();
  return all.filter((j) => j?.Id != null && JOB_ID_RE.test(String(j.Id)) && !seen.has(String(j.Id)) && seen.add(String(j.Id)));
}

export async function fetchDetail(env, id, { budget, timeout = 12000 } = {}) {
  if (!JOB_ID_RE.test(String(id))) throw new EpmError('id inválido');
  const data = await get(env, `recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${SITE}`, budget, timeout);
  return data?.items?.[0] ?? null;
}

export { BudgetError };
