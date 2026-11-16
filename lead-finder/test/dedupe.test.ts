import { describe, expect, it } from 'vitest';
import { compareFacilities, normalizeName, normalizeStreet, splitBranch, brandKey, scoreLead } from '../src/core/index.ts';

describe('normalisation', () => {
  it('normalises names', () => {
    expect(normalizeName('The Bayside Hospice, LLC')).toBe('bayside hospice');
    expect(normalizeName('Smith & Sons Home Health Inc.')).toBe('smith and sons home health');
  });
  it('normalises streets and drops suite numbers', () => {
    expect(normalizeStreet('1414 Physicians Drive, Suite 200')).toBe('1414 physicians dr');
    expect(normalizeStreet('1414 Physicians Dr')).toBe('1414 physicians dr');
  });
});

describe('duplicate facility detection', () => {
  const base = { name: 'Bayside Hospice', street: '100 Main Street', city: 'Tampa', state: 'FL' };
  it('exact: same name and address', () => {
    expect(compareFacilities(base, { name: 'Bayside Hospice, LLC', street: '100 Main St Ste 4', city: 'Tampa', state: 'Florida' })?.strength).toBe('exact');
  });
  it('likely: same name and city, street missing on one side', () => {
    expect(compareFacilities(base, { name: 'Bayside Hospice', city: 'Tampa', state: 'FL' })?.strength).toBe('likely');
  });
  it('possible (separate branch): same name, different street', () => {
    const r = compareFacilities(base, { name: 'Bayside Hospice', street: '9 Bay Rd', city: 'Clearwater', state: 'FL' });
    expect(r?.strength).toBe('possible');
    expect(r?.reasons[0]).toContain('separate branch');
  });
  it('similar names are only "possible", never exact', () => {
    expect(compareFacilities(base, { name: 'Bayside Hospice Care', city: 'Tampa', state: 'FL' })?.strength).toBe('possible');
  });
  it('different organisations do not match', () => {
    expect(compareFacilities(base, { name: 'Sunrise Home Health', street: '5 Elm St', city: 'Tampa', state: 'FL' })).toBeNull();
  });
  it('same name in different states is not a duplicate', () => {
    expect(compareFacilities({ name: 'Hope Hospice', city: 'Tampa', state: 'FL' }, { name: 'Hope Hospice', city: 'Austin', state: 'TX' })).toBeNull();
  });
  it('same website suggests a possible match', () => {
    expect(compareFacilities({ name: 'A', website: 'https://www.acme.org/x' }, { name: 'B', website: 'acme.org' })?.strength).toBe('possible');
  });
});

describe('branch versus parent company', () => {
  it('splits a branch label from the brand', () => {
    expect(splitBranch('Amberwood Hospice - Tampa')).toEqual({ brand: 'Amberwood Hospice', branch: 'Tampa' });
    expect(splitBranch('Amberwood Home Health of Orlando')).toEqual({ brand: 'Amberwood Home Health', branch: 'Orlando' });
    expect(splitBranch('Lower Cape Fear LifeCare')).toEqual({ brand: 'Lower Cape Fear LifeCare', branch: null });
  });
  it('links branches of the same brand as related, not duplicates', () => {
    expect(brandKey('Amberwood Hospice - Tampa')).toBe('amberwood');
    const r = compareFacilities({ name: 'Amberwood Hospice - Tampa', city: 'Tampa', state: 'FL' }, { name: 'Amberwood Home Health of Orlando', city: 'Orlando', state: 'FL' });
    expect(r?.strength).toBe('related');
  });
});

describe('lead scoring', () => {
  const now = new Date('2026-11-16T00:00:00Z');
  it('scores and explains a strong lead', () => {
    const r = scoreLead({
      identityStatus: 'confirmed', verificationStatus: 'extracted', branchCount: 2, now,
      jobs: [
        { decision: 'accept', license: 'RN', role: 'Case Manager', title: 'Hospice RN Case Manager', lastSeen: '2026-11-15' },
        { decision: 'accept', license: 'LPN', role: null, title: 'Hospice LPN', lastSeen: '2026-11-10' },
      ],
    });
    expect(r.score).toBe(100);
    expect(r.priority).toBe('High');
    expect(r.reasons.map((x) => x.label)).toContain('RN Case Manager opening');
  });
  it('unverified identity means Needs Research', () => {
    expect(scoreLead({ identityStatus: 'possible', verificationStatus: 'unverified', branchCount: 1, now, jobs: [{ decision: 'accept', license: 'RN', role: null, title: 'Hospice RN', lastSeen: '2026-11-15' }] }).priority).toBe('Needs Research');
  });
});
