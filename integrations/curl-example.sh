TOKEN=PASTE_TOKEN_HERE
curl -X POST https://agent-office-demo.orworkdelevski.workers.dev/api/ingest \
  -H "Content-Type: application/json" -H "X-Ingest-Token: $TOKEN" \
  -d '{"agent":"ritman","kind":"lead.new","value":"+1","note":"ליד חדש מהאתר"}'
