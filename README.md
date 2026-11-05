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
| `GET /api/reviews[?author=id]` | session cookie | Code reviews (newest last, up to 200) |
| `GET /api/changes[?day=YYYY-MM-DD]` | session cookie | What changed today: merged PRs, deploys, closed tasks (newest first; day = Israel time) |
| `GET /api/replay[?day=YYYY-MM-DD]` | session cookie | The day's stored reports plus a start-of-day snapshot, which the day replay plays back (the last 3 days are kept) |
| `POST /api/tasks` `{title, agent, note}` | session cookie | "Give a task": adds a card to that agent's **to do** column. Only a card: no agent is called or notified |
| `GET /api/summary[?since=ISO\|ms][&format=text]` | session cookie **or** any agent token | Morning summary: what happened since `since` (default: 18:00 yesterday, Israel time), as JSON with a `text` digest, or plain text |

### Event types (`POST /api/ingest`)

Every field is optional except `kind`. Fields can be nested (as below) or flat at the top level.
Strings are trimmed and stripped of markup; links must be `http(s)`.

| `kind` | Body | Effect |
| --- | --- | --- |
| `task.start` | `{"task": {"id", "title", "link"}}` | Sets *working on now*, adds the task as running |
| `task.done` / `task.failed` | `{"task": {"id"}}` (or no task = the current one) | Marks the task done / failed, clears *now* |
| `task.queued` | `{"task": {"id", "title", "link"}}` | Planned work: a card in the board's **לביצוע** column (aliases `task.todo`, `task.planned`). A later `task.start` with the same `id` moves it to **בעבודה** |
| `status` | `{"status": "working\|idle\|blocked\|offline", "task": {…}}` | Sets status (and optionally *now*) |
| `usage` | `{"usage": {"messages", "tokens", "cost", "tasks"}, "mode": "set\|add", "day": "YYYY-MM-DD"}` | Today's usage. `set` (default) = today's totals so far, safe to resend; `add` = increment. `cost` is in USD. Day = Israel time. `tasks` defaults to tasks finished today. |
| `config` | `{"config": {"model", "skills": [], "tools": [], "description"}}` | Capabilities shown on the card (merged) |
| `review` | `{"pr", "repo", "title", "author_agent", "reviewer_agent", "verdict", "findings": [], "summary", "round", "ts"}` | A code review: who reviewed which agent's PR and what they found. Feeds the **ביקורות** window and the findings-per-PR trend. See below |
| `pr.merged` | `{"pr", "repo", "title", "author_agent", "merged_by", "ts"}` | A PR landed. Shows in **מה השתנה היום** |
| `deploy` | `{"target", "env", "version", "status": "success\|failed\|rolled_back", "link", "note", "ts"}` | Something went live (or failed to). Shows in **מה השתנה היום** |
| `handoff` | `{"to", "task_id", "title", "link", "note", "from"}` | One agent passes a task to another: an arc flies between the desks, the task lands in the receiver's **to do** column, and the chain is shown on the card. See below |
| anything else | `{"value", "note"}` | The original free-form event: log line + animation |

`heartbeat` accepts Instinct's snapshot shape:
`{"status", "current": {"title", "since", "ref"}, "recent": [{"title", "done_at", "result": "ok|failed|queued"}], "usage": {...}, "capabilities": {"model", "skills", "tools"}}`.

### Reviews, merges and deploys (v3)

These three kinds are **validated**: a bad payload gets `400 {"ok":false,"error":"invalid review","details":["verdict: …"]}`
and nothing is stored. (The original kinds above are never rejected, so existing agents keep working unchanged.)

- `review`
  - `pr` (required): `12`, `"#12"` or the PR URL. A URL also fills `repo`.
  - `author_agent` (required): whose PR it is, e.g. `"hermes"`.
  - `reviewer_agent`: defaults to the agent sending the report.
  - `verdict`: `approved` · `changes_requested` · `commented` (default). Aliases: `approve`/`lgtm`, `request_changes`, `comment`.
  - `findings[]`: `{"severity", "title", "file", "line"}`.
    - `severity`: `critical` · `high` · `medium` · `low` · `nit` (aliases: `blocker`, `major`, `minor`, `info`).
    - A plain string counts as a `medium` finding. Up to 50 per review.
  - `summary`: up to 300 characters.
  - `round`: a second review round of the same PR is `2`. Re-sending the same `repo`+`pr`+`reviewer`+`round` replaces that review, so retries are safe.
  - `ts`: when the review happened (ISO or epoch ms). Defaults to now; future times are clamped to now.
  - The trend draws one point per PR (all its reviews summed) for each author, so Hermes's line going down is fewer findings per PR.
- `pr.merged`: `pr` or `title` is required. `merged_by` defaults to the sender. Re-sending the same PR replaces it.
- `deploy`: `target` is required. `env` defaults to `production` and `status` to `success`.
- `task.done` needs nothing new: every task that closes today shows in **מה השתנה היום** and in the agent's 7-day graph.

