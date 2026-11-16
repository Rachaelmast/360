import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.ts';
import { HttpError } from './errors.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = 'admin' | 'manager' | 'member';
export interface User { id: string; email: string; name: string; role: Role }

export const SESSION_COOKIE = 'lf_session';
const SESSION_DAYS = 14;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, s, k] = stored.split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const expected = Buffer.from(k, 'base64');
  const key = await scrypt(pw, Buffer.from(s, 'base64'), expected.length);
  return timingSafeEqual(key, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function issueToken(db: Db, userId: string, kind: 'session' | 'api', label?: string): Promise<string> {
  const token = `${kind === 'api' ? 'lfk' : 'lfs'}_${randomBytes(32).toString('base64url')}`;
  const expires = kind === 'session' ? new Date(Date.now() + SESSION_DAYS * 86_400_000) : null;
  await db.query('INSERT INTO auth_tokens(token_hash, user_id, kind, label, expires_at) VALUES ($1,$2,$3,$4,$5)', [sha256(token), userId, kind, label ?? null, expires]);
  return token;
}

export async function revokeToken(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM auth_tokens WHERE token_hash = $1', [sha256(token)]);
}

export async function userFromToken(db: Db, token: string): Promise<User | null> {
  const r = await db.query<User>(
    `UPDATE auth_tokens t SET last_used_at = now()
       FROM users u
      WHERE t.token_hash = $1 AND u.id = t.user_id AND u.active
        AND (t.expires_at IS NULL OR t.expires_at > now())
      RETURNING u.id, u.email, u.name, u.role`,
    [sha256(token)],
  );
  return r.rows[0] ?? null;
}

declare module 'fastify' {
  interface FastifyRequest { user: User | null; authKind: 'session' | 'api' | null }
}

/** Resolve the caller from a Bearer API token or the session cookie. */
export function authHook(db: Db) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    req.user = null;
    req.authKind = null;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      req.user = await userFromToken(db, header.slice(7).trim());
      req.authKind = req.user ? 'api' : null;
      return;
    }
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (cookie) {
      req.user = await userFromToken(db, cookie);
      req.authKind = req.user ? 'session' : null;
      // CSRF: cookie-authenticated writes must come from this origin.
      if (req.user && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        const host = req.headers.host;
        let originHost = '';
        try { originHost = origin ? new URL(origin).host : ''; } catch { originHost = 'invalid'; }
        if (origin && host && originHost !== host) throw new HttpError(403, 'Cross-site request blocked.');
      }
    }
  };
}

const RANK: Record<Role, number> = { member: 1, manager: 2, admin: 3 };

export function requireUser(req: FastifyRequest, minRole: Role = 'member'): User {
  if (!req.user) throw new HttpError(401, 'Sign in required.');
  if (RANK[req.user.role] < RANK[minRole]) throw new HttpError(403, `This action requires the ${minRole} role.`);
  return req.user;
}
