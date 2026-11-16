// Server-side retrieval of a Vivian job page.
//
// Rules: only allow-listed Vivian hosts over HTTPS, every redirect hop re-validated,
// resolved IPs must be public, response size and time are capped, requests are spaced
// out, and the client identifies itself honestly. A Cloudflare bot challenge is reported
// as "blocked" - this code never tries to get past it.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { parseVivianJobUrl, VIVIAN_HOSTS } from '../core/url.ts';

export type FetchOutcome =
  | { kind: 'ok'; html: string; finalUrl: string; status: number }
  | { kind: 'blocked'; status: number; message: string }
  | { kind: 'error'; message: string; status?: number };

export interface Fetcher { fetchJobPage(url: string): Promise<FetchOutcome> }

const USER_AGENT = 'SkyBridgeLeadFinder/0.1 (internal business-development tool; one request per user action)';
const MAX_BYTES = 6 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MIN_INTERVAL_MS = 3_000;

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

export class VivianFetcher implements Fetcher {
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();

  /** Requests are serialised and spaced at least MIN_INTERVAL_MS apart. */
  fetchJobPage(url: string): Promise<FetchOutcome> {
    const run = this.chain.then(async () => {
      const wait = this.last + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return this.fetchOnce(url);
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async fetchOnce(input: string): Promise<FetchOutcome> {
    let current = input;
    for (let hop = 0; hop < 4; hop++) {
      const check = parseVivianJobUrl(current);
      if (!check.ok) return { kind: 'error', message: hop ? `Redirected to a URL that is not allowed: ${check.error}` : check.error };
      const u = new URL(check.url);
      if (!(VIVIAN_HOSTS as readonly string[]).includes(u.hostname)) return { kind: 'error', message: 'Host not allowed.' };
      try {
        const addrs = await lookup(u.hostname, { all: true });
        if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return { kind: 'error', message: 'The host resolved to a private address; request refused.' };
      } catch {
        return { kind: 'error', message: `Could not resolve ${u.hostname}.` };
      }
      let res: Response;
      try {
        res = await fetch(u, {
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        });
      } catch (e) {
        const msg = (e as Error).name === 'TimeoutError' ? 'The request timed out.' : `Network error: ${(e as Error).message}`;
        return { kind: 'error', message: msg };
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { kind: 'error', status: res.status, message: 'Redirect without a location.' };
        current = new URL(loc, u).toString();
        continue;
      }
      const body = await readCapped(res);
      if (body === null) return { kind: 'error', status: res.status, message: 'The page is larger than the 6 MB limit.' };
      if (res.headers.get('cf-mitigated') === 'challenge' || /challenges\.cloudflare\.com|Just a moment\.\.\./i.test(body.slice(0, 20_000)) && res.status >= 400) {
        return {
          kind: 'blocked',
          status: res.status,
          message: 'Vivian answered with a Cloudflare bot check, so the server cannot read this page. Open the job in your browser and use the SkyBridge extension, or paste the page source.',
        };
      }
      if (res.status === 404 || res.status === 410) return { kind: 'error', status: res.status, message: 'Vivian says this job page does not exist (it may have been filled or removed).' };
      if (res.status === 429) return { kind: 'blocked', status: 429, message: 'Vivian is rate-limiting requests. Wait before retrying.' };
      if (res.status >= 400) return { kind: 'error', status: res.status, message: `Vivian returned HTTP ${res.status}.` };
      return { kind: 'ok', html: body, finalUrl: u.toString(), status: res.status };
    }
    return { kind: 'error', message: 'Too many redirects.' };
  }
}

async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
