import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Alert, BatchBadge, DecisionBadge, IdentityBadge, Loading, fmtDateTime, go, useLoad } from '../ui.tsx';

export function Batches({ id }: { id?: string }) {
  return id ? <BatchDetail id={id} /> : <BatchList />;
}

function BatchList() {
  const { data, error, loading } = useLoad<any[]>(() => api('/api/batches'), []);
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const count = (text.match(/vivian\.com\/job\/[A-Za-z0-9-]+/gi) ?? []).length;

  async function create() {
    setBusy(true); setErr(null);
    try { const r = await api<{ batchId: string }>('/api/batches', { body: { text, label: label || undefined } }); go(`batches/${r.batchId}`); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="page-head"><div><h1>Batch Import</h1><p>Queue many Vivian job URLs at once. Already-saved jobs are skipped.</p></div></div>
      <Alert kind="info">
        Vivian currently answers server requests with a Cloudflare bot check, so batch items usually end as <b>Needs browser</b>. Each one has an
        “Open in Vivian” link; open it and click the SkyBridge extension to save it, and the batch updates automatically. The server stops requesting a batch after the first block.
      </Alert>
      <div className="card stack">
        <div className="fields">
          <label className="field full"><span>Job URLs (paste a list, or any text or CSV containing them)</span>
            <textarea rows={7} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={'https://www.vivian.com/job/145-1448402/\nhttps://www.vivian.com/job/...'} />
          </label>
          <label className="field"><span>Or upload a CSV / text file</span>
            <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setText((await file.text()).slice(0, 2_000_000)); }} />
          </label>
          <label className="field"><span>Batch label (optional)</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Florida hospice, week 47" /></label>
        </div>
        {err && <Alert kind="error">{err}</Alert>}
        <div className="spread"><span className="muted small">{count} Vivian job URL{count === 1 ? '' : 's'} found</span><button className="primary" disabled={!count || busy} onClick={create}>{busy ? 'Creating…' : 'Start batch'}</button></div>
      </div>
      <div className="card">
        <h2>Recent batches</h2>
        {loading && !data ? <Loading /> : error ? <Alert kind="error">{error}</Alert> : !data?.length ? <p className="muted">No batches yet.</p> : (
          <table>
            <thead><tr><th>Batch</th><th>Created</th><th className="right">URLs</th><th className="right">Pending</th><th className="right">Done</th><th className="right">Need attention</th></tr></thead>
            <tbody>{data.map((b) => (
              <tr key={b.id}><td><a href={`#/batches/${b.id}`}>{b.label || 'Untitled batch'}</a></td><td className="small">{fmtDateTime(b.created_at)} · {b.created_by_name}</td><td className="right">{b.total}</td><td className="right">{b.pending}</td><td className="right">{b.done}</td><td className="right">{b.attention}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}

function BatchDetail({ id }: { id: string }) {
  const { data, error, loading, reload } = useLoad<any>(() => api(`/api/batches/${id}`), [id]);
  const [msg, setMsg] = useState<string | null>(null);
  const pending = (data?.counts.queued ?? 0) + (data?.counts.processing ?? 0);
  useEffect(() => { if (!pending) return; const t = setTimeout(reload, 2000); return () => clearTimeout(t); }, [data, pending, reload]);
  if (loading && !data) return <Loading />;
  if (error || !data) return <Alert kind="error">{error}</Alert>;
  const total = data.items.length;
  const settled = total - pending;
  const attention = (data.counts.failed ?? 0) + (data.counts.needs_browser ?? 0);
  return (
    <>
      <div className="page-head">
        <div><div className="small"><a href="#/batches">Batch Import</a> /</div><h1>{data.label || 'Untitled batch'}</h1><p>{fmtDateTime(data.created_at)} · {data.created_by_name}</p></div>
        <button disabled={!attention} onClick={async () => { const r = await api<{ requeued: number }>(`/api/batches/${id}/retry`, { body: {} }); setMsg(`Re-queued ${r.requeued} item(s).`); reload(); }}>Retry failed / blocked</button>
      </div>
      {msg && <Alert kind="ok">{msg}</Alert>}
      <div className="card">
        <div className="spread small" style={{ marginBottom: 6 }}><span>{settled} of {total} processed</span><span className="row">{Object.entries(data.counts).map(([k, n]) => <span key={k}><BatchBadge s={k} /> {String(n)}</span>)}</span></div>
        <div className="progress"><div style={{ width: `${total ? (settled / total) * 100 : 0}%` }} /></div>
      </div>
      <div className="table-wrap" style={{ marginTop: 14 }}>
        <table>
          <thead><tr><th>Job URL</th><th>Status</th><th>Facility</th><th>State</th><th>Specialty</th><th>Message</th><th /></tr></thead>
          <tbody>{data.items.map((it: any) => (
            <tr key={it.id}>
              <td className="small mono">{/^https:\/\/www\.vivian\.com\//.test(it.url) ? <a href={it.url} target="_blank" rel="noreferrer noopener">{it.url.replace('https://www.vivian.com', '')}</a> : it.url}</td>
              <td><BatchBadge s={it.status} /></td>
              <td>{it.result?.facilityName ?? '—'}{it.result?.identityStatus && <div><IdentityBadge s={it.result.identityStatus} /></div>}</td>
              <td>{it.result?.state ?? '—'}</td>
              <td>{it.result?.specialty ?? '—'}{it.result?.decision && <div><DecisionBadge s={it.result.decision} /></div>}</td>
              <td className="small muted">{it.message ?? ''}</td>
              <td className="nowrap small">
                {it.status === 'extracted' && <a className="btn small-btn" href={`#/find?extraction=${it.result.extractionId}`}>Review &amp; save</a>}
                {it.status === 'needs_browser' && <><a className="btn small-btn" href={it.url} target="_blank" rel="noreferrer noopener">Open in Vivian</a> <a className="small" href={`#/find?mode=paste&url=${encodeURIComponent(it.url)}`}>Paste source</a></>}
                {(it.status === 'saved' || it.status === 'duplicate') && it.facility_id && <a href={`#/facility/${it.facility_id}`}>Open facility</a>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}
