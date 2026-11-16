# SkyBridge Healthcare — Facility Lead Finder

Internal tool that turns Vivian job postings into business-development leads: **find a job → identify the actual facility → verify → save → research → contact**. Separate from the 360 Review tool and the recruiter hub in this repository.

## Simplest way to use it: one HTML file

**`standalone/SkyBridge-Lead-Finder.html`**: download it and double-click it to open it in Chrome or Edge. There's nothing to install, no server, and no login.

1. On a Vivian job page, click the **Copy for SkyBridge** bookmark. The file explains how to add it with one drag. Or use Ctrl+U, then Ctrl+A and Ctrl+C.
2. In the Lead Finder, click **Paste from clipboard**. It shows the facility, address, VMS, specialty, staffing agency, and evidence.
3. Correct anything if needed, then **Save lead**. Jobs at the same facility are grouped, and possible duplicates are offered, never merged automatically.
4. Track status, owner, follow-up dates and notes. **Export CSV** opens in Excel.

Data is stored in that browser only:
- Use **Backup** regularly; it saves a `.json` file you can keep on OneDrive.
- To combine leads with a teammate, **Restore** their backup file. It adds their facilities and jobs and never overwrites yours.

Rebuild after code changes with `npm run build:html`.

The rest of this README describes the full multi-user version (server, database, extension), kept for when a shared central database is wanted.

## What works today (full version)

| Area | Status |
|---|---|
| Facility extraction engine (`hospitalName` and variants, nested/escaped JSON, JSON-LD, Next.js data, data attributes, raw-text fallback) | Built and tested on synthetic fixtures |
| Staffing agency vs. end-client separation, generic-name detection ("Home Health", "Confidential") | Built and tested |
| VMS capture: every page field whose name contains "vms", plus plain-text "VMS" mentions with context | Built and tested; stored per job, shown on the facility page, exported |
| Specialty classification (Home Health, Hospice, Palliative, IPC Hospice; RN / LPN / LVN; roles), configurable taxonomy, manual review queue | Built and tested |
| Paste page source → review → correct → save lead | Built and tested end to end in a browser |
| Duplicate detection (one facility, many jobs; branches kept separate; merge + undo) | Built and tested |
| Lead database: search, filters, sorting, bulk edit, facility profile, notes, follow-ups, audit trail, CSV export (opens in Excel) | Built |
| Lead scoring with reasons, manual priority override | Built |
| Batch import (paste URLs or upload CSV), progress, retry, duplicate skipping | Built and tested |
| Chrome / Edge extension | Built; loads in Chromium. **The popup flow has not yet been clicked through in a real browser** (see Testing) |
| Users, roles (member / manager / admin), personal tokens for the extension | Built and tested |

### The Vivian access limitation
Server requests to `vivian.com/job/...` receive a **Cloudflare bot check** (HTTP 403, `cf-mitigated: challenge`). This was confirmed live on 16 Nov 2026 with the job URL from the project brief. The tool does not try to get around it. As a result:

- **Find Facility by URL** reports the block and points you to the extension or paste.
- **Batch import** marks blocked items **Needs browser**. After the first block it stops requesting that batch. Each item gets an *Open in Vivian* link, and saving it through the extension marks it *Saved*.
- **Extension** (recommended): it reads the job page already open in your browser, only when you click it.
- **Paste page source** (always works): Ctrl+U on the job page, Ctrl+A, Ctrl+C, then paste.

Vivian's robots.txt allows `/job/` pages and disallows `/api`. The tool never calls Vivian's API. Automated search-result discovery (Phase 4) is not built: there is no permitted access method.

## Run it

Requirements: Node 20+, PostgreSQL 14+.

```bash
cd lead-finder
npm install
cp .env.example .env            # set DATABASE_URL
createdb leadfinder              # or create it in your Postgres admin tool
npm run create-user -- --email you@skybridgehealthcare.com --name "Your Name" --role admin
npm run build                    # builds the web app into web/dist
npm start                        # API + web app on http://127.0.0.1:8787 (migrations run automatically)
```

Development with live reload: `npm run dev:server` and `npm run dev:web` (http://localhost:5173, proxies `/api`).

`.env` is not loaded automatically. Export the variables, or run `node --env-file=.env --import tsx src/server/index.ts`.

## Install the browser extension (Chrome or Edge)

1. In the web app, open **Settings → Browser extension** and create a token. Copy it.
2. Go to `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked**, and choose the `lead-finder/extension` folder.
3. The settings page opens. Enter the server address and the token, then click **Save and test**. Chrome asks for permission to reach that one server; allow it.
4. On any Vivian job page, click the SkyBridge icon. Check the facility, then click **Save Lead**.

The extension has `activeTab` permission only. It reads nothing until you click it, and it sends the page to your SkyBridge server only. If the rendered page has no facility data, it fetches the page source once from the tab, the same thing Ctrl+U does.

## Using it

- **Find Facility**: paste a URL, or switch to *Paste page source*.
  - Each result shows a status: *Confirmed facility* (from a facility field such as `hospitalName`), *Possible* (organization field, conflicting values, or mostly generic name), *Staffing agency only*, *Generic description*, or *Not identified*.
  - The evidence table lists every field found, with its location in the page.
  - Edit anything before saving. Original values and your corrections are both stored.
  - If a matching facility exists you choose where the job goes. Exact matches are preselected. Similar names are never merged automatically.
- **Facility Leads**: filter by state, city, care line, RN vs LPN/LVN, status, priority, owner, verification, discovery date, review needed, or existing client. Sort any column, select rows for bulk status/owner/priority changes, and export what you're viewing.
- **Facility profile**:
  - *Overview*: editable organization data.
  - *Jobs*: every posting, its source link, extraction evidence, and inline classification fixes.
  - *Business Development*: status, owner, follow-up, outreach log, existing-client flag, and the Bullhorn ID (entered by hand).
  - *Research*: verification status, branches, possible duplicates with merge/undo.
  - *History*: full audit trail.
- **Settings** (admin): users and roles, the specialty taxonomy (regex patterns), and lead scoring weights.

## Architecture

- `src/core/`: the extraction engine, classifier, duplicate matching, and scoring. Pure TypeScript, with no extraction logic duplicated anywhere else.
- `src/server/`: Fastify API on PostgreSQL.
  - Separate tables for job postings, facility branches, parent organizations, extractions (the evidence), activities, merges, and the audit log.
  - Security: scrypt passwords, hashed session/API tokens, origin check on cookie writes, rate limits.
  - Server fetching is SSRF-safe: allow-listed hosts only, every redirect re-checked, private IPs refused, size and time caps.
  - SQL migrations in `src/server/migrations/`.
- `web/`: React + TypeScript (Vite).
- `extension/`: Manifest V3, plain JavaScript, no build step.
- Bullhorn: the facility has `bullhorn_company_id` and an existing-client flag. No connection is made until API access is configured.
- Azure: it is a standard Node service plus PostgreSQL, so it fits Azure App Service with Azure Database for PostgreSQL. Set `COOKIE_SECURE=true` behind HTTPS.

## Testing

```bash
npm test            # 119 tests: extraction, classification, duplicates, scoring, API (needs Postgres; see TEST_DATABASE_URL)
npm run typecheck
```

Test fixtures are **synthetic**: no real Vivian page could be fetched. The Lower Cape Fear LifeCare fixture uses only the name and street address from the brief. Before relying on the field list, save the source of a few real Vivian job pages (Ctrl+U → Save As) into `test/fixtures/` and add tests for them. Real pages may use field names not covered yet.

Not yet verified: the extension popup in a real browser session on vivian.com, and live extraction from a real Vivian page.
