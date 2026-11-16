import { CARE_LINE_LABEL, DEFAULT_TAXONOMY, type CareLine, type Taxonomy } from './taxonomy.ts';

export type License = 'RN' | 'LPN' | 'LVN' | 'LPN/LVN';
export type Decision = 'accept' | 'review' | 'exclude';

export interface Classification {
  /** accept = in scope, review = a person must decide, exclude = out of scope */
  decision: Decision;
  /** Primary care line, or null when it cannot be determined. */
  careLine: CareLine | null;
  /** Every care line detected in the title (hybrid titles list more than one). */
  careLines: CareLine[];
  license: License | null;
  role: string | null;
  /** Readable specialty, e.g. "Hospice RN Case Manager". */
  specialty: string | null;
  /** Evidence for the decision, in plain language. */
  reasons: string[];
}

export interface ClassifyInput {
  title: string;
  /** Optional extra text (description, facility name) used only to suggest a care line for review. */
  context?: string;
}

interface Compiled {
  careLines: [CareLine, RegExp[]][];
  ambiguousIpc: RegExp[];
  licenses: Record<keyof Taxonomy['licenses'], RegExp[]>;
  roles: [string, RegExp[]][];
  excluded: RegExp[];
  nonNursing: RegExp[];
}

const cache = new WeakMap<Taxonomy, Compiled>();
const rx = (list: string[]) => list.map((p) => new RegExp(p, 'i'));

function compile(t: Taxonomy): Compiled {
  let c = cache.get(t);
  if (!c) {
    // IPC is checked before plain hospice so "Inpatient Hospice RN" is IPC, not generic hospice.
    const order: CareLine[] = ['ipc_hospice', 'hospice', 'palliative', 'home_health'];
    c = {
      careLines: order.map((k) => [k, rx(t.careLines[k] ?? [])]),
      ambiguousIpc: rx(t.ambiguousIpc),
      licenses: {
        RN: rx(t.licenses.RN), LPN: rx(t.licenses.LPN), LVN: rx(t.licenses.LVN),
        LPN_LVN: rx(t.licenses.LPN_LVN), GENERIC_NURSE: rx(t.licenses.GENERIC_NURSE),
      },
      roles: Object.entries(t.roles).map(([k, v]) => [k, rx(v)]),
      excluded: rx(t.excluded),
      nonNursing: rx(t.nonNursing),
    };
    cache.set(t, c);
  }
  return c;
}

/** Lowercase, "&" -> "and", punctuation -> spaces (keeps "/" for LPN/LVN). */
export function normalizeTitle(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9/]+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

const firstHit = (list: RegExp[], s: string) => list.find((r) => r.test(s));
const hitText = (list: RegExp[], s: string) => {
  for (const r of list) { const m = s.match(r); if (m) return m[0].trim(); }
  return null;
};

function detectCareLines(c: Compiled, s: string): CareLine[] {
  const found: CareLine[] = [];
  for (const [line, pats] of c.careLines) if (firstHit(pats, s)) found.push(line);
  // IPC hospice implies hospice; keep only the more specific line.
  if (found.includes('ipc_hospice')) return found.filter((l) => l !== 'hospice');
  return found;
}

function detectLicense(c: Compiled, s: string): License | null {
  if (firstHit(c.licenses.LPN_LVN, s)) return 'LPN/LVN';
  if (firstHit(c.licenses.RN, s)) return 'RN';
  const lpn = !!firstHit(c.licenses.LPN, s);
  const lvn = !!firstHit(c.licenses.LVN, s);
  if (lpn && lvn) return 'LPN/LVN';
  if (lpn) return 'LPN';
  if (lvn) return 'LVN';
  return null;
}

function specialtyLabel(careLine: CareLine | null, careLines: CareLine[], license: License | null, role: string | null): string | null {
  let care: string | null = careLine ? CARE_LINE_LABEL[careLine] : null;
  if (careLine === 'hospice' && careLines.includes('palliative')) care = 'Hospice/Palliative';
  if (!care) return null;
  const lic = license ?? 'Nurse';
  const pre = role && ['Admissions', 'On-Call', 'Triage', 'After-Hours', 'Weekend'].includes(role) ? `${role} ` : '';
  const post = role === 'Case Manager' ? ' Case Manager' : '';
  return `${care} ${pre}${lic}${post}`;
}

