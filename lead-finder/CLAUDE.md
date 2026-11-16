# CLAUDE.md — SkyBridge Facility Lead Finder

Separate project from the 360 Review tool and the recruiter hub at the repo root. Do not share code or data with them.

## Working with the user
- Never ask the user to do something manually that you can do for them. Check MCP servers, tools, and connectors first; if you can do it, do it.
- No hallucinations. Only state facts verified from the code, tools, or sources. If you don't know, say so.
- Do not claim live Vivian extraction works unless it was tested live. Server requests to vivian.com/job/* get a Cloudflare bot check (HTTP 403, `cf-mitigated: challenge`). Never try to bypass it (no browser user-agent spoofing, no headless-browser workarounds).

## Coding rules (from Ponytail, MIT, github.com/DietrichGebert/ponytail)
Lazy senior developer: solve the whole problem with the least new code. End replies with one or two lines on what was skipped or not checked, and any risk.
- Before writing: read the code the change touches; list every place it must reach (callers, tests, fixtures, config, exports).
- Take the first option that fully works: does it need to exist? → already in this codebase? → standard library / platform feature? → installed dependency (never add one for a few lines)? → one readable line? → otherwise the minimum code that works.
- No abstraction, wrapper, option, config or "for later" code nobody asked for. Keep the existing structure and conventions. Deletion beats addition.
- Bug fix: grep every caller first, fix the root cause once in the shared code.
- New non-trivial logic (branch, loop, parser, money, security) leaves one small test. A known shortcut gets `// shortcut: <limit>, <when to upgrade>`.
- Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything the user asked for.

## Layout
- `src/core/` — extraction engine, specialty classifier, normalisation/duplicate matching, lead scoring. No DOM or Node APIs; shared by server, web and extension.
- `src/server/` — Fastify API, PostgreSQL (`migrations/*.sql`, applied in filename order on start), auth (sessions + personal API tokens for the extension), batch worker.
- `web/` — React + TypeScript (Vite). Hash routing.
- `extension/` — Chrome/Edge MV3 extension; reads the current tab only when clicked and posts the page HTML to `/api/extract/html`.
- `test/` — Vitest. `api.test.ts` needs Postgres (`TEST_DATABASE_URL`, default `leadfinder_test`). Fixtures are synthetic; the Lower Cape Fear LifeCare fixture uses only the name/address from the brief and must never be hardcoded as a result.

## Commands
`npm test` · `npm run typecheck` · `npm run dev:server` + `npm run dev:web` · `npm run build` · `npm start`
