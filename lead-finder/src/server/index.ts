import { buildApp } from './app.ts';
import { createPool, migrate } from './db.ts';

const db = createPool();
await migrate(db, (m) => console.log(m));
const { app } = await buildApp({ db, logger: true, startWorker: true, cookieSecure: process.env.COOKIE_SECURE === 'true' });
const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });

const users = await db.query('SELECT count(*)::int AS n FROM users');
if (users.rows[0].n === 0) {
  console.log('\nNo users yet. Create the first admin with:\n  npm run create-user -- --email you@example.com --name "Your Name" --role admin\n');
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
