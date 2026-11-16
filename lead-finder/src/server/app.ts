import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { CARE_LINE_LABEL, DEFAULT_TAXONOMY, DEFAULT_WEIGHTS, extractUrlsFromText, parseVivianJobUrl } from '../core/index.ts';
import { authHook, hashPassword, issueToken, requireUser, revokeToken, SESSION_COOKIE, verifyPassword } from './auth.ts';
import type { Db } from './db.ts';
import { audit } from './db.ts';
import { HttpError } from './errors.ts';
import { VivianFetcher, type Fetcher } from './fetcher.ts';
import { RateLimiter } from './ratelimit.ts';
import * as svc from './service.ts';
import { BatchWorker } from './worker.ts';

export interface AppOptions {
  db: Db;
  fetcher?: Fetcher;
  logger?: boolean;
  startWorker?: boolean;
  cookieSecure?: boolean;
}

const uuid = z.string().uuid();
const opt = z.string().trim().max(500).nullish();
const careLine = z.enum(['home_health', 'hospice', 'palliative', 'ipc_hospice']);

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, `Invalid request: ${r.error.issues.map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ')}`);
  return r.data;
}

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; settings: svc.Settings; worker: BatchWorker }> {
  const { db } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024 * 1024, trustProxy: true });
  const settings = new svc.Settings(db);
  await settings.load();
  const fetcher = opts.fetcher ?? new VivianFetcher();
  const worker = new BatchWorker(db, settings, fetcher, (m, e) => app.log.info({ e }, m));
  if (opts.startWorker) worker.start();

  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  const fetchLimiter = new RateLimiter(30, 60_000);
  const writeLimiter = new RateLimiter(600, 60_000);

  await app.register(cookie);
  app.decorateRequest('user', null);
  app.decorateRequest('authKind', null);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
  });
  app.addHook('preHandler', authHook(db));
  app.addHook('preHandler', async (req) => {
    if (req.user && !['GET', 'HEAD'].includes(req.method)) writeLimiter.check(`w:${req.user.id}`);
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server. The error has been logged.' });
  });

  // ---- auth ----
  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }), req.body);
    loginLimiter.check(`${req.ip}:${body.email}`, 'Too many sign-in attempts. Wait 15 minutes and try again.');
    const r = await db.query('SELECT id, email, name, role, password_hash, active FROM users WHERE email = $1', [body.email]);
    const u = r.rows[0];
    if (!u || !u.active || !(await verifyPassword(body.password, u.password_hash))) throw new HttpError(401, 'Email or password is incorrect.');
    const token = await issueToken(db, u.id, 'session');
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: opts.cookieSecure ?? false, maxAge: 14 * 86_400 });
    await audit(db, u.id, 'user', u.id, 'login');
    return { user: { id: u.id, email: u.email, name: u.name, role: u.role } };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) await revokeToken(db, t);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', async (req) => ({ user: requireUser(req) }));

  // ---- personal API tokens (browser extension) ----
  app.get('/api/tokens', async (req) => {
    const u = requireUser(req);
    return (await db.query("SELECT token_hash AS id, label, created_at, last_used_at FROM auth_tokens WHERE user_id = $1 AND kind = 'api' ORDER BY created_at DESC", [u.id])).rows
      .map((r) => ({ ...r, id: String(r.id).slice(0, 16) }));
  });
  app.post('/api/tokens', async (req) => {
    const u = requireUser(req);
    if (req.authKind !== 'session') throw new HttpError(403, 'Create tokens from the web app.');
    const body = parse(z.object({ label: z.string().trim().min(1).max(80) }), req.body);
    const token = await issueToken(db, u.id, 'api', body.label);
    await audit(db, u.id, 'user', u.id, 'create_api_token', { label: body.label });
    return { token };
  });
  app.delete('/api/tokens/:prefix', async (req) => {
    const u = requireUser(req);
    const { prefix } = parse(z.object({ prefix: z.string().regex(/^[0-9a-f]{16}$/) }), req.params);
    const r = await db.query("DELETE FROM auth_tokens WHERE user_id = $1 AND kind = 'api' AND token_hash LIKE $2", [u.id, `${prefix}%`]);
    return { revoked: r.rowCount };
  });

  // ---- users ----
  app.get('/api/users', async (req) => {
    requireUser(req);
    return (await db.query('SELECT id, email, name, role, active FROM users ORDER BY name')).rows;
  });
  app.post('/api/users', async (req) => {
    const admin = requireUser(req, 'admin');
    const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(1).max(120), role: z.enum(['admin', 'manager', 'member']), password: z.string().min(10).max(200) }), req.body);
    const r = await db.query('INSERT INTO users(email, name, role, password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING RETURNING id', [b.email, b.name, b.role, await hashPassword(b.password)]);
    if (!r.rows[0]) throw new HttpError(409, 'A user with that email already exists.');
    await audit(db, admin.id, 'user', r.rows[0].id, 'create', { email: b.email, role: b.role });
    return { id: r.rows[0].id };
  });
  app.patch('/api/users/:id', async (req) => {
    const admin = requireUser(req, 'admin');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ role: z.enum(['admin', 'manager', 'member']).optional(), active: z.boolean().optional(), name: z.string().trim().min(1).max(120).optional(), password: z.string().min(10).max(200).optional() }), req.body);
    if (id === admin.id && (b.active === false || (b.role && b.role !== 'admin'))) throw new HttpError(400, 'You cannot demote or deactivate yourself.');
    const sets: string[] = []; const vals: unknown[] = [id];
    if (b.role) sets.push(`role = $${vals.push(b.role)}`);
    if (b.active !== undefined) sets.push(`active = $${vals.push(b.active)}`);
    if (b.name) sets.push(`name = $${vals.push(b.name)}`);
    if (b.password) sets.push(`password_hash = $${vals.push(await hashPassword(b.password))}`);
    if (sets.length) await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (b.active === false || b.password) await db.query('DELETE FROM auth_tokens WHERE user_id = $1', [id]);
    await audit(db, admin.id, 'user', id, 'update', { ...b, password: b.password ? '(changed)' : undefined });
    return { ok: true };
  });

  // ---- reference data ----
  app.get('/api/meta', async (req) => {
    requireUser(req);
    return {
      leadStatuses: svc.LEAD_STATUSES, priorities: svc.PRIORITIES, verificationStatuses: svc.VERIFICATION_STATUSES,
      verificationLabels: svc.VERIFICATION_LABEL, careLines: CARE_LINE_LABEL,
      roles: Object.keys(settings.taxonomy.roles), licenses: ['RN', 'LPN', 'LVN', 'LPN/LVN'],
    };
  });

  // ---- extraction ----
  app.post('/api/extract/url', async (req) => {
    const u = requireUser(req);
    fetchLimiter.check(`f:${u.id}`, 'Too many lookups in a minute. Wait a moment.');
    const b = parse(z.object({ url: z.string().max(2048), force: z.boolean().optional() }), req.body);
    const v = parseVivianJobUrl(b.url);
    if (!v.ok) throw new HttpError(400, v.error);
    const existingJob = await svc.findJobByUrl(db, v.url);
    if (existingJob && !b.force) return { url: v.url, existingJob, skipped: true };
    const out = await fetcher.fetchJobPage(v.url);
    if (out.kind !== 'ok') return { url: v.url, existingJob, fetch: { kind: out.kind, status: out.status ?? null, message: out.message } };
    const x = await svc.extractAndRecord(db, settings, u, 'server_fetch', out.html, v.url);
    return { ...x, fetch: { kind: 'ok', status: out.status } };
  });
  app.post('/api/extract/html', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ html: z.string().min(1).max(15_000_000), url: z.string().max(2048).nullish(), method: z.enum(['paste', 'extension']).default('paste') }), req.body);
    return svc.extractAndRecord(db, settings, u, b.method, b.html, b.url ?? null);
  });
  app.get('/api/extractions/:id', async (req) => {
    requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const e = await svc.getExtraction(db, id);
    const r = e.result;
    const matches = r.facility?.name ? await svc.matchFacilities(db, { name: r.facility.name, street: r.facility.address.street, city: r.facility.address.city ?? r.job.city, state: r.facility.address.state ?? r.job.state }) : [];
    const existingJob = e.source_url ? await svc.findJobByUrl(db, e.source_url) : null;
    return { extractionId: e.id, url: e.source_url, result: r, matches, existingJob };
  });
  app.get('/api/jobs/lookup', async (req) => {
    requireUser(req);
    const { url } = parse(z.object({ url: z.string().max(2048) }), req.query);
    const v = parseVivianJobUrl(url);
    if (!v.ok) return { valid: false, error: v.error };
    return { valid: true, url: v.url, existingJob: await svc.findJobByUrl(db, v.url) };
  });
  app.post('/api/facilities/match', async (req) => {
    requireUser(req);
    const b = parse(z.object({ name: z.string().trim().min(1).max(300), street: opt, city: opt, state: opt, website: opt, parentName: opt, excludeId: uuid.optional() }), req.body);
    return svc.matchFacilities(db, b, b.excludeId);
  });

  // ---- leads ----
  const saveSchema = z.object({
    extractionId: uuid.optional(),
    sourceUrl: z.string().max(2048),
    facilityChoice: z.union([z.literal('auto'), z.literal('new'), uuid]).default('auto'),
    facility: z.object({ name: z.string().max(300), street: opt, city: opt, state: opt, zip: opt, website: opt, phone: opt, parentName: opt, branchLabel: opt }),
    job: z.object({ title: z.string().max(300), city: opt, state: opt, employmentType: opt }),
    classification: z.object({ decision: z.enum(['accept', 'review', 'exclude']), careLine: careLine.nullable(), license: z.enum(['RN', 'LPN', 'LVN', 'LPN/LVN']).nullable(), role: z.string().max(40).nullable() }).optional(),
    method: z.enum(['paste', 'extension', 'server_fetch']).optional(),
  });
  app.post('/api/leads', async (req) => {
    const u = requireUser(req);
    return svc.saveLead(db, settings, u, parse(saveSchema, req.body) as svc.SaveLeadInput);
  });

  const filterSchema = z.object({
    q: z.string().max(200).optional(), state: z.string().max(40).optional(), city: z.string().max(120).optional(), careLine: z.string().max(40).optional(),
    specialty: z.string().max(120).optional(), license: z.enum(['RN', 'LPN/LVN']).optional(), status: z.string().max(60).optional(), priority: z.string().max(40).optional(),
    owner: z.string().max(60).optional(), verification: z.string().max(40).optional(), discoveredFrom: z.string().max(20).optional(), discoveredTo: z.string().max(20).optional(),
    classification: z.string().max(20).optional(), existingClient: z.enum(['yes', 'no']).optional(), sort: z.string().max(40).optional(), dir: z.enum(['asc', 'desc']).optional(),
    limit: z.coerce.number().int().optional(), offset: z.coerce.number().int().optional(),
  });
  const cleanFilters = (q: unknown) => Object.fromEntries(Object.entries((q ?? {}) as Record<string, unknown>).filter(([, v]) => v !== '' && v != null));
  app.get('/api/facilities', async (req) => {
    requireUser(req);
    return svc.listLeads(db, settings, parse(filterSchema, cleanFilters(req.query)));
  });
  app.get('/api/facilities/:id', async (req) => {
    requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return svc.getFacility(db, settings, id);
  });
  app.patch('/api/facilities/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({
      name: z.string().max(300).optional(), street: opt, city: opt, state: opt, zip: opt, website: opt, phone: opt, facilityType: opt, branchLabel: opt, branchCode: opt,
      parentName: opt, verificationStatus: z.enum(svc.VERIFICATION_STATUSES).optional(), leadStatus: z.enum(svc.LEAD_STATUSES).optional(),
      priorityOverride: z.enum(['High', 'Medium', 'Low', 'Needs Research']).nullable().optional(), ownerId: uuid.nullable().optional(),
      isExistingClient: z.boolean().optional(), existingClientOwner: opt, bullhornCompanyId: opt,
      lastContactedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), nextFollowUp: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      nextAction: opt, opportunityNotes: z.string().max(20_000).nullish(),
    }).strict(), req.body);
    return svc.updateFacility(db, u, id, b);
  });
  app.post('/api/facilities/bulk', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ ids: z.array(uuid).min(1).max(500), patch: z.object({ leadStatus: z.enum(svc.LEAD_STATUSES).optional(), ownerId: uuid.nullable().optional(), priorityOverride: z.enum(['High', 'Medium', 'Low', 'Needs Research']).nullable().optional() }).strict() }), req.body);
    return svc.bulkUpdate(db, u, b.ids, b.patch);
  });
  app.post('/api/facilities/:id/activities', async (req) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ kind: z.enum(['note', 'contact', 'comment']), body: z.string().max(10_000), contactDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() }), req.body);
    return svc.addActivity(db, u, id, b.kind, b.body, b.contactDate);
  });
  app.post('/api/facilities/:id/merge', async (req) => {
    const u = requireUser(req, 'manager');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({ mergeId: uuid }), req.body);
    return svc.mergeFacilities(db, u, id, b.mergeId);
  });
  app.post('/api/merges/:id/undo', async (req) => {
    const u = requireUser(req, 'manager');
    const { id } = parse(z.object({ id: uuid }), req.params);
    return svc.undoMerge(db, u, id);
  });
  app.patch('/api/jobs/:id', async (req) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const b = parse(z.object({
      title: z.string().max(300).optional(), decision: z.enum(['accept', 'review', 'exclude']).optional(), careLine: careLine.nullable().optional(),
      license: z.enum(['RN', 'LPN', 'LVN', 'LPN/LVN']).nullable().optional(), role: z.string().max(40).nullable().optional(),
      city: opt, state: opt, jobStatus: z.enum(['observed', 'closed', 'unknown']).optional(), facilityId: uuid.optional(),
    }).strict(), req.body);
    return svc.updateJob(db, settings, u, id, b as Parameters<typeof svc.updateJob>[4]);
  });

  app.get('/api/dashboard', async (req) => { requireUser(req); return svc.dashboard(db, settings); });
  app.get('/api/export.csv', async (req, reply) => {
    const u = requireUser(req);
    const csv = await svc.exportCsv(db, settings, parse(filterSchema, cleanFilters(req.query)));
    await audit(db, u.id, 'export', 'facilities', 'export_csv', cleanFilters(req.query));
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="skybridge-facility-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    return csv;
  });

  // ---- batches ----
  app.post('/api/batches', async (req) => {
    const u = requireUser(req);
    const b = parse(z.object({ text: z.string().max(2_000_000), label: z.string().max(120).optional() }), req.body);
    const urls = extractUrlsFromText(b.text);
    // lines that look like URLs but are not Vivian job links are reported as invalid
    const otherLines = b.text.split(/[\r\n,;\t ]+/).map((s) => s.trim().replace(/^"|"$/g, '')).filter((s) => /^https?:\/\//i.test(s) && !/vivian\.com\/job\//i.test(s));
    return svc.createBatch(db, u, [...urls, ...otherLines], b.label);
  });
  app.get('/api/batches', async (req) => { requireUser(req); return svc.listBatches(db); });
  app.get('/api/batches/:id', async (req) => {
    requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return svc.getBatch(db, id);
  });
  app.post('/api/batches/:id/retry', async (req) => {
    const u = requireUser(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    return svc.retryBatch(db, u, id);
  });

  // ---- settings ----
  app.get('/api/settings', async (req) => {
    requireUser(req);
    return { taxonomy: settings.taxonomy, taxonomyDefault: DEFAULT_TAXONOMY, weights: settings.weights, weightsDefault: DEFAULT_WEIGHTS };
  });
  app.put('/api/settings/taxonomy', async (req) => {
    const u = requireUser(req, 'admin');
    await settings.saveTaxonomy(u, req.body);
    return { taxonomy: settings.taxonomy };
  });
  app.put('/api/settings/scoring', async (req) => {
    const u = requireUser(req, 'admin');
    await settings.saveWeights(u, (req.body ?? {}) as Record<string, number>);
    return { weights: settings.weights };
  });

  app.get('/api/health', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  // ---- built web app ----
  const dist = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found.' });
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => worker.stop());
  return { app, settings, worker };
}
