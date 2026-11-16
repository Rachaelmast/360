import { HttpError } from './errors.ts';

/** Small in-memory fixed-window limiter (per process). Enough for a ~12-person internal tool. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private limit: number, private windowMs: number) {}
  check(key: string, message = 'Too many requests. Try again shortly.'): void {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      return;
    }
    if (++e.count > this.limit) throw new HttpError(429, message);
  }
}
