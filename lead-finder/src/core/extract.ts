// Facility extraction engine. Runs unchanged in Node (server, tests) and in the
// browser extension, so it uses no DOM APIs: HTML is scanned as text.
//
// Strategy, in order of trust:
//  1. Parse every JSON document we can find (JSON-LD, <script type="application/json">,
//     __NEXT_DATA__, `window.X = {...}` assignments, and JSON embedded in escaped JS strings)
//     and walk the objects, so a facility name is kept together with the address fields
//     that sit in the same object.
//  2. Fall back to scanning the raw and unescaped text for `"key": "value"` pairs, which
//     still works when the page structure changes or the JSON is truncated.
// Nothing is ever filled in that was not found on the page.

import { classifyJob, type Classification } from './classify.ts';
import { looksLikeStaffingAgency, normalizeName, normalizeState, orgNameGenericity } from './normalize.ts';
import { DEFAULT_TAXONOMY, type Taxonomy } from './taxonomy.ts';

export type IdentityStatus = 'confirmed' | 'possible' | 'agency_only' | 'generic' | 'not_found' | 'error';

export const IDENTITY_LABEL: Record<IdentityStatus, string> = {
  confirmed: 'Confirmed facility name',
  possible: 'Possible facility name',
  agency_only: 'Staffing agency only',
  generic: 'Generic description only',
  not_found: 'Facility not identified',
  error: 'Extraction error',
};

export type FieldTier = 'facility' | 'organization' | 'agency';

export interface Evidence {
  /** Field name as it appeared on the page, e.g. "hospitalName". */
  field: string;
  /** Location of the field: JSON path, or "text" for the raw-text fallback. */
  path: string;
  value: string;
  method: 'json-ld' | 'json' | 'text' | 'html';
  tier?: FieldTier;
  /** How the value was judged. */
  assessment?: 'specific' | 'weak' | 'generic' | 'staffing_agency';
}

