import type { ExtractionResult } from '../../src/core/extract.ts';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event('lf:signed-out'));
    throw new ApiError(res.status, (isJson && data?.error) || `Request failed (${res.status}).`, isJson ? data?.details : undefined);
  }
  return data as T;
}

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface User { id: string; email: string; name: string; role: 'admin' | 'manager' | 'member' }
export interface Meta {
  leadStatuses: string[]; priorities: string[]; verificationStatuses: string[]; verificationLabels: Record<string, string>;
  careLines: Record<string, string>; roles: string[]; licenses: string[];
}
export interface Match {
  facility: { id: string; name: string; street: string | null; city: string | null; state: string | null; parentName: string | null; jobCount: number };
  strength: 'exact' | 'likely' | 'possible' | 'related';
  reasons: string[];
}
export interface ExistingJob { id: string; facility_id: string | null; title: string; facility_name: string | null; first_seen_at: string; last_seen_at: string }
export interface ExtractResponse {
  extractionId: string; url: string | null; result: ExtractionResult; existingJob: ExistingJob | null; matches: Match[];
}
export type { ExtractionResult };
