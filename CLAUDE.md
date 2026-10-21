# CLAUDE.md

## Working with the user
- Never ask the user to do something manually that you can do for them. Check your MCP servers, tools, and connectors first; if you can do it, always do it yourself.
- No hallucinations. Only state facts you have verified from the code, tools, or sources. If you don't know, say so.

## Project
SkyBridge Healthcare 360 Review tool, a single-page app with no build step.

- `app.html` is the source. It has no `<!doctype>`/`<head>` because it's published as a claude.ai Artifact, which adds that wrapper.
- `index.html` is the same page wrapped in a full HTML document so it runs standalone in a browser. After editing `app.html`, regenerate `index.html` so the two stay identical apart from the wrapper.
- Question bank: `CORE` (shared competencies), `ROLES` (Recruiter, Account Manager, Director, Executive VP of Operations), `OPEN` (written questions) at the top of the script.
- Storage: when it runs as an Artifact, the page uses the shared `db` capability (`cycles/*` that only editors can write; `responses/<reviewerId>` that each reviewer writes for themselves and only editors and the owner can read). Anywhere else it falls back to `localStorage`.
- Placeholders: `DEV` (development ideas per competency) and `buildDemo()` (sample people and comments) are placeholder content meant to be replaced with SkyBridge's own.
- Anonymity: peer, direct report, and partner groups with fewer than 3 reviewers are folded into "Other reviewers" in the report.

## SkyBridge VMS (`vms/`)
A vendor management system with the same conventions as the 360 tool: no build step, single page.

- `vms/app.html` is the source, published as a claude.ai Artifact (https://claude.ai/artifact/7oVYvA7Pg2S7GWJiNUGUxw) with the `db`, `user`, `downloads` and `sample` capabilities. `vms/index.html` is the same page with the full-document wrapper. After editing `app.html`, regenerate `index.html` by inserting `</head><body>` after the first `</style>` line and adding the doctype/meta header and the closing tags.
- Collections (shared `db` docs, or `localStorage` keys `sbvms.<name>`): `facilities` (rate cards in `rates`, `budget`, `mileage`), `vendors`, `reqs`, `subs`, `assigns`, `timesheets`, `invoices`, `activity` (audit log, written through `log()`).
- Roles (`S.role`: admin, facility, vendor) only change the view through `scope()` and `can`. They are not a security boundary.
- `buildDemo()` holds the placeholder sample data, kept in memory only.
- Claude features (`parsePosting`, `compareCandidates`, `askData`) only appear when `claude.use("sample")` resolves, so they're hidden in `index.html`.
- Money rules: overtime after 40 hours at 1.5× (hourly only); the VMS fee applies to labor, not expenses; mileage uses the facility's rate.