export interface AddressParts {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface ExtractionResult {
  status: IdentityStatus;
  facility: {
    name: string | null;
    sourceField: string | null;
    sourcePath: string | null;
    address: AddressParts;
    addressSourceFields: string[];
    systemId: string | null;
    systemName: string | null;
  };
  advertiser: { name: string; sourceField: string; looksLikeStaffingAgency: boolean } | null;
  /** Vendor management system (VMS) data: every page field whose name contains "vms", plus text mentions. */
  vms: { name: string | null; fields: { field: string; value: string; path: string }[]; mentions: string[] };
  job: {
    title: string | null;
    titleSource: string | null;
    city: string | null;
    state: string | null;
    employmentType: string | null;
    externalId: string | null;
    specialtyHint: string | null;
    datePosted: string | null;
  };
  classification: Classification;
  evidence: Evidence[];
  warnings: string[];
  errors: string[];
}

// ---- field registry (lower-case keys) ---------------------------------------------------

const FACILITY_NAME_KEYS = ['hospitalname', 'hospital_name', 'facilityname', 'facility_name', 'clientfacilityname', 'clientfacility', 'clientname'];
const ORG_NAME_KEYS = ['organizationname', 'organization_name', 'organisationname', 'employername', 'employer_name', 'companyname', 'company_name', 'hiringorganizationname'];
const AGENCY_NAME_KEYS = ['agencyname', 'agency_name', 'staffingagencyname', 'staffingagency', 'recruitercompanyname', 'recruitingagency', 'vendorname'];
const NESTED_FACILITY_OBJECTS = ['hospital', 'facility', 'clientfacility', 'worksite'];
const NESTED_ORG_OBJECTS = ['organization', 'organisation', 'employer', 'company', 'hiringorganization'];
const NESTED_AGENCY_OBJECTS = ['agency', 'staffingagency', 'recruiter'];

const STREET_KEYS = ['hospitaladdress', 'hospitaladdress1', 'hospitalstreet', 'hospitalstreetaddress', 'facilityaddress', 'facilityaddress1', 'facilitystreet', 'streetaddress', 'address1', 'address_1', 'addressline1', 'street', 'address'];
const CITY_KEYS = ['hospitalcity', 'facilitycity', 'city', 'addresslocality'];
const STATE_KEYS = ['hospitalstate', 'facilitystate', 'state', 'statecode', 'addressregion'];
const ZIP_KEYS = ['hospitalzip', 'hospitalzipcode', 'hospitalpostalcode', 'facilityzip', 'facilityzipcode', 'zip', 'zipcode', 'postalcode'];
const SYSTEM_ID_KEYS = ['hospitalsystemid', 'healthsystemid', 'systemid'];
const SYSTEM_NAME_KEYS = ['hospitalsystemname', 'healthsystemname', 'hospitalsystem', 'parentorganization', 'parentorganizationname'];

const TITLE_KEYS = ['jobtitle', 'job_title', 'title', 'positiontitle'];
const JOB_CITY_KEYS = ['jobcity', 'job_city', 'city', 'locationcity'];
const JOB_STATE_KEYS = ['jobstate', 'job_state', 'state', 'statecode', 'locationstate'];
const EMPLOYMENT_KEYS = ['employmenttype', 'employment_type', 'jobtype', 'job_type', 'positiontype'];
const SPECIALTY_KEYS = ['specialty', 'specialtyname', 'discipline', 'disciplinename', 'profession'];

const TEXT_KEYS = [
  ...FACILITY_NAME_KEYS, ...ORG_NAME_KEYS, ...AGENCY_NAME_KEYS,
  'hospitaladdress', 'hospitaladdress1', 'hospitalstreet', 'facilityaddress', 'hospitalcity', 'facilitycity',
  'hospitalstate', 'facilitystate', 'hospitalzip', 'hospitalzipcode', 'facilityzip', ...SYSTEM_ID_KEYS, ...SYSTEM_NAME_KEYS,
  'jobtitle', 'employmenttype', 'specialty', 'discipline',
];

// ---- helpers ------------------------------------------------------------------------------

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (ENTITY[e] !== undefined) return ENTITY[e];
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

function clean(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = decodeEntities(String(v)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /^(null|undefined|none|n\/a|-)$/i.test(s)) return null;
  return s.length > 300 ? s.slice(0, 300) : s;
}

/** One level of JS string unescaping (\" -> ", \\ -> \, \/ -> /, \uXXXX). */
function unescapeOnce(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["\\/])/g, '$1');
}

/** Extract a balanced {...} or [...] starting at index i (string-aware). */
function balancedAt(s: string, i: number): string | null {
  const open = s[i];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) return null;
  let depth = 0, inStr = false, esc = false;
  const limit = Math.min(s.length, i + 5_000_000);
  for (let j = i; j < limit; j++) {
    const ch = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return s.slice(i, j + 1);
    }
  }
  return null;
}

function tryJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

interface Script { attrs: string; body: string }

function scripts(html: string): Script[] {
  const out: Script[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ attrs: m[1] ?? '', body: m[2] ?? '' });
  return out;
}

interface Doc { value: unknown; method: 'json-ld' | 'json'; origin: string }

