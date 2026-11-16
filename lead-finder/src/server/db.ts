import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

// Return DATE columns as plain YYYY-MM-DD strings instead of local-midnight Date objects.
pg.types.setTypeParser(1082, (v) => v);

export function createPool(url = process.env.DATABASE_URL ?? 'postgres://leadfinder:leadfinder@localhost:5432/leadfinder'): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export async function tx<T>(db: Db, fn: (c: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** Apply pending SQL migrations in filename order. Each runs in its own transaction. */
export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(MIGRATIONS_DIR + f, 'utf8');
    await tx(db, async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
    log(`applied migration ${f}`);
    applied.push(f);
  }
  return applied;
}

export async function audit(q: Queryable, userId: string | null, entity: string, entityId: string, action: string, changes: unknown = {}): Promise<void> {
  await q.query('INSERT INTO audit_log(user_id, entity, entity_id, action, changes) VALUES ($1,$2,$3,$4,$5)', [userId, entity, entityId, action, JSON.stringify(changes)]);
}
