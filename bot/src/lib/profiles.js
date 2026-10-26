// Perfiles de carrera y cargo (generado a partir de epm-notifier.mjs; términos sin tildes, en minúsculas).
import { norm } from './util.js';

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
export const profileLabel = (p) => PROFILE_LABELS[p] || p;
export { PROFILES, CARGO_PROFILES, TITLE_ONLY, PROFILE_LABELS };
export const areaProfiles = () => Object.keys(PROFILES).filter((p) => !CARGO_PROFILES.includes(p));

const compiled = new Map();
const compileProfile = (p) => {
  if (!compiled.has(p)) compiled.set(p, PROFILES[p].map((t) => new RegExp(`(^|[^a-z0-9])${t.replace(/ /g, '\\s+')}([^a-z0-9]|$)`)));
  return compiled.get(p);
};
// ¿La oferta (listado) corresponde al perfil? Los de nivel buscan solo en el título; el resto, en título + descripción corta.
export const jobMatchesProfile = (job, p) => {
  if (!PROFILES[p]) return false;
  const text = norm(TITLE_ONLY.has(p) ? job.Title : `${job.Title} ${job.ShortDescriptionStr || ''}`);
  return compileProfile(p).some((re) => re.test(text));
};
export const matchingProfiles = (job) => Object.keys(PROFILES).filter((p) => jobMatchesProfile(job, p));