### Stuck / silent alert and the 7-day graph

- **Stuck** (תקוע): an agent has an open task, and nothing about that task arrived for more than **30 minutes**. Nothing means no `task.start`, `status` or `heartbeat` that names the task.
- **Silent** (שקט): no open task, but the agent reports by heartbeat (or last said `working`/`blocked`) and has sent nothing for 30 minutes.
- An agent that sent `{"kind":"status","status":"offline"}` is never flagged.
- The threshold is one constant, `ALERT_AFTER_MIN` in `insights.js`.
- Where it shows: a red ⚠ sign and a pulsing ring at the agent's desk, a red name tag, a banner above the agent list, the agent's card, and a red dot on the mobile **סוכנים** tab.
- **7-day graph**: each agent's card shows tasks done (green) and failed (red) per day for the last 7 days (Israel time). It is built from `task.done`, `task.failed` and the heartbeat `recent[]` list, with nothing extra to send.

### v4: activity line, handoffs, budgets, replay, morning summary, meeting room

- **Live activity line.** Add `"activity"` (or `"detail"`) to a `task.start`, `status` or `heartbeat` (`current.detail` works too).
  - It's up to 120 characters, e.g. `"activity":"running the test suite"`.
  - It shows under the agent's name tag in the room while they work, in the agent list and on the agent card.
  - A new task without one clears it, and so does finishing the task.
- **Handoffs.** Either send a `handoff`, or start the task on the receiving side with `"from_agent"`:
  - `{"kind":"handoff","to":"hermes","task_id":"k1","title":"Write tests","note":"tests for the trend"}` comes from the sender. `from` defaults to the sender.
    - The sender's copy is marked ↪️ "handed to Hermes", and its desk is freed.
    - The receiver gets the task queued, with the chain of who passed it on.
  - `{"kind":"task.start","task":{...},"from_agent":"tab"}` is sent by the receiver.
  - A full `"chain":["nova","tab"]` is accepted on `task.start` / `task.queued` as well.
  - The chain shows on the board card and the agent card, e.g. `Nova → Tab → Hermes`.
- **Daily budget and meter.** Set `config.budget`, e.g. `{"kind":"config","config":{"budget":{"cost":5}}}`.
  - The budget can be USD `cost`, `tokens` or `messages`, or a mix. `"budget": 5` means `{"cost": 5}`.
  - The agent card shows a meter against today's `usage`, and the tightest budget counts.
  - It turns amber at 80% and red when over. The agent list shows a 💸 chip at those two levels.
- **Day replay.** In live mode, press **⏪ שחזור יום** in the room. The room, desks, board, feed and **מה השתנה היום** play back from today's stored reports, at ×10, ×60 or ×600.
  - Drag the slider to jump to any moment. Alerts and offline states are computed for that moment.
  - The browser runs the same reducer as the server (`office-state.js`), so the replay matches what really happened.
  - **✕ חזרה לחי** goes back to live.
- **Morning summary.** `GET /api/summary` (or the **☀️ סיכום בוקר** button) returns the overnight digest:
  - tasks done or failed per agent;
  - what each agent is on now;
  - merged PRs, deploys and reviews;
  - who is stuck right now.
  - It is not sent anywhere by itself. To post it every morning, have any scheduler call it with an agent token:

```bash
# plain text, e.g. for a Slack incoming webhook at 08:30 (not wired up here; this is only an example)
TEXT=$(curl -s "$URL/api/summary?format=text" -H "Authorization: Bearer $TOKEN")
curl -s -X POST "$SLACK_WEBHOOK_URL" -H 'Content-Type: application/json' -d "$(jq -n --arg t "$TEXT" '{text:$t}')"

# JSON for your own formatting; since= takes ISO or epoch ms
curl -s "$URL/api/summary?since=2026-11-04T18:00:00%2B02:00" -H "Authorization: Bearer $TOKEN" | jq .counts
```

- **Meeting room.** When two or more agents are working at the same time on the same GitHub PR, they get up and sit together at the round table in the lounge. A matching repo link counts too, e.g. a reviewer and an author whose current `task.link` is the same PR.
  - Their tags read "👥 PR #120", and a toast says who moved.
  - They go back to their desks when one of them moves on.

### v5: reliability score and "give a task"

- **Reliability score** (0–100, on the agent card under **אמינות**). It is built only from events agents already send:
  - **Success, 60 pts:** the share of tasks finished in the last 7 days that were done rather than failed. If none finished, the agent gets 45, which is neutral.
  - **Stability, 25 pts:** −8 for every time the agent got stuck in 7 days, meaning an open task with no update for more than `ALERT_AFTER_MIN`.
    - Each silence counts once.
    - An agent that is stuck right now counts immediately.
  - **Code quality, 15 pts:** the findings-per-PR trend from reviews of the agent's own PRs.
    - Fully falling earns 15, flat earns 7.5, rising earns less.
    - With no reviews, the agent gets 7.5.
  - Labels: 85+ אמין מאוד · 70+ יציב · 50+ בינוני · below that דורש תשומת לב.
  - The card has an "איך זה מחושב?" explanation. The weights are `RELIABILITY` in `insights.js`.
