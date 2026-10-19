## What and why

<!-- What changes, and why it is needed. Link the issue if there is one. -->

## How it was checked

<!-- What you ran or tried, and what you saw. "just check passes" plus anything by hand. -->

## Checklist

- [ ] `just check` passes (the server's tests need `just db-up`)
- [ ] no secrets, real transcripts or family data in the diff
- [ ] database changes are a new migration (no edited one)
- [ ] docs updated where behaviour changed (`docs/ingest/api.md` for the ingestion API)
