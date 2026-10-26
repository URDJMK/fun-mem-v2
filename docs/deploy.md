# Deploying

```
browser ──► Vercel (apps/web, static)          ──/v1/*──►  Cloudflare Worker (server/api)
              same origin: vercel.json rewrite              │  createApp: every route
                                                            │  Cron Trigger (every minute): embeddings, job sweep
browser ──► Supabase Auth (Google sign-in)                  │  Queue: interview imports
                                                            │  Workers AI: bge-m3 embeddings
                                                            └──► Supabase Postgres, transaction pooler (6543)
```

The browser talks to Supabase only to sign in; every read and write goes through the API
([ADR 0002](adr/0002-data-api-reaches-no-table.md)). Local development is unchanged: `just db-up`,
`just api` (the Node server, `server/api/src/main.ts`) and `just web`.

Nothing below can be done without your accounts. Each step says what you create and what to
copy where; no value in this file is real.

## 1. Supabase

1. Create a project (supabase.com → New project). Pick its **region** deliberately: the data lives
   there, and the Worker runs next to it (smart placement).
2. **Database** → Connect: copy two connection strings.
   - **Transaction pooler** (port 6543): the Worker's `FUNMEM_DB_URL`.
   - **Session pooler** (port 5432), or the direct connection: for applying the migrations.
3. Apply the migrations, in order, with the session string:
   ```sh
   for f in supabase/migrations/*.sql; do psql "$SESSION_DB_URL" -v ON_ERROR_STOP=1 -f "$f"; done
   ```
   (or `supabase link` and `supabase db push`). Never edit a migration that has run.
4. **Project Settings → API**: copy the **Project URL** (`https://<project-ref>.supabase.co`) and the
   **anon / publishable key**. Both are public; the web app ships them.
5. **Project Settings → JWT Keys**: the project must sign with an **asymmetric** key (ECC P-256 or
   RSA). The API checks every sign-in against `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`,
   which lists only asymmetric keys: a project still on the legacy shared secret answers every API
   call `401`. If it says "legacy JWT secret", create a new asymmetric signing key and rotate to it.
6. **Authentication → Providers → Google**: turn it on with the OAuth client from Google Cloud
   (below). The app signs in with Google only, so turn **Email** sign-ups off: an email account
   nobody confirmed should never exist.
7. **Authentication → URL Configuration** (once section 3 has given you the Vercel domain): **Site URL**
   `https://<your-vercel-domain>`; **Redirect URLs** the same, plus `https://<your-vercel-domain>/**`.
8. Recommended: **Database → Settings → SSL enforcement** on.

**Google Cloud Console** → APIs & Services → Credentials → OAuth client ID (Web application):
- Authorized JavaScript origins: `https://<your-vercel-domain>`
- Authorized redirect URIs: `https://<project-ref>.supabase.co/auth/v1/callback`

(The local stack's redirect URI, `http://127.0.0.1:54321/auth/v1/callback`, can stay for development.)

## 2. The API Worker (server/api)

You need a Cloudflare account with a `workers.dev` subdomain. Wrangler signs in with
`npx wrangler login`, or, non-interactively, with `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare
Workers", plus Queues: Edit) and `CLOUDFLARE_ACCOUNT_ID` in the environment.

```sh
cd server/api
npx wrangler queues create funmem-ingest
npx wrangler secret put FUNMEM_DB_URL         # the transaction pooler string (6543)
npx wrangler secret put FUNMEM_SUPABASE_URL   # https://<project-ref>.supabase.co
npx wrangler secret put NVIDIA_API_KEY        # optional: without it imports keep the speaker's own words
npx wrangler deploy
```

`wrangler deploy` prints the Worker's URL, `https://funmem-api.<your-subdomain>.workers.dev`. Check
it: `/health` answers `{"ok":true}`, and `/ready` `{"ready":true,"db":"ok",...}` once the database
is reachable.

What the Worker runs, and why it differs from the Node server:

| | Node server (`main.ts`) | Worker (`worker.ts`, `wrangler.toml`) |
|---|---|---|
| database | one pg.Pool for the process | a pool per request (`request-pool.ts`), over the transaction pooler |
| embeddings | bge-m3 in-process (568 MB) | Workers AI `@cf/baai/bge-m3` (binding `AI`) |
| embedding drain, job sweep | timers | Cron Trigger, every minute, through `/internal/*` |
| an import nobody waits on | runs in the process | Queue `funmem-ingest`; the consumer runs it (≤ 15 min) |
| import jobs | `public.ingest_jobs` | the same table: any isolate carries any job |
| shutdown | drains, then closes the pool | nothing to do |

**Plan limits.** The Workers Free plan allows 10 ms of CPU per request, and 50 subrequests. Reading
and checking an interview can take more: if imports fail with error 1102 ("exceeded resource
limits"), move to Workers Paid and uncomment `[limits] cpu_ms` in `wrangler.toml`.

**The Worker's vectors are not the local model's** (that one is an int8 export), so they carry
their own model version: the first cron runs embed the whole archive once with Workers AI.

**Locally, as a Worker**: `server/api/.dev.vars` (git-ignored) holds the secrets, then
`pnpm --filter @funmem/api worker:dev --env local`. The `local` environment leaves out Workers
AI (its binding needs a Cloudflare login even in development) and embeds with the deterministic
test provider. `--test-scheduled` adds `/__scheduled` to run the cron by hand.

## 3. The web app (apps/web) on Vercel

1. Put the Worker's origin in `apps/web/vercel.json`, in the `/v1/:path*` rewrite's destination:
   `https://funmem-api.<your-subdomain>.workers.dev/v1/:path*`, and commit it. Until then the
   build refuses to run (`scripts/check-api-rewrite.mjs`): a site whose every API call fails is
   worse than no deployment.
2. Vercel → Add New Project → import this repository. **Root Directory: `apps/web`**; keep
   "Include files outside the root directory" on (the app uses `@funmem/core` from
   `packages/core`). Framework, install and build commands come from `vercel.json`: only
   `@funmem/web` and its workspace dependencies are installed.
3. Environment variables (Production, and Preview if you use previews):
   - `VITE_SUPABASE_URL` = the Project URL
   - `VITE_SUPABASE_ANON_KEY` = the anon / publishable key
   They are read at build time: change one, redeploy.
4. Deploy, then finish Supabase step 7 and the Google origins with the domain Vercel gave you.

## 4. Check it

Sign in with Google at the Vercel URL, create an archive, write a note, search for it, ask about
it, import a short transcript and save it, then undo the import. A minute after writing, the
note's chunks have Workers AI vectors (`select count(*) from public.chunk_embeddings`).

## Who sees the data

Supabase (database, sign-in), Cloudflare (the Worker, the queue, Workers AI for embeddings),
Vercel (the static site; it forwards `/v1` and sees those requests), Google (sign-in: name, email,
photo), and NVIDIA when `NVIDIA_API_KEY` is set (interview text for the AI step). NVIDIA's free
API catalog is a trial: its terms do not allow production use or personal data, so a real
deployment needs a paid plan or another provider before real interviews go in.
