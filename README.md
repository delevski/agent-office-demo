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
  (`worker.js` → `server/hub.js`); `GET /api/events?since=N` is the polling fallback / catch-up path.
- An event from an unknown agent auto-creates a new character in the office.
- Roster is data-driven: `roster.json` — `agents` are the demo characters, `live` are the real
  agents (Tab, Instinct, Hermes). Rename or add agents there (config, not code).
- The older format above still works. Live data (events, agent panels) is visible only after login,
  see the next section.

## Login & agent API (live mode)

The office is public in **demo** mode. Live mode — the real agents and what they report — opens
only after Ori logs in with one password; the browser then keeps a signed, HttpOnly session cookie
for 180 days. Click a character (or a row in the agents list) to open its panel: what it is working
on now, recent tasks with status, today's usage (messages / tokens / cost / tasks) and its
capabilities (model, skills, tools). An agent that never reported shows **אין נתונים** ("no data"),
and one that has not reported for 10 minutes shows **לא מחובר** ("offline") — never made-up numbers.

### Secrets (names only — values are set with `npx wrangler secret put NAME`, never committed)

| Name | What it is |
| --- | --- |
| `OFFICE_PASSWORD` | Ori's login password. Without it login is off and only demo mode works. |
| `SESSION_SECRET` | Optional. Signs the session cookie. When unset, a key derived from `OFFICE_PASSWORD` is used (changing the password logs everyone out). |
| `AGENT_TOKEN_TAB` | Write token for Tab. |
| `AGENT_TOKEN_INSTINCT` | Write token for Instinct. |
| `AGENT_TOKEN_HERMES` | Write token for Hermes (add when it joins). Any `AGENT_TOKEN_<ID>` adds an agent `<id>`. |
| `INGEST_TOKEN` | Existing shared token (`X-Ingest-Token`), still accepted for the old hooks. |

A per-agent token *is* the agent's identity: a report sent with `AGENT_TOKEN_TAB` is always filed
under `tab`, and naming another agent in the body returns `403`.

### Endpoints

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/ingest` | `Authorization: Bearer <agent token>` (or legacy `X-Ingest-Token`) | One report (event types below) |
| `POST /api/agents/:id/heartbeat` | Bearer token of that agent | Full snapshot in one call (optional) |
| `POST /api/login` `{"password": "…"}` | — | Sets the session cookie (8 wrong tries per 15 min per IP → `429`) |
| `POST /api/logout` | — | Clears it |
| `GET /api/me` | — | `{"loggedIn": bool, "loginConfigured": bool}` |
| `GET /api/agents`, `GET /api/agents/:id` | session cookie | Live state for the panel |
| `GET /api/events?since=N`, `GET /api/ws` | session cookie | Event feed (poll / WebSocket) |

### Event types (`POST /api/ingest`)

Every field is optional except `kind`. Fields can be nested (as below) or flat at the top level.
Strings are trimmed and stripped of markup; links must be `http(s)`.

| `kind` | Body | Effect |
| --- | --- | --- |
| `task.start` | `{"task": {"id", "title", "link"}}` | Sets *working on now*, adds the task as running |
| `task.done` / `task.failed` | `{"task": {"id"}}` (or no task = the current one) | Marks the task done / failed, clears *now* |
| `status` | `{"status": "working\|idle\|blocked\|offline", "task": {…}}` | Sets status (and optionally *now*) |
| `usage` | `{"usage": {"messages", "tokens", "cost", "tasks"}, "mode": "set\|add", "day": "YYYY-MM-DD"}` | Today's usage. `set` (default) = today's totals so far, safe to resend; `add` = increment. `cost` is in USD. Day = Israel time. `tasks` defaults to tasks finished today. |
| `config` | `{"config": {"model", "skills": [], "tools": [], "description"}}` | Capabilities shown on the card (merged) |
| anything else | `{"value", "note"}` | The original free-form event: log line + animation |

`heartbeat` accepts Instinct's snapshot shape:
`{"status", "current": {"title", "since", "ref"}, "recent": [{"title", "done_at", "result": "ok|failed"}], "usage": {...}, "capabilities": {"model", "skills", "tools"}}`.

Report only what is fine for Ori to read: task names, status, counts and capabilities — no prompts,
credentials or internals. `model` is whatever name the agent wants shown (Tab reports `"Tab"`).

### Examples

```bash
URL=https://agent-office-demo.orworkdelevski.workers.dev
TOKEN=$AGENT_OFFICE_TOKEN   # this agent's AGENT_TOKEN_<ID> value

# started a task
curl -sX POST $URL/api/ingest -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"task.start","task":{"id":"pr-61","title":"Agent panel PR","link":"https://github.com/delevski/agent-office-demo/pull/61"}}'

# finished it (or "task.failed")
curl -sX POST $URL/api/ingest -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"task.done","task":{"id":"pr-61"}}'

# status without a task
curl -sX POST $URL/api/ingest -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"status","status":"blocked","task":{"title":"Waiting for Ori to approve the deploy"}}'

# today's usage so far
curl -sX POST $URL/api/ingest -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"usage","usage":{"messages":86,"tokens":412300,"cost":3.18,"tasks":5}}'

# capabilities
curl -sX POST $URL/api/ingest -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"config","config":{"model":"Tab","skills":["research","websites","video"],"tools":["browser","phone"]}}'

# or everything at once
curl -sX POST $URL/api/agents/instinct/heartbeat -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"working","current":{"title":"LeadFlow deploy","ref":"https://github.com/delevski/leadflow-mvp/pull/56"},"usage":{"tasks":12},"capabilities":{"skills":["deploy"]}}'
```

Responses: `200 {"ok":true,…}`, `401` bad/missing token, `403` token of another agent, `400` invalid JSON.

## Wiring your agents (see integrations/)

- `integrations/office-hook.sh` + `integrations/settings-snippet.json` — Claude Code
  PostToolUse/Stop hook: your coding agents report automatically, zero code changes.
- `integrations/curl-example.sh` — curl for every event type (per-agent token).
- `integrations/office-agent.js` — zero-dep JS/TS helper (`createReporter`).

## Stack

Cloudflare Workers free tier: static assets (repo root, minus `.assetsignore`) + a Worker
(`worker.js`, with `server/`) + one SQLite-backed Durable Object that also keeps each agent's
state. No paid APIs, no build step. Three.js is vendored (`three.module.js`), all 3D geometry
is generated in code. The web UI is Hebrew/RTL;
this README is English for portfolio value.

## Develop / deploy

```
npm test                                 # unit tests (node --test, no dependencies)
cp .dev.vars.example .dev.vars           # local secrets for wrangler dev (gitignored)
npx wrangler dev                         # local site + API + DO on http://localhost:8787
npx wrangler secret put OFFICE_PASSWORD  # production secrets (once each, see table above)
npx wrangler secret put AGENT_TOKEN_TAB
npx wrangler deploy                      # deploy site + worker + DO
```
