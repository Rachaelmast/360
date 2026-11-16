import { useEffect, useMemo, useState } from 'react';
import { api, qs, type Meta, type User } from '../api.ts';
import { Alert, Loading, PriorityBadge, VerificationBadge, fmtDate, go, loadMeta, loadUsers, useLoad, type Route } from '../ui.tsx';

interface Row {
  id: string; name: string; parentName: string | null; city: string | null; state: string | null; facilityType: string | null; specialties: string[];
  jobCount: number; reviewJobCount: number; lastJobObserved: string | null; priority: string; priorityOverride: string | null; score: number;
  leadStatus: string; ownerName: string | null; verificationStatus: string; isExistingClient: boolean; nextFollowUp: string | null; sourceUrls: string[];
  scoreReasons: { label: string; points: number }[];
}

const FILTER_KEYS = ['q', 'state', 'city', 'careLine', 'specialty', 'license', 'status', 'priority', 'owner', 'verification', 'discoveredFrom', 'discoveredTo', 'classification', 'existingClient'] as const;
type Filters = Partial<Record<(typeof FILTER_KEYS)[number], string>>;

const COLUMNS: [string, string][] = [
  ['name', 'Facility'], ['parentName', 'Parent company'], ['city', 'City'], ['state', 'State'], ['facilityType', 'Facility type'], ['specialties', 'Specialty'],
  ['jobCount', 'Jobs'], ['lastJobObserved', 'Last job observed'], ['priority', 'Priority'], ['leadStatus', 'Lead status'], ['ownerName', 'Owner'],
];

