import { api } from '../api.ts';
import { Alert, Loading, PriorityBadge, fmtDate, go, useLoad } from '../ui.tsx';

interface Dash {
  kpis: Record<string, number>;
  byStatus: { status: string; count: number }[];
  topHiring: { id: string; name: string; state: string | null; jobCount: number }[];
  recent: { id: string; name: string; city: string | null; state: string | null; priority: string; firstDiscovered: string }[];
}

const weekAgo = () => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const KPIS: [string, string, () => string][] = [
  ['totalFacilities', 'Total facilities discovered', () => 'leads'],
  ['newThisWeek', 'New facilities this week', () => `leads?discoveredFrom=${weekAgo()}`],
  ['verifiedFacilities', 'Verified facilities', () => 'leads?sort=verificationStatus'],
  ['confirmedFromVivian', 'Confirmed from Vivian', () => 'leads'],
  ['homeHealth', 'Home Health leads', () => 'leads?careLine=home_health'],
  ['hospice', 'Hospice leads', () => 'leads?careLine=hospice'],
  ['palliative', 'Palliative Care leads', () => 'leads?careLine=palliative'],
  ['ipcHospice', 'IPC Hospice leads', () => 'leads?careLine=ipc_hospice'],
  ['highPriority', 'High-priority leads', () => 'leads?priority=High'],
  ['contacted', 'Leads contacted', () => 'leads?sort=lastContactedAt'],
  ['followUpsDue', 'Follow-ups due', () => 'leads?sort=nextFollowUp&dir=asc'],
  ['jobsNeedingReview', 'Jobs needing review', () => 'leads?classification=review'],
];

export function Dashboard() {
  const { data, error, loading } = useLoad<Dash>(() => api('/api/dashboard'), []);
  if (loading && !data) return <Loading />;
  if (error || !data) return <Alert kind="error">Could not load the dashboard: {error}</Alert>;
  const empty = data.kpis.totalFacilities === 0;
  return (
    <>
      <div className="page-head">
        <div><h1>Dashboard</h1><p>Find a job → identify the facility → verify → save → research → contact.</p></div>
        <button className="primary" onClick={() => go('find')}>Find Facility</button>
      </div>
      {empty && <Alert kind="info">No facilities yet. Start with <a href="#/find">Find Facility</a>, the browser extension, or a <a href="#/batches">batch import</a>.</Alert>}
      <div className="kpis">
        {KPIS.map(([k, label, to]) => (
          <div key={k} className="kpi link" role="link" tabIndex={0} onClick={() => go(to())} onKeyDown={(e) => { if (e.key === 'Enter') go(to()); }}>
            <div className="v">{data.kpis[k] ?? 0}</div><div className="l">{label}</div>
          </div>
        ))}
      </div>
      <div className="grid g3" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>Recently discovered</h2>
          {data.recent.length ? <table><tbody>{data.recent.map((r) => (
            <tr key={r.id}><td><a href={`#/facility/${r.id}`}>{r.name}</a><div className="small muted">{[r.city, r.state].filter(Boolean).join(', ')} · {fmtDate(r.firstDiscovered)}</div></td><td className="right"><PriorityBadge s={r.priority} /></td></tr>
          ))}</tbody></table> : <p className="muted">Nothing yet.</p>}
        </div>
        <div className="card">
          <h2>Most relevant openings</h2>
          {data.topHiring.length ? <table><tbody>{data.topHiring.map((r) => (
            <tr key={r.id}><td><a href={`#/facility/${r.id}`}>{r.name}</a> <span className="muted small">{r.state}</span></td><td className="right">{r.jobCount}</td></tr>
          ))}</tbody></table> : <p className="muted">Nothing yet.</p>}
        </div>
        <div className="card">
          <h2>Pipeline</h2>
          <table><tbody>{data.byStatus.map((s) => (
            <tr key={s.status}><td><a href={`#/leads?status=${encodeURIComponent(s.status)}`}>{s.status}</a></td><td className="right">{s.count}</td></tr>
          ))}</tbody></table>
        </div>
      </div>
    </>
  );
}
