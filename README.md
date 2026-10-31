# Agent Office Demo (משרד הסוכנים)

An isometric 3D "agent office" dashboard: every toy character in the office is an AI agent
working for the business, driven by a live (simulated) event stream. Inspired by a Hebrew
tech reel — the office itself is the dashboard: when five agents work in parallel, you see
what each one is doing in a second instead of reading logs.

**All data is fictional demo data (דמו). Nothing real is sent or charged.**

- 3D office built entirely in code with Three.js (vendored, no external assets, no paid APIs).
- Hebrew RTL UI. The web UI is Hebrew; this README is English for portfolio value.
- Mock realtime event feed (`events` log), per-agent status panels, KPI cards, morning-meeting mode.
- Desktop layout + mobile bottom nav. Loaders, double-click guards and error/retry on all controls.

## Run locally
Serve `public/` with any static server, e.g. `npx serve public`, and open it in a browser.

## Deploy
Static site deployed as Cloudflare Workers static assets: `npx wrangler deploy` (see `wrangler.toml`).