- **Give a task** (**➕ משימה חדשה** on the task board, live mode): a title, an agent and an optional note.
  - It adds a card to that agent's **to do** column, marked ✍️ ידני.
  - That is all it does. No agent is called, messaged or triggered.
  - When an agent later reports `task.start` with the same `task.id`, the card moves to **in progress** like any other.
  - API: `POST /api/tasks` (session only, same-origin).

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

# a code review of Hermes's PR (sent by the reviewer)
curl -sX POST $URL/api/ingest -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"review","pr":"https://github.com/delevski/agent-office-demo/pull/12","author_agent":"hermes","verdict":"changes_requested",
       "findings":[{"severity":"high","title":"No timeout on the retry loop","file":"server/hub.js","line":40},{"severity":"nit","title":"Typo"}],
       "summary":"Good base; needs a timeout and a test for 5xx."}'

# a PR landed
curl -sX POST $URL/api/ingest -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"pr.merged","pr":12,"repo":"delevski/agent-office-demo","title":"Review card","author_agent":"hermes"}'

# a deploy
curl -sX POST $URL/api/ingest -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"kind":"deploy","target":"agent-office","env":"production","version":"c5d6aa9","status":"success"}'

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


## The office (v2)

The scene (`office.js`, Three.js r170, no model files or image assets — everything is generated in code):

- **Camera** — isometric, eased. Pinch (phone), wheel / trackpad pinch (desktop) and the **+ / −**
  buttons zoom towards the pointer, with limits; drag orbits within limits, right-drag / shift-drag /
  two fingers pan; **איפוס מצלמה** resets. Keyboard: focus the scene, then `+`, `-`, `0`.
  Tapping a character opens its panel, tapping the wall board opens the kanban, tapping the bookcase
  opens the skills list (tested with touch taps on a 390 px phone).
- **Room** — a diorama: walls with windows and drifting clouds, soft daylight with real window
  shadows and light shafts, dust motes, plants, sofa and lamp, a coffee corner with steam, a wall
  clock on real time and the events TV.
- **Agents** — every desk monitor glows in its agent's colour and shows the agent's emblem.
  Live status is visible at a glance: **working** = typing, code scrolling on the screen;
  **idle** = coffee break, leaning back with a mug; **blocked** = scratching head with a "?";
  **offline / never reported** = asleep on the desk, greyed out, screen off.
- **Emblems** (`emblems.js`) — original badges: monogram + colour + a small icon, drawn as SVG for
  the UI and on canvas for the 3D tags, monitors, kanban cards and shelves. Data-driven from
  `roster.json`:
  ```json
  { "id": "hermes", "name": "Hermes", "color": "#c986f2", "emblem": { "mono": "He", "icon": "wing" } }
  ```
  Icons: `tab, spark, wing, magnet, tag, chat, coin, pen, megaphone, hex, orbit, leaf`.
  An agent that is not in the roster gets its first letter and a deterministic icon automatically.
- **Kanban board** — on the back wall, readable when you zoom in; **לוח משימות** (or a tap on the board)
  opens the 2D version. Live mode shows only what agents reported: `task.queued` / `blocked` →
  לביצוע, `task.start` → בעבודה, `task.done` / `task.failed` → הושלם (failed is marked). Demo mode
  shows sample tasks of the demo characters, labelled דמו on the board itself.
- **Skills shelves** — one shelf row per agent; each skill from the agent's `config.skills` is a
  labelled box in the agent's colour. An agent that never sent `config` shows "אין נתונים".
- **Performance** — static furniture is merged into one draw call per material (about 110 draw calls
  for the furnished room, about 230 with nine characters), books and boxes are instanced, textures are ≤1024 px on phones
  (board 1536 px on desktop), pixel ratio is capped (1.5 phone / 2 desktop) and drops automatically,
  then soft shadows switch off, if a phone can't hold ~30 fps. The render loop pauses in background
  tabs. `prefers-reduced-motion` turns off camera easing, particles and the showcase orbit.

## Showcase (embed on a website)

`/showcase` (or `/?showcase=1`) renders the office **in demo mode only** — fictional characters and
sample tasks, no login UI, and it never calls the private API — with a slow cinematic camera loop.

```html
<iframe src="https://agent-office-demo.orworkdelevski.workers.dev/showcase"
        title="Agent Office" loading="lazy"
        style="width:100%;aspect-ratio:16/9;border:0;border-radius:20px;overflow:hidden"
        allow="fullscreen"></iframe>
```

Options (query string): `bg=transparent` (no background — place it over your own section),
`bg=light` (cream background), default brand-dark; `loop=12` (camera loop length in seconds).
The `/showcase` route sends `Content-Security-Policy: frame-ancestors *` so any site can embed it.
`capture=1` steps the scene frame by frame from `window.__office.step(dt)` for video export.

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
