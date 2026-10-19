# fun-mem v2

A family memory wiki. Relatives write down, or tell in a recorded interview, what they remember
about one person. The app keeps it as linked notes, and its AI only ever repeats what was written:
when nothing was written, it says so.

This repository is the clean restart of fun_mem v1 (github.com/URDJMK/fun_mem, no longer
developed). It holds v1's core and its server, and a deliberately plain web app: the new design
comes later.

## What is here

| | |
|---|---|
| Sign-in | Google, through Supabase Auth |
| Wiki notes | write, read, edit, delete; `[[links]]` between notes, backlinks, renames that rewrite the links to a note, the revision history (API) |
| Interview ingestion | a transcript becomes dated memories in the speaker's own words, tidied by the AI and checked against what she said (API only: its screen is being built separately). See [docs/ingest/api.md](docs/ingest/api.md) |
| AI | ingestion, the archive assistant, the draft composer, and Q&A that answers only from the archive (API only) |

Not here yet: photos, markdown export (the welcome page still promises it), and any AI screen.

## Run it

You need Node 22+, pnpm 10, Docker Desktop, the Supabase CLI, `just`, `pre-commit` and `gitleaks`.

```sh
cp .env.example .env   # fill in the Google OAuth client, and NVIDIA_API_KEY for ingestion
just setup             # dependencies and the git hooks
just db-up             # the local Supabase stack (stop v1's first: `supabase stop` in fun_mem)
just api               # the API on http://127.0.0.1:8788
just web               # the web app on http://127.0.0.1:3000
```

Open http://127.0.0.1:3000, not `localhost`: the browser keeps the sign-in per address. `just`
lists every recipe; `just check` runs what CI runs.

## Layout

| | |
|---|---|
| `packages/core` | the notes model: `[[wikilinks]]`, titles, the rename cascade, dates, chunking |
| `packages/persona` | grounded answers: evidence, abstention, cleaning text |
| `server/api` | the Hono API; `src/app.ts` lists every route |
| `apps/web` | sign-in and the wiki notes, unstyled |
| `supabase` | the local stack's config and the schema (one migration) |
| `docs` | the ingestion API, conventions, decisions ([docs/adr](docs/adr)) |

## Where to start reading

1. `server/api/src/app.ts` — every route, and which module serves it
2. `server/api/src/notes.ts` — notes, revisions, links
3. `server/api/src/ingest.ts`, then `ingest-pipeline.ts` — the ingestion workflow
4. [docs/ingest/api.md](docs/ingest/api.md) — the contract for whatever sends transcripts in
5. [CONTRIBUTING.md](CONTRIBUTING.md) — branches, commits, secrets
