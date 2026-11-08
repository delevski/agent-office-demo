# Agent Office

**A live 3D "office" where AI agents sit at desks and stream their work into one hub, so you can see what every agent is doing, what it costs and where it is stuck in one glance.**

**Live demo:** https://agent-office-demo.orworkdelevski.workers.dev
**Embeddable showcase:** https://agent-office-demo.orworkdelevski.workers.dev/showcase

## What it does

Running several AI agents (Claude, GPT, Hermes and others) leaves you reading logs to find out who is working on what. Agent Office turns that into a room: each agent is a character at a desk, driven by the events it reports.

- **Two modes.** *Demo* runs a built-in simulation with fictional characters and is clearly labelled. *Live* shows real events pushed by your own agents and opens only after login.
- **Status at a glance.** Working = typing with code scrolling on the monitor; idle = coffee break; blocked = scratching its head; offline = asleep at the desk.
- **Kanban board** on the back wall (and as a 2D view), built only from what agents reported: queued, in progress, done / failed.
- **Agent card** per agent: current task, recent tasks, today's usage (messages, tokens, cost, tasks), model and skills, a 7-day done/failed graph and a reliability score (0–100) with an explanation of how it is computed.
- **Code reviews** with a findings-per-PR trend per author, plus a "what changed today" feed of merged PRs, deploys and closed tasks.
- **Stuck / silent alerts** when an open task gets no update for 30 minutes.
- **Handoffs** between agents drawn as arcs between desks, a live one-line activity under each name tag, cost/budget meters, a meeting room, and a **day replay** that plays the day back from stored events.
- **Morning summary** endpoint (text or JSON) of everything since yesterday evening.
- **Give a task**: add a card to an agent's to-do column from the UI. It only adds the card; no agent is called.
- An agent that never reported shows "no data", never made-up numbers.

## Architecture

## v6: a living room

- **Full-screen room + drawer.** The room fills the screen; the side panel is a drawer (‹ / ›) and leaves a narrow strip with the key numbers (connected, tasks today, events, bell rings, room clock) and one dot per agent when closed. Its state is remembered.
- **Real time of day.** The wall clock, the TV corner, the light, the windows and the sky behind the room follow the viewer's clock: dawn, day, dusk and night (stars, a night skyline, desk lamps on, agents in pajamas and nightcaps). Debug: `?time=22:00` fixes the room's clock, `?time=cycle:60` runs a whole day in 60 s (also in ⚡ → "שעה בחדר").
- **The bell.** On `task.done` (not failed) and on the new `pr.opened`, the agent gets up, walks to the bell in the front-right corner and rings it twice. The sound is synthesized with WebAudio (`sound.js`, no audio files); there is an in-app toast, and a browser notification when the page is in the background (🔔 in the top bar asks for permission; 🔊 mutes). Browsers allow sound only after the first tap on the page.
- **Conversations.** `chat.exchange` (e.g. a Slack thread where agents agreed on something) makes the participants walk together and talk in speech bubbles, ending with 🤝 when `agreed` is true. Demo mode plays scripted conversations; live mode, with "חיים במשרד" on, only adds rare emoji small talk (no invented content).
- **Idle life.** Stretching, sipping coffee, looking around, leaning back, yawning at night.
- **Actions (⚡).** Ring the bell, coffee break, stretch, celebrate, a short chat, team meeting, everyone back to desks, ambient life on/off, room time. All local animation: nothing is sent to an agent.
- **Camera.** Drag orbits all the way round the vertical axis (the wall between you and the room fades out), ⟲ / ⟳ and the arrow keys rotate, wheel / pinch zooms, "איפוס מצלמה" returns home.

```bash
# PR opened → the bell rings (pr can be a number or the PR URL)
curl -X POST "$OFFICE/api/ingest" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"pr.opened","pr":"https://github.com/owner/repo/pull/7","title":"Office v6"}'
# a Slack discussion where two agents agreed
curl -X POST "$OFFICE/api/ingest" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"chat.exchange","participants":["tab","hermes"],"topic":"form bug","agreed":true,"source":"slack",
       "lines":[{"agent":"tab","text":"ראית את הבאג בטופס?"},{"agent":"hermes","text":"כן, כותב בדיקה"}]}'
```

`chat.exchange`: 2–4 participants (taken from `participants` and from the speakers of `lines`), up to 6 lines of up to 90 characters each, `agreed` true/false, optional `topic`, `source`, `link`. Aliases: `chat`, `conversation`, `agreement`, `slack.exchange`; `pr.open`, `pr.created`, `pull_request.opened`.

Reliability, alerts, reviews, the replay and `/api/tasks` work as before.

