#!/usr/bin/env bash
# Agent Office — Claude Code hook reporter (PostToolUse / Stop).
# Install: save as ~/.claude/hooks/office-hook.sh, chmod +x, then add the
# settings.json snippet from settings-snippet.json. Token comes from the
# AGENT_OFFICE_TOKEN env var (see the snippet).
set -u
URL="https://agent-office-demo.orworkdelevski.workers.dev/api/ingest"
AGENT="${AGENT_OFFICE_NAME:-claude-code}"
[ -z "${AGENT_OFFICE_TOKEN:-}" ] && exit 0
TOOL=$(python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(d.get("tool_name") or d.get("hook_event_name") or "event")
except Exception: print("event")' 2>/dev/null)
curl -s -m 3 -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "X-Ingest-Token: $AGENT_OFFICE_TOKEN" \
  -d "{\"agent\":\"$AGENT\",\"kind\":\"${TOOL:-event}\",\"value\":\"+1\",\"note\":\"Claude Code hook\"}" >/dev/null 2>&1 || true
exit 0
