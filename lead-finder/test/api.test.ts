import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.ts';
import { hashPassword } from '../src/server/auth.ts';
import { createPool, migrate, type Db } from '../src/server/db.ts';
import type { FetchOutcome, Fetcher } from '../src/server/fetcher.ts';
import type { BatchWorker } from '../src/server/worker.ts';

const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://leadfinder:leadfinder@localhost:5432/leadfinder_test';
const lcfl = readFileSync(new URL('./fixtures/lower-cape-fear-lifecare.html', import.meta.url), 'utf8');
const pageWith = (state: object) => `<html><head><title>x</title></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { job: state } } })}</script></body></html>`;

/** Stands in for Vivian. Unknown URLs get the Cloudflare challenge that the real site returns to servers. */
class FakeFetcher implements Fetcher {
  pages = new Map<string, FetchOutcome>();
  calls: string[] = [];
  async fetchJobPage(url: string): Promise<FetchOutcome> {
    this.calls.push(url);
    return this.pages.get(url) ?? { kind: 'blocked', status: 403, message: 'Vivian answered with a Cloudflare bot check.' };
  }
}

let db: Db;
let app: FastifyInstance;
let worker: BatchWorker;
const fetcher = new FakeFetcher();
let cookie = '';
let memberCookie = '';

async function call(method: string, url: string, body?: unknown, who = cookie) {
  const res = await app.inject({ method: method as 'GET', url, payload: body as object, headers: who ? { cookie: who } : {} });
  return { status: res.statusCode, json: res.headers['content-type']?.includes('json') ? res.json() : null, text: res.body };
}

async function login(email: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  expect(res.statusCode).toBe(200);
  const c = res.cookies.find((x) => x.name === 'lf_session');
  return `lf_session=${c!.value}`;
}

