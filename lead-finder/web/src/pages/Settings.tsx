import { useState } from 'react';
import { api, type User } from '../api.ts';
import { Alert, Field, fmtDateTime, loadUsers, useLoad } from '../ui.tsx';

export function SettingsPage({ user }: { user: User }) {
  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><p>Browser extension access{user.role === 'admin' ? ', team members, specialty taxonomy and lead scoring' : ''}.</p></div></div>
      <Tokens />
      {user.role === 'admin' && <><Users me={user} /><Taxonomy /><Scoring /></>}
    </>
  );
}

function Tokens() {
  const { data, reload } = useLoad<any[]>(() => api('/api/tokens'), []);
  const [label, setLabel] = useState('Chrome');
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="card">
      <h2>Browser extension</h2>
      <p className="small">Create a personal access token, then paste it with this server's address into the extension's options page. Tokens act as you; revoke any you no longer use.</p>
      <p className="small">Server address for the extension: <code>{window.location.origin}</code></p>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input style={{ maxWidth: 260 }} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Token label" />
        <button className="primary" disabled={!label.trim()} onClick={async () => { setErr(null); try { setToken((await api<{ token: string }>('/api/tokens', { body: { label } })).token); reload(); } catch (e) { setErr((e as Error).message); } }}>Create token</button>
      </div>
      {err && <Alert kind="error">{err}</Alert>}
      {token && <Alert kind="ok">Copy this token now; it is shown only once.<div className="mono" style={{ wordBreak: 'break-all', marginTop: 6 }}>{token}</div><button className="small" style={{ marginTop: 6 }} onClick={() => navigator.clipboard?.writeText(token)}>Copy</button></Alert>}
      {data?.length ? (
        <table style={{ marginTop: 10 }}><thead><tr><th>Label</th><th>Created</th><th>Last used</th><th /></tr></thead>
          <tbody>{data.map((t) => <tr key={t.id}><td>{t.label}</td><td>{fmtDateTime(t.created_at)}</td><td>{fmtDateTime(t.last_used_at)}</td><td className="right"><button className="small danger" onClick={async () => { await api(`/api/tokens/${t.id}`, { method: 'DELETE' }); reload(); }}>Revoke</button></td></tr>)}</tbody>
        </table>
      ) : null}
    </div>
  );
}

function Users({ me }: { me: User }) {
  const { data, reload } = useLoad<(User & { active: boolean })[]>(() => api('/api/users'), []);
  const [n, setN] = useState({ name: '', email: '', role: 'member', password: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setMsg({ kind: 'ok', text: ok }); loadUsers(true); reload(); } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); } };
  return (
    <div className="card">
      <h2>Team members</h2>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
        <tbody>{data?.map((u) => (
          <tr key={u.id}>
            <td>{u.name}</td><td>{u.email}</td>
            <td><select style={{ width: 'auto' }} value={u.role} disabled={u.id === me.id} onChange={(e) => run(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated.')}><option value="member">Member</option><option value="manager">Manager</option><option value="admin">Admin</option></select></td>
            <td>{u.id === me.id ? 'You' : <button className="small" onClick={() => run(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }), u.active ? 'Deactivated.' : 'Reactivated.')}>{u.active ? 'Deactivate' : 'Reactivate'}</button>}</td>
          </tr>
        ))}</tbody>
      </table>
      <h3 style={{ marginTop: 14 }}>Add a team member</h3>
      <div className="fields-4">
        <Field label="Name"><input value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} /></Field>
        <Field label="Email"><input type="email" value={n.email} onChange={(e) => setN({ ...n, email: e.target.value })} /></Field>
        <Field label="Role"><select value={n.role} onChange={(e) => setN({ ...n, role: e.target.value })}><option value="member">Member</option><option value="manager">Manager</option><option value="admin">Admin</option></select></Field>
        <Field label="Temporary password (10+ chars)"><input type="password" autoComplete="new-password" value={n.password} onChange={(e) => setN({ ...n, password: e.target.value })} /></Field>
      </div>
      <button style={{ marginTop: 10 }} disabled={!n.name || !n.email || n.password.length < 10} onClick={() => run(async () => { await api('/api/users', { body: n }); setN({ name: '', email: '', role: 'member', password: '' }); }, 'User added.')}>Add user</button>
      <p className="small muted">Members save and work leads. Managers can also merge facilities. Admins manage users and settings.</p>
    </div>
  );
}

function Taxonomy() {
  const { data, reload } = useLoad<any>(() => api('/api/settings'), []);
  const [text, setText] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  if (!data) return null;
  const value = text ?? JSON.stringify(data.taxonomy, null, 2);
  const save = async (body: unknown) => {
    try { await api('/api/settings/taxonomy', { method: 'PUT', body }); setMsg({ kind: 'ok', text: 'Taxonomy saved. New extractions use it immediately.' }); setText(null); reload(); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  };
  return (
    <div className="card">
      <h2>Specialty taxonomy</h2>
      <p className="small">Regular-expression patterns (case-insensitive) matched against job titles. Add title variations under <code>careLines</code>, non-target settings under <code>excluded</code>, staffing agency names under <code>knownStaffingAgencies</code>.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <textarea rows={16} className="mono" value={value} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={() => { try { save(JSON.parse(value)); } catch { setMsg({ kind: 'error', text: 'That is not valid JSON.' }); } }}>Save taxonomy</button>
        <button onClick={() => { if (confirm('Replace the taxonomy with the built-in defaults?')) save(data.taxonomyDefault); }}>Reset to defaults</button>
      </div>
    </div>
  );
}

const WEIGHT_LABELS: Record<string, string> = {
  verifiedIdentity: 'Verified facility identity', targetSpecialty: 'Confirmed target specialty', rnOpening: 'RN or RN Case Manager opening', lpnOpening: 'LPN/LVN opening',
  multipleOpenings: 'Multiple distinct relevant openings', recentPosting: 'Recently observed posting', multipleBranches: 'Multiple hiring branches',
  recentDays: '“Recent” means within (days)', highAt: 'High priority at score ≥', mediumAt: 'Medium priority at score ≥',
};

function Scoring() {
  const { data, reload } = useLoad<any>(() => api('/api/settings'), []);
  const [w, setW] = useState<Record<string, number> | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  if (!data) return null;
  const vals = w ?? data.weights;
  return (
    <div className="card">
      <h2>Lead scoring</h2>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="fields">
        {Object.keys(WEIGHT_LABELS).map((k) => <Field key={k} label={WEIGHT_LABELS[k]}><input type="number" min={0} max={1000} value={vals[k]} onChange={(e) => setW({ ...vals, [k]: Number(e.target.value) })} /></Field>)}
      </div>
      <button className="primary" style={{ marginTop: 10 }} onClick={async () => { try { await api('/api/settings/scoring', { method: 'PUT', body: vals }); setMsg({ kind: 'ok', text: 'Scoring saved.' }); setW(null); reload(); } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); } }}>Save scoring</button>
      <p className="small muted" style={{ marginTop: 8 }}>Facilities whose identity is not confirmed or verified are always “Needs Research”, whatever the score.</p>
    </div>
  );
}
