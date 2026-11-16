// URL validation for job-posting sources. Only Vivian job pages are accepted
// for fetching; this list doubles as the server's SSRF allow-list.

export const VIVIAN_HOSTS = ['www.vivian.com', 'vivian.com'] as const;

export type UrlCheck =
  | { ok: true; url: string; source: 'vivian'; externalId: string }
  | { ok: false; error: string };

const JOB_PATH = /^\/job\/([A-Za-z0-9][A-Za-z0-9-]{0,63})\/?$/;

/** Validate and canonicalise a Vivian job URL, e.g. https://www.vivian.com/job/145-1448402/ */
export function parseVivianJobUrl(input: string): UrlCheck {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, error: 'Enter a Vivian job URL.' };
  if (raw.length > 2048) return { ok: false, error: 'URL is too long.' };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Only http(s) URLs are supported.' };
  if (u.username || u.password) return { ok: false, error: 'URLs with embedded credentials are not allowed.' };
  if (u.port && u.port !== '443' && u.port !== '80') return { ok: false, error: 'Custom ports are not allowed.' };
  const host = u.hostname.toLowerCase();
  if (!(VIVIAN_HOSTS as readonly string[]).includes(host)) {
    return { ok: false, error: `Only Vivian job URLs (vivian.com/job/...) are supported. Got "${host}".` };
  }
  const m = u.pathname.match(JOB_PATH);
  if (!m) return { ok: false, error: 'This is a Vivian URL but not a job posting (expected vivian.com/job/<id>/).' };
  return { ok: true, url: `https://www.vivian.com/job/${m[1]}/`, source: 'vivian', externalId: m[1] };
}

/** Pull candidate URLs out of free text or a CSV export (one or many per line). */
export function extractUrlsFromText(text: string): string[] {
  const found = (text ?? '').match(/(?:https?:\/\/)?(?:www\.)?vivian\.com\/job\/[A-Za-z0-9-]+\/?/gi) ?? [];
  return found;
}
