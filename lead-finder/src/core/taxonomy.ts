// Configurable specialty taxonomy. Admins can override any list from the
// Settings page; the server stores overrides and merges them over these defaults.
// Patterns are case-insensitive regular expression sources matched against a
// normalised title (lowercase, punctuation turned into spaces, "&" -> " and ").

export type CareLine = 'home_health' | 'hospice' | 'palliative' | 'ipc_hospice';

export interface Taxonomy {
  careLines: Record<CareLine, string[]>;
  /** Terms that make an IPC reading ambiguous on their own (needs hospice context). */
  ambiguousIpc: string[];
  licenses: { RN: string[]; LPN: string[]; LVN: string[]; LPN_LVN: string[]; GENERIC_NURSE: string[] };
  roles: Record<string, string[]>;
  /** Clearly non-target nursing settings. A job with only these is excluded. */
  excluded: string[];
  /** Non-nursing roles. A job with these and no nursing term is excluded. */
  nonNursing: string[];
  /** Words that, alone, do not identify an organisation. */
  genericOrgTerms: string[];
  /** Phrases that make any name generic (e.g. "Confidential"). */
  genericOrgPhrases: string[];
  /** Name fragments that indicate a staffing agency rather than the end client. */
  staffingAgencyPatterns: string[];
  /** Known staffing agency names (normalised, exact or prefix match). */
  knownStaffingAgencies: string[];
}

export const CARE_LINE_LABEL: Record<CareLine, string> = {
  home_health: 'Home Health',
  hospice: 'Hospice',
  palliative: 'Palliative Care',
  ipc_hospice: 'IPC Hospice',
};

export const DEFAULT_TAXONOMY: Taxonomy = {
  careLines: {
    ipc_hospice: [
      '\\binpatient hospice\\b',
      '\\bhospice inpatient\\b',
      '\\bipc\\b.*\\bhospice\\b',
      '\\bhospice\\b.*\\bipc\\b',
      '\\bhospice (house|home|unit|facility|center)\\b',
      '\\bgip\\b.*\\bhospice\\b',
      '\\bhospice\\b.*\\bgip\\b',
      '\\bgeneral inpatient\\b',
      '\\binpatient (unit|care)\\b.*\\bhospice\\b',
      '\\bhospice\\b.*\\binpatient\\b',
      '\\binpatient\\b.*\\bhospice\\b',
    ],
    hospice: ['\\bhospice\\b', '\\bend of life\\b'],
    palliative: ['\\bpalliative\\b', '\\bcomfort care\\b'],
    home_health: ['\\bhome health\\b', '\\bhome healthcare\\b', '\\bhome care\\b', '\\bhomecare\\b', '\\bhome visits?\\b', '\\bhh\\b', '\\bin home\\b'],
  },
  ambiguousIpc: ['\\bipc\\b', '\\bipu\\b', '\\bgip\\b'],
  licenses: {
    LPN_LVN: ['\\blpn ?/? ?lvn\\b', '\\blvn ?/? ?lpn\\b', '\\blpn or lvn\\b', '\\blvn or lpn\\b'],
    RN: ['\\brn\\b', '\\bregistered nurse\\b', '\\brns\\b', '\\bbsn\\b'],
    LPN: ['\\blpn\\b', '\\blicensed practical\\b'],
    LVN: ['\\blvn\\b', '\\blicensed vocational\\b'],
    GENERIC_NURSE: ['\\bnurse\\b', '\\bnursing\\b'],
  },
  roles: {
    'Case Manager': ['\\bcase manag', '\\bcm\\b', '\\bcare manager\\b'],
    Admissions: ['\\badmission', '\\bintake\\b'],
    'On-Call': ['\\bon ?call\\b'],
    Triage: ['\\btriage\\b'],
    'After-Hours': ['\\bafter ?hours\\b', '\\bnight\\b', '\\bovernight\\b', '\\bnoc\\b'],
    Weekend: ['\\bweekend'],
    Visit: ['\\bvisit', '\\bfield\\b'],
  },
  excluded: [
    '\\bicu\\b', '\\bintensive care\\b', '\\bcritical care\\b', '\\bemergency\\b', '\\ber\\b', '\\bemergency department\\b',
    '\\bmed ?surg', '\\bmedical surgical\\b', '\\btelemetry\\b', '\\btele\\b', '\\bstep ?down\\b', '\\bpcu\\b',
    '\\bsnf\\b', '\\bskilled nursing facility\\b', '\\blong term care\\b', '\\bltc\\b', '\\bltac\\b',
    '\\boutpatient\\b', '\\bclinic\\b', '\\bambulatory\\b', '\\boperating room\\b', '\\bperioperative\\b', '\\bpacu\\b',
    '\\blabor and delivery\\b', '\\bl and d\\b', '\\bnicu\\b', '\\bpicu\\b', '\\bcath lab\\b', '\\bdialysis\\b',
    '\\bpsych', '\\bbehavioral health\\b', '\\boncology infusion\\b', '\\bschool nurse\\b', '\\bcorrectional\\b',
    '\\bhospital\\b', '\\bacute care\\b', '\\butilization review\\b',
  ],
  nonNursing: [
    '\\bsocial worker\\b', '\\bmsw\\b', '\\bchaplain\\b', '\\baide\\b', '\\bhha\\b', '\\bcna\\b', '\\bcaregiver\\b',
    '\\bphysical therap', '\\bpta\\b', '\\boccupational therap', '\\bcota\\b', '\\bspeech',
    '\\bslp\\b', '\\bphysician\\b', '\\bmd\\b', '\\bnurse practitioner\\b', '\\bnp\\b', '\\bfnp\\b', '\\bscheduler\\b',
    '\\bcoordinator\\b(?!.*\\bnurse\\b)', '\\bmarketer\\b', '\\bliaison\\b(?!.*\\b(rn|nurse)\\b)', '\\bdirector\\b',
    '\\badministrator\\b', '\\bvolunteer\\b', '\\bbereavement\\b', '\\bmedical assistant\\b',
  ],
  genericOrgTerms: [
    'a', 'an', 'the', 'of', 'in', 'and', 'for', 'at', 'our', 'your', 'home', 'health', 'healthcare', 'care', 'hospice',
    'palliative', 'agency', 'agencies', 'facility', 'facilities', 'hospital', 'hospitals', 'client', 'company',
    'provider', 'providers', 'organization', 'organisation', 'leading', 'top', 'rated', 'local', 'national',
    'nonprofit', 'non', 'profit', 'private', 'confidential', 'undisclosed', 'unknown', 'na', 'n', 'tbd', 'medical',
    'center', 'centre', 'services', 'service', 'group', 'system', 'network', 'inpatient', 'ipc', 'nursing', 'clinic',
    'premier', 'established', 'growing', 'well', 'known', 'large', 'small', 'regional', 'community', 'based',
    'employer', 'partner', 'travel', 'per', 'diem', 'staff', 'job', 'position', 'opportunity', 'rn', 'lpn', 'lvn',
  ],
  genericOrgPhrases: ['confidential', 'undisclosed', 'not disclosed', 'name withheld', 'withheld', 'client facility', 'our client', 'n/a', 'tbd', 'unknown'],
  staffingAgencyPatterns: [
    '\\bstaffing\\b', '\\btravel nurs', '\\btravel\\b', '\\bnurse travel', '\\blocums?\\b', '\\brecruit',
    '\\btalent\\b', '\\bworkforce\\b', '\\bplacement\\b', '\\bpersonnel\\b', '\\bmedical solutions\\b', '\\bnurses? network\\b',
  ],
  knownStaffingAgencies: [
    'amn healthcare', 'aya healthcare', 'cross country', 'cross country nurses', 'trusted health', 'trusted nurse staffing',
    'medical solutions', 'fusion medical staffing', 'host healthcare', 'nomad health', 'vivian', 'vivian health',
    'triage staffing', 'trustaff', 'atlas medstaff', 'aureus medical', 'travel nurse across america', 'tna',
    'ventura medstaff', 'gifted healthcare', 'medpro healthcare staffing', 'american mobile', 'onestaff medical',
    'nursefly', 'incredible health', 'connectrn', 'clipboard health', 'shiftkey', 'intelycare', 'maxim healthcare',
    'favorite healthcare staffing', 'supplemental health care', 'jackson nurse professionals', 'skybridge healthcare',
  ],
};