/** Find every JSON document embedded in the page. */
function collectJsonDocs(html: string, warnings: string[]): Doc[] {
  const docs: Doc[] = [];
  const all = scripts(html);
  all.forEach((sc, idx) => {
    const type = (sc.attrs.match(/type\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? '').toLowerCase();
    const id = sc.attrs.match(/id\s*=\s*["']?([^"'\s>]+)/i)?.[1] ?? '';
    const body = sc.body.trim();
    if (!body) return;
    const origin = id ? `script#${id}` : `script[${idx}]`;
    if (type === 'application/ld+json') {
      const v = tryJson(body) ?? tryJson(decodeEntities(body));
      if (v !== undefined) docs.push({ value: v, method: 'json-ld', origin });
      else warnings.push(`A JSON-LD block (${origin}) could not be parsed.`);
      return;
    }
    if (type === 'application/json' || id === '__NEXT_DATA__' || id === '__NUXT_DATA__') {
      const v = tryJson(body);
      if (v !== undefined) { docs.push({ value: v, method: 'json', origin }); return; }
    }
    // `window.__STATE__ = {...}` style assignments
    const assign = /=\s*(?:JSON\.parse\(\s*)?([{\[])/g;
    let m: RegExpExecArray | null;
    while ((m = assign.exec(body))) {
      const start = m.index + m[0].length - 1;
      const blob = balancedAt(body, start);
      if (blob && blob.length > 20) {
        const v = tryJson(blob);
        if (v !== undefined) docs.push({ value: v, method: 'json', origin: `${origin} assignment` });
        assign.lastIndex = start + blob.length;
      }
    }
    // JSON inside JS string literals, e.g. JSON.parse("{\"hospitalName\":...}") or Next.js flight data.
    const strRe = /"((?:[^"\\]|\\.){40,})"/g;
    while ((m = strRe.exec(body))) {
      const lit = m[1];
      if (!/hospital|facility|organization|employer|agency|jobTitle/i.test(lit)) continue;
      const decoded = tryJson(`"${lit}"`);
      if (typeof decoded !== 'string') continue;
      for (let k = 0; k < decoded.length; k++) {
        const ch = decoded[k];
        if (ch !== '{' && ch !== '[') continue;
        const blob = balancedAt(decoded, k);
        if (!blob) continue;
        if (blob.length > 20 && /"(hospital|facility|organization|employer|agency|job)/i.test(blob)) {
          const v = tryJson(blob);
          if (v !== undefined) { docs.push({ value: v, method: 'json', origin: `${origin} escaped string` }); k += blob.length - 1; }
        }
      }
    }
  });
  // JSON in HTML attributes, e.g. data-props="{&quot;hospitalName&quot;:...}"
  const attrRe = /\sdata-[a-z0-9-]+\s*=\s*"(\{[^"]{20,}\})"/gi;
  let a: RegExpExecArray | null;
  while ((a = attrRe.exec(html))) {
    const v = tryJson(decodeEntities(a[1]));
    if (v !== undefined) docs.push({ value: v, method: 'json', origin: 'data attribute' });
  }
  return docs;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function lowerMap(o: Obj): Map<string, [string, unknown]> {
  const m = new Map<string, [string, unknown]>();
  for (const [k, v] of Object.entries(o)) m.set(k.toLowerCase(), [k, v]);
  return m;
}

function pick(m: Map<string, [string, unknown]>, keys: string[]): { key: string; value: string } | null {
  for (const k of keys) {
    const e = m.get(k);
    if (!e) continue;
    const v = isObj(e[1]) ? (e[1] as Obj).name : e[1];
    const c = clean(v);
    if (c) return { key: e[0], value: c };
  }
  return null;
}

interface Candidate {
  tier: FieldTier;
  name: string;
  field: string;
  path: string;
  method: Evidence['method'];
  address: AddressParts;
  addressFields: string[];
  systemId: string | null;
  systemName: string | null;
}

function addressFrom(m: Map<string, [string, unknown]>): { address: AddressParts; fields: string[] } {
  const fields: string[] = [];
  const get = (keys: string[]) => {
    for (const k of keys) {
      const e = m.get(k);
      if (!e) continue;
      if (isObj(e[1])) continue;
      const c = clean(e[1]);
      if (c) { fields.push(e[0]); return c; }
    }
    return null;
  };
  let street = get(STREET_KEYS);
  let city = get(CITY_KEYS);
  let state = get(STATE_KEYS);
  let zip = get(ZIP_KEYS);
  // nested address object (schema.org PostalAddress or similar)
  const addrObj = m.get('address')?.[1] ?? m.get('location')?.[1];
  if (isObj(addrObj)) {
    const am = lowerMap(addrObj);
    const nested = addressFrom(am);
    street ??= nested.address.street; city ??= nested.address.city; state ??= nested.address.state; zip ??= nested.address.zip;
    fields.push(...nested.fields.map((f) => `address.${f}`));
  }
  if (street && /^\d{5}(-\d{4})?$/.test(street)) street = null; // a ZIP in the street slot is not a street
  return { address: { street, city, state, zip }, fields };
}

/** Lists of *other* jobs shown on a job page (e.g. Vivian's "similarJobs"). Their facility and VMS
 *  belong to other postings, often other agencies, and must never be attributed to this job. */
const OTHER_JOBS_KEY = /similar|related|recommend|suggest|other.?jobs|more.?jobs|nearby|session|profile|current.?user|viewer/i; // also the signed-in viewer's own data

function collectStrings(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 40) return;
  if (typeof v === 'string') { const c = clean(v); if (c) out.add(c); }
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out, depth + 1));
  else if (isObj(v)) Object.values(v).forEach((x) => collectStrings(x, out, depth + 1));
}

