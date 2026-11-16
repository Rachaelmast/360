import { Fragment, useEffect, useState } from 'react';
import { api, type Meta, type User } from '../api.ts';
import { Alert, DecisionBadge, Field, IdentityBadge, Loading, PriorityBadge, VerificationBadge, dash, fmtDate, fmtDateTime, go, loadMeta, loadUsers, useLoad } from '../ui.tsx';

type F = any; // shape is defined by getFacility() on the server

const TABS = ['Overview', 'Jobs', 'Business Development', 'Research', 'History'] as const;

export function Facility({ id, user }: { id: string; user: User }) {
  const { data, error, loading, reload } = useLoad<F>(() => api(`/api/facilities/${id}`), [id]);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => { loadMeta().then(setMeta).catch(() => {}); loadUsers().then(setUsers).catch(() => {}); }, []);

  if (loading && !data) return <Loading />;
  if (error) return <Alert kind="error">{error} <a href="#/leads">Back to leads</a></Alert>;
  const f = data;

  const patch = async (body: Record<string, unknown>, okText = 'Saved.') => {
    try { await api(`/api/facilities/${id}`, { method: 'PATCH', body }); setMsg({ kind: 'ok', text: okText }); reload(); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  };
  const act = async (fn: () => Promise<unknown>, okText: string) => {
    try { await fn(); setMsg({ kind: 'ok', text: okText }); reload(); } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  };
  const canMerge = user.role !== 'member';

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small"><a href="#/leads">Facility Leads</a> /</div>
          <h1>{f.name}</h1>
          <div className="row">
            <IdentityBadge s={f.identityStatus} /><VerificationBadge s={f.verificationStatus} /><PriorityBadge s={f.priority} manual={!!f.priorityOverride} />
            <span className="badge">{f.leadStatus}</span>
            {f.isExistingClient && <span className="badge b-violet">Existing client{f.existingClientOwner ? ` · ${f.existingClientOwner}` : ''}</span>}
            {f.vmsNames.length > 0 && <span className="badge b-blue">VMS: {f.vmsNames.join(', ')}</span>}
          </div>
        </div>
        <div className="muted small right">{[f.street, f.city, f.state, f.zip].filter(Boolean).join(', ') || 'No address on file'}<br />First discovered {fmtDate(f.firstDiscovered)}</div>
      </div>
      {f.isExistingClient && <Alert kind="warn">Existing SkyBridge client. Keep it out of new-business outreach; coordinate with the account owner.</Alert>}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <div className="tabs">{TABS.map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}{t === 'Jobs' ? ` (${f.jobs.length})` : ''}</button>)}</div>

      {tab === 'Overview' && <Overview f={f} meta={meta} onSave={(b) => patch(b, 'Facility updated.')} />}
      {tab === 'Jobs' && <Jobs f={f} meta={meta} onChange={() => { setMsg({ kind: 'ok', text: 'Job updated.' }); reload(); }} onError={(t) => setMsg({ kind: 'error', text: t })} />}
      {tab === 'Business Development' && <BizDev f={f} meta={meta} users={users} onSave={(b) => patch(b, 'Lead updated.')} onNote={(b) => act(() => api(`/api/facilities/${id}/activities`, { body: b }), 'Added.')} />}
      {tab === 'Research' && <Research f={f} meta={meta} canMerge={canMerge} onSave={(b) => patch(b, 'Research updated.')}
        onMerge={(mergeId) => act(() => api(`/api/facilities/${id}/merge`, { body: { mergeId } }), 'Merged. The other record now points here; you can undo below.')}
        onUndo={(mergeId) => act(() => api(`/api/merges/${mergeId}/undo`, { body: {} }), 'Merge undone.')} />}
      {tab === 'History' && <History f={f} />}
    </>
  );
}

function useForm<T extends Record<string, unknown>>(init: T) {
  const [v, setV] = useState(init);
  const bind = (k: keyof T) => ({ value: (v[k] as string) ?? '', onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });
  const diff = () => Object.fromEntries(Object.entries(v).filter(([k, x]) => (x ?? '') !== (init[k] ?? '')).map(([k, x]) => [k, x === '' ? null : x]));
  return { v, setV, bind, diff };
}