beforeAll(async () => {
  db = createPool(TEST_DB);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await db.query("INSERT INTO users(email, name, role, password_hash) VALUES ('admin@test.local','Test Admin','admin',$1), ('am@test.local','Account Manager','member',$1)", [await hashPassword('correct-horse-1')]);
  ({ app, worker } = await buildApp({ db, fetcher }));
  cookie = await login('admin@test.local', 'correct-horse-1');
  memberCookie = await login('am@test.local', 'correct-horse-1');
});
afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe('auth and security', () => {
  it('requires sign-in', async () => {
    expect((await call('GET', '/api/facilities', undefined, '')).status).toBe(401);
  });
  it('rejects wrong passwords', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@test.local', password: 'nope' } });
    expect(r.statusCode).toBe(401);
  });
  it('blocks cross-site cookie writes', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/batches', payload: { text: 'x' }, headers: { cookie, origin: 'https://evil.example', host: 'localhost' } });
    expect(r.statusCode).toBe(403);
  });
  it('API tokens authenticate the extension', async () => {
    const { json } = await call('POST', '/api/tokens', { label: 'Chrome' });
    const r = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${json.token}` } });
    expect(r.json().user.email).toBe('admin@test.local');
  });
  it('rejects non-Vivian URLs before any network request (SSRF)', async () => {
    const before = fetcher.calls.length;
    for (const url of ['http://169.254.169.254/latest/meta-data', 'https://localhost/job/1/', 'https://www.vivian.com.attacker.net/job/1/']) {
      expect((await call('POST', '/api/extract/url', { url })).status).toBe(400);
    }
    expect(fetcher.calls.length).toBe(before);
  });
});

describe('Phase 1: extract, correct, save, search', () => {
  it('reports the Cloudflare block for live fetches instead of pretending', async () => {
    const r = await call('POST', '/api/extract/url', { url: 'https://www.vivian.com/job/999-1/' });
    expect(r.status).toBe(200);
    expect(r.json.fetch.kind).toBe('blocked');
    expect(r.json.result).toBeUndefined();
  });

  let extractionId = '';
  it('extracts from pasted page source and records the evidence', async () => {
    const r = await call('POST', '/api/extract/html', { html: lcfl, url: 'https://www.vivian.com/job/145-1448402/' });
    expect(r.status).toBe(200);
    expect(r.json.result.status).toBe('confirmed');
    expect(r.json.result.facility.name).toBe('Lower Cape Fear LifeCare');
    expect(r.json.matches).toEqual([]);
    extractionId = r.json.extractionId;
    const row = (await db.query('SELECT method, identity_status, source_field, original_value, source_url FROM extractions WHERE id = $1', [extractionId])).rows[0];
    expect(row).toEqual({ method: 'paste', identity_status: 'confirmed', source_field: 'hospitalName', original_value: 'Lower Cape Fear LifeCare', source_url: 'https://www.vivian.com/job/145-1448402/' });
  });

  let facilityId = '';
  it('saves the lead with manual corrections and keeps the original value', async () => {
    const r = await call('POST', '/api/leads', {
      extractionId, sourceUrl: 'https://www.vivian.com/job/145-1448402/', facilityChoice: 'auto',
      facility: { name: 'Lower Cape Fear LifeCare', street: '1414 Physicians Dr', city: 'Wilmington', state: 'NC' },
      job: { title: 'Hospice RN Case Manager' },
    });
    expect(r.status, r.text).toBe(200);
    expect(r.json.facilityCreated).toBe(true);
    facilityId = r.json.facilityId;
    const ex = (await db.query('SELECT corrections, job_posting_id FROM extractions WHERE id = $1', [extractionId])).rows[0];
    expect(ex.job_posting_id).toBe(r.json.jobId);
    expect(ex.corrections['facility.city']).toEqual({ from: null, to: 'Wilmington' });
    expect(ex.corrections['facility.name']).toBeUndefined();
    const f = await call('GET', `/api/facilities/${facilityId}`);
    expect(f.json).toMatchObject({ name: 'Lower Cape Fear LifeCare', city: 'Wilmington', state: 'NC', identityStatus: 'confirmed', verificationStatus: 'extracted', careLines: ['hospice'], jobCount: 1, leadStatus: 'New Lead' });
    expect(f.json.jobs[0]).toMatchObject({ specialty: 'Hospice RN Case Manager', classification: 'accept', source_url: 'https://www.vivian.com/job/145-1448402/' });
    expect(f.json.jobs[0].extractions[0].original_value).toBe('Lower Cape Fear LifeCare');
  });

  it('does not save the same job URL twice', async () => {
    const x = await call('POST', '/api/extract/html', { html: lcfl, url: 'https://www.vivian.com/job/145-1448402/' });
    expect(x.json.existingJob.facility_name).toBe('Lower Cape Fear LifeCare');
    const r = await call('POST', '/api/leads', { extractionId: x.json.extractionId, sourceUrl: 'https://www.vivian.com/job/145-1448402/', facility: { name: 'Lower Cape Fear LifeCare' }, job: { title: 'Hospice RN Case Manager' } });
    expect(r.json.existingJob).toBe(true);
    expect((await db.query('SELECT count(*)::int AS n FROM job_postings')).rows[0].n).toBe(1);
    // a server-side lookup of a known job is skipped without contacting Vivian
    const before = fetcher.calls.length;
    const s = await call('POST', '/api/extract/url', { url: 'https://www.vivian.com/job/145-1448402/' });
    expect(s.json.skipped).toBe(true);
    expect(fetcher.calls.length).toBe(before);
  });

  it('refuses excluded jobs and generic facility names', async () => {
    const icu = await call('POST', '/api/leads', { sourceUrl: 'https://www.vivian.com/job/1-500/', facility: { name: 'Memorial Regional' }, job: { title: 'ICU Registered Nurse' } });
    expect(icu.status).toBe(422);
    expect(icu.json.error).toContain('outside the target specialties');
    const generic = await call('POST', '/api/leads', { sourceUrl: 'https://www.vivian.com/job/1-501/', facility: { name: 'Home Health Agency' }, job: { title: 'Home Health RN' } });
    expect(generic.status).toBe(422);
    expect(generic.json.error).toContain('generic');
  });

  it('allows a manual classification override and records it', async () => {
    const r = await call('POST', '/api/leads', {
      sourceUrl: 'https://www.vivian.com/job/1-502/', facility: { name: 'Seabreeze Care Partners', city: 'Tampa', state: 'FL' }, job: { title: 'RN Case Manager' },
      classification: { decision: 'accept', careLine: 'home_health', license: 'RN', role: 'Case Manager' },
    });
    expect(r.status, r.text).toBe(200);
    const j = (await db.query('SELECT specialty, classification, classification_manual FROM job_postings WHERE id = $1', [r.json.jobId])).rows[0];
    expect(j).toEqual({ specialty: 'Home Health RN Case Manager', classification: 'accept', classification_manual: true });
  });

  it('groups three Tampa hospice jobs under one facility', async () => {
    const jobs = [['2-1', 'Hospice RN', '100 Main Street'], ['2-2', 'Hospice RN Case Manager', '100 Main St'], ['2-3', 'Hospice Admissions RN', null]] as const;
    const ids = new Set<string>();
    for (const [id, title, street] of jobs) {
      const x = await call('POST', '/api/extract/html', { html: pageWith({ jobTitle: title, hospitalName: 'Bayside Hospice', hospitalAddress: street, hospitalCity: 'Tampa', hospitalState: 'FL' }), url: `https://www.vivian.com/job/${id}/` });
      const r = await call('POST', '/api/leads', { extractionId: x.json.extractionId, sourceUrl: `https://www.vivian.com/job/${id}/`, facility: { name: 'Bayside Hospice', street, city: 'Tampa', state: 'FL' }, job: { title } });
      expect(r.status, r.text).toBe(200);
      ids.add(r.json.facilityId);
    }
    expect(ids.size).toBe(1);
    const f = await call('GET', `/api/facilities/${[...ids][0]}`);
    expect(f.json.jobCount).toBe(3);
    expect(f.json.street).toBe('100 Main Street');
    expect(f.json.specialties.sort()).toEqual(['Hospice Admissions RN', 'Hospice RN', 'Hospice RN Case Manager']);
  });

  it('keeps a same-name branch at a different address separate and flags it', async () => {
    const r = await call('POST', '/api/leads', { sourceUrl: 'https://www.vivian.com/job/2-4/', facility: { name: 'Bayside Hospice', street: '9 Gulf Blvd', city: 'Clearwater', state: 'FL' }, job: { title: 'Hospice LPN' } });
    expect(r.json.facilityCreated).toBe(true);
    const m = await call('POST', '/api/facilities/match', { name: 'Bayside Hospice', street: '9 Gulf Blvd', city: 'Clearwater', state: 'FL' });
    expect(m.json[0].strength).toBe('exact');
    expect(m.json.some((x: { strength: string }) => x.strength === 'possible')).toBe(true);
  });

  it('searches and filters saved facilities', async () => {
    const all = await call('GET', '/api/facilities?q=bayside');
    expect(all.json.total).toBe(2);
    const fl = await call('GET', '/api/facilities?state=FL&careLine=hospice&license=LPN%2FLVN');
    expect(fl.json.rows.map((r: { city: string }) => r.city)).toEqual(['Clearwater']);
    const nc = await call('GET', '/api/facilities?state=NC');
    expect(nc.json.rows[0]).toMatchObject({ name: 'Lower Cape Fear LifeCare', jobCount: 1 });
    expect(nc.json.rows[0].sourceUrls).toEqual(['https://www.vivian.com/job/145-1448402/']);
  });
});

