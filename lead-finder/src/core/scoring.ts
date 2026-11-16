// Configurable lead scoring. A score signals business-development potential only;
// it is not evidence that a facility needs contract staff.

export interface ScoringWeights {
  verifiedIdentity: number;
  targetSpecialty: number;
  rnOpening: number;
  lpnOpening: number;
  multipleOpenings: number;
  recentPosting: number;
  multipleBranches: number;
  /** Days within which a posting counts as recent. */
  recentDays: number;
  highAt: number;
  mediumAt: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  verifiedIdentity: 20,
  targetSpecialty: 20,
  rnOpening: 15,
  lpnOpening: 10,
  multipleOpenings: 15,
  recentPosting: 10,
  multipleBranches: 10,
  recentDays: 14,
  highAt: 60,
  mediumAt: 35,
};

export type Priority = 'High' | 'Medium' | 'Low' | 'Needs Research';

export interface ScoreInput {
  identityStatus: string; // best identity status across the facility's extractions
  verificationStatus: string; // facility verification status
  jobs: { decision: string; license: string | null; role: string | null; title: string; lastSeen: string | Date }[];
  branchCount: number; // facilities sharing this facility's parent organization (including itself)
  now?: Date;
}

export interface ScoreResult {
  score: number;
  priority: Priority;
  reasons: { label: string; points: number }[];
}

export function scoreLead(input: ScoreInput, w: ScoringWeights = DEFAULT_WEIGHTS): ScoreResult {
  const reasons: { label: string; points: number }[] = [];
  const add = (label: string, points: number) => { if (points) reasons.push({ label, points }); };
  const now = input.now ?? new Date();
  const verified = input.identityStatus === 'confirmed' || ['verified_website', 'verified_license', 'verified_manual'].includes(input.verificationStatus);
  if (verified) add('Facility identity confirmed', w.verifiedIdentity);
  const target = input.jobs.filter((j) => j.decision === 'accept');
  if (target.length) add('Confirmed target specialty', w.targetSpecialty);
  if (target.some((j) => j.license === 'RN')) add(target.some((j) => j.role === 'Case Manager' && j.license === 'RN') ? 'RN Case Manager opening' : 'RN opening', w.rnOpening);
  if (target.some((j) => j.license && j.license !== 'RN')) add('LPN/LVN opening', w.lpnOpening);
  const distinctTitles = new Set(target.map((j) => j.title.toLowerCase().trim()));
  if (distinctTitles.size > 1) add(`${distinctTitles.size} distinct relevant openings`, w.multipleOpenings);
  const recent = input.jobs.some((j) => (now.getTime() - new Date(j.lastSeen).getTime()) / 86_400_000 <= w.recentDays);
  if (recent) add(`Posting observed in the last ${w.recentDays} days`, w.recentPosting);
  if (input.branchCount > 1) add(`${input.branchCount} hiring branches under the same parent`, w.multipleBranches);
  const score = reasons.reduce((s, r) => s + r.points, 0);
  let priority: Priority;
  if (!verified && !target.length) priority = 'Needs Research';
  else if (!verified) priority = 'Needs Research';
  else priority = score >= w.highAt ? 'High' : score >= w.mediumAt ? 'Medium' : 'Low';
  return { score, priority, reasons };
}
