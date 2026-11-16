import { describe, expect, it } from 'vitest';
import { classifyJob, mergeTaxonomy, validateTaxonomy, DEFAULT_TAXONOMY } from '../src/core/index.ts';

const c = (title: string, context?: string) => classifyJob({ title, context });

describe('specialty classification: accepted target roles', () => {
  it.each([
    ['Home Health Registered Nurse', 'home_health', 'RN', 'Home Health RN'],
    ['Home Care Registered Nurse', 'home_health', 'RN', 'Home Health RN'],
    ['RN - Home Health Visits', 'home_health', 'RN', 'Home Health RN'],
    ['Home Health LPN', 'home_health', 'LPN', 'Home Health LPN'],
    ['Home Health LVN', 'home_health', 'LVN', 'Home Health LVN'],
    ['LPN/LVN - Home Health', 'home_health', 'LPN/LVN', 'Home Health LPN/LVN'],
    ['Home Health RN Case Manager', 'home_health', 'RN', 'Home Health RN Case Manager'],
    ['Home Health LPN Case Manager', 'home_health', 'LPN', 'Home Health LPN Case Manager'],
    ['Hospice Registered Nurse', 'hospice', 'RN', 'Hospice RN'],
    ['Hospice Field RN', 'hospice', 'RN', 'Hospice RN'],
    ['Hospice LPN', 'hospice', 'LPN', 'Hospice LPN'],
    ['Licensed Vocational Nurse - Hospice', 'hospice', 'LVN', 'Hospice LVN'],
    ['RN Case Manager - Hospice', 'hospice', 'RN', 'Hospice RN Case Manager'],
    ['Hospice LPN/LVN Case Manager', 'hospice', 'LPN/LVN', 'Hospice LPN/LVN Case Manager'],
    ['Hospice Admissions RN', 'hospice', 'RN', 'Hospice Admissions RN'],
    ['Hospice On-Call RN', 'hospice', 'RN', 'Hospice On-Call RN'],
    ['Hospice Triage RN', 'hospice', 'RN', 'Hospice Triage RN'],
    ['Hospice After-Hours RN', 'hospice', 'RN', 'Hospice After-Hours RN'],
    ['Weekend Hospice RN', 'hospice', 'RN', 'Hospice Weekend RN'],
    ['Palliative Care RN', 'palliative', 'RN', 'Palliative Care RN'],
    ['Palliative Care LPN', 'palliative', 'LPN', 'Palliative Care LPN'],
    ['Palliative Care Nurse Case Manager', 'palliative', null, 'Palliative Care Nurse Case Manager'],
    ['Community-Based Palliative Care Nurse', 'palliative', null, 'Palliative Care Nurse'],
    ['Inpatient Hospice RN', 'ipc_hospice', 'RN', 'IPC Hospice RN'],
    ['IPC Hospice LPN', 'ipc_hospice', 'LPN', 'IPC Hospice LPN'],
    ['Hospice House RN Case Manager', 'ipc_hospice', 'RN', 'IPC Hospice RN Case Manager'],
    ['RN - Hospice Inpatient Unit', 'ipc_hospice', 'RN', 'IPC Hospice RN'],
    ['Hospice Admissions Nurse', 'hospice', null, 'Hospice Admissions Nurse'],
    ['Hospice & Palliative Care RN', 'hospice', 'RN', 'Hospice/Palliative RN'],
  ])('%s', (title, careLine, license, specialty) => {
    const r = c(title);
    expect(r.decision, r.reasons.join(' | ')).toBe('accept');
    expect(r.careLine).toBe(careLine);
    expect(r.license).toBe(license);
    expect(r.specialty).toBe(specialty);
  });

  it('does not confuse Home Health with Hospice', () => {
    expect(c('Home Health RN').careLine).toBe('home_health');
    expect(c('Hospice RN').careLine).toBe('hospice');
    expect(c('Home Health RN').careLines).not.toContain('hospice');
  });

  it('treats "PT" as part-time, not physical therapy', () => {
    expect(c('Hospice RN - PT').decision).toBe('accept');
  });
});

describe('specialty classification: exclusions', () => {
  it.each([
    'ICU Registered Nurse',
    'Emergency Department RN',
    'Med-Surg RN',
    'Registered Nurse - Telemetry',
    'SNF LPN',
    'Outpatient Clinic RN',
    'Labor & Delivery RN',
    'Hospital Staff RN',
  ])('excludes unrelated hospital/facility nursing: %s', (title) => {
    expect(c(title).decision).toBe('exclude');
  });
  it.each(['Hospice Aide', 'Home Health Physical Therapist', 'Hospice Chaplain', 'Medical Social Worker - Hospice'])('excludes non-nursing role: %s', (title) => {
    expect(c(title).decision).toBe('exclude');
  });
  it('excludes a generic RN when the surrounding text points to a hospital setting', () => {
    expect(c('Registered Nurse', 'Memorial Hospital Med Surg').decision).toBe('exclude');
  });
});

describe('specialty classification: manual review', () => {
  it('does not assume an RN Case Manager is Home Health or Hospice', () => {
    const r = c('RN Case Manager');
    expect(r.decision).toBe('review');
    expect(r.careLine).toBeNull();
  });
  it('flags ambiguous IPC abbreviations', () => {
    const r = c('IPC RN');
    expect(r.decision).toBe('review');
    expect(r.careLine).toBe('ipc_hospice');
  });
  it('flags hybrid Home Health / Hospice titles', () => {
    const r = c('Home Health & Hospice RN');
    expect(r.decision).toBe('review');
    expect(r.careLines).toEqual(expect.arrayContaining(['home_health', 'hospice']));
  });
  it('uses page context only to suggest a care line, never to auto-accept', () => {
    const r = c('Registered Nurse', 'Hospice');
    expect(r.decision).toBe('review');
    expect(r.careLine).toBe('hospice');
  });
  it('flags case manager titles without a nursing term', () => {
    expect(c('Hospice Case Manager').decision).toBe('review');
  });
  it('flags target specialty with a non-target setting term', () => {
    expect(c('Hospice RN - Hospital Liaison').decision).toBe('review');
  });
  it('flags missing titles', () => {
    expect(c('').decision).toBe('review');
  });
});

describe('configurable taxonomy', () => {
  it('lets an admin add a title variant', () => {
    expect(c('Comfort Nurse RN').decision).toBe('review');
    const t = mergeTaxonomy({ careLines: { hospice: [...DEFAULT_TAXONOMY.careLines.hospice, '\\bcomfort nurse\\b'] } });
    expect(classifyJob({ title: 'Comfort Nurse RN' }, t)).toMatchObject({ decision: 'accept', careLine: 'hospice' });
  });
  it('rejects invalid patterns', () => {
    expect(() => validateTaxonomy(mergeTaxonomy({ excluded: ['(unclosed'] }))).toThrow(/Invalid pattern/);
  });
});