describe('editing, audit, merge and undo', () => {
  it('edits a facility with an audit trail and status history', async () => {
    const f = (await call('GET', '/api/facilities?q=Lower')).json.rows[0];
    const users = (await call('GET', '/api/users')).json;
    const r = await call('PATCH', `/api/facilities/${f.id}`, { leadStatus: 'Research Needed', ownerId: users[0].id, website: 'https://example.org', nextFollowUp: '2026-11-20' }, memberCookie);
    expect(r.status, r.text).toBe(200);
    const d = (await call('GET', `/api/facilities/${f.id}`)).json;
    expect(d).toMatchObject({ leadStatus: 'Research Needed', website: 'https://example.org', nextFollowUp: '2026-11-20' });
    expect(d.audit.some((a: { action: string; changes: Record<string, unknown> }) => a.action === 'update' && 'leadStatus' in a.changes)).toBe(true);
    expect(d.activities[0].kind).toBe('status_change');
  });

  it('corrects a job classification manually', async () => {
    const f = (await call('GET', '/api/facilities?q=Seabreeze')).json.rows[0];
    const d = (await call('GET', `/api/facilities/${f.id}`)).json;
    const r = await call('PATCH', `/api/jobs/${d.jobs[0].id}`, { careLine: 'hospice' });
    expect(r.status, r.text).toBe(200);
    const d2 = (await call('GET', `/api/facilities/${f.id}`)).json;
    expect(d2.jobs[0].specialty).toBe('Hospice RN Case Manager');
    expect(d2.careLines).toEqual(['hospice']);
  });

  it('merges confirmed duplicates (manager role) and undoes the merge', async () => {
    const rows = (await call('GET', '/api/facilities?q=Bayside')).json.rows;
    const tampa = rows.find((r: { city: string }) => r.city === 'Tampa');
    const clw = rows.find((r: { city: string }) => r.city === 'Clearwater');
    expect((await call('POST', `/api/facilities/${tampa.id}/merge`, { mergeId: clw.id }, memberCookie)).status).toBe(403);
    const m = await call('POST', `/api/facilities/${tampa.id}/merge`, { mergeId: clw.id });
    expect(m.json.movedJobs).toBe(1);
    expect((await call('GET', `/api/facilities/${tampa.id}`)).json.jobCount).toBe(4);
    expect((await call('GET', `/api/facilities/${clw.id}`)).status).toBe(410);
    const u = await call('POST', `/api/merges/${m.json.mergeId}/undo`);
    expect(u.json.restoredId).toBe(clw.id);
    expect((await call('GET', `/api/facilities/${tampa.id}`)).json.jobCount).toBe(3);
    expect((await call('GET', `/api/facilities/${clw.id}`)).json.jobCount).toBe(1);
  });

  it('records contact notes and updates last contacted', async () => {
    const f = (await call('GET', '/api/facilities?q=Lower')).json.rows[0];
    await call('POST', `/api/facilities/${f.id}/activities`, { kind: 'contact', body: 'Called main line; asked for DON.', contactDate: '2026-11-16' });
    expect((await call('GET', `/api/facilities/${f.id}`)).json.lastContactedAt).toBe('2026-11-16');
  });

  it('exports CSV with source URLs and verification status', async () => {
    const r = await call('GET', '/api/export.csv?state=NC');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Source URL');
    expect(r.text).toContain('https://www.vivian.com/job/145-1448402/');
    expect(r.text).toContain('Extracted from Vivian');
  });

  it('computes dashboard KPIs', async () => {
    const d = (await call('GET', '/api/dashboard')).json;
    expect(d.kpis).toMatchObject({ totalFacilities: 4, hospice: 4, homeHealth: 0, followUpsDue: 0 });
  });
});