/** Merge an admin override (partial) over the defaults. Unknown keys are ignored. */
export function mergeTaxonomy(override: unknown): Taxonomy {
  const base: Taxonomy = structuredClone(DEFAULT_TAXONOMY);
  if (!override || typeof override !== 'object') return base;
  const o = override as Record<string, unknown>;
  const strArr = (v: unknown) => (Array.isArray(v) && v.every((s) => typeof s === 'string') ? (v as string[]) : null);
  for (const key of ['ambiguousIpc', 'excluded', 'nonNursing', 'genericOrgTerms', 'genericOrgPhrases', 'staffingAgencyPatterns', 'knownStaffingAgencies'] as const) {
    const v = strArr(o[key]);
    if (v) base[key] = v;
  }
  for (const group of ['careLines', 'licenses', 'roles'] as const) {
    const g = o[group];
    if (g && typeof g === 'object') {
      for (const [k, v] of Object.entries(g as Record<string, unknown>)) {
        const arr = strArr(v);
        if (arr && (group === 'roles' || k in base[group])) (base[group] as Record<string, string[]>)[k] = arr;
      }
    }
  }
  return base;
}

/** Throws with a readable message if any pattern is not a valid regular expression. */
export function validateTaxonomy(t: Taxonomy): void {
  const check = (where: string, list: string[]) => {
    for (const p of list) {
      try { new RegExp(p, 'i'); } catch (e) { throw new Error(`Invalid pattern in ${where}: ${p} (${(e as Error).message})`); }
    }
  };
  for (const [k, v] of Object.entries(t.careLines)) check(`careLines.${k}`, v);
  for (const [k, v] of Object.entries(t.licenses)) check(`licenses.${k}`, v);
  for (const [k, v] of Object.entries(t.roles)) check(`roles.${k}`, v);
  check('ambiguousIpc', t.ambiguousIpc);
  check('excluded', t.excluded);
  check('nonNursing', t.nonNursing);
  check('staffingAgencyPatterns', t.staffingAgencyPatterns);
}
