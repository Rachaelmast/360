import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, type Meta, type User } from './api.ts';

// ---- routing (hash based, so the built app works from any static host) ----
export interface Route { path: string[]; query: URLSearchParams }
function readRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [p, q] = h.split('?');
  return { path: (p || 'dashboard').split('/').filter(Boolean), query: new URLSearchParams(q ?? '') };
}
export function useRoute(): Route {
  const [r, setR] = useState(readRoute);
  useEffect(() => {
    const on = () => setR(readRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}
export const go = (path: string) => { window.location.hash = `#/${path.replace(/^\/?#?\/?/, '')}`; };

// ---- data loading ----
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void; setData: (d: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fn().then((d) => { if (live) { setData(d); setError(null); } }).catch((e) => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, loading, reload, setData };
}

// ---- shared context-ish singletons ----
let metaPromise: Promise<Meta> | null = null;
export const loadMeta = () => (metaPromise ??= api<Meta>('/api/meta').catch((e) => { metaPromise = null; throw e; }));
let usersPromise: Promise<User[]> | null = null;
export const loadUsers = (fresh = false) => { if (fresh) usersPromise = null; return (usersPromise ??= api<User[]>('/api/users').catch((e) => { usersPromise = null; throw e; })); };

// ---- formatting ----
export const fmtDate = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
export const fmtDateTime = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
export const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

// ---- badges ----
const IDENTITY: Record<string, [string, string]> = {
  confirmed: ['Confirmed facility', 'b-green'],
  possible: ['Possible facility', 'b-amber'],
  agency_only: ['Staffing agency only', 'b-violet'],
  generic: ['Generic description', 'b-amber'],
  not_found: ['Facility not identified', 'b-red'],
  error: ['Extraction error', 'b-red'],
  manual: ['Entered manually', 'b-blue'],
};
export const IdentityBadge = ({ s }: { s: string }) => { const [l, c] = IDENTITY[s] ?? [s, '']; return <span className={`badge ${c}`}>{l}</span>; };

const DECISION: Record<string, [string, string]> = { accept: ['In scope', 'b-green'], review: ['Needs review', 'b-amber'], exclude: ['Out of scope', 'b-red'] };
export const DecisionBadge = ({ s }: { s: string }) => { const [l, c] = DECISION[s] ?? [s, '']; return <span className={`badge ${c}`}>{l}</span>; };

const PRIORITY: Record<string, string> = { High: 'b-green', Medium: 'b-blue', Low: '', 'Needs Research': 'b-amber' };
export const PriorityBadge = ({ s, manual }: { s: string; manual?: boolean }) => <span className={`badge ${PRIORITY[s] ?? ''}`} title={manual ? 'Set manually' : 'Calculated from lead score'}>{s}{manual ? ' •' : ''}</span>;

const VERIF: Record<string, [string, string]> = {
  extracted: ['Extracted from Vivian', 'b-blue'], unverified: ['Unverified', 'b-amber'],
  verified_website: ['Verified: website', 'b-green'], verified_license: ['Verified: license', 'b-green'], verified_manual: ['Verified: manual', 'b-green'],
};
export const VerificationBadge = ({ s }: { s: string }) => { const [l, c] = VERIF[s] ?? [s, '']; return <span className={`badge ${c}`}>{l}</span>; };

const BATCH: Record<string, [string, string]> = {
  queued: ['Queued', ''], processing: ['Processing', 'b-blue'], extracted: ['Ready to review', 'b-blue'], needs_browser: ['Needs browser', 'b-amber'],
  failed: ['Failed', 'b-red'], duplicate: ['Already saved', 'b-violet'], saved: ['Saved', 'b-green'], invalid: ['Invalid URL', 'b-red'],
};
export const BatchBadge = ({ s }: { s: string }) => { const [l, c] = BATCH[s] ?? [s, '']; return <span className={`badge ${c}`}>{l}</span>; };

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Field({ label, children, full }: { label: string; children: ReactNode; full?: boolean }) {
  return <label className={`field${full ? ' full' : ''}`}><span>{label}</span>{children}</label>;
}

export function Loading() { return <div className="empty">Loading…</div>; }