export function classifyJob(input: ClassifyInput, taxonomy: Taxonomy = DEFAULT_TAXONOMY): Classification {
  const c = compile(taxonomy);
  const t = normalizeTitle(input.title);
  const reasons: string[] = [];
  const out = (decision: Decision, careLine: CareLine | null, careLines: CareLine[], license: License | null, role: string | null): Classification => ({
    decision, careLine, careLines, license, role, specialty: specialtyLabel(careLine, careLines, license, role), reasons,
  });

  if (!t) {
    reasons.push('No job title was found, so the specialty cannot be classified.');
    return out('review', null, [], null, null);
  }

  const careLines = detectCareLines(c, t);
  const license = detectLicense(c, t);
  const genericNurse = !!firstHit(c.licenses.GENERIC_NURSE, t);
  const nursing = !!license || genericNurse;
  const role = c.roles.find(([, pats]) => firstHit(pats, t))?.[0] ?? null;
  const excludedHit = hitText(c.excluded, t);
  const nonNursingHit = hitText(c.nonNursing, t);
  const ambiguousIpc = careLines.length === 0 ? hitText(c.ambiguousIpc, t) : null;

  if (!nursing) {
    if (role === 'Case Manager' && careLines.length) {
      reasons.push('Case manager title with no RN/LPN/LVN or "nurse" term; it could be a social-work case manager.');
      return out('review', careLines[0], careLines, null, role);
    }
    reasons.push(nonNursingHit ? `Not a nursing position ("${nonNursingHit}").` : 'No RN, LPN, LVN, or nurse term in the title.');
    return out('exclude', careLines[0] ?? null, careLines, null, role);
  }

  if (license) reasons.push(`License level: ${license}.`);
  else reasons.push('Nursing role, but the title does not state RN, LPN, or LVN.');

  if (careLines.length === 0) {
    if (ambiguousIpc) {
      reasons.push(`"${ambiguousIpc.toUpperCase()}" may mean inpatient hospice care, but the title does not say hospice. Confirm manually.`);
      return out('review', 'ipc_hospice', ['ipc_hospice'], license, role);
    }
    if (excludedHit) {
      reasons.push(`Non-target setting in title ("${excludedHit}") and no Home Health, Hospice, Palliative, or IPC term.`);
      return out('exclude', null, [], license, role);
    }
    const ctx = normalizeTitle(input.context ?? '');
    const ctxLines = ctx ? detectCareLines(c, ctx) : [];
    if (ctxLines.length) {
      reasons.push(`Title has no specialty term; surrounding text mentions ${ctxLines.map((l) => CARE_LINE_LABEL[l]).join(' and ')}. Confirm manually.`);
      return out('review', ctxLines[0], ctxLines, license, role);
    }
    if (ctx && firstHit(c.excluded, ctx)) {
      reasons.push(`No target specialty in the title, and the surrounding text points to a non-target setting ("${hitText(c.excluded, ctx)}").`);
      return out('exclude', null, [], license, role);
    }
    reasons.push(role === 'Case Manager'
      ? 'RN case manager with no Home Health or Hospice term; it may be a hospital or payer role. Confirm manually.'
      : 'No Home Health, Hospice, Palliative, or IPC term in the title. Confirm manually.');
    return out('review', null, [], license, role);
  }

  reasons.push(`Specialty terms found: ${careLines.map((l) => CARE_LINE_LABEL[l]).join(', ')}.`);

  if (nonNursingHit) {
    reasons.push(`Title also mentions "${nonNursingHit}", which may not be a field nursing role. Confirm manually.`);
    return out('review', careLines[0], careLines, license, role);
  }
  if (excludedHit) {
    reasons.push(`Title also contains a non-target setting ("${excludedHit}"). Confirm manually.`);
    return out('review', careLines[0], careLines, license, role);
  }

  const set = new Set(careLines);
  const isHybridHH = set.has('home_health') && (set.has('hospice') || set.has('ipc_hospice') || set.has('palliative'));
  if (isHybridHH) {
    reasons.push('Title mentions Home Health together with Hospice or Palliative. Classify the job by its actual specialty.');
    return out('review', null, careLines, license, role);
  }
  // hospice + palliative, or ipc + palliative: the more specific hospice line leads.
  const primary = careLines[0];
  return out('accept', primary, careLines, license, role);
}
