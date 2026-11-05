#!/usr/bin/env bash
# Agent Office — report from any agent with curl. TOKEN = this agent's AGENT_TOKEN_<ID> value.
set -eu
URL="${AGENT_OFFICE_URL:-https://agent-office-demo.orworkdelevski.workers.dev}"
TOKEN="${AGENT_OFFICE_TOKEN:?set AGENT_OFFICE_TOKEN}"
post() { curl -s -m 5 -X POST "$URL/api/ingest" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1"; echo; }

post '{"kind":"task.start","task":{"id":"t-1","title":"Example task","link":"https://example.com"}}'
post '{"kind":"task.done","task":{"id":"t-1"}}'
post '{"kind":"status","status":"idle"}'
post '{"kind":"usage","usage":{"messages":12,"tokens":48000,"cost":0.42,"tasks":3}}'
post '{"kind":"config","config":{"model":"MyAgent","skills":["research","code"],"tools":["browser"]}}'

# Old format (shared X-Ingest-Token) still works:
# curl -X POST "$URL/api/ingest" -H "Content-Type: application/json" -H "X-Ingest-Token: $INGEST_TOKEN" \
#   -d '{"agent":"ritman","kind":"lead.new","value":"+1","note":"ליד חדש מהאתר"}'
