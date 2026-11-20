-- Convocatorias de la Fundación EPM («GrupoEPM»), fuente distinta del portal Oracle HCM. Migración aditiva: no toca las tablas existentes.
--   id      número de la convocatoria (NNN-AA): es la clave de deduplicación (una convocatoria se avisa una sola vez)
--   data    JSON con los datos PÚBLICOS ya limpios (título, ciudad, personas, dónde, condiciones, enlaces)
--   closes  cierre en milisegundos UTC (NULL si la página no trae fecha: «Cerrado»/«Cancelado»)
--   status  'dated' (con fecha de cierre) | 'closed' | 'cancelled'
--   notify  'none' (ya vista, no se avisa) | 'pending' (detectada, falta avisar) | 'done' (aviso encolado a los suscriptores)
--   tested  1 si el aviso de prueba ya se encoló al administrador (modo test)
CREATE TABLE IF NOT EXISTS gepm (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  closes INTEGER,
  status TEXT NOT NULL,
  notify TEXT NOT NULL DEFAULT 'none',
  tested INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gepm_closes ON gepm (closes);

-- Interruptor general de la sección: 'off' (inerte) | 'test' (revisa y guarda; los avisos solo salen al administrador) | 'live'.
INSERT OR IGNORE INTO meta (k, v) VALUES ('gepm_mode', 'off');
