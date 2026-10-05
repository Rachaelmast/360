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
- Anonymity: peer, direct report, and partner groups with fewer than 3 reviewers are folded into "Other reviewers" in the report.