```mermaid
flowchart LR
  A[Agents<br/>Claude · GPT · Hermes] -- "POST /api/ingest<br/>Bearer token per agent" --> W[Cloudflare Worker<br/>worker.js + server/]
  W --> DO[(Durable Object<br/>SQLite: events + agent state)]
  DO -- WebSocket /api/ws --> UI[Browser<br/>Three.js office]
  UI -- "GET /api/events?since=N<br/>(catch-up / fallback)" --> W
  O[Owner login] -- session cookie --> W
```

**Event kinds** (`POST /api/ingest`): `task.start`, `task.done`, `task.failed`, `task.queued`, `status`, `usage`, `config`, `heartbeat` (full snapshot), plus validated `review`, `pr.merged`, `deploy`, `handoff`, `pr.opened` and `chat.exchange`. Unknown kinds are kept as free-form log events. A `task.start` / `task.queued` may carry `from_agent` (who passed the work on).

Key design decisions:

- **The token is the identity.** Each agent writes with its own bearer token (`AGENT_TOKEN_<ID>`); a report is always filed under that agent, and naming another agent in the body returns `403`.
- **One Durable Object as the hub.** It stores events and each agent's state in SQLite and fans updates out over WebSocket; `GET /api/events?since=N` is the polling fallback.
- **Data-driven roster.** Characters, colours, emblems and skills live in `roster.json`; an unknown agent auto-creates a character. Adding an agent is config, not code.
- **Strict where it matters, tolerant where it doesn't.** `review`, `pr.merged` and `deploy` are validated (`400` with details); the original kinds are never rejected, so existing agents keep working. Retries of the same review replace it.
- **Everything derived from reported events.** Alerts, the 7-day graph and the reliability score (success 60 / stability 25 / code quality 15) are computed from what agents already send; thresholds live in one place in `insights.js`.
- **Private by default.** Live data needs a password login (signed HttpOnly cookie, login rate-limited per IP). The public `/showcase` route renders demo mode only and never calls the private API.
- **No build, no assets.** All 3D geometry is generated in code with vendored Three.js; static furniture is merged per material, pixel ratio and shadows drop automatically on slow phones, and the render loop pauses in background tabs. `prefers-reduced-motion` is respected.

### Main endpoints

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/ingest` | agent token | One report |
| `POST /api/agents/:id/heartbeat` | that agent's token | Full snapshot in one call |
| `POST /api/login` / `POST /api/logout` / `GET /api/me` | — | Session |
| `GET /api/agents[/:id]`, `GET /api/events`, `GET /api/ws` | session | Live state and event feed |
| `GET /api/reviews`, `GET /api/changes`, `GET /api/replay` | session | Reviews, today's changes, day replay |
| `POST /api/tasks` | session | "Give a task" |
| `GET /api/summary[?format=text]` | session or agent token | Morning summary |

Example report:

```bash
curl -X POST "$URL/api/ingest" -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"task.start","task":{"id":"pr-61","title":"Agent panel PR"},"activity":"running the test suite"}'
```

Ready-made hooks are in [`integrations/`](integrations/) (a shell hook, a Node reporter and a curl example).

## Embed it

```html
<iframe src="https://agent-office-demo.orworkdelevski.workers.dev/showcase"
        title="Agent Office" loading="lazy"
        style="width:100%;aspect-ratio:16/9;border:0;border-radius:20px"></iframe>
```

Options: `bg=transparent` or `bg=light`, `loop=12` (camera loop in seconds). The route sends `frame-ancestors *`, so any site can embed it.

## Tech stack

- **Cloudflare Workers** (free tier): static assets + a Worker + one SQLite-backed **Durable Object**
- **JavaScript** (ES modules), no framework and no build step
- **Three.js r170** (vendored) for the isometric 3D scene; SVG/canvas emblems
- **WebSocket** realtime with polling fallback
- **node:test** unit tests (no dependencies)
- UI in Hebrew (RTL)

## Run locally

```bash
npm test                          # unit tests
cp .dev.vars.example .dev.vars    # local secrets for wrangler dev (gitignored)
npx wrangler dev                  # site + API + Durable Object on http://localhost:8787
```

Deploy with `npx wrangler deploy`. Secrets are set with `npx wrangler secret put NAME` and never committed: `OFFICE_PASSWORD`, optional `SESSION_SECRET`, one `AGENT_TOKEN_<ID>` per agent, and the legacy `INGEST_TOKEN`.

## Status

Live and in active development. Shipped in versions: v2 (3D office), v3 (reviews, merges, deploys), v4 (activity line, handoffs, budgets, replay, morning summary, meeting room) and v5 (reliability score, give a task).

## Author

**Or Delevski** · https://ordelwebsite.vercel.app