function Overview({ f, meta, onSave }: { f: F; meta: Meta | null; onSave: (b: Record<string, unknown>) => void }) {
  const form = useForm({ name: f.name, parentName: f.parentName ?? '', street: f.street ?? '', city: f.city ?? '', state: f.state ?? '', zip: f.zip ?? '', website: f.website ?? '', phone: f.phone ?? '', facilityType: f.facilityTypeManual ?? '', branchLabel: f.branchLabel ?? '', branchCode: f.branchCode ?? '' });
  return (
    <div className="grid g-side">
      <div className="card">
        <h2>Organization</h2>
        <div className="fields">
          <Field label="Facility name" full><input {...form.bind('name')} /></Field>
          <Field label="Parent organization"><input {...form.bind('parentName')} /></Field>
          <Field label={`Facility type (calculated: ${f.facilityType ?? 'none'})`}><input {...form.bind('facilityType')} placeholder="Leave blank to use the calculated type" /></Field>
          <Field label="Street" full><input {...form.bind('street')} /></Field>
          <Field label="City"><input {...form.bind('city')} /></Field>
          <Field label="State"><input {...form.bind('state')} /></Field>
          <Field label="ZIP"><input {...form.bind('zip')} /></Field>
          <Field label="Branch label"><input {...form.bind('branchLabel')} /></Field>
          <Field label="Official website"><input {...form.bind('website')} placeholder="https://" /></Field>
          <Field label="Public business phone"><input {...form.bind('phone')} /></Field>
          <Field label="Branch identifier"><input {...form.bind('branchCode')} /></Field>
        </div>
        <div className="row" style={{ marginTop: 12 }}><button className="primary" onClick={() => { const d = form.diff(); if (Object.keys(d).length) onSave(d); }}>Save changes</button><span className="muted small">Every change is recorded in History.</span></div>
      </div>
      <div className="card">
        <h2>Summary</h2>
        <dl className="kv">
          <dt>Care lines</dt><dd>{f.careLines.map((c: string) => meta?.careLines[c] ?? c).join(', ') || '—'}</dd>
          <dt>Specialties</dt><dd>{f.specialties.join(', ') || '—'}</dd>
          <dt>Relevant jobs</dt><dd>{f.jobCount}{f.reviewJobCount ? ` (${f.reviewJobCount} need review)` : ''}</dd>
          <dt>Last job seen</dt><dd>{fmtDate(f.lastJobObserved)}</dd>
          <dt>VMS</dt><dd>{f.vmsNames.join(', ') || '—'}</dd>
          <dt>Lead score</dt><dd>{f.score} → {f.computedPriority}</dd>
        </dl>
        <ul className="small" style={{ paddingLeft: 18, marginTop: 8 }}>{f.scoreReasons.map((r: { label: string; points: number }) => <li key={r.label}>{r.label} (+{r.points})</li>)}</ul>
        <p className="small muted">The score reflects hiring signals only. It is not evidence of a contract-staffing need.</p>
      </div>
    </div>
  );
}

