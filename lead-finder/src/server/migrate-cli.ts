import { createPool, migrate } from './db.ts';

const db = createPool();
const applied = await migrate(db, (m) => console.log(m));
console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
await db.end();
