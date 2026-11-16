import {
  CARE_LINE_LABEL, DEFAULT_TAXONOMY, DEFAULT_WEIGHTS, classifyJob, compareFacilities, extractFromHtml, mergeTaxonomy,
  normalizeName, normalizeState, orgNameGenericity, parseVivianJobUrl, scoreLead, splitBranch, validateTaxonomy,
  type CareLine, type Classification, type ExtractionResult, type FacilityLike, type MatchStrength, type Priority,
  type ScoringWeights, type Taxonomy,
} from '../core/index.ts';
import { audit, tx, type Db, type Queryable } from './db.ts';
import { HttpError } from './errors.ts';
import type { User } from './auth.ts';

export const LEAD_STATUSES = [
  'New Lead', 'Research Needed', 'Qualified', 'Ready for Outreach', 'Contacted', 'Follow-Up Needed',
  'Meeting Scheduled', 'Active Opportunity', 'Existing Client', 'Not a Fit',
] as const;
export const VERIFICATION_STATUSES = ['extracted', 'unverified', 'verified_website', 'verified_license', 'verified_manual'] as const;
export const VERIFICATION_LABEL: Record<string, string> = {
  extracted: 'Extracted from Vivian',
  unverified: 'Unverified / manual entry',
  verified_website: 'Verified: official website',
  verified_license: 'Verified: licensing source',
  verified_manual: 'Verified: manual research',
};
export const PRIORITIES: Priority[] = ['High', 'Medium', 'Low', 'Needs Research'];

// ---- settings -------------------------------------------------------------------------

export class Settings {
  taxonomy: Taxonomy = DEFAULT_TAXONOMY;
  weights: ScoringWeights = DEFAULT_WEIGHTS;
  taxonomyOverride: unknown = null;
  constructor(private db: Db) {}
  async load(): Promise<void> {
    const r = await this.db.query<{ key: string; value: unknown }>("SELECT key, value FROM settings WHERE key IN ('taxonomy','scoring')");
    const t = r.rows.find((x) => x.key === 'taxonomy')?.value ?? null;
    const s = r.rows.find((x) => x.key === 'scoring')?.value ?? null;
    this.taxonomyOverride = t;
    this.taxonomy = t ? mergeTaxonomy(t) : DEFAULT_TAXONOMY;
    this.weights = { ...DEFAULT_WEIGHTS, ...(s && typeof s === 'object' ? (s as Partial<ScoringWeights>) : {}) };
  }
  async saveTaxonomy(user: User, override: unknown): Promise<void> {
    const merged = mergeTaxonomy(override);
    try { validateTaxonomy(merged); } catch (e) { throw new HttpError(400, (e as Error).message); }
    await this.db.query('INSERT INTO settings(key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()', ['taxonomy', JSON.stringify(merged), user.id]);
    await audit(this.db, user.id, 'settings', 'taxonomy', 'update', {});
    await this.load();
  }
  async saveWeights(user: User, w: Partial<ScoringWeights>): Promise<void> {
    const next = { ...DEFAULT_WEIGHTS, ...this.weights };
    for (const [k, v] of Object.entries(w)) {
      if (!(k in DEFAULT_WEIGHTS) || typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000) throw new HttpError(400, `Invalid scoring value for ${k}.`);
      (next as Record<string, number>)[k] = v;
    }
    await this.db.query('INSERT INTO settings(key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()', ['scoring', JSON.stringify(next), user.id]);
    await audit(this.db, user.id, 'settings', 'scoring', 'update', next);
    await this.load();
  }
}

// ---- extraction records -----------------------------------------------------------------

export type ExtractMethod = 'server_fetch' | 'extension' | 'paste';