describe('Phase 2: batch import', () => {
  it('dedupes, processes, and reports failures and blocks honestly', async () => {
    fetcher.pages.set('https://www.vivian.com/job/3-1/', { kind: 'ok', status: 200, finalUrl: 'https://www.vivian.com/job/3-1/', html: pageWith({ jobTitle: 'Home Health LVN', hospitalName: 'Lone Star Home Health', hospitalCity: 'Austin', hospitalState: 'TX' }) });
    fetcher.pages.set('https://www.vivian.com/job/3-2/', { kind: 'error', status: 404, message: 'Vivian says this job page does not exist.' });
    const text = [
      'url,notes',
      'https://www.vivian.com/job/3-1/,first',
      'https://www.vivian.com/job/3-1/?ref=dup,repeat',
      'https://www.vivian.com/job/3-2/',
      'https://www.vivian.com/job/145-1448402/',
      'https://www.vivian.com/job/3-3/',
      'https://www.vivian.com/job/3-4/',
      'https://example.com/not-vivian',
    ].join('\n');
    const b = await call('POST', '/api/batches', { text });
    expect(b.json).toMatchObject({ queued: 4, duplicate: 1, invalid: 1, repeatedInBatch: 1 });
    await worker.drain();
    const d = (await call('GET', `/api/batches/${b.json.batchId}`)).json;
    const by = Object.fromEntries(d.items.map((i: { url: string }) => [i.url, i]));
    expect(by['https://www.vivian.com/job/3-1/']).toMatchObject({ status: 'extracted', result: { facilityName: 'Lone Star Home Health', specialty: 'Home Health LVN', state: 'TX' } });
    expect(by['https://www.vivian.com/job/3-2/'].status).toBe('failed');
    expect(by['https://www.vivian.com/job/145-1448402/'].status).toBe('duplicate');
    expect(by['https://www.vivian.com/job/3-3/'].status).toBe('needs_browser');
    // after the first block, the rest of the batch is not requested from Vivian
    expect(by['https://www.vivian.com/job/3-4/'].status).toBe('needs_browser');
    expect(fetcher.calls.filter((u) => u.includes('/job/3-4/'))).toHaveLength(0);

    // resolving an item through the extension marks it saved
    const x = await call('POST', '/api/extract/html', { method: 'extension', html: pageWith({ jobTitle: 'Hospice LVN', hospitalName: 'Hill Country Hospice', hospitalState: 'TX' }), url: 'https://www.vivian.com/job/3-3/' });
    await call('POST', '/api/leads', { extractionId: x.json.extractionId, sourceUrl: 'https://www.vivian.com/job/3-3/', facility: { name: 'Hill Country Hospice', state: 'TX' }, job: { title: 'Hospice LVN' } });
    const d2 = (await call('GET', `/api/batches/${b.json.batchId}`)).json;
    expect(d2.items.find((i: { url: string }) => i.url.includes('3-3')).status).toBe('saved');
    // VMS seen on the page is stored with the job and exported
    const x2 = await call('POST', '/api/extract/html', { html: pageWith({ jobTitle: 'Hospice RN', hospitalName: 'Hill Country Hospice', hospitalState: 'TX', vmsName: 'ShiftWise' }), url: 'https://www.vivian.com/job/3-9/' });
    expect(x2.json.result.vms.name).toBe('ShiftWise');
    await call('POST', '/api/leads', { extractionId: x2.json.extractionId, sourceUrl: 'https://www.vivian.com/job/3-9/', facility: { name: 'Hill Country Hospice', state: 'TX' }, job: { title: 'Hospice RN' } });
    const hc = (await call('GET', '/api/facilities?q=Hill Country')).json.rows[0];
    expect(hc.vmsNames).toEqual(['ShiftWise']);
    expect((await call('GET', '/api/export.csv?state=TX')).text).toContain('ShiftWise');

    // retry re-queues failed and blocked items
    const rt = await call('POST', `/api/batches/${b.json.batchId}/retry`);
    expect(rt.json.requeued).toBe(2);
  });
});

describe('settings', () => {
  it('admins can extend the taxonomy; members cannot', async () => {
    const s = (await call('GET', '/api/settings')).json;
    const next = { ...s.taxonomy, careLines: { ...s.taxonomy.careLines, hospice: [...s.taxonomy.careLines.hospice, '\\bcomfort nurse\\b'] } };
    expect((await call('PUT', '/api/settings/taxonomy', next, memberCookie)).status).toBe(403);
    expect((await call('PUT', '/api/settings/taxonomy', { excluded: ['(bad'] })).status).toBe(400);
    expect((await call('PUT', '/api/settings/taxonomy', next)).status).toBe(200);
    const x = await call('POST', '/api/extract/html', { html: pageWith({ jobTitle: 'Comfort Nurse RN', hospitalName: 'Willow Creek Care' }) });
    expect(x.json.result.classification.careLine).toBe('hospice');
  });
});
