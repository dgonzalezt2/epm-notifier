// D1 simulada sobre node:sqlite (solo para pruebas unitarias): misma interfaz que usa src/lib/db.js (prepare/bind/all/run/batch).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const schema = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations/0001_init.sql'), 'utf8');

class Stmt {
  constructor(db, sql, args = [], d1 = null) {
    this.d1 = d1;
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...a) {
    return new Stmt(this.db, this.sql, a, this.d1);
  }
  async all() {
    this.d1.trips++;
    const rows = this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r }));
    return { results: rows, meta: { rows_read: rows.length, rows_written: 0 } };
  }
  async run() {
    this.d1.trips++;
    return this.exec();
  }
  exec() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes), rows_written: Number(r.changes), rows_read: 0 } };
  }
}

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const d1 = {
    raw: db,
    failNextBatch: false, // simula un corte justo antes de la escritura atómica
    trips: 0, // viajes a la base (un lote = 1), que es lo que cuesta CPU
    prepare: (sql) => new Stmt(db, sql, [], d1),
    async batch(stmts) {
      d1.trips++;
      if (d1.failNextBatch) {
        d1.failNextBatch = false;
        throw new Error('corte simulado antes de escribir');
      }
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return d1;
}