function Jobs({ f, meta, onChange, onError }: { f: F; meta: Meta | null; onChange: () => void; onError: (t: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const update = async (jobId: string, body: Record<string, unknown>) => {
    try { await api(`/api/jobs/${jobId}`, { method: 'PATCH', body }); onChange(); } catch (e) { onError((e as Error).message); }
  };
  if (!f.jobs.length) return <div className="card empty">No job postings are linked to this facility.</div>;
  return (
    <div className="table-wrap" style={{ maxHeight: 'none' }}>
      <table>
        <thead><tr><th>Job title</th><th>Specialty</th><th>Classification</th><th>Location</th><th>Advertiser / VMS</th><th>First / last seen</th><th>Source</th></tr></thead>
        <tbody>
          {f.jobs.map((j: F) => (
            <Fragment key={j.id}>
              <tr>
                <td><b>{j.title}</b>{j.classification_manual && <div className="small muted">classification set manually</div>}</td>
                <td>{dash(j.specialty)}</td>
                <td>
                  <DecisionBadge s={j.classification} />
                  <div className="row" style={{ marginTop: 4, gap: 4 }}>
                    <select className="small" style={{ width: 'auto' }} value={j.classification} onChange={(e) => update(j.id, { decision: e.target.value })} aria-label="Decision">
                      <option value="accept">In scope</option><option value="review">Needs review</option><option value="exclude">Out of scope</option>
                    </select>
                    <select className="small" style={{ width: 'auto' }} value={j.care_line ?? ''} onChange={(e) => update(j.id, { careLine: e.target.value || null })} aria-label="Care line">
                      <option value="">—</option>{meta && Object.entries(meta.careLines).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                </td>
                <td>{[j.city, j.state].filter(Boolean).join(', ') || '—'}</td>
                <td className="small">{j.advertiser_name ? <>{j.advertiser_name}{j.advertiser_is_agency ? ' (agency)' : ''}</> : '—'}{j.vms_name && <div>VMS: {j.vms_name}</div>}</td>
                <td className="small nowrap">{fmtDate(j.first_seen_at)}<br />{fmtDate(j.last_seen_at)}</td>
                <td className="small"><a href={j.source_url} target="_blank" rel="noreferrer noopener">Vivian</a><br /><button className="link small" onClick={() => setOpen(open === j.id ? null : j.id)}>{open === j.id ? 'Hide' : 'Evidence'}</button></td>
              </tr>
              {open === j.id && (
                <tr><td colSpan={7} style={{ background: '#fafbfc' }}>
                  {(j.extractions ?? []).map((e: F) => (
                    <div key={e.id} className="small" style={{ marginBottom: 10 }}>
                      <div><b>{fmtDateTime(e.extracted_at)}</b> · {e.method.replace('_', ' ')} · <IdentityBadge s={e.identity_status} /> · field <code>{e.source_field ?? '—'}</code> · original value “{e.original_value ?? '—'}”</div>
                      {Object.keys(e.corrections ?? {}).length > 0 && <div>Corrected by user: {Object.entries(e.corrections).map(([k, v]: [string, F]) => `${k}: “${typeof v.from === 'object' ? JSON.stringify(v.from) : v.from ?? '—'}” → “${typeof v.to === 'object' ? JSON.stringify(v.to) : v.to ?? '—'}”`).join('; ')}</div>}
                      {(e.warnings ?? []).map((w: string) => <div key={w} className="muted">⚠ {w}</div>)}
                      {(e.errors ?? []).map((w: string) => <div key={w} style={{ color: 'var(--red)' }}>{w}</div>)}
                    </div>
                  ))}
                  <ul className="small muted" style={{ paddingLeft: 18 }}>{(j.classification_reasons ?? []).map((r: string) => <li key={r}>{r}</li>)}</ul>
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BizDev({ f, meta, users, onSave, onNote }: { f: F; meta: Meta | null; users: User[]; onSave: (b: Record<string, unknown>) => void; onNote: (b: Record<string, unknown>) => void }) {
  const form = useForm({ leadStatus: f.leadStatus, priorityOverride: f.priorityOverride ?? '', ownerId: f.ownerId ?? '', nextFollowUp: f.nextFollowUp ?? '', lastContactedAt: f.lastContactedAt ?? '', nextAction: f.nextAction ?? '', opportunityNotes: f.opportunityNotes ?? '', existingClientOwner: f.existingClientOwner ?? '', bullhornCompanyId: f.bullhornCompanyId ?? '' });
  const [note, setNote] = useState({ kind: 'note', body: '', contactDate: new Date().toISOString().slice(0, 10) });
  return (
    <div className="grid g2">
      <div className="card">
        <h2>Pipeline</h2>
        <div className="fields">
          <Field label="Lead status"><select {...form.bind('leadStatus')}>{meta?.leadStatuses.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label={`Priority (calculated: ${f.computedPriority})`}><select {...form.bind('priorityOverride')}><option value="">Use calculated</option>{meta?.priorities.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Assigned owner"><select {...form.bind('ownerId')}><option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          <Field label="Next follow-up"><input type="date" {...form.bind('nextFollowUp')} /></Field>
          <Field label="Last contacted"><input type="date" {...form.bind('lastContactedAt')} /></Field>
          <Field label="Bullhorn company ID"><input {...form.bind('bullhornCompanyId')} placeholder="Manual until Bullhorn is connected" /></Field>
          <Field label="Next action" full><input {...form.bind('nextAction')} /></Field>
          <Field label="Opportunity notes" full><textarea rows={4} {...form.bind('opportunityNotes')} /></Field>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <label className="row small" style={{ gap: 6 }}><input type="checkbox" style={{ width: 'auto' }} checked={f.isExistingClient} onChange={(e) => onSave({ isExistingClient: e.target.checked })} /> Existing SkyBridge client</label>
          {f.isExistingClient && <input style={{ width: 200 }} placeholder="Account owner" {...form.bind('existingClientOwner')} />}
        </div>
        <button className="primary" style={{ marginTop: 12 }} onClick={() => { const d = form.diff(); if (Object.keys(d).length) onSave(d); }}>Save</button>
      </div>
      <div className="card">
        <h2>Outreach and notes</h2>
        <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          <select style={{ width: 130 }} value={note.kind} onChange={(e) => setNote({ ...note, kind: e.target.value })}><option value="note">Note</option><option value="contact">Contact</option><option value="comment">Comment</option></select>
          {note.kind === 'contact' && <input type="date" style={{ width: 150 }} value={note.contactDate} onChange={(e) => setNote({ ...note, contactDate: e.target.value })} aria-label="Contact date" />}
        </div>
        <textarea rows={3} style={{ marginTop: 8 }} value={note.body} onChange={(e) => setNote({ ...note, body: e.target.value })} placeholder={note.kind === 'contact' ? 'Who you reached and what was said' : 'Internal note'} />
        <button style={{ marginTop: 8 }} disabled={!note.body.trim()} onClick={() => { onNote({ kind: note.kind, body: note.body, contactDate: note.kind === 'contact' ? note.contactDate : null }); setNote({ ...note, body: '' }); }}>Add</button>
        <ul className="timeline" style={{ marginTop: 12 }}>
          {f.activities.length === 0 && <li className="muted">No activity yet.</li>}
          {f.activities.map((a: F) => (
            <li key={a.id}><div className="small muted">{fmtDateTime(a.created_at)} · {a.user_name ?? 'system'} · {a.kind.replace('_', ' ')}{a.contact_date ? ` on ${fmtDate(a.contact_date)}` : ''}</div><div style={{ whiteSpace: 'pre-wrap' }}>{a.body}</div></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Research({ f, meta, canMerge, onSave, onMerge, onUndo }: { f: F; meta: Meta | null; canMerge: boolean; onSave: (b: Record<string, unknown>) => void; onMerge: (id: string) => void; onUndo: (id: string) => void }) {
  const q = encodeURIComponent([f.name, f.city, f.state].filter(Boolean).join(' '));
  return (
    <div className="grid g2">
      <div className="card stack">
        <h2>Verification</h2>
        <Field label="Verification status">
          <select value={f.verificationStatus} onChange={(e) => onSave({ verificationStatus: e.target.value })}>
            {meta?.verificationStatuses.map((s) => <option key={s} value={s}>{meta.verificationLabels[s]}</option>)}
          </select>
        </Field>
        <p className="small muted">Record the website or phone on the Overview tab only after confirming it on the organization's official site or a licensing source. Add the source as a note.</p>
        <div className="row small">
          <a className="btn small-btn" href={`https://www.google.com/search?q=${q}`} target="_blank" rel="noreferrer noopener">Search the web</a>
          <a className="btn small-btn" href="https://www.medicare.gov/care-compare/" target="_blank" rel="noreferrer noopener">Medicare Care Compare</a>
        </div>
        <h3 style={{ marginTop: 12 }}>Other branches of {f.parentName ?? 'this parent'}</h3>
        {f.branches.length ? <ul className="small">{f.branches.map((b: F) => <li key={b.id}><a href={`#/facility/${b.id}`}>{b.name}</a> · {[b.city, b.state].filter(Boolean).join(', ')}</li>)}</ul> : <p className="small muted">{f.parentName ? 'No other branches saved.' : 'Set a parent organization on the Overview tab to group branches.'}</p>}
      </div>
      <div className="card stack">
        <h2>Possible duplicates and related records</h2>
        {f.possibleDuplicates.length === 0 && <p className="muted small">None found.</p>}
        {f.possibleDuplicates.map((m: F) => (
          <div key={m.facility.id} className="match">
            <div style={{ flex: 1 }}>
              <div><a href={`#/facility/${m.facility.id}`}><b>{m.facility.name}</b></a> <span className="badge">{m.strength}</span></div>
              <div className="small muted">{[m.facility.street, m.facility.city, m.facility.state].filter(Boolean).join(', ')} · {m.facility.jobCount} jobs</div>
              <div className="small">{m.reasons.join(' ')}</div>
            </div>
            {canMerge && m.strength !== 'related' && <button className="small" onClick={() => { if (confirm(`Merge "${m.facility.name}" into this record? Its jobs and notes move here. You can undo this.`)) onMerge(m.facility.id); }}>Merge into this</button>}
          </div>
        ))}
        {!canMerge && <p className="small muted">Merging requires the manager role.</p>}
        <h3 style={{ marginTop: 12 }}>Merge history</h3>
        {f.merges.length === 0 ? <p className="small muted">No merges.</p> : (
          <ul className="small">{f.merges.map((m: F) => <li key={m.id}>{fmtDateTime(m.created_at)} · merged “{m.merged_name}” by {m.user_name ?? '—'} {m.undone_at ? <span className="muted">(undone {fmtDate(m.undone_at)})</span> : canMerge && <button className="link small" onClick={() => onUndo(m.id)}>Undo</button>}</li>)}</ul>
        )}
      </div>
    </div>
  );
}

function History({ f }: { f: F }) {
  return (
    <div className="card">
      <h2>Audit trail</h2>
      <ul className="timeline">
        {f.audit.map((a: F) => (
          <li key={a.id} className="small">
            <span className="muted">{fmtDateTime(a.created_at)} · {a.user_name ?? 'system'}</span> · <b>{a.action.replace(/_/g, ' ')}</b> {a.entity === 'job_posting' ? '(job)' : ''}
            {a.changes && Object.keys(a.changes).length > 0 && <div className="mono muted" style={{ whiteSpace: 'pre-wrap' }}>{Object.entries(a.changes).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}</div>}
          </li>
        ))}
      </ul>
      <button className="link small" onClick={() => go('leads')}>Back to leads</button>
    </div>
  );
}
