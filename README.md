# Agent Office (משרד הסוכנים)

An isometric 3D "agent office" dashboard: every toy character in the office is an AI agent
working for the business, driven by a live event stream. Inspired by a Hebrew tech reel —
the office itself is the dashboard: when five agents work in parallel, you see what each one
is doing in a second instead of reading logs.

**Live demo:** https://agent-office-demo.orworkdelevski.workers.dev

The office has two modes, switchable from the pill on the scene:

- **דמו (demo)** — built-in simulation with fictional data, clearly labeled דמו.
- **חי (live)** — real events pushed by your own agents through the ingestion API.
  The first real event flips the office to live mode automatically.

## Ingestion API

```
POST /api/ingest
Headers: Content-Type: application/json, X-Ingest-Token: <token>
Body:    {"agent": "ritman", "kind": "lead.new", "value": "+1", "note": "ליד חדש"}
```

- Auth: shared secret in the `X-Ingest-Token` header (a Workers secret, never in the repo).
- Realtime: browsers get events over WebSocket (`/api/ws`) fanned out by a Durable Object
  (`src/worker.js`); `GET /api/events?since=N` is the polling fallback / catch-up path.
- An event from an unknown agent auto-creates a new character in the office.
- Roster is data-driven: `public/roster.json`. Rename or add agents there (config, not code).

## Wiring your agents (see integrations/)

- `integrations/office-hook.sh` + `integrations/settings-snippet.json` — Claude Code
  PostToolUse/Stop hook: your coding agents report automatically, zero code changes.
- `integrations/curl-example.sh` — 3-line curl.
- `integrations/office-agent.js` — zero-dep JS/TS helper (`createReporter`).

## Stack

Cloudflare Workers free tier: static assets (`public/`) + a Worker (`src/worker.js`) +
one Durable Object. No paid APIs, no build step. Three.js is vendored
(`public/three.module.js`), all 3D geometry is generated in code. The web UI is Hebrew/RTL;
this README is English for portfolio value.

## Develop / deploy

```
npx wrangler deploy                      # deploy site + worker + DO
npx wrangler secret put INGEST_TOKEN     # set the ingestion token (once)
npx serve public                         # local static-only preview (demo mode)
```