export async function recordExtraction(q: Queryable, user: User | null, method: ExtractMethod, url: string | null, result: ExtractionResult): Promise<string> {
  const r = await q.query<{ id: string }>(
    `INSERT INTO extractions(source_url, method, identity_status, source_field, source_path, original_value, result, errors, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [url, method, result.status, result.facility.sourceField, result.facility.sourcePath, result.facility.name, JSON.stringify(result), JSON.stringify(result.errors), user?.id ?? null],
  );
  return r.rows[0].id;
}

export async function getExtraction(q: Queryable, id: string) {
  const r = await q.query('SELECT id, source_url, method, extracted_at, identity_status, source_field, source_path, original_value, result, corrections, errors, job_posting_id FROM extractions WHERE id = $1', [id]);
  if (!r.rows[0]) throw new HttpError(404, 'Extraction not found.');
  return r.rows[0];
}

export async function findJobByUrl(q: Queryable, url: string) {
  const r = await q.query<{ id: string; facility_id: string | null; title: string; facility_name: string | null; first_seen_at: Date; last_seen_at: Date }>(
    `SELECT j.id, j.facility_id, j.title, f.name AS facility_name, j.first_seen_at, j.last_seen_at
       FROM job_postings j LEFT JOIN facilities f ON f.id = j.facility_id WHERE j.source_url = $1`, [url]);
  return r.rows[0] ?? null;
}

/** Run the engine on HTML and store the attempt. Used by paste, extension and server fetch. */
export async function extractAndRecord(db: Db, settings: Settings, user: User | null, method: ExtractMethod, html: string, rawUrl: string | null) {
  let url: string | null = null;
  const warnings: string[] = [];
  if (rawUrl) {
    const v = parseVivianJobUrl(rawUrl);
    if (v.ok) url = v.url;
    else warnings.push(`Source URL not recognised as a Vivian job URL: ${v.error}`);
  }
  const result = extractFromHtml(html, { taxonomy: settings.taxonomy, url: url ?? undefined });
  result.warnings.push(...warnings);
  const extractionId = await recordExtraction(db, user, method, url, result);
  const existingJob = url ? await findJobByUrl(db, url) : null;
  const matches = result.facility.name
    ? await matchFacilities(db, { name: result.facility.name, street: result.facility.address.street, city: result.facility.address.city ?? result.job.city, state: result.facility.address.state ?? result.job.state, parentName: result.facility.systemName })
    : [];
  return { extractionId, url, result, existingJob, matches };
}

// ---- duplicate matching -------------------------------------------------------------------

const STRENGTH_RANK: Record<MatchStrength, number> = { exact: 0, likely: 1, possible: 2, related: 3 };

export interface FacilityMatch {
  facility: { id: string; name: string; street: string | null; city: string | null; state: string | null; parentName: string | null; jobCount: number };
  strength: MatchStrength;
  reasons: string[];
}

export async function matchFacilities(q: Queryable, input: FacilityLike, excludeId?: string): Promise<FacilityMatch[]> {
  const norm = normalizeName(input.name);
  const st = normalizeState(input.state);
  const r = await q.query<{ id: string; name: string; street: string | null; city: string | null; state: string | null; website: string | null; branch_code: string | null; parent_name: string | null; job_count: number }>(
    `SELECT f.id, f.name, f.street, f.city, f.state, f.website, f.branch_code, o.name AS parent_name,
            (SELECT count(*)::int FROM job_postings j WHERE j.facility_id = f.id) AS job_count
       FROM facilities f LEFT JOIN organizations o ON o.id = f.organization_id
      WHERE f.merged_into_id IS NULL AND ($3::uuid IS NULL OR f.id <> $3::uuid)
        AND (f.normalized_name = $1 OR f.state = $2 OR $2 = '' OR f.normalized_name LIKE $4)
      LIMIT 5000`,
    [norm, st, excludeId ?? null, `${norm.split(' ')[0] ?? ''}%`],
  );
  const out: FacilityMatch[] = [];
  for (const f of r.rows) {
    const m = compareFacilities(input, { name: f.name, street: f.street, city: f.city, state: f.state, website: f.website, branchCode: f.branch_code, parentName: f.parent_name });
    if (m) out.push({ facility: { id: f.id, name: f.name, street: f.street, city: f.city, state: f.state, parentName: f.parent_name, jobCount: f.job_count }, strength: m.strength, reasons: m.reasons });
  }
  return out.sort((a, b) => STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength]).slice(0, 15);
}

// ---- saving leads -------------------------------------------------------------------------

export interface SaveLeadInput {
  extractionId?: string;
  sourceUrl: string;
  facilityChoice: 'auto' | 'new' | string;
  facility: { name: string; street?: string | null; city?: string | null; state?: string | null; zip?: string | null; website?: string | null; phone?: string | null; parentName?: string | null; branchLabel?: string | null };
  job: { title: string; city?: string | null; state?: string | null; employmentType?: string | null };
  /** Manual classification override. Omit to classify from the title automatically. */
  classification?: { decision: 'accept' | 'review' | 'exclude'; careLine: CareLine | null; license: string | null; role: string | null };
  /** Required when there is no stored extraction (manual entry). */
  method?: ExtractMethod;
}

const blank = (s: string | null | undefined) => (s ?? '').trim() || null;

export function facilityTypeLabel(careLines: string[]): string | null {
  const lines = careLines.filter((l): l is CareLine => l in CARE_LINE_LABEL);
  if (!lines.length) return null;
  if (lines.length === 1) return CARE_LINE_LABEL[lines[0]];
  const order: CareLine[] = ['home_health', 'hospice', 'ipc_hospice', 'palliative'];
  return `Hybrid: ${order.filter((l) => lines.includes(l)).map((l) => CARE_LINE_LABEL[l]).join(' + ')}`;
}

async function upsertOrganization(q: Queryable, name: string | null | undefined): Promise<string | null> {
  const n = blank(name);
  if (!n) return null;
  const norm = normalizeName(n);
  const r = await q.query<{ id: string }>(
    `INSERT INTO organizations(name, normalized_name) VALUES ($1,$2)
     ON CONFLICT (normalized_name) DO UPDATE SET updated_at = organizations.updated_at RETURNING id`, [n, norm]);
  return r.rows[0].id;
}

async function refreshCareLines(q: Queryable, facilityId: string): Promise<void> {
  await q.query(
    `UPDATE facilities SET care_lines = COALESCE((SELECT array_agg(DISTINCT care_line ORDER BY care_line) FROM job_postings
        WHERE facility_id = $1 AND classification <> 'exclude' AND care_line IS NOT NULL), '{}'), updated_at = now() WHERE id = $1`, [facilityId]);
}

function specialtyFromOverride(base: Classification, o: NonNullable<SaveLeadInput['classification']>): Classification {
  const care = o.careLine ? CARE_LINE_LABEL[o.careLine] : null;
  const pre = o.role && ['Admissions', 'On-Call', 'Triage', 'After-Hours', 'Weekend'].includes(o.role) ? `${o.role} ` : '';
  const post = o.role === 'Case Manager' ? ' Case Manager' : '';
  return {
    decision: o.decision,
    careLine: o.careLine,
    careLines: o.careLine ? [o.careLine] : [],
    license: (o.license as Classification['license']) ?? null,
    role: o.role,
    specialty: care ? `${care} ${pre}${o.license ?? 'Nurse'}${post}` : null,
    reasons: [...base.reasons, 'Classification set manually.'],
  };
}

export async function saveLead(db: Db, settings: Settings, user: User, input: SaveLeadInput) {
  const v = parseVivianJobUrl(input.sourceUrl);
  if (!v.ok) throw new HttpError(400, v.error);
  const url = v.url;
  const name = blank(input.facility.name);
  if (!name) throw new HttpError(422, 'Enter the facility name before saving.');
  if (orgNameGenericity(name, settings.taxonomy) === 'generic') throw new HttpError(422, `"${name}" is a generic description, not an organization name. Enter the facility's actual name.`);
  const title = blank(input.job.title);
  if (!title) throw new HttpError(422, 'Enter the job title before saving.');

  let extraction: { id: string; result: ExtractionResult; job_posting_id: string | null } | null = null;
  if (input.extractionId) {
    const e = await getExtraction(db, input.extractionId);
    extraction = { id: e.id, result: e.result as ExtractionResult, job_posting_id: e.job_posting_id };
  }

  const auto = classifyJob({ title, context: [extraction?.result.job.specialtyHint, name].filter(Boolean).join(' ') }, settings.taxonomy);
  const cls = input.classification ? specialtyFromOverride(auto, input.classification) : auto;
  const manualCls = !!input.classification && (input.classification.decision !== auto.decision || input.classification.careLine !== auto.careLine || input.classification.license !== auto.license || input.classification.role !== auto.role);
  if (cls.decision === 'exclude') {
    throw new HttpError(422, `This job is outside the target specialties and was not saved. ${auto.reasons.join(' ')} If that is wrong, change the classification and save again.`);
  }

  // what the user changed relative to the engine's output
  const corrections: Record<string, { from: unknown; to: unknown }> = {};
  if (extraction) {
    const r = extraction.result;
    const cmp = (field: string, from: unknown, to: unknown) => { if ((from ?? null) !== (to ?? null)) corrections[field] = { from: from ?? null, to: to ?? null }; };
    cmp('facility.name', r.facility.name, name);
    cmp('facility.street', r.facility.address.street, blank(input.facility.street));
    cmp('facility.city', r.facility.address.city, blank(input.facility.city));
    cmp('facility.state', r.facility.address.state, blank(input.facility.state) ? normalizeState(input.facility.state) : null);
    cmp('facility.zip', r.facility.address.zip, blank(input.facility.zip));
    cmp('job.title', r.job.title, title);
    if (manualCls) corrections.classification = { from: { decision: r.classification.decision, careLine: r.classification.careLine, license: r.classification.license, role: r.classification.role }, to: input.classification };
  }
  const nameCorrected = !!corrections['facility.name'];
  const identityStatus = !extraction ? 'manual' : nameCorrected ? 'manual' : extraction.result.status;

  return tx(db, async (c) => {
    // duplicate job posting: record the new observation, do not create a second job
    const existing = await findJobByUrl(c, url);
    if (existing) {
      await c.query('UPDATE job_postings SET last_seen_at = now() WHERE id = $1', [existing.id]);
      if (extraction) await c.query('UPDATE extractions SET job_posting_id = $1, source_url = $2 WHERE id = $3', [existing.id, url, extraction.id]);
      await audit(c, user.id, 'job_posting', existing.id, 'reobserved', { url });
      await c.query("UPDATE batch_items SET status = 'saved', job_posting_id = $1, updated_at = now() WHERE url = $2 AND status <> 'saved'", [existing.id, url]);
      return { existingJob: true, jobId: existing.id, facilityId: existing.facility_id, facilityCreated: false };
    }

    // choose or create the facility
    let facilityId: string | null = null;
    let facilityCreated = false;
    const submitted: FacilityLike = { name, street: blank(input.facility.street), city: blank(input.facility.city), state: blank(input.facility.state), website: blank(input.facility.website), parentName: blank(input.facility.parentName) };
    if (input.facilityChoice !== 'new' && input.facilityChoice !== 'auto') {
      const f = await c.query<{ id: string; merged_into_id: string | null }>('SELECT id, merged_into_id FROM facilities WHERE id = $1', [input.facilityChoice]);
      if (!f.rows[0]) throw new HttpError(404, 'The selected facility no longer exists.');
      facilityId = f.rows[0].merged_into_id ?? f.rows[0].id;
    } else if (input.facilityChoice === 'auto') {
      const m = (await matchFacilities(c, submitted)).filter((x) => x.strength === 'exact' || x.strength === 'likely');
      const exact = m.filter((x) => x.strength === 'exact');
      if (exact.length === 1) facilityId = exact[0].facility.id;
      else if (!exact.length && m.length === 1) facilityId = m[0].facility.id;
    }

    const orgId = await upsertOrganization(c, input.facility.parentName);
    const state = blank(input.facility.state) ? normalizeState(input.facility.state) : null;
    if (!facilityId) {
      const branch = blank(input.facility.branchLabel) ?? splitBranch(name).branch;
      const r = await c.query<{ id: string }>(
        `INSERT INTO facilities(organization_id, name, normalized_name, street, city, state, zip, website, phone, branch_label,
                                verification_status, identity_status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [orgId, name, normalizeName(name), blank(input.facility.street), blank(input.facility.city), state, blank(input.facility.zip),
          blank(input.facility.website), blank(input.facility.phone), branch, identityStatus === 'confirmed' ? 'extracted' : 'unverified', identityStatus, user.id],
      );
      facilityId = r.rows[0].id;
      facilityCreated = true;
      await audit(c, user.id, 'facility', facilityId, 'create', { name, identityStatus, sourceUrl: url });
    } else {
      // fill blanks on the existing record only; never overwrite what is there
      const before = (await c.query('SELECT street, city, state, zip, website, phone, organization_id FROM facilities WHERE id = $1', [facilityId])).rows[0];
      const fill: Record<string, unknown> = {};
      for (const [col, val] of [['street', blank(input.facility.street)], ['city', blank(input.facility.city)], ['state', state], ['zip', blank(input.facility.zip)], ['website', blank(input.facility.website)], ['phone', blank(input.facility.phone)], ['organization_id', orgId]] as const) {
        if (val && !before[col]) fill[col] = val;
      }
      if (Object.keys(fill).length) {
        const cols = Object.keys(fill);
        await c.query(`UPDATE facilities SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1`, [facilityId, ...cols.map((k) => fill[k])]);
        await audit(c, user.id, 'facility', facilityId, 'fill_blanks', fill);
      }
    }

    const res = extraction?.result;
    const jr = await c.query<{ id: string }>(
      `INSERT INTO job_postings(facility_id, source, source_url, external_id, title, specialty, care_line, license, role, classification,
                                classification_reasons, classification_manual, employment_type, city, state, advertiser_name, advertiser_is_agency, created_by, vms_name, vms)
       VALUES ($1,'vivian',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [facilityId, url, v.externalId, title, cls.specialty, cls.careLine, cls.license, cls.role, cls.decision, JSON.stringify(cls.reasons), manualCls,
        blank(input.job.employmentType) ?? res?.job.employmentType ?? null,
        blank(input.job.city) ?? res?.job.city ?? null,
        blank(input.job.state) ? normalizeState(input.job.state) : res?.job.state ?? null,
        res?.advertiser?.name ?? null, res?.advertiser?.looksLikeStaffingAgency ?? null, user.id,
        res?.vms?.name ?? null, res?.vms && (res.vms.fields.length || res.vms.mentions.length) ? JSON.stringify(res.vms) : null],
    );
    const jobId = jr.rows[0].id;
    if (extraction) {
      await c.query('UPDATE extractions SET job_posting_id = $1, source_url = $2, corrections = $3 WHERE id = $4', [jobId, url, JSON.stringify(corrections), extraction.id]);
    } else {
      const manual: ExtractionResult = {
        status: 'not_found', facility: { name, sourceField: 'manual entry', sourcePath: null, address: { street: blank(input.facility.street), city: blank(input.facility.city), state, zip: blank(input.facility.zip) }, addressSourceFields: [], systemId: null, systemName: null },
        advertiser: null, vms: { name: null, fields: [], mentions: [] }, job: { title, titleSource: 'manual entry', city: blank(input.job.city), state: blank(input.job.state), employmentType: blank(input.job.employmentType), externalId: v.externalId, specialtyHint: null, datePosted: null },
        classification: cls, evidence: [], warnings: ['Entered manually; nothing was extracted from the page.'], errors: [],
      };
      const id = await recordExtraction(c, user, input.method ?? 'paste', url, manual);
      await c.query('UPDATE extractions SET job_posting_id = $1, identity_status = $2 WHERE id = $3', [jobId, 'manual', id]);
    }
    await audit(c, user.id, 'job_posting', jobId, 'create', { url, title, specialty: cls.specialty, decision: cls.decision, facilityId, corrections });
    await refreshCareLines(c, facilityId);
    await c.query("UPDATE batch_items SET status = 'saved', job_posting_id = $1, updated_at = now() WHERE url = $2", [jobId, url]);
    return { existingJob: false, jobId, facilityId, facilityCreated };
  });
}

// ---- listing, profiles, scoring --------------------------------------------------------------

export interface LeadFilters {
  q?: string; state?: string; city?: string; careLine?: string; specialty?: string; license?: 'RN' | 'LPN/LVN';
  status?: string; priority?: string; owner?: string; verification?: string; discoveredFrom?: string; discoveredTo?: string;
  classification?: string; existingClient?: 'yes' | 'no'; sort?: string; dir?: 'asc' | 'desc'; limit?: number; offset?: number;
}

interface JobAgg { id: string; title: string; specialty: string | null; care_line: string | null; license: string | null; role: string | null; decision: string; last_seen: string; first_seen: string; source_url: string; city: string | null; state: string | null; advertiser: string | null; vms: string | null }

export interface LeadRow {
  id: string; name: string; parentName: string | null; organizationId: string | null; street: string | null; city: string | null; state: string | null; zip: string | null;
  website: string | null; phone: string | null; facilityType: string | null; careLines: string[]; specialties: string[]; vmsNames: string[]; jobCount: number; reviewJobCount: number;
  lastJobObserved: string | null; firstDiscovered: string; priority: Priority; computedPriority: Priority; priorityOverride: string | null; score: number;
  scoreReasons: { label: string; points: number }[]; leadStatus: string; ownerId: string | null; ownerName: string | null; verificationStatus: string;
  identityStatus: string; isExistingClient: boolean; existingClientOwner: string | null; nextFollowUp: string | null; lastContactedAt: string | null; nextAction: string | null; jobs: JobAgg[];
}

async function loadLeadRows(q: Queryable, settings: Settings, where = 'TRUE', params: unknown[] = []): Promise<LeadRow[]> {
  const r = await q.query(
    `SELECT f.*, o.name AS parent_name, u.name AS owner_name,
            (SELECT count(*)::int FROM facilities b WHERE b.organization_id = f.organization_id AND b.merged_into_id IS NULL) AS branch_count,
            COALESCE(json_agg(json_build_object('id', j.id, 'title', j.title, 'specialty', j.specialty, 'care_line', j.care_line, 'license', j.license,
              'role', j.role, 'decision', j.classification, 'last_seen', j.last_seen_at, 'first_seen', j.first_seen_at, 'source_url', j.source_url,
              'city', j.city, 'state', j.state, 'advertiser', j.advertiser_name, 'vms', j.vms_name) ORDER BY j.last_seen_at DESC) FILTER (WHERE j.id IS NOT NULL), '[]') AS jobs
       FROM facilities f
       LEFT JOIN organizations o ON o.id = f.organization_id
       LEFT JOIN users u ON u.id = f.owner_id
       LEFT JOIN job_postings j ON j.facility_id = f.id
      WHERE f.merged_into_id IS NULL AND ${where}
      GROUP BY f.id, o.name, u.name`, params);
  return r.rows.map((f) => {
    const jobs = f.jobs as JobAgg[];
    const s = scoreLead({
      identityStatus: f.identity_status, verificationStatus: f.verification_status,
      jobs: jobs.map((j) => ({ decision: j.decision, license: j.license, role: j.role, title: j.title, lastSeen: j.last_seen })),
      branchCount: f.organization_id ? Number(f.branch_count) : 1,
    }, settings.weights);
    const relevant = jobs.filter((j) => j.decision !== 'exclude');
    return {
      id: f.id, name: f.name, parentName: f.parent_name, organizationId: f.organization_id, street: f.street, city: f.city, state: f.state, zip: f.zip,
      website: f.website, phone: f.phone, facilityType: f.facility_type ?? facilityTypeLabel(f.care_lines), careLines: f.care_lines,
      specialties: [...new Set(relevant.map((j) => j.specialty).filter(Boolean) as string[])],
      vmsNames: [...new Set(jobs.map((j) => j.vms).filter(Boolean) as string[])],
      jobCount: relevant.length, reviewJobCount: jobs.filter((j) => j.decision === 'review').length,
      lastJobObserved: jobs[0]?.last_seen ?? null, firstDiscovered: f.created_at,
      priority: (f.priority_override as Priority) ?? s.priority, computedPriority: s.priority, priorityOverride: f.priority_override, score: s.score, scoreReasons: s.reasons,
      leadStatus: f.lead_status, ownerId: f.owner_id, ownerName: f.owner_name, verificationStatus: f.verification_status, identityStatus: f.identity_status,
      isExistingClient: f.is_existing_client, existingClientOwner: f.existing_client_owner, nextFollowUp: f.next_follow_up, lastContactedAt: f.last_contacted_at,
      nextAction: f.next_action, jobs,
    } satisfies LeadRow;
  });
}

const cmpVal = (a: unknown, b: unknown) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
};
const PRIORITY_ORDER: Record<string, number> = { High: 0, Medium: 1, Low: 2, 'Needs Research': 3 };

export function filterLeads(rows: LeadRow[], f: LeadFilters): LeadRow[] {
  const q = f.q?.trim().toLowerCase();
  let out = rows.filter((r) => {
    if (q && ![r.name, r.parentName, r.city, r.state, r.website, ...r.specialties, ...r.jobs.map((j) => j.title)].some((v) => v?.toLowerCase().includes(q))) return false;
    if (f.state && r.state !== f.state.toUpperCase()) return false;
    if (f.city && (r.city ?? '').toLowerCase() !== f.city.toLowerCase()) return false;
    if (f.careLine && !r.careLines.includes(f.careLine)) return false;
    if (f.specialty && !r.specialties.some((s) => s.toLowerCase().includes(f.specialty!.toLowerCase()))) return false;
    if (f.license === 'RN' && !r.jobs.some((j) => j.license === 'RN')) return false;
    if (f.license === 'LPN/LVN' && !r.jobs.some((j) => j.license && j.license !== 'RN')) return false;
    if (f.status && r.leadStatus !== f.status) return false;
    if (f.priority && r.priority !== f.priority) return false;
    if (f.owner === 'unassigned' ? r.ownerId : f.owner && r.ownerId !== f.owner) return false;
    if (f.verification && r.verificationStatus !== f.verification) return false;
    if (f.discoveredFrom && new Date(r.firstDiscovered) < new Date(f.discoveredFrom)) return false;
    if (f.discoveredTo && new Date(r.firstDiscovered) > new Date(`${f.discoveredTo}T23:59:59`)) return false;
    if (f.classification === 'review' && !r.reviewJobCount) return false;
    if (f.existingClient === 'yes' && !r.isExistingClient) return false;
    if (f.existingClient === 'no' && r.isExistingClient) return false;
    return true;
  });
  const key = f.sort ?? 'lastJobObserved';
  const dir = f.dir === 'asc' ? 1 : -1;
  const get = (r: LeadRow): unknown => {
    switch (key) {
      case 'priority': return PRIORITY_ORDER[r.priority];
      case 'jobCount': return r.jobCount;
      case 'score': return r.score;
      case 'lastJobObserved': return r.lastJobObserved ? new Date(r.lastJobObserved).getTime() : null;
      case 'firstDiscovered': return new Date(r.firstDiscovered).getTime();
      default: return (r as unknown as Record<string, unknown>)[key];
    }
  };
  out = out.slice().sort((a, b) => dir * cmpVal(get(a), get(b)) || cmpVal(a.name, b.name));
  return out;
}

export async function listLeads(db: Db, settings: Settings, f: LeadFilters) {
  const all = await loadLeadRows(db, settings);
  const rows = filterLeads(all, f);
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 1000);
  const offset = Math.max(f.offset ?? 0, 0);
  return {
    total: rows.length,
    rows: rows.slice(offset, offset + limit).map(({ jobs, ...r }) => ({ ...r, sourceUrls: jobs.map((j) => j.source_url) })),
    facets: {
      states: [...new Set(all.map((r) => r.state).filter(Boolean))].sort(),
      cities: [...new Set(all.map((r) => r.city).filter(Boolean))].sort(),
    },
  };
}

export async function getFacility(db: Db, settings: Settings, id: string) {
  const rows = await loadLeadRows(db, settings, 'f.id = $1', [id]);
  if (!rows[0]) {
    const merged = await db.query<{ merged_into_id: string }>('SELECT merged_into_id FROM facilities WHERE id = $1', [id]);
    if (merged.rows[0]?.merged_into_id) throw new HttpError(410, 'This facility was merged into another record.', { mergedInto: merged.rows[0].merged_into_id });
    throw new HttpError(404, 'Facility not found.');
  }
  const lead = rows[0];
  const jobs = (await db.query(
    `SELECT j.*, (SELECT json_agg(json_build_object('id', e.id, 'method', e.method, 'extracted_at', e.extracted_at, 'identity_status', e.identity_status,
              'source_field', e.source_field, 'source_path', e.source_path, 'original_value', e.original_value, 'corrections', e.corrections, 'errors', e.errors,
              'evidence', e.result->'evidence', 'warnings', e.result->'warnings') ORDER BY e.extracted_at DESC) FROM extractions e WHERE e.job_posting_id = j.id) AS extractions
       FROM job_postings j WHERE j.facility_id = $1 ORDER BY j.last_seen_at DESC`, [id])).rows;
  const activities = (await db.query('SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.facility_id = $1 ORDER BY a.created_at DESC', [id])).rows;
  const auditRows = (await db.query(
    `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE (a.entity = 'facility' AND a.entity_id = $1) OR (a.entity = 'job_posting' AND a.entity_id = ANY($2::text[]))
      ORDER BY a.created_at DESC LIMIT 200`, [id, jobs.map((j) => j.id)])).rows;
  const raw = (await db.query('SELECT facility_type, branch_label, branch_code, bullhorn_company_id, opportunity_notes, organization_id FROM facilities WHERE id = $1', [id])).rows[0];
  const branches = lead.organizationId
    ? (await db.query('SELECT id, name, city, state FROM facilities WHERE organization_id = $1 AND id <> $2 AND merged_into_id IS NULL ORDER BY state, city', [lead.organizationId, id])).rows
    : [];
  const merges = (await db.query(
    `SELECT m.id, m.created_at, m.undone_at, f.name AS merged_name, m.merged_id, u.name AS user_name FROM merges m JOIN facilities f ON f.id = m.merged_id
       LEFT JOIN users u ON u.id = m.user_id WHERE m.survivor_id = $1 ORDER BY m.created_at DESC`, [id])).rows;
  const possibleDuplicates = await matchFacilities(db, { name: lead.name, street: lead.street, city: lead.city, state: lead.state, website: lead.website, parentName: lead.parentName }, id);
  return { ...lead, facilityTypeManual: raw.facility_type, branchLabel: raw.branch_label, branchCode: raw.branch_code, bullhornCompanyId: raw.bullhorn_company_id, opportunityNotes: raw.opportunity_notes, jobs, activities, audit: auditRows, branches, merges, possibleDuplicates };
}

// ---- editing ----------------------------------------------------------------------------------

const FACILITY_COLUMNS: Record<string, string> = {
  name: 'name', street: 'street', city: 'city', state: 'state', zip: 'zip', website: 'website', phone: 'phone',
  facilityType: 'facility_type', branchLabel: 'branch_label', branchCode: 'branch_code', verificationStatus: 'verification_status',
  leadStatus: 'lead_status', priorityOverride: 'priority_override', ownerId: 'owner_id', isExistingClient: 'is_existing_client',
  existingClientOwner: 'existing_client_owner', bullhornCompanyId: 'bullhorn_company_id', lastContactedAt: 'last_contacted_at',
  nextFollowUp: 'next_follow_up', nextAction: 'next_action', opportunityNotes: 'opportunity_notes',
};

export async function updateFacility(db: Db, user: User, id: string, patch: Record<string, unknown>) {
  return tx(db, async (c) => {
    const before = (await c.query('SELECT * FROM facilities WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw new HttpError(404, 'Facility not found.');
    if (before.merged_into_id) throw new HttpError(409, 'This facility was merged into another record. Edit that record instead.');
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, raw] of Object.entries(patch)) {
      if (k === 'parentName') continue;
      const col = FACILITY_COLUMNS[k];
      if (!col) continue;
      let val = typeof raw === 'string' ? raw.trim() || null : raw;
      if (k === 'name') {
        if (!val) throw new HttpError(422, 'Facility name cannot be empty.');
        sets.push(`normalized_name = $${vals.push(normalizeName(String(val)))}`);
      }
      if (k === 'state' && val) val = normalizeState(String(val));
      if (k === 'leadStatus' && !LEAD_STATUSES.includes(val as (typeof LEAD_STATUSES)[number])) throw new HttpError(400, 'Unknown lead status.');
      if (k === 'verificationStatus' && !VERIFICATION_STATUSES.includes(val as (typeof VERIFICATION_STATUSES)[number])) throw new HttpError(400, 'Unknown verification status.');
      if (k === 'priorityOverride' && val !== null && !PRIORITIES.includes(val as Priority)) throw new HttpError(400, 'Unknown priority.');
      const prev = before[col] instanceof Date ? before[col].toISOString() : before[col];
      if (String(prev ?? '') === String(val ?? '')) continue;
      changes[k] = { from: prev ?? null, to: val ?? null };
      sets.push(`${col} = $${vals.push(val)}`);
    }
    if ('parentName' in patch) {
      const orgId = await upsertOrganization(c, patch.parentName as string | null);
      if ((before.organization_id ?? null) !== orgId) {
        changes.parentName = { from: before.organization_id, to: patch.parentName ?? null };
        sets.push(`organization_id = $${vals.push(orgId)}`);
      }
    }
    if ('leadStatus' in changes && changes.leadStatus.to === 'Existing Client') sets.push('is_existing_client = true');
    if (!sets.length) return { changed: {} };
    await c.query(`UPDATE facilities SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
    await audit(c, user.id, 'facility', id, 'update', changes);
    if (changes.leadStatus) {
      await c.query("INSERT INTO activities(facility_id, user_id, kind, body) VALUES ($1,$2,'status_change',$3)", [id, user.id, `Status changed from "${changes.leadStatus.from}" to "${changes.leadStatus.to}".`]);
    }
    return { changed: changes };
  });
}

export async function bulkUpdate(db: Db, user: User, ids: string[], patch: { leadStatus?: string; ownerId?: string | null; priorityOverride?: string | null }) {
  const allowed: Record<string, unknown> = {};
  for (const k of ['leadStatus', 'ownerId', 'priorityOverride'] as const) if (k in patch) allowed[k] = patch[k];
  let n = 0;
  for (const id of ids.slice(0, 500)) { await updateFacility(db, user, id, allowed); n++; }
  return { updated: n };
}

export async function updateJob(db: Db, settings: Settings, user: User, id: string, patch: { title?: string; decision?: 'accept' | 'review' | 'exclude'; careLine?: CareLine | null; license?: string | null; role?: string | null; city?: string | null; state?: string | null; jobStatus?: string; facilityId?: string }) {
  return tx(db, async (c) => {
    const before = (await c.query('SELECT * FROM job_postings WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw new HttpError(404, 'Job posting not found.');
    const next = {
      title: patch.title?.trim() || before.title,
      decision: patch.decision ?? before.classification,
      careLine: patch.careLine !== undefined ? patch.careLine : before.care_line,
      license: patch.license !== undefined ? patch.license : before.license,
      role: patch.role !== undefined ? patch.role : before.role,
    };
    const base = classifyJob({ title: next.title }, settings.taxonomy);
    const clsTouched = ['decision', 'careLine', 'license', 'role'].some((k) => k in patch);
    const cls = clsTouched ? specialtyFromOverride(base, { decision: next.decision, careLine: next.careLine, license: next.license, role: next.role }) : patch.title ? base : null;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, from: unknown, to: unknown, key = col) => { if ((from ?? null) !== (to ?? null)) { changes[key] = { from: from ?? null, to: to ?? null }; sets.push(`${col} = $${vals.push(to)}`); } };
    set('title', before.title, next.title);
    if (cls) {
      set('classification', before.classification, cls.decision);
      set('care_line', before.care_line, cls.careLine);
      set('license', before.license, cls.license);
      set('role', before.role, cls.role);
      set('specialty', before.specialty, cls.specialty);
      sets.push(`classification_reasons = $${vals.push(JSON.stringify(cls.reasons))}`, `classification_manual = $${vals.push(clsTouched)}`);
    }
    if (patch.city !== undefined) set('city', before.city, patch.city?.trim() || null);
    if (patch.state !== undefined) set('state', before.state, patch.state ? normalizeState(patch.state) : null);
    if (patch.jobStatus !== undefined) set('job_status', before.job_status, patch.jobStatus);
    if (patch.facilityId && patch.facilityId !== before.facility_id) {
      const f = await c.query('SELECT id FROM facilities WHERE id = $1 AND merged_into_id IS NULL', [patch.facilityId]);
      if (!f.rows[0]) throw new HttpError(404, 'Target facility not found.');
      set('facility_id', before.facility_id, patch.facilityId);
    }
    if (!Object.keys(changes).length) return { changed: {} };
    await c.query(`UPDATE job_postings SET ${sets.join(', ')} WHERE id = $1`, vals);
    await audit(c, user.id, 'job_posting', id, 'update', changes);
    if (before.facility_id) await refreshCareLines(c, before.facility_id);
    if (patch.facilityId && patch.facilityId !== before.facility_id) await refreshCareLines(c, patch.facilityId);
    return { changed: changes };
  });
}

export async function addActivity(db: Db, user: User, facilityId: string, kind: 'note' | 'contact' | 'comment', body: string, contactDate?: string | null) {
  const text = body.trim();
  if (!text) throw new HttpError(422, 'Note text is required.');
  return tx(db, async (c) => {
    const f = await c.query('SELECT id FROM facilities WHERE id = $1', [facilityId]);
    if (!f.rows[0]) throw new HttpError(404, 'Facility not found.');
    const r = await c.query('INSERT INTO activities(facility_id, user_id, kind, body, contact_date) VALUES ($1,$2,$3,$4,$5) RETURNING id', [facilityId, user.id, kind, text.slice(0, 10_000), contactDate ?? null]);
    if (kind === 'contact') {
      await c.query('UPDATE facilities SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, $2::date), $2::date), updated_at = now() WHERE id = $1', [facilityId, contactDate ?? new Date().toISOString().slice(0, 10)]);
    }
    await audit(c, user.id, 'facility', facilityId, `add_${kind}`, { activityId: r.rows[0].id });
    return { id: r.rows[0].id };
  });
}

// ---- merges -----------------------------------------------------------------------------------

export async function mergeFacilities(db: Db, user: User, survivorId: string, mergedId: string) {
  if (survivorId === mergedId) throw new HttpError(400, 'Choose two different facilities to merge.');
  return tx(db, async (c) => {
    const rows = (await c.query('SELECT id, name, merged_into_id FROM facilities WHERE id = ANY($1::uuid[]) FOR UPDATE', [[survivorId, mergedId]])).rows;
    const survivor = rows.find((r) => r.id === survivorId);
    const merged = rows.find((r) => r.id === mergedId);
    if (!survivor || !merged) throw new HttpError(404, 'Facility not found.');
    if (survivor.merged_into_id || merged.merged_into_id) throw new HttpError(409, 'One of these facilities has already been merged.');
    const jobs = (await c.query<{ id: string }>('UPDATE job_postings SET facility_id = $1 WHERE facility_id = $2 RETURNING id', [survivorId, mergedId])).rows.map((r) => r.id);
    const acts = (await c.query<{ id: string }>('UPDATE activities SET facility_id = $1 WHERE facility_id = $2 RETURNING id', [survivorId, mergedId])).rows.map((r) => r.id);
    await c.query('UPDATE facilities SET merged_into_id = $1, updated_at = now() WHERE id = $2', [survivorId, mergedId]);
    const m = await c.query<{ id: string }>('INSERT INTO merges(survivor_id, merged_id, moved_job_ids, moved_activity_ids, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id', [survivorId, mergedId, jobs, acts, user.id]);
    await refreshCareLines(c, survivorId);
    await audit(c, user.id, 'facility', survivorId, 'merge', { mergedId, mergedName: merged.name, mergeId: m.rows[0].id, movedJobs: jobs.length });
    await audit(c, user.id, 'facility', mergedId, 'merged_into', { survivorId, mergeId: m.rows[0].id });
    return { mergeId: m.rows[0].id, movedJobs: jobs.length };
  });
}

export async function undoMerge(db: Db, user: User, mergeId: string) {
  return tx(db, async (c) => {
    const m = (await c.query('SELECT * FROM merges WHERE id = $1 FOR UPDATE', [mergeId])).rows[0];
    if (!m) throw new HttpError(404, 'Merge not found.');
    if (m.undone_at) throw new HttpError(409, 'This merge was already undone.');
    // jobs added to the survivor after the merge stay with the survivor
    await c.query('UPDATE job_postings SET facility_id = $1 WHERE id = ANY($2::uuid[]) AND facility_id = $3', [m.merged_id, m.moved_job_ids, m.survivor_id]);
    await c.query('UPDATE activities SET facility_id = $1 WHERE id = ANY($2::uuid[]) AND facility_id = $3', [m.merged_id, m.moved_activity_ids, m.survivor_id]);
    await c.query('UPDATE facilities SET merged_into_id = NULL, updated_at = now() WHERE id = $1', [m.merged_id]);
    await c.query('UPDATE merges SET undone_at = now(), undone_by = $2 WHERE id = $1', [mergeId, user.id]);
    await refreshCareLines(c, m.survivor_id);
    await refreshCareLines(c, m.merged_id);
    await audit(c, user.id, 'facility', m.survivor_id, 'undo_merge', { mergeId, restoredId: m.merged_id });
    await audit(c, user.id, 'facility', m.merged_id, 'restored', { mergeId });
    return { restoredId: m.merged_id };
  });
}

// ---- dashboard & export ---------------------------------------------------------------------

export async function dashboard(db: Db, settings: Settings) {
  const rows = await loadLeadRows(db, settings);
  const weekAgo = Date.now() - 7 * 86_400_000;
  const today = new Date().toISOString().slice(0, 10);
  const contactedStatuses = new Set(['Contacted', 'Follow-Up Needed', 'Meeting Scheduled', 'Active Opportunity']);
  const closed = new Set(['Not a Fit', 'Existing Client']);
  const has = (l: string) => rows.filter((r) => r.careLines.includes(l)).length;
  const reviewJobs = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM job_postings WHERE classification = 'review'");
  return {
    kpis: {
      totalFacilities: rows.length,
      newThisWeek: rows.filter((r) => new Date(r.firstDiscovered).getTime() >= weekAgo).length,
      verifiedFacilities: rows.filter((r) => r.verificationStatus.startsWith('verified')).length,
      confirmedFromVivian: rows.filter((r) => r.identityStatus === 'confirmed').length,
      homeHealth: has('home_health'),
      hospice: has('hospice'),
      palliative: has('palliative'),
      ipcHospice: has('ipc_hospice'),
      highPriority: rows.filter((r) => r.priority === 'High').length,
      contacted: rows.filter((r) => contactedStatuses.has(r.leadStatus) || !!r.lastContactedAt).length,
      followUpsDue: rows.filter((r) => r.nextFollowUp && r.nextFollowUp <= today && !closed.has(r.leadStatus)).length,
      jobsNeedingReview: reviewJobs.rows[0].n,
    },
    byStatus: LEAD_STATUSES.map((s) => ({ status: s, count: rows.filter((r) => r.leadStatus === s).length })),
    topHiring: rows.slice().sort((a, b) => b.jobCount - a.jobCount).slice(0, 8).map((r) => ({ id: r.id, name: r.name, state: r.state, jobCount: r.jobCount })),
    recent: rows.slice().sort((a, b) => new Date(b.firstDiscovered).getTime() - new Date(a.firstDiscovered).getTime()).slice(0, 8).map((r) => ({ id: r.id, name: r.name, city: r.city, state: r.state, priority: r.priority, firstDiscovered: r.firstDiscovered })),
  };
}

const CSV_COLUMNS = [
  'Facility', 'Parent Company', 'Facility Type', 'Street', 'City', 'State', 'ZIP', 'Website', 'Phone', 'Identity Status', 'Verification Status',
  'Lead Status', 'Priority', 'Score', 'Score Reasons', 'Assigned Owner', 'Existing Client', 'Next Follow-Up', 'Job Title', 'Specialty',
  'Classification', 'License', 'Job City', 'Job State', 'Advertiser', 'VMS', 'Job First Seen', 'Job Last Seen', 'Source URL', 'Facility ID',
];

function csvCell(v: unknown): string {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // block spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per job posting so every row carries its source URL and verification status. */
export async function exportCsv(db: Db, settings: Settings, f: LeadFilters): Promise<string> {
  const rows = filterLeads(await loadLeadRows(db, settings), f);
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const base = [r.name, r.parentName, r.facilityType, r.street, r.city, r.state, r.zip, r.website, r.phone, r.identityStatus, VERIFICATION_LABEL[r.verificationStatus] ?? r.verificationStatus,
      r.leadStatus, r.priority, r.score, r.scoreReasons.map((x) => `${x.label} (+${x.points})`).join('; '), r.ownerName, r.isExistingClient ? 'Yes' : 'No', r.nextFollowUp];
    const jobs = r.jobs.length ? r.jobs : [null];
    for (const j of jobs) {
      lines.push([...base, j?.title, j?.specialty, j?.decision, j?.license, j?.city, j?.state, j?.advertiser, j?.vms, j?.first_seen, j?.last_seen, j?.source_url, r.id].map(csvCell).join(','));
    }
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---- batch import ------------------------------------------------------------------------------

export async function createBatch(db: Db, user: User, rawUrls: string[], label?: string) {
  if (!rawUrls.length) throw new HttpError(422, 'No URLs found. Paste Vivian job links (vivian.com/job/...) or upload a CSV that contains them.');
  if (rawUrls.length > 500) throw new HttpError(422, 'A batch can contain at most 500 URLs.');
  return tx(db, async (c) => {
    const b = await c.query<{ id: string }>('INSERT INTO batches(label, created_by) VALUES ($1,$2) RETURNING id', [label ?? null, user.id]);
    const batchId = b.rows[0].id;
    const seen = new Set<string>();
    const counts = { queued: 0, duplicate: 0, invalid: 0, repeatedInBatch: 0 };
    for (const raw of rawUrls) {
      const v = parseVivianJobUrl(raw);
      if (!v.ok) {
        const key = raw.trim().slice(0, 500);
        if (seen.has(key)) continue;
        seen.add(key);
        await c.query("INSERT INTO batch_items(batch_id, url, status, message) VALUES ($1,$2,'invalid',$3) ON CONFLICT DO NOTHING", [batchId, key, v.error]);
        counts.invalid++;
        continue;
      }
      if (seen.has(v.url)) { counts.repeatedInBatch++; continue; }
      seen.add(v.url);
      const existing = await findJobByUrl(c, v.url);
      if (existing) {
        await c.query("INSERT INTO batch_items(batch_id, url, status, message, job_posting_id) VALUES ($1,$2,'duplicate',$3,$4)", [batchId, v.url, `Already saved${existing.facility_name ? ` under ${existing.facility_name}` : ''}.`, existing.id]);
        counts.duplicate++;
      } else {
        await c.query("INSERT INTO batch_items(batch_id, url, status) VALUES ($1,$2,'queued')", [batchId, v.url]);
        counts.queued++;
      }
    }
    await audit(c, user.id, 'batch', batchId, 'create', counts);
    return { batchId, ...counts };
  });
}

export async function getBatch(db: Db, id: string) {
  const b = (await db.query('SELECT b.*, u.name AS created_by_name FROM batches b LEFT JOIN users u ON u.id = b.created_by WHERE b.id = $1', [id])).rows[0];
  if (!b) throw new HttpError(404, 'Batch not found.');
  const items = (await db.query(
    `SELECT i.id, i.url, i.status, i.message, i.attempts, i.updated_at, i.job_posting_id, i.result, j.facility_id
       FROM batch_items i LEFT JOIN job_postings j ON j.id = i.job_posting_id WHERE i.batch_id = $1 ORDER BY i.url`, [id])).rows;
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  return { ...b, items, counts };
}

export async function listBatches(db: Db) {
  return (await db.query(
    `SELECT b.id, b.label, b.created_at, u.name AS created_by_name, count(i.*)::int AS total,
            count(*) FILTER (WHERE i.status IN ('queued','processing'))::int AS pending,
            count(*) FILTER (WHERE i.status IN ('saved','duplicate'))::int AS done,
            count(*) FILTER (WHERE i.status IN ('needs_browser','failed'))::int AS attention
       FROM batches b LEFT JOIN batch_items i ON i.batch_id = b.id LEFT JOIN users u ON u.id = b.created_by
      GROUP BY b.id, u.name ORDER BY b.created_at DESC LIMIT 50`)).rows;
}

export async function retryBatch(db: Db, user: User, id: string) {
  const r = await db.query("UPDATE batch_items SET status = 'queued', message = NULL, updated_at = now() WHERE batch_id = $1 AND status IN ('failed','needs_browser') RETURNING id", [id]);
  await audit(db, user.id, 'batch', id, 'retry', { items: r.rowCount });
  return { requeued: r.rowCount ?? 0 };
}