function walk(value: unknown, path: string, method: Evidence['method'], visit: (o: Obj, path: string, method: Evidence['method']) => void, depth = 0, seen = new Set<unknown>(), otherJobs?: Set<string>): void {
  if (depth > 40 || seen.has(value)) return;
  if (Array.isArray(value)) {
    seen.add(value);
    value.slice(0, 2000).forEach((v, i) => walk(v, `${path}[${i}]`, method, visit, depth + 1, seen, otherJobs));
    return;
  }
  if (!isObj(value)) return;
  seen.add(value);
  visit(value, path, method);
  for (const [k, v] of Object.entries(value)) {
    if (!v || typeof v !== 'object') continue;
    if (OTHER_JOBS_KEY.test(k)) { if (otherJobs) collectStrings(v, otherJobs); continue; }
    walk(v, path ? `${path}.${k}` : k, method, visit, depth + 1, seen, otherJobs);
  }
}

function typeOf(o: Obj): string {
  const t = o['@type'];
  return Array.isArray(t) ? t.join(',') : typeof t === 'string' ? t : '';
}

// ---- main ---------------------------------------------------------------------------------

export interface ExtractOptions {
  taxonomy?: Taxonomy;
  /** Original job URL; used only for the external ID. */
  url?: string;
}

export function extractFromHtml(html: string, opts: ExtractOptions = {}): ExtractionResult {
  const taxonomy = opts.taxonomy ?? DEFAULT_TAXONOMY;
  const warnings: string[] = [];
  const errors: string[] = [];
  const evidence: Evidence[] = [];
  const candidates: Candidate[] = [];
  const job: ExtractionResult['job'] = { title: null, titleSource: null, city: null, state: null, employmentType: null, externalId: null, specialtyHint: null, datePosted: null };
  const ev = (e: Evidence) => {
    if (!evidence.some((x) => x.field === e.field && x.value === e.value && x.path === e.path)) evidence.push(e);
  };

  const empty = (): ExtractionResult => ({
    status: 'error',
    facility: { name: null, sourceField: null, sourcePath: null, address: { street: null, city: null, state: null, zip: null }, addressSourceFields: [], systemId: null, systemName: null },
    advertiser: null, vms: { name: null, fields: [], mentions: [] }, job, classification: classifyJob({ title: '' }, taxonomy), evidence, warnings, errors,
  });

  if (typeof html !== 'string' || !html.trim()) {
    errors.push('No page content was provided.');
    return empty();
  }
  if (html.length > 15_000_000) {
    errors.push('Page content is larger than 15 MB and was not processed.');
    return empty();
  }
  if (/challenges\.cloudflare\.com|cf-chl-|Just a moment\.\.\.|Attention Required! \| Cloudflare/i.test(html) && !/hospitalName|JobPosting/i.test(html)) {
    errors.push('This is a Cloudflare security check page, not the job posting. Open the job in your browser, let it load, then use the extension or copy the page source again.');
    return empty();
  }

  const vmsFields: ExtractionResult['vms']['fields'] = [];
  const otherJobValues = new Set<string>();
  function addVms(field: string, v: unknown, path: string) {
    const value = isObj(v) ? clean(v.name)
      : Array.isArray(v) ? v.map((x) => (isObj(x) ? clean(x.name) : clean(x as string))).filter(Boolean).join(', ')
      : typeof v === 'boolean' ? String(v) : clean(v);
    if (value && !(path === 'text' && otherJobValues.has(value) && !vmsFields.some((x) => x.value === value)) && !vmsFields.some((x) => x.field === field && x.value === value)) vmsFields.push({ field, value, path });
  }

  if (opts.url) job.externalId = opts.url.match(/\/job\/([A-Za-z0-9-]+)/)?.[1] ?? null;

  // 1) structured documents
  const docs = collectJsonDocs(html, warnings);
  for (const doc of docs) {
    walk(doc.value, doc.origin, doc.method, (o, path, method) => {
      const m = lowerMap(o);
      for (const [k, v] of Object.entries(o)) if (/vms/i.test(k)) addVms(k, v, path);
      const type = typeOf(o);

      if (/JobPosting/i.test(type)) {
        const t = clean(o.title) ?? clean(o.name);
        if (t && !job.title) { job.title = t; job.titleSource = `${path}.title (JSON-LD JobPosting)`; ev({ field: 'title', path, value: t, method }); }
        const emp = Array.isArray(o.employmentType) ? o.employmentType.join(', ') : clean(o.employmentType);
        if (emp && !job.employmentType) job.employmentType = String(emp);
        job.datePosted ??= clean(o.datePosted);
        const idv = isObj(o.identifier) ? clean((o.identifier as Obj).value) : clean(o.identifier);
        job.externalId ??= idv;
        const locs = Array.isArray(o.jobLocation) ? o.jobLocation : o.jobLocation ? [o.jobLocation] : [];
        for (const loc of locs) {
          const addr = isObj(loc) && isObj((loc as Obj).address) ? lowerMap((loc as Obj).address as Obj) : null;
          if (addr) {
            const a = addressFrom(addr);
            job.city ??= a.address.city;
            job.state ??= a.address.state;
            if (a.address.city || a.address.state) ev({ field: 'jobLocation.address', path, value: [a.address.street, a.address.city, a.address.state, a.address.zip].filter(Boolean).join(', '), method });
          }
        }
        const ho = o.hiringOrganization;
        const hoName = isObj(ho) ? clean(ho.name) : clean(ho);
        if (hoName) {
          const hoAddr = isObj(ho) && isObj((ho as Obj).address) ? addressFrom(lowerMap((ho as Obj).address as Obj)) : { address: { street: null, city: null, state: null, zip: null }, fields: [] };
          candidates.push({ tier: 'organization', name: hoName, field: 'hiringOrganization.name', path, method, address: hoAddr.address, addressFields: hoAddr.fields, systemId: null, systemName: null });
        }
        return;
      }

      // flat facility fields, e.g. { hospitalName, hospitalAddress, hospitalCity, ... }
      const fac = pick(m, FACILITY_NAME_KEYS);
      if (fac && !isObj(m.get(fac.key.toLowerCase())?.[1])) {
        const a = addressFrom(m);
        candidates.push({
          tier: 'facility', name: fac.value, field: fac.key, path, method, address: a.address, addressFields: a.fields,
          systemId: pick(m, SYSTEM_ID_KEYS)?.value ?? null, systemName: pick(m, SYSTEM_NAME_KEYS)?.value ?? null,
        });
      }
      const org = pick(m, ORG_NAME_KEYS);
      if (org) {
        const a = addressFrom(m);
        candidates.push({ tier: 'organization', name: org.value, field: org.key, path, method, address: a.address, addressFields: a.fields, systemId: null, systemName: null });
      }
      const ag = pick(m, AGENCY_NAME_KEYS);
      if (ag) candidates.push({ tier: 'agency', name: ag.value, field: ag.key, path, method, address: { street: null, city: null, state: null, zip: null }, addressFields: [], systemId: null, systemName: null });

      // nested objects, e.g. { hospital: { name, address, city } }
      const nested = (keys: string[], tier: FieldTier) => {
        for (const k of keys) {
          const e = m.get(k);
          if (!e || !isObj(e[1])) continue;
          const nm = lowerMap(e[1] as Obj);
          const n = clean((e[1] as Obj).name) ?? pick(nm, ['displayname', 'legalname', ...FACILITY_NAME_KEYS])?.value ?? null;
          if (!n) continue;
          const a = addressFrom(nm);
          candidates.push({
            tier, name: n, field: `${e[0]}.name`, path, method, address: a.address, addressFields: a.fields.map((f) => `${e[0]}.${f}`),
            systemId: pick(nm, SYSTEM_ID_KEYS)?.value ?? null, systemName: pick(nm, SYSTEM_NAME_KEYS)?.value ?? null,
          });
        }
      };
      if (!/JobPosting/i.test(type)) {
        nested(NESTED_FACILITY_OBJECTS, 'facility');
        nested(NESTED_ORG_OBJECTS, 'organization');
        nested(NESTED_AGENCY_OBJECTS, 'agency');
      }

      // job-level fields on application state objects
      const looksLikeJob = m.has('jobtitle') || m.has('job_title') || (m.has('title') && (fac || m.has('specialty') || m.has('discipline') || m.has('employmenttype')));
      if (looksLikeJob) {
        const t = pick(m, TITLE_KEYS);
        if (t && !job.title) { job.title = t.value; job.titleSource = `${path}.${t.key}`; ev({ field: t.key, path, value: t.value, method }); }
        const emp = pick(m, EMPLOYMENT_KEYS);
        if (emp && !job.employmentType) job.employmentType = emp.value;
        if (!fac) {
          job.city ??= pick(m, JOB_CITY_KEYS)?.value ?? null;
          job.state ??= pick(m, JOB_STATE_KEYS)?.value ?? null;
        }
      }
      const sp = pick(m, SPECIALTY_KEYS);
      if (sp) {
        job.specialtyHint = job.specialtyHint && !job.specialtyHint.includes(sp.value) ? `${job.specialtyHint}; ${sp.value}` : (job.specialtyHint ?? sp.value);
        ev({ field: sp.key, path, value: sp.value, method });
      }
    }, 0, new Set(), otherJobValues);
  }

  // 2) raw-text fallback across escape levels
  const variants: string[] = [html, decodeEntities(html)];
  let u = html;
  for (let i = 0; i < 3 && /\\"/.test(u); i++) { u = unescapeOnce(u); variants.push(u); }
  const keyAlt = TEXT_KEYS.join('|');
  const textRe = new RegExp(`["']?(${keyAlt})["']?\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,300})"`, 'gi');
  const textHits: { key: string; value: string; index: number; variant: number }[] = [];
  variants.forEach((text, vi) => {
    let m: RegExpExecArray | null;
    textRe.lastIndex = 0;
    while ((m = textRe.exec(text))) {
      const decoded = tryJson(`"${m[2]}"`);
      const val = clean(typeof decoded === 'string' ? decoded : m[2]);
      if (val) textHits.push({ key: m[1], value: val, index: m.index, variant: vi });
    }
  });
  const fromText = (keys: string[]) => textHits.filter((h) => keys.includes(h.key.toLowerCase()));
  // only add text-derived candidates when structured parsing did not already find that value
  const known = new Set(candidates.map((c) => `${c.tier}|${c.name}`));
  const near = (h: { index: number; variant: number }, keys: string[]) => {
    const hits = textHits.filter((x) => x.variant === h.variant && keys.includes(x.key.toLowerCase()) && Math.abs(x.index - h.index) < 1500);
    hits.sort((a, b) => Math.abs(a.index - h.index) - Math.abs(b.index - h.index));
    return hits[0] ?? null;
  };
  for (const [tier, keys] of [['facility', FACILITY_NAME_KEYS], ['organization', ORG_NAME_KEYS], ['agency', AGENCY_NAME_KEYS]] as const) {
    for (const h of fromText(keys)) {
      if (known.has(`${tier}|${h.value}`) || otherJobValues.has(h.value)) continue;
      known.add(`${tier}|${h.value}`);
      const addrFields: string[] = [];
      const take = (ks: string[]) => { const n = tier === 'facility' ? near(h, ks) : null; if (n) addrFields.push(n.key); return n?.value ?? null; };
      candidates.push({
        tier, name: h.value, field: h.key, path: 'text', method: 'text',
        address: {
          street: take(['hospitaladdress', 'hospitaladdress1', 'hospitalstreet', 'facilityaddress']),
          city: take(['hospitalcity', 'facilitycity']),
          state: take(['hospitalstate', 'facilitystate']),
          zip: take(['hospitalzip', 'hospitalzipcode', 'facilityzip']),
        },
        addressFields: addrFields,
        systemId: tier === 'facility' ? near(h, SYSTEM_ID_KEYS)?.value ?? null : null,
        systemName: tier === 'facility' ? near(h, SYSTEM_NAME_KEYS)?.value ?? null : null,
      });
    }
  }
  if (!job.title) {
    const t = fromText(['jobtitle'])[0];
    if (t) { job.title = t.value; job.titleSource = `text: ${t.key}`; }
  }
  if (!job.specialtyHint) {
    const s = fromText(['specialty', 'discipline']).map((h) => h.value);
    if (s.length) job.specialtyHint = [...new Set(s)].join('; ');
  }

  // 3) HTML fallbacks for the job title
  if (!job.title) {
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    const tt = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const pickT = clean(og?.[1]) ?? clean(h1?.[1]) ?? clean(tt?.[1]);
    if (pickT) {
      job.title = pickT.replace(/\s*[|–-]\s*Vivian.*$/i, '').trim();
      job.titleSource = og ? 'og:title meta tag' : h1 ? '<h1> heading' : '<title> tag';
      ev({ field: job.titleSource, path: 'html', value: job.title, method: 'html' });
      warnings.push('Job title came from the page heading, not structured data. Check it.');
    }
  }

  const vmsRe = /["']?([A-Za-z_]*vms[A-Za-z0-9_]*)["']?\s*:\s*("((?:[^"\\]|\\.){0,300})"|true|false|-?\d+(?:\.\d+)?)/gi;
  for (const text of variants) {
    let m: RegExpExecArray | null;
    while ((m = vmsRe.exec(text))) {
      const decoded = m[3] !== undefined ? tryJson(`"${m[3]}"`) : m[2];
      addVms(m[1], typeof decoded === 'string' ? decoded : m[3] ?? m[2], 'text');
    }
  }
  // standalone "VMS" in visible text or descriptions, shown so a person can read the context
  const vmsMentions: string[] = [];
  const plain = decodeEntities(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  for (const src of [plain, variants[variants.length - 1]]) {
    const re = /\bVMS\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) && vmsMentions.length < 5) {
      if (/^["']?\s*:/.test(src.slice(m.index + 3, m.index + 8))) continue; // a JSON key, already captured above
      const snip = src.slice(Math.max(0, m.index - 80), m.index + 80).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!vmsMentions.some((x) => x.includes(snip) || snip.includes(x))) vmsMentions.push(snip);
    }
  }
  const vmsNamed = vmsFields.filter((x) => !/^(true|false|-?\d+(\.\d+)?)$/i.test(x.value));
  const vmsName = (vmsNamed.find((x) => /^vms$|name|provider|system|platform|vendor/i.test(x.field)) ?? vmsNamed[0])?.value ?? null;

  // ---- assess candidates ----
  const assess = (c: Candidate): Evidence['assessment'] => {
    if (c.tier === 'agency') return 'staffing_agency';
    if (looksLikeStaffingAgency(c.name, taxonomy)) return 'staffing_agency';
    return orgNameGenericity(c.name, taxonomy);
  };
  const assessed = candidates.map((c) => ({ c, a: assess(c) }));
  for (const { c, a } of assessed) ev({ field: c.field, path: c.path, value: c.name, method: c.method, tier: c.tier, assessment: a });

  const agencies = assessed.filter((x) => x.a === 'staffing_agency');
  const agencyNames = new Set(agencies.map((x) => normalizeName(x.c.name)));
  const usable = (tier: FieldTier, levels: Evidence['assessment'][]) =>
    assessed.filter((x) => x.c.tier === tier && levels.includes(x.a) && !agencyNames.has(normalizeName(x.c.name)));

  let status: IdentityStatus;
  let chosen: Candidate | null = null;
  const facSpecific = usable('facility', ['specific']);
  const facWeak = usable('facility', ['weak']);
  const orgSpecific = usable('organization', ['specific']);
  const orgWeak = usable('organization', ['weak']);

  if (facSpecific.length) {
    chosen = facSpecific.slice().sort((x, y) => scoreCandidate(y.c) - scoreCandidate(x.c))[0].c;
    const distinct = new Set(facSpecific.map((x) => normalizeName(x.c.name)));
    if (distinct.size > 1) {
      status = 'possible';
      warnings.push(`The page lists more than one facility name (${[...new Set(facSpecific.map((x) => x.c.name))].join(' / ')}). Confirm which one applies to this job.`);
    } else {
      status = 'confirmed';
    }
  } else if (facWeak.length) {
    chosen = facWeak[0].c;
    status = 'possible';
    warnings.push(`"${chosen.name}" is mostly generic words and a place name. Verify that this is the organization's real name.`);
  } else if (orgSpecific.length || orgWeak.length) {
    chosen = (orgSpecific[0] ?? orgWeak[0]).c;
    status = 'possible';
    warnings.push(`No facility field was found. "${chosen.name}" comes from the ${chosen.field} field, which may be the employer or the advertiser rather than the facility.`);
  } else if (agencies.length) {
    status = 'agency_only';
    warnings.push('Only a staffing agency name was found. The end-client facility is not shown on this page.');
  } else if (assessed.some((x) => x.a === 'generic')) {
    status = 'generic';
    warnings.push(`Only generic descriptions were found (${[...new Set(assessed.filter((x) => x.a === 'generic').map((x) => `"${x.c.name}"`))].join(', ')}). These are not treated as an organization name.`);
  } else {
    status = 'not_found';
    if (!docs.length) warnings.push('No structured data was found on the page. If you pasted visible text instead of the page source, paste the source (Ctrl+U) instead.');
  }

  // advertiser = explicit agency field, or a different organization name that looks like an agency,
  // or any organization name that differs from the chosen facility.
  let advertiser: ExtractionResult['advertiser'] = null;
  const chosenNorm = chosen ? normalizeName(chosen.name) : '';
  const adv = agencies.find((x) => normalizeName(x.c.name) !== chosenNorm)
    ?? assessed.find((x) => x.c.tier === 'organization' && x.c !== chosen && normalizeName(x.c.name) !== chosenNorm && x.a !== 'generic');
  if (adv) advertiser = { name: adv.c.name, sourceField: adv.c.field, looksLikeStaffingAgency: adv.a === 'staffing_agency' };

  // facility address: from the chosen candidate; fill gaps only from other candidates with the same name
  const address: AddressParts = { ...(chosen?.address ?? { street: null, city: null, state: null, zip: null }) };
  const addressSourceFields = [...(chosen?.addressFields ?? [])];
  if (chosen) {
    for (const { c } of assessed) {
      if (c === chosen || normalizeName(c.name) !== chosenNorm) continue;
      for (const k of ['street', 'city', 'state', 'zip'] as const) {
        if (!address[k] && c.address[k]) { address[k] = c.address[k]; addressSourceFields.push(`${c.field}→${k}`); }
      }
    }
  }
  if (address.state) address.state = normalizeState(address.state);
  if (job.state) job.state = normalizeState(job.state);
  if (!job.city && !job.state && chosen && status !== 'not_found') {
    // the facility location is a reasonable job location when the posting has no separate one
    job.city = address.city;
    job.state = address.state;
  }

  const classification = classifyJob({
    title: job.title ?? '',
    context: [job.specialtyHint, chosen?.name, advertiser?.name].filter(Boolean).join(' '),
  }, taxonomy);
  if (job.specialtyHint && classification.decision !== 'accept') classification.reasons.push(`Page specialty field: "${job.specialtyHint}".`);

  return {
    status,
    facility: {
      name: chosen?.name ?? null,
      sourceField: chosen?.field ?? null,
      sourcePath: chosen ? `${chosen.path}${chosen.method === 'text' ? '' : ` (${chosen.method})`}` : null,
      address,
      addressSourceFields,
      systemId: chosen?.systemId ?? null,
      systemName: chosen?.systemName ?? null,
    },
    advertiser,
    job,
    classification,
    evidence,
    vms: { name: vmsName, fields: vmsFields, mentions: vmsMentions },
    warnings,
    errors,
  };
}

function scoreCandidate(c: Candidate): number {
  let s = 0;
  if (c.method !== 'text') s += 4; // structured beats regex
  if (/hospital/i.test(c.field)) s += 2;
  s += Object.values(c.address).filter(Boolean).length;
  return s;
}
