// Create (or reset the password of) a user from the command line.
// Usage: npm run create-user -- --email a@b.com --name "A B" --role admin [--password ...]
// Without --password a random one is generated and printed once.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { hashPassword } from './auth.ts';
import { createPool, migrate } from './db.ts';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, role: { type: 'string', default: 'member' }, password: { type: 'string' } } });
if (!values.email || !values.name) {
  console.error('Usage: npm run create-user -- --email you@example.com --name "Your Name" --role admin|manager|member [--password <min 10 chars>]');
  process.exit(1);
}
if (!['admin', 'manager', 'member'].includes(values.role!)) { console.error('role must be admin, manager or member'); process.exit(1); }
const password = values.password ?? randomBytes(12).toString('base64url');
if (password.length < 10) { console.error('Password must be at least 10 characters.'); process.exit(1); }
const db = createPool();
await migrate(db);
await db.query(
  `INSERT INTO users(email, name, role, password_hash) VALUES (lower($1),$2,$3,$4)
   ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash, active = true`,
  [values.email, values.name, values.role, await hashPassword(password)],
);
console.log(`User ${values.email} (${values.role}) is ready.`);
if (!values.password) console.log(`Temporary password: ${password}`);
await db.end();
