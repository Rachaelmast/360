import { useEffect, useMemo, useState } from 'react';
import { classifyJob, type Taxonomy } from '../../../src/core/index.ts';
import { api, type ExtractResponse, type ExistingJob } from '../api.ts';
import { Alert, DecisionBadge, Field, IdentityBadge, fmtDateTime, go, loadMeta, type Route } from '../ui.tsx';

type Mode = 'url' | 'paste';
type UrlOutcome = { url: string; existingJob: ExistingJob | null; skipped?: boolean; fetch?: { kind: string; status: number | null; message?: string } } & Partial<ExtractResponse>;

let taxonomyPromise: Promise<Taxonomy> | null = null;
const loadTaxonomy = () => (taxonomyPromise ??= api<{ taxonomy: Taxonomy }>('/api/settings').then((s) => s.taxonomy));

export function FindFacility({ route }: { route: Route }) {
  const [mode, setMode] = useState<Mode>((route.query.get('mode') as Mode) || 'url');
  const [url, setUrl] = useState(route.query.get('url') ?? '');
  const [html, setHtml] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<UrlOutcome | null>(null);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [extractedAt, setExtractedAt] = useState<Date | null>(null);
  const [method, setMethod] = useState('');

  // open an extraction created elsewhere (batch import)
  const extractionParam = route.query.get('extraction');
  useEffect(() => {
    if (!extractionParam) return;
    setBusy(true);
    api<ExtractResponse>(`/api/extractions/${extractionParam}`)
      .then((r) => { setResult(r); setUrl(r.url ?? ''); setExtractedAt(new Date()); setMethod('batch server fetch'); })
      .catch((e) => setError(e.message)).finally(() => setBusy(false));
  }, [extractionParam]);

  const reset = () => { setError(null); setNotice(null); setResult(null); };

  async function findByUrl(force = false) {
    reset(); setBusy(true);
    try {
      const r = await api<UrlOutcome>('/api/extract/url', { body: { url, force } });
      if (r.result) { setResult(r as ExtractResponse); setExtractedAt(new Date()); setMethod('server fetch'); }
      else setNotice(r);
      if (r.url) setUrl(r.url);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function extractPaste() {
    reset(); setBusy(true);
    try {
      const r = await api<ExtractResponse>('/api/extract/html', { body: { html, url: url || null, method: 'paste' } });
      setResult(r); setExtractedAt(new Date()); setMethod('pasted page source');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Find Facility</h1>
          <p>Identify the organization behind a Vivian job posting, check it, and save it as a lead.</p>
        </div>
      </div>

      <div className="card">
        <div className="tabs" role="tablist">
          <button className={mode === 'url' ? 'on' : ''} onClick={() => setMode('url')}>Job URL</button>
          <button className={mode === 'paste' ? 'on' : ''} onClick={() => setMode('paste')}>Paste page source</button>
        </div>
        <Field label="Vivian job URL">
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.vivian.com/job/145-1448402/" onKeyDown={(e) => { if (e.key === 'Enter' && mode === 'url' && url) findByUrl(); }} />
            {mode === 'url' && <button className="primary nowrap" disabled={!url || busy} onClick={() => findByUrl()}>{busy ? 'Working…' : 'Find Facility'}</button>}
          </div>
        </Field>
        {mode === 'paste' && (
          <div className="stack" style={{ marginTop: 10 }}>
            <Field label="Page source">
              <textarea rows={8} className="mono" value={html} onChange={(e) => setHtml(e.target.value)} placeholder="On the job page press Ctrl+U, then Ctrl+A and Ctrl+C in the source tab, and paste here." />
            </Field>
            <div className="spread">
              <span className="muted small">{html ? `${(html.length / 1024).toFixed(0)} KB pasted` : 'The URL above is used as the source link for this job.'}</span>
              <button className="primary" disabled={!html.trim() || busy} onClick={extractPaste}>{busy ? 'Working…' : 'Find Facility'}</button>
            </div>
          </div>
        )}
      </div>

      {error && <div style={{ marginTop: 14 }}><Alert kind="error">{error}</Alert></div>}

      {notice?.skipped && notice.existingJob && (
        <div style={{ marginTop: 14 }}>
          <Alert kind="info">
            This job is already saved{notice.existingJob.facility_name ? <> under <b>{notice.existingJob.facility_name}</b></> : null} (first seen {fmtDateTime(notice.existingJob.first_seen_at)}).{' '}
            {notice.existingJob.facility_id && <a href={`#/facility/${notice.existingJob.facility_id}`}>Open the facility record</a>}{' · '}
            <button className="link" onClick={() => findByUrl(true)}>Look it up again anyway</button>
          </Alert>
        </div>
      )}
      {notice?.fetch && notice.fetch.kind !== 'ok' && (
        <div style={{ marginTop: 14 }}>
          <Alert kind="warn">
            <b>{notice.fetch.kind === 'blocked' ? 'Vivian did not let the server read this page.' : 'The page could not be retrieved.'}</b>
            <div>{notice.fetch.message}</div>
            {notice.fetch.kind === 'blocked' && (
              <ul>
                <li>With the <b>SkyBridge browser extension</b>: open the job in Chrome or Edge, click the extension, then click <i>Save Lead</i>.</li>
                <li>Or <button className="link" onClick={() => setMode('paste')}>paste the page source</button>: on the job page press <b>Ctrl+U</b>, then <b>Ctrl+A</b>, <b>Ctrl+C</b>, and paste it here.</li>
              </ul>
            )}
          </Alert>
        </div>
      )}

      {result && (
        <ReviewPanel
          key={result.extractionId}
          data={result}
          sourceUrl={url}
          extractedAt={extractedAt}
          method={method}
          onSaved={() => { setHtml(''); }}
        />
      )}
    </>
  );
}

const ROLES = ['', 'Case Manager', 'Admissions', 'On-Call', 'Triage', 'After-Hours', 'Weekend', 'Visit'];

export function ReviewPanel({ data, sourceUrl, extractedAt, method, onSaved }: { data: ExtractResponse; sourceUrl: string; extractedAt: Date | null; method: string; onSaved?: () => void }) {
  const r = data.result;
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const [careLabels, setCareLabels] = useState<Record<string, string>>({});
  useEffect(() => { loadTaxonomy().then(setTaxonomy).catch(() => {}); loadMeta().then((m) => setCareLabels(m.careLines)).catch(() => {}); }, []);

  const [f, setF] = useState({
    name: r.facility.name ?? '', street: r.facility.address.street ?? '', city: r.facility.address.city ?? '', state: r.facility.address.state ?? '', zip: r.facility.address.zip ?? '',
    parentName: '', website: '', phone: '',
  });
  const [j, setJ] = useState({ title: r.job.title ?? '', city: r.job.city ?? '', state: r.job.state ?? '', employmentType: r.job.employmentType ?? '' });
  const [url, setUrl] = useState(data.url ?? sourceUrl ?? '');
  const firstAuto = data.matches.find((m) => m.strength === 'exact') ?? (data.matches.filter((m) => m.strength === 'likely').length === 1 ? data.matches.find((m) => m.strength === 'likely') : undefined);
  const [choice, setChoice] = useState<string>(firstAuto?.facility.id ?? 'new');
  const [override, setOverride] = useState<null | { decision: 'accept' | 'review' | 'exclude'; careLine: string | null; license: string | null; role: string | null }>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ facilityId: string | null; existingJob: boolean; facilityCreated: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const auto = useMemo(() => (taxonomy && j.title !== (r.job.title ?? '') ? classifyJob({ title: j.title, context: [r.job.specialtyHint, f.name].filter(Boolean).join(' ') }, taxonomy) : r.classification), [taxonomy, j.title, f.name, r]);
  const cls = override ?? { decision: auto.decision, careLine: auto.careLine, license: auto.license, role: auto.role };
  const setCls = (patch: Partial<typeof cls>) => setOverride({ ...cls, ...patch });

  const changed = (a: string | null | undefined, b: string) => (a ?? '') !== b;
  const corrected = [
    changed(r.facility.name, f.name) && 'facility name', changed(r.facility.address.street, f.street) && 'street', changed(r.facility.address.city, f.city) && 'city',
    changed(r.facility.address.state, f.state) && 'state', changed(r.facility.address.zip, f.zip) && 'ZIP', changed(r.job.title, j.title) && 'job title', override && 'classification',
  ].filter(Boolean) as string[];

  async function save() {
    setSaving(true); setErr(null);
    try {
      const res = await api('/api/leads', {
        body: {
          extractionId: data.extractionId, sourceUrl: url, facilityChoice: choice,
          facility: f, job: j,
          classification: override ? { ...override, careLine: override.careLine || null, license: override.license || null, role: override.role || null } : undefined,
        },
      });
      setSaved(res); onSaved?.();
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  }

  const tierLabel: Record<string, string> = { facility: 'Facility field', organization: 'Organization field', agency: 'Agency field' };
  const assessLabel: Record<string, string> = { specific: 'Specific name', weak: 'Mostly generic', generic: 'Generic', staffing_agency: 'Staffing agency' };

  return (
    <div className="grid g-side" style={{ marginTop: 14 }}>
      <div className="stack">
        <div className="card">
          <div className="spread" style={{ marginBottom: 10 }}>
            <div className="row"><IdentityBadge s={r.status} /><DecisionBadge s={cls.decision} />{auto.specialty && <span className="badge">{override ? 'Manual: ' : ''}{override ? (cls.careLine ? `${careLabels[cls.careLine] ?? cls.careLine} ${cls.license ?? 'Nurse'}${cls.role ? ` ${cls.role}` : ''}` : 'No specialty') : auto.specialty}</span>}</div>
            {r.facility.sourceField && <span className="muted small">Facility from <code>{r.facility.sourceField}</code></span>}
          </div>
          {r.errors.length > 0 && <Alert kind="error"><ul>{r.errors.map((e) => <li key={e}>{e}</li>)}</ul></Alert>}
          {r.warnings.length > 0 && <Alert kind="warn"><ul>{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul></Alert>}
          {data.existingJob && <Alert kind="info">This job URL is already saved{data.existingJob.facility_name ? ` under ${data.existingJob.facility_name}` : ''}. Saving again only records that it was seen again. {data.existingJob.facility_id && <a href={`#/facility/${data.existingJob.facility_id}`}>Open record</a>}</Alert>}
          {r.advertiser && (
            <Alert kind={r.advertiser.looksLikeStaffingAgency ? 'info' : 'warn'}>
              Advertised by <b>{r.advertiser.name}</b> (<code>{r.advertiser.sourceField}</code>){r.advertiser.looksLikeStaffingAgency ? ', which looks like a staffing agency. It is kept separate from the facility.' : '. This organization name differs from the facility name. Check which is the end client.'}
            </Alert>
          )}

          {(r.vms.fields.length > 0 || r.vms.mentions.length > 0) && (
            <Alert kind="info">
              <b>VMS{r.vms.name ? `: ${r.vms.name}` : ' mentioned on this page'}</b>
              <ul>
                {r.vms.fields.map((x) => <li key={x.field + x.value}><code>{x.field}</code> = {x.value}</li>)}
                {r.vms.mentions.map((x) => <li key={x}>“…{x}…”</li>)}
              </ul>
            </Alert>
          )}

          <h3>Facility</h3>
          <div className="fields">
            <Field label="Facility name *" full><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={r.status === 'not_found' || r.status === 'generic' || r.status === 'agency_only' ? 'Not identified on the page. Enter it only if you have verified it.' : ''} /></Field>
            <Field label="Street address" full><input value={f.street} onChange={(e) => setF({ ...f, street: e.target.value })} /></Field>
          </div>
          <div className="fields-4" style={{ marginTop: 10 }}>
            <Field label="City"><input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
            <Field label="State"><input value={f.state} maxLength={20} onChange={(e) => setF({ ...f, state: e.target.value })} /></Field>
            <Field label="ZIP"><input value={f.zip} onChange={(e) => setF({ ...f, zip: e.target.value })} /></Field>
            <span />
          </div>
          <div className="fields" style={{ marginTop: 10 }}>
            <Field label="Parent organization">
              <input value={f.parentName} onChange={(e) => setF({ ...f, parentName: e.target.value })} />
              {r.facility.systemName && !f.parentName && <button className="link small" onClick={() => setF({ ...f, parentName: r.facility.systemName! })}>Use “{r.facility.systemName}” from the page</button>}
            </Field>
            <Field label="Official website"><input value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} placeholder="Only if verified" /></Field>
          </div>

          <h3 style={{ marginTop: 16 }}>Job</h3>
          <div className="fields">
            <Field label="Job title *" full><input value={j.title} onChange={(e) => setJ({ ...j, title: e.target.value })} /></Field>
            <Field label="Job city"><input value={j.city} onChange={(e) => setJ({ ...j, city: e.target.value })} /></Field>
            <Field label="Job state"><input value={j.state} onChange={(e) => setJ({ ...j, state: e.target.value })} /></Field>
            <Field label="Employment type"><input value={j.employmentType} onChange={(e) => setJ({ ...j, employmentType: e.target.value })} /></Field>
            <Field label="Source URL *"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.vivian.com/job/..." /></Field>
          </div>

          <h3 style={{ marginTop: 16 }}>Specialty classification</h3>
          <div className="fields-4">
            <Field label="Decision">
              <select value={cls.decision} onChange={(e) => setCls({ decision: e.target.value as 'accept' })}>
                <option value="accept">In scope</option><option value="review">Needs review</option><option value="exclude">Out of scope</option>
              </select>
            </Field>
            <Field label="Care line">
              <select value={cls.careLine ?? ''} onChange={(e) => setCls({ careLine: e.target.value || null })}>
                <option value="">—</option>{Object.entries(careLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="License">
              <select value={cls.license ?? ''} onChange={(e) => setCls({ license: e.target.value || null })}>
                <option value="">Not stated</option>{['RN', 'LPN', 'LVN', 'LPN/LVN'].map((x) => <option key={x}>{x}</option>)}
              </select>
            </Field>
            <Field label="Role">
              <select value={cls.role ?? ''} onChange={(e) => setCls({ role: e.target.value || null })}>
                {ROLES.map((x) => <option key={x} value={x}>{x || 'Staff nurse'}</option>)}
              </select>
            </Field>
          </div>
          <ul className="small muted" style={{ margin: '8px 0 0', paddingLeft: 18 }}>{auto.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
          {override && <button className="link small" onClick={() => setOverride(null)}>Reset to automatic classification</button>}
        </div>

        <div className="card">
          <h2>Extraction evidence</h2>
          <dl className="kv small" style={{ marginBottom: 10 }}>
            <dt>Source URL</dt><dd>{url ? <a href={url} target="_blank" rel="noreferrer noopener">{url}</a> : <span className="muted">Not provided</span>}</dd>
            <dt>Extracted</dt><dd>{fmtDateTime(extractedAt)} via {method}</dd>
            <dt>Facility field</dt><dd>{r.facility.sourceField ? <><code>{r.facility.sourceField}</code> at <code>{r.facility.sourcePath}</code></> : '—'}</dd>
            <dt>Original value</dt><dd>{r.facility.name ?? '—'}</dd>
            <dt>Address fields</dt><dd>{r.facility.addressSourceFields.length ? r.facility.addressSourceFields.map((x) => <code key={x} style={{ marginRight: 6 }}>{x}</code>) : '—'}</dd>
            <dt>Job title from</dt><dd>{r.job.titleSource ?? '—'}</dd>
            {r.job.specialtyHint && <><dt>Page specialty</dt><dd>{r.job.specialtyHint}</dd></>}
            <dt>Extraction ID</dt><dd className="mono">{data.extractionId}</dd>
          </dl>
          {r.evidence.length ? (
            <div style={{ overflowX: 'auto' }}>
              <table className="evidence">
                <thead><tr><th>Field</th><th>Value</th><th>Judged as</th><th>Where</th></tr></thead>
                <tbody>
                  {r.evidence.map((e, i) => (
                    <tr key={i}>
                      <td><code>{e.field}</code>{e.tier && <div className="muted">{tierLabel[e.tier]}</div>}</td>
                      <td>{e.value}</td>
                      <td>{e.assessment ? assessLabel[e.assessment] : '—'}</td>
                      <td className="muted"><code>{e.path}</code> · {e.method}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="muted">No organization or job fields were found on the page.</p>}
        </div>
      </div>

      <div className="stack" style={{ position: 'sticky', top: 16 }}>
        <div className="card">
          <h2>Save as lead</h2>
          {data.matches.length > 0 ? (
            <>
              <p className="small muted">Similar facilities already in the database. Choose one to add this job to it, or create a new facility. Similar names are never merged automatically.</p>
              <div className="stack">
                {data.matches.map((m) => (
                  <label key={m.facility.id} className={`match ${choice === m.facility.id ? 'sel' : ''}`}>
                    <input type="radio" name="fac" checked={choice === m.facility.id} onChange={() => setChoice(m.facility.id)} />
                    <div>
                      <div><b>{m.facility.name}</b> <span className={`badge ${m.strength === 'exact' ? 'b-green' : m.strength === 'likely' ? 'b-blue' : 'b-amber'}`}>{m.strength}</span></div>
                      <div className="small muted">{[m.facility.street, m.facility.city, m.facility.state].filter(Boolean).join(', ') || 'No address'} · {m.facility.jobCount} job{m.facility.jobCount === 1 ? '' : 's'}</div>
                      <div className="small">{m.reasons.join(' ')}</div>
                    </div>
                  </label>
                ))}
                <label className={`match ${choice === 'new' ? 'sel' : ''}`}>
                  <input type="radio" name="fac" checked={choice === 'new'} onChange={() => setChoice('new')} />
                  <div><b>Create a new facility</b><div className="small muted">Use for a separate branch or a different organization.</div></div>
                </label>
              </div>
            </>
          ) : <p className="small muted">No matching facility in the database. A new facility record will be created.</p>}
          {corrected.length > 0 && <p className="small" style={{ marginTop: 10 }}>You changed: {corrected.join(', ')}. The original extracted values are kept with the record.</p>}
          {cls.decision === 'exclude' && <Alert kind="warn">Out-of-scope jobs are not saved. Change the decision if the classification is wrong.</Alert>}
          {err && <Alert kind="error">{err}</Alert>}
          {saved ? (
            <Alert kind="ok">
              {saved.existingJob ? 'This job was already saved; the new observation was recorded.' : saved.facilityCreated ? 'Saved. A new facility lead was created.' : 'Saved. The job was added to the existing facility.'}{' '}
              {saved.facilityId && <a href={`#/facility/${saved.facilityId}`}>Open facility</a>}
              <div style={{ marginTop: 6 }}><button className="small" onClick={() => go('find')}>Find another</button></div>
            </Alert>
          ) : (
            <button className="primary" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }} disabled={saving || !f.name.trim() || !j.title.trim() || !url.trim() || cls.decision === 'exclude'} onClick={save}>
              {saving ? 'Saving…' : 'Save Lead'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
