import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractFromHtml, parseVivianJobUrl, extractUrlsFromText } from '../src/core/index.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const page = (body: string) => `<!doctype html><html><head><title>Job | Vivian</title></head><body>${body}</body></html>`;

describe('Vivian URL validation', () => {
  it('accepts and canonicalises job URLs', () => {
    expect(parseVivianJobUrl('https://www.vivian.com/job/145-1448402/')).toEqual({ ok: true, url: 'https://www.vivian.com/job/145-1448402/', source: 'vivian', externalId: '145-1448402' });
    expect(parseVivianJobUrl('vivian.com/job/145-1448402')).toMatchObject({ ok: true, url: 'https://www.vivian.com/job/145-1448402/' });
    expect(parseVivianJobUrl('https://www.vivian.com/job/145-1448402/?utm_source=x#top')).toMatchObject({ ok: true, externalId: '145-1448402' });
  });
  it.each([
    ['', 'Enter'],
    ['not a url at all', 'valid URL'],
    ['https://evil.example.com/job/1/', 'Only Vivian'],
    ['https://www.vivian.com.evil.com/job/1/', 'Only Vivian'],
    ['https://user:pw@www.vivian.com/job/1/', 'credentials'],
    ['https://www.vivian.com:8443/job/1/', 'ports'],
    ['ftp://www.vivian.com/job/1/', 'http'],
    ['https://www.vivian.com/jobs?state=FL', 'not a job posting'],
    ['https://127.0.0.1/job/1/', 'Only Vivian'],
  ])('rejects %s', (url, msg) => {
    const r = parseVivianJobUrl(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });
  it('finds URLs inside pasted text and CSV', () => {
    expect(extractUrlsFromText('url\nhttps://www.vivian.com/job/1-2/,x\n"vivian.com/job/3-4"')).toEqual(['https://www.vivian.com/job/1-2/', 'vivian.com/job/3-4']);
  });
});

describe('facility extraction', () => {
  it('extracts hospitalName and hospitalAddress from the Lower Cape Fear LifeCare fixture', () => {
    const r = extractFromHtml(fixture('lower-cape-fear-lifecare.html'), { url: 'https://www.vivian.com/job/145-1448402/' });
    expect(r.status).toBe('confirmed');
    expect(r.facility.name).toBe('Lower Cape Fear LifeCare');
    expect(r.facility.sourceField).toBe('hospitalName');
    expect(r.facility.address.street).toBe('1414 Physicians Dr');
    // the fixture has no city/state/zip, so nothing may be invented
    expect(r.facility.address.city).toBeNull();
    expect(r.facility.address.state).toBeNull();
    expect(r.facility.address.zip).toBeNull();
    expect(r.job.title).toBe('Hospice RN Case Manager');
    expect(r.job.externalId).toBe('145-1448402');
    expect(r.classification).toMatchObject({ decision: 'accept', careLine: 'hospice', license: 'RN', specialty: 'Hospice RN Case Manager' });
    expect(r.evidence.some((e) => e.field === 'hospitalName' && e.value === 'Lower Cape Fear LifeCare')).toBe(true);
  });

  it('does not hardcode the fixture organisation', () => {
    const html = fixture('lower-cape-fear-lifecare.html').replaceAll('Lower Cape Fear LifeCare', 'Northwind Hospice Partners');
    expect(extractFromHtml(html).facility.name).toBe('Northwind Hospice Partners');
  });

  it('extracts from nested JSON objects with a nested address', () => {
    const state = { data: { posting: { title: 'Home Health LPN', specialty: 'Home Health', facility: { name: 'Riverbend Home Health', address: { streetAddress: '200 Oak Ave Suite 4', addressLocality: 'Tampa', addressRegion: 'Florida', postalCode: '33602' } } } } };
    const r = extractFromHtml(page(`<script>window.__APP_STATE__ = ${JSON.stringify(state)};</script>`));
    expect(r.status).toBe('confirmed');
    expect(r.facility.name).toBe('Riverbend Home Health');
    expect(r.facility.sourceField).toBe('facility.name');
    expect(r.facility.address).toEqual({ street: '200 Oak Ave Suite 4', city: 'Tampa', state: 'FL', zip: '33602' });
    expect(r.classification.specialty).toBe('Home Health LPN');
  });

  it('extracts from escaped JSON inside a JavaScript string (Next.js flight data)', () => {
    const inner = JSON.stringify({ job: { jobTitle: 'Hospice Admissions RN', hospitalName: 'Cedar Ridge Hospice', hospitalCity: 'Raleigh', hospitalState: 'NC', hospitalZip: '27601' } });
    const html = page(`<script>self.__next_f.push([1,${JSON.stringify('3:' + inner)}])</script>`);
    const r = extractFromHtml(html);
    expect(r.status).toBe('confirmed');
    expect(r.facility.name).toBe('Cedar Ridge Hospice');
    expect(r.facility.address).toMatchObject({ city: 'Raleigh', state: 'NC', zip: '27601' });
    expect(r.classification.specialty).toBe('Hospice Admissions RN');
  });

  it('extracts from double-escaped JSON via the text fallback', () => {
    const once = JSON.stringify(JSON.stringify({ hospitalName: 'Magnolia Palliative Partners', hospitalAddress: '9 Elm St' }));
    const twice = JSON.stringify(once); // \\\" level escaping
    const r = extractFromHtml(page(`<script>var x = ${twice};</script>`));
    expect(r.facility.name).toBe('Magnolia Palliative Partners');
    expect(r.facility.address.street).toBe('9 Elm St');
    expect(r.status).toBe('confirmed');
  });

  it('decodes HTML entities in values and data attributes', () => {
    const r = extractFromHtml(page(`<div data-props="{&quot;hospitalName&quot;:&quot;Smith &amp;amp; Sons Hospice&quot;,&quot;jobTitle&quot;:&quot;Hospice LPN&quot;}"></div>`));
    expect(r.facility.name).toBe('Smith & Sons Hospice');
  });

  it('reports not_found when there are no facility fields, without inventing a name', () => {
    const r = extractFromHtml(page('<h1>Hospice RN</h1><p>Great job.</p>'));
    expect(r.status).toBe('not_found');
    expect(r.facility.name).toBeNull();
    expect(r.facility.address).toEqual({ street: null, city: null, state: null, zip: null });
    expect(r.job.title).toBe('Hospice RN');
  });

  it('treats generic values as generic, not as an organisation', () => {
    for (const g of ['Home Health', 'Hospice', 'Confidential', 'Confidential Hospice Client', 'A Leading Home Health Agency', 'Hospice Agency']) {
      const r = extractFromHtml(page(`<script type="application/json">${JSON.stringify({ hospitalName: g, jobTitle: 'Hospice RN' })}</script>`));
      expect(r.status, g).toBe('generic');
      expect(r.facility.name, g).toBeNull();
    }
  });

  it('marks place-plus-generic names as possible, not confirmed', () => {
    const r = extractFromHtml(page(`<script type="application/json">${JSON.stringify({ hospitalName: 'Florida Home Health', jobTitle: 'Home Health RN' })}</script>`));
    expect(r.status).toBe('possible');
    expect(r.facility.name).toBe('Florida Home Health');
  });

  it('separates the staffing agency (advertiser) from the end-client facility', () => {
    const ld = { '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Hospice RN - Weekend', hiringOrganization: { '@type': 'Organization', name: 'Acme Nurse Staffing' }, jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Tampa', addressRegion: 'FL' } } };
    const state = { job: { hospitalName: 'Bayside Hospice of Tampa', hospitalCity: 'Tampa', hospitalState: 'FL' } };
    const r = extractFromHtml(page(`<script type="application/ld+json">${JSON.stringify(ld)}</script><script type="application/json">${JSON.stringify(state)}</script>`));
    expect(r.status).toBe('confirmed');
    expect(r.facility.name).toBe('Bayside Hospice of Tampa');
    expect(r.advertiser).toEqual({ name: 'Acme Nurse Staffing', sourceField: 'hiringOrganization.name', looksLikeStaffingAgency: true });
    expect(r.job).toMatchObject({ city: 'Tampa', state: 'FL' });
    expect(r.classification.specialty).toBe('Hospice Weekend RN');
  });

  it('reports agency_only when the only organisation is a staffing agency', () => {
    const ld = { '@type': 'JobPosting', title: 'Home Health RN', hiringOrganization: { name: 'Trusted Nurse Staffing' } };
    const r = extractFromHtml(page(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`));
    expect(r.status).toBe('agency_only');
    expect(r.facility.name).toBeNull();
    expect(r.advertiser?.name).toBe('Trusted Nurse Staffing');
  });

  it('does not accept a staffing agency name in a facility field', () => {
    const r = extractFromHtml(page(`<script type="application/json">${JSON.stringify({ hospitalName: 'Aya Healthcare', agencyName: 'Aya Healthcare', jobTitle: 'Hospice RN' })}</script>`));
    expect(r.status).toBe('agency_only');
  });

  it('uses hiringOrganization as a possible (not confirmed) facility when no facility field exists', () => {
    const ld = { '@type': 'JobPosting', title: 'Palliative Care RN', hiringOrganization: { name: 'Coastal Palliative Medicine Group' } };
    const r = extractFromHtml(page(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`));
    expect(r.status).toBe('possible');
    expect(r.facility.name).toBe('Coastal Palliative Medicine Group');
  });

  it('flags conflicting facility names as possible', () => {
    const r = extractFromHtml(page(`<script type="application/json">${JSON.stringify({ a: { hospitalName: 'Alpha Hospice' }, b: { facilityName: 'Beta Home Health' } })}</script>`));
    expect(r.status).toBe('possible');
    expect(r.warnings.join(' ')).toContain('more than one facility name');
  });

  it('recognises a Cloudflare challenge page', () => {
    const r = extractFromHtml('<html><head><title>Just a moment...</title></head><body><script src="https://challenges.cloudflare.com/x.js"></script></body></html>');
    expect(r.status).toBe('error');
    expect(r.errors[0]).toContain('Cloudflare');
  });

  it('handles empty input and malformed JSON without throwing', () => {
    expect(extractFromHtml('').status).toBe('error');
    const r = extractFromHtml(page(`<script type="application/ld+json">{ broken json </script><script>var s = {"hospitalName": "Pinecrest Hospice", "oops": }</script>`));
    expect(r.facility.name).toBe('Pinecrest Hospice');
    expect(r.facility.sourcePath).toBe('text');
    expect(r.warnings.join(' ')).toContain('could not be parsed');
  });

  it('keeps hospitalSystemId / system name as evidence', () => {
    const r = extractFromHtml(page(`<script type="application/json">${JSON.stringify({ hospitalName: 'Oakview Hospice - Tampa', hospitalSystemId: 77, hospitalSystemName: 'Oakview Health' })}</script>`));
    expect(r.facility.systemId).toBe('77');
    expect(r.facility.systemName).toBe('Oakview Health');
  });
});

describe('VMS (vendor management system) capture', () => {
  it('captures VMS fields from page JSON, including escaped and nested ones', () => {
    const state = { job: { hospitalName: 'Bayside Hospice', jobTitle: 'Hospice RN', vmsName: 'ShiftWise', isVms: true, vms: { id: 4, name: 'Medefis' } } };
    const r = extractFromHtml(page(`<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(state))}])</script>`));
    expect(r.vms.fields.map((f) => [f.field, f.value])).toEqual(expect.arrayContaining([['vmsName', 'ShiftWise'], ['isVms', 'true'], ['vms', 'Medefis']]));
    expect(['ShiftWise', 'Medefis']).toContain(r.vms.name);
  });
  it('shows plain-text VMS mentions with context', () => {
    const r = extractFromHtml(page('<p>This position is filled through our VMS partner, Example Connect.</p>'));
    expect(r.vms.fields).toEqual([]);
    expect(r.vms.mentions[0]).toContain('VMS partner, Example Connect');
  });
  it('reports nothing when the page has no VMS data', () => {
    expect(extractFromHtml(fixture('lower-cape-fear-lifecare.html')).vms).toEqual({ name: null, fields: [], mentions: [] });
  });
});
