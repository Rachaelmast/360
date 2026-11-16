import { DEFAULT_TAXONOMY, type Taxonomy } from './taxonomy.ts';

const LEGAL_SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'l l c', 'llp', 'lp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'pllc', 'pc', 'pa', 'plc', 'dba']);

/** Normalised organisation name used for duplicate detection. Keeps service words (hospice, home health). */
export function normalizeName(name: string | null | undefined): string {
  let s = (name ?? '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const words = s.split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop();
  if (words[0] === 'the' && words.length > 1) words.shift();
  s = words.join(' ');
  return s;
}

const STREET_ABBR: Record<string, string> = {
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd', lane: 'ln', court: 'ct',
  place: 'pl', parkway: 'pkwy', highway: 'hwy', circle: 'cir', terrace: 'ter', square: 'sq', trail: 'trl',
  north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  suite: 'ste', building: 'bldg', floor: 'fl', apartment: 'apt', unit: 'unit',
};

/** Normalised street address; suite/unit numbers are dropped so one building matches. */
export function normalizeStreet(street: string | null | undefined): string {
  const words = (street ?? '').toLowerCase().replace(/[^a-z0-9# ]+/g, ' ').split(/\s+/).filter(Boolean).map((w) => STREET_ABBR[w] ?? w);
  const cut = words.findIndex((w) => w === 'ste' || w === 'unit' || w === 'apt' || w === 'fl' || w === 'bldg' || w.startsWith('#'));
  return (cut >= 0 ? words.slice(0, cut) : words).join(' ');
}

export function normalizeState(s: string | null | undefined): string {
  const v = (s ?? '').trim();
  if (/^[a-z]{2}$/i.test(v)) return v.toUpperCase();
  return STATE_CODES[v.toLowerCase()] ?? v.toUpperCase();
}

export function normalizeCity(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\bsaint\b/g, 'st').replace(/\s+/g, ' ').trim();
}

export function domainOf(website: string | null | undefined): string {
  if (!website) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export type Genericity = 'generic' | 'weak' | 'specific';

/**
 * generic:  does not name an organisation at all ("Home Health", "Confidential", "Hospice Agency")
 * weak:     only generic words plus a place name ("Florida Home Health") - may be real, needs review
 * specific: contains at least one distinctive word
 */
export function orgNameGenericity(name: string | null | undefined, taxonomy: Taxonomy = DEFAULT_TAXONOMY): Genericity {
  const raw = (name ?? '').trim();
  if (raw.length < 3) return 'generic';
  const lower = raw.toLowerCase();
  if (taxonomy.genericOrgPhrases.some((p) => lower.includes(p))) return 'generic';
  const generic = new Set(taxonomy.genericOrgTerms);
  const tokens = lower.replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
  const meaningful = tokens.filter((t) => !generic.has(t));
  if (meaningful.length === 0) return 'generic';
  if (meaningful.every((t) => US_STATE_WORDS.has(t))) return 'weak';
  return 'specific';
}

/** True when the value does not name a specific organisation (e.g. "Home Health", "Confidential"). */
export function isGenericOrgName(name: string | null | undefined, taxonomy: Taxonomy = DEFAULT_TAXONOMY): boolean {
  return orgNameGenericity(name, taxonomy) === 'generic';
}

/** True when a name looks like a staffing agency rather than the end-client facility. */
export function looksLikeStaffingAgency(name: string | null | undefined, taxonomy: Taxonomy = DEFAULT_TAXONOMY): boolean {
  const n = normalizeName(name);
  if (!n) return false;
  if (taxonomy.knownStaffingAgencies.some((a) => n === a || n.startsWith(`${a} `))) return true;
  return taxonomy.staffingAgencyPatterns.some((p) => new RegExp(p, 'i').test(n));
}

/**
 * Split a facility name into a brand and a branch label, e.g.
 * "Acme Hospice - Tampa" -> { brand: "Acme Hospice", branch: "Tampa" },
 * "Acme Home Health of Orlando" -> { brand: "Acme Home Health", branch: "Orlando" }.
 */
export function splitBranch(name: string): { brand: string; branch: string | null } {
  const n = (name ?? '').trim();
  const dash = n.match(/^(.+?)\s+[-–—|:]\s+(.+)$/);
  if (dash) return { brand: dash[1].trim(), branch: dash[2].trim() };
  const paren = n.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (paren) return { brand: paren[1].trim(), branch: paren[2].trim() };
  const of = n.match(/^(.+?\b(?:hospice|home health|home care|palliative care|healthcare|health))\s+of\s+(.+)$/i);
  if (of) return { brand: of[1].trim(), branch: of[2].trim() };
  return { brand: n, branch: null };
}

/** The first distinctive word(s) of a brand, used to suggest a shared parent company. */
export function brandKey(name: string, taxonomy: Taxonomy = DEFAULT_TAXONOMY): string {
  const { brand } = splitBranch(name);
  const generic = new Set(taxonomy.genericOrgTerms);
  const tokens = normalizeName(brand).split(' ').filter((t) => t && !generic.has(t));
  return tokens.join(' ');
}

function tokenSet(s: string): Set<string> {
  return new Set(s.split(' ').filter((t) => t.length > 1));
}

export function nameSimilarity(a: string, b: string): number {
  const A = tokenSet(normalizeName(a));
  const B = tokenSet(normalizeName(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface FacilityLike {
  id?: string;
  name: string;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  website?: string | null;
  branchCode?: string | null;
  parentName?: string | null;
}

export type MatchStrength = 'exact' | 'likely' | 'possible' | 'related';

export interface MatchResult {
  strength: MatchStrength;
  reasons: string[];
}

/**
 * Compare a newly extracted facility with an existing one.
 * - exact:    same normalised name and same street address (or same branch identifier)
 * - likely:   same normalised name and same city/state, street unknown on one side
 * - possible: same address with a different name, similar name in the same state, or same website
 * - related:  same brand in a different location (a possible branch of the same parent)
 * Returns null when there is no meaningful overlap. Only "exact" and "likely" are safe to link automatically,
 * and only when the user confirms; similar names alone are never merged.
 */
export function compareFacilities(a: FacilityLike, b: FacilityLike, taxonomy: Taxonomy = DEFAULT_TAXONOMY): MatchResult | null {
  const reasons: string[] = [];
  const nA = normalizeName(a.name), nB = normalizeName(b.name);
  const sameName = !!nA && nA === nB;
  const stA = normalizeState(a.state), stB = normalizeState(b.state);
  const sameState = !!stA && stA === stB;
  const cityA = normalizeCity(a.city), cityB = normalizeCity(b.city);
  const sameCity = sameState && !!cityA && cityA === cityB;
  const strA = normalizeStreet(a.street), strB = normalizeStreet(b.street);
  const bothStreets = !!strA && !!strB;
  const sameStreet = bothStreets && strA === strB;
  const domA = domainOf(a.website), domB = domainOf(b.website);
  const sameDomain = !!domA && domA === domB;
  const sameBranchCode = !!a.branchCode && a.branchCode === b.branchCode;

  if (sameBranchCode) {
    reasons.push(`Same branch identifier (${a.branchCode}).`);
    return { strength: 'exact', reasons };
  }
  if (sameName && sameStreet && (sameState || !stA || !stB)) {
    reasons.push('Same normalised name and street address.');
    return { strength: 'exact', reasons };
  }
  if (sameName && sameCity && !bothStreets) {
    reasons.push('Same normalised name in the same city and state; street address missing on one record.');
    return { strength: 'likely', reasons };
  }
  if (sameName && sameState && !a.city && !b.city && !bothStreets) {
    reasons.push('Same normalised name in the same state; no city or street to compare.');
    return { strength: 'likely', reasons };
  }
  if (sameName && bothStreets && !sameStreet) {
    reasons.push('Same name but a different street address. This may be a separate branch.');
    return { strength: 'possible', reasons };
  }
  if (sameStreet && (sameCity || (!a.city || !b.city))) {
    reasons.push('Same street address with a different name.');
    return { strength: 'possible', reasons };
  }
  const sim = nameSimilarity(a.name, b.name);
  if (sim >= 0.6 && sameState) {
    reasons.push(`Similar name (${Math.round(sim * 100)}% word overlap) in the same state.`);
    if (sameCity) reasons.push('Same city.');
    return { strength: 'possible', reasons };
  }
  if (sameDomain) {
    reasons.push(`Same website domain (${domA}).`);
    return { strength: 'possible', reasons };
  }
  const kA = brandKey(a.name, taxonomy), kB = brandKey(b.name, taxonomy);
  const distinctive = kA.includes(' ') || kA.length >= 8;
  if (kA && kA === kB && (distinctive || sameState)) {
    reasons.push(`Same brand ("${kA}") at a different location. Possibly a branch of the same parent company.`);
    return { strength: 'related', reasons };
  }
  if (a.parentName && b.parentName && normalizeName(a.parentName) === normalizeName(b.parentName)) {
    reasons.push('Same parent company.');
    return { strength: 'related', reasons };
  }
  return null;
}

const STATE_CODES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR',
};

export const US_STATES = Object.values(STATE_CODES);

const US_STATE_WORDS = new Set(
  Object.keys(STATE_CODES).flatMap((k) => k.split(' ')).concat(['north', 'south', 'new', 'west']),
);
