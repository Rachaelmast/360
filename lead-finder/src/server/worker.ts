// Background processor for batch imports. Processes one queued URL at a time.
// If Vivian blocks server access (Cloudflare check / rate limit), the rest of that batch
// is marked "needs_browser" instead of being retried in a loop.

import type { Db } from './db.ts';
import type { Fetcher } from './fetcher.ts';
import { extractAndRecord, type Settings } from './service.ts';

export class BatchWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(private db: Db, private settings: Settings, private fetcher: Fetcher, private log: (msg: string, extra?: unknown) => void = () => {}) {}

  start(intervalMs = 1000): void {
    if (this.timer) return;
    // items left "processing" by a crash are put back in the queue
    this.db.query("UPDATE batch_items SET status = 'queued' WHERE status = 'processing'").catch(() => {});
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Process at most one item. Returns false when the queue is empty. */
  async tick(): Promise<boolean> {
    if (this.busy) return true;
    this.busy = true;
    try {
      const r = await this.db.query<{ id: string; batch_id: string; url: string }>(
        `UPDATE batch_items SET status = 'processing', attempts = attempts + 1, updated_at = now()
          WHERE id = (SELECT id FROM batch_items WHERE status = 'queued' ORDER BY updated_at, url LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING id, batch_id, url`);
      const item = r.rows[0];
      if (!item) return false;
      try {
        const out = await this.fetcher.fetchJobPage(item.url);
        if (out.kind === 'ok') {
          const x = await extractAndRecord(this.db, this.settings, null, 'server_fetch', out.html, item.url);
          const summary = {
            extractionId: x.extractionId, identityStatus: x.result.status, facilityName: x.result.facility.name,
            state: x.result.facility.address.state ?? x.result.job.state, specialty: x.result.classification.specialty,
            decision: x.result.classification.decision, title: x.result.job.title,
          };
          const status = x.result.status === 'error' ? 'failed' : 'extracted';
          await this.db.query('UPDATE batch_items SET status = $2, result = $3, message = $4, updated_at = now() WHERE id = $1',
            [item.id, status, JSON.stringify(summary), x.result.errors[0] ?? x.result.warnings[0] ?? null]);
        } else if (out.kind === 'blocked') {
          await this.db.query("UPDATE batch_items SET status = 'needs_browser', message = $2, updated_at = now() WHERE id = $1", [item.id, out.message]);
          await this.db.query(
            "UPDATE batch_items SET status = 'needs_browser', message = $2, updated_at = now() WHERE batch_id = $1 AND status = 'queued'",
            [item.batch_id, 'Not attempted: Vivian blocked server access earlier in this batch. Open the job in your browser and use the extension.']);
          this.log('vivian blocked server fetch', { status: out.status });
        } else {
          await this.db.query("UPDATE batch_items SET status = 'failed', message = $2, updated_at = now() WHERE id = $1", [item.id, out.message]);
        }
      } catch (e) {
        await this.db.query("UPDATE batch_items SET status = 'failed', message = $2, updated_at = now() WHERE id = $1", [item.id, `Processing error: ${(e as Error).message}`]);
        this.log('batch item failed', { id: item.id, error: (e as Error).message });
      }
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** Drain the queue (tests and CLI). */
  async drain(): Promise<void> {
    while (await this.tick()) { /* continue */ }
  }
}