export function Leads({ route }: { route: Route }) {
  const initial: Filters = {};
  for (const k of FILTER_KEYS) { const v = route.query.get(k); if (v) initial[k] = v; }
  const [filters, setFilters] = useState<Filters>(initial);
  const [q, setQ] = useState(initial.q ?? '');
  const [sort, setSort] = useState({ key: route.query.get('sort') ?? 'lastJobObserved', dir: (route.query.get('dir') as 'asc' | 'desc') ?? 'desc' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<Meta | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [bulk, setBulk] = useState({ leadStatus: '', ownerId: '', priorityOverride: '' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [more, setMore] = useState(Object.keys(initial).some((k) => !['q', 'state', 'careLine', 'status', 'priority', 'owner'].includes(k)));

  useEffect(() => { loadMeta().then(setMeta).catch(() => {}); loadUsers().then(setUsers).catch(() => {}); }, []);
  useEffect(() => { const t = setTimeout(() => setFilters((f) => ({ ...f, q: q || undefined })), 250); return () => clearTimeout(t); }, [q]);

  const query = useMemo(() => qs({ ...filters, sort: sort.key, dir: sort.dir, limit: 1000 }), [filters, sort]);
  const { data, error, loading, reload } = useLoad(() => api<{ total: number; rows: Row[]; facets: { states: string[]; cities: string[] } }>(`/api/facilities${query}`), [query]);

  const set = (k: keyof Filters, v: string) => setFilters((f) => ({ ...f, [k]: v || undefined }));
  const sortBy = (key: string) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));
  const rows = data?.rows ?? [];
  const allSel = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const active = Object.values(filters).filter(Boolean).length;

  async function applyBulk() {
    const patch: Record<string, unknown> = {};
    if (bulk.leadStatus) patch.leadStatus = bulk.leadStatus;
    if (bulk.ownerId) patch.ownerId = bulk.ownerId === 'none' ? null : bulk.ownerId;
    if (bulk.priorityOverride) patch.priorityOverride = bulk.priorityOverride === 'auto' ? null : bulk.priorityOverride;
    if (!Object.keys(patch).length) return;
    try {
      const r = await api<{ updated: number }>('/api/facilities/bulk', { body: { ids: [...selected], patch } });
      setMsg({ kind: 'ok', text: `Updated ${r.updated} facilit${r.updated === 1 ? 'y' : 'ies'}.` });
      setSelected(new Set()); setBulk({ leadStatus: '', ownerId: '', priorityOverride: '' }); reload();
    } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Facility Leads</h1><p>{data ? `${data.total} facilit${data.total === 1 ? 'y' : 'ies'}${active ? ' match the filters' : ''}` : ' '}</p></div>
        <div className="row">
          <a className="btn" href={`/api/export.csv${qs({ ...filters, sort: sort.key, dir: sort.dir })}`}>Export CSV (Excel)</a>
          <button className="primary" onClick={() => go('find')}>Find Facility</button>
        </div>
      </div>

      <div className="filters">
        <input placeholder="Search facility, parent, city, job title…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select value={filters.state ?? ''} onChange={(e) => set('state', e.target.value)} aria-label="State"><option value="">All states</option>{data?.facets.states.map((s) => <option key={s}>{s}</option>)}</select>
        <select value={filters.careLine ?? ''} onChange={(e) => set('careLine', e.target.value)} aria-label="Facility type"><option value="">All care lines</option>{meta && Object.entries(meta.careLines).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select value={filters.license ?? ''} onChange={(e) => set('license', e.target.value)} aria-label="RN vs LPN/LVN"><option value="">RN and LPN/LVN</option><option value="RN">RN openings</option><option value="LPN/LVN">LPN/LVN openings</option></select>
        <select value={filters.status ?? ''} onChange={(e) => set('status', e.target.value)} aria-label="Lead status"><option value="">All statuses</option>{meta?.leadStatuses.map((s) => <option key={s}>{s}</option>)}</select>
        <select value={filters.priority ?? ''} onChange={(e) => set('priority', e.target.value)} aria-label="Priority"><option value="">All priorities</option>{meta?.priorities.map((s) => <option key={s}>{s}</option>)}</select>
        <select value={filters.owner ?? ''} onChange={(e) => set('owner', e.target.value)} aria-label="Owner"><option value="">All owners</option><option value="unassigned">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
      </div>
      <div className="spread" style={{ marginBottom: 10 }}>
        <button className="link small" onClick={() => setMore(!more)}>{more ? 'Fewer filters' : 'More filters'}</button>
        {active > 0 && <button className="link small" onClick={() => { setFilters({}); setQ(''); }}>Clear all filters</button>}
      </div>
      {more && (
        <div className="filters-more">
          <select value={filters.city ?? ''} onChange={(e) => set('city', e.target.value)} aria-label="City"><option value="">All cities</option>{data?.facets.cities.map((s) => <option key={s}>{s}</option>)}</select>
          <input placeholder="Job specialty contains…" value={filters.specialty ?? ''} onChange={(e) => set('specialty', e.target.value)} aria-label="Job specialty" />
          <select value={filters.verification ?? ''} onChange={(e) => set('verification', e.target.value)} aria-label="Verification"><option value="">Any verification</option>{meta?.verificationStatuses.map((s) => <option key={s} value={s}>{meta.verificationLabels[s]}</option>)}</select>
          <label className="field"><span>Discovered from</span><input type="date" value={filters.discoveredFrom ?? ''} onChange={(e) => set('discoveredFrom', e.target.value)} /></label>
          <label className="field"><span>Discovered to</span><input type="date" value={filters.discoveredTo ?? ''} onChange={(e) => set('discoveredTo', e.target.value)} /></label>
          <div className="stack">
            <select value={filters.classification ?? ''} onChange={(e) => set('classification', e.target.value)} aria-label="Review"><option value="">All jobs</option><option value="review">Has jobs needing review</option></select>
            <select value={filters.existingClient ?? ''} onChange={(e) => set('existingClient', e.target.value)} aria-label="Existing client"><option value="">Clients and prospects</option><option value="no">Prospects only</option><option value="yes">Existing clients only</option></select>
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="card row" style={{ marginBottom: 10, padding: 10 }}>
          <b>{selected.size} selected</b>
          <select style={{ width: 180 }} value={bulk.leadStatus} onChange={(e) => setBulk({ ...bulk, leadStatus: e.target.value })}><option value="">Set status…</option>{meta?.leadStatuses.map((s) => <option key={s}>{s}</option>)}</select>
          <select style={{ width: 180 }} value={bulk.ownerId} onChange={(e) => setBulk({ ...bulk, ownerId: e.target.value })}><option value="">Assign owner…</option><option value="none">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          <select style={{ width: 180 }} value={bulk.priorityOverride} onChange={(e) => setBulk({ ...bulk, priorityOverride: e.target.value })}><option value="">Set priority…</option><option value="auto">Use calculated</option>{meta?.priorities.map((s) => <option key={s}>{s}</option>)}</select>
          <button className="primary" onClick={applyBulk} disabled={!bulk.leadStatus && !bulk.ownerId && !bulk.priorityOverride}>Apply</button>
          <button onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {error && <Alert kind="error">Could not load leads: {error}</Alert>}

      {loading && !data ? <Loading /> : rows.length === 0 ? (
        <div className="card empty">
          {active ? <>No facilities match these filters. <button className="link" onClick={() => { setFilters({}); setQ(''); }}>Clear filters</button></> : <>No facilities saved yet. <a href="#/find">Find your first facility</a>.</>}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 30 }}><input type="checkbox" aria-label="Select all" checked={allSel} onChange={() => setSelected(allSel ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                {COLUMNS.map(([k, l]) => <th key={k} className="sortable nowrap" onClick={() => sortBy(k)}>{l}{sort.key === k ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>)}
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? 'selected' : ''}>
                  <td><input type="checkbox" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => { const s = new Set(selected); if (s.has(r.id)) s.delete(r.id); else s.add(r.id); setSelected(s); }} /></td>
                  <td>
                    <a href={`#/facility/${r.id}`}><b>{r.name}</b></a>
                    <div className="row" style={{ gap: 4, marginTop: 3 }}>
                      <VerificationBadge s={r.verificationStatus} />
                      {r.isExistingClient && <span className="badge b-violet">Existing client</span>}
                      {r.reviewJobCount > 0 && <span className="badge b-amber">{r.reviewJobCount} to review</span>}
                    </div>
                  </td>
                  <td>{r.parentName ?? <span className="muted">—</span>}</td>
                  <td>{r.city ?? <span className="muted">—</span>}</td>
                  <td>{r.state ?? <span className="muted">—</span>}</td>
                  <td>{r.facilityType ?? <span className="muted">—</span>}</td>
                  <td className="small">{r.specialties.join(', ') || <span className="muted">—</span>}</td>
                  <td className="right">{r.jobCount}</td>
                  <td className="nowrap">{fmtDate(r.lastJobObserved)}</td>
                  <td title={r.scoreReasons.map((x) => `${x.label} +${x.points}`).join('\n') || 'No scoring signals'}><PriorityBadge s={r.priority} manual={!!r.priorityOverride} /><div className="small muted">score {r.score}</div></td>
                  <td className="nowrap">{r.leadStatus}{r.nextFollowUp && <div className="small muted">follow up {fmtDate(r.nextFollowUp)}</div>}</td>
                  <td>{r.ownerName ?? <span className="muted">Unassigned</span>}</td>
                  <td className="small">{r.sourceUrls.slice(0, 2).map((u, i) => <div key={u}><a href={u} target="_blank" rel="noreferrer noopener">Vivian {i + 1}</a></div>)}{r.sourceUrls.length > 2 && <span className="muted">+{r.sourceUrls.length - 2} more</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
