# Design baseline

Every main page of the web app, before any design changes, at 1440px (desktop, 1x) and 390px
(mobile, 2x). Taken 2026-10-28 from `main` at `98e5c5f`. Full-page shots, reduced motion on.

Files are `<order>-<page>--<desktop|mobile>.png`:

| | Page | Route |
|---|---|---|
| 01 | Landing (signed out) | `/` |
| 02 | Sign in | `/sign-in` |
| 03 | Projects | `/` |
| 04 | New project | `/new-archive` |
| 05 | Project home | `/a/:id` |
| 06 | Interviews | `/a/:id/interviews` |
| 07 | Add an interview (transcript import) | `/a/:id/interviews/new` |
| 08 | Stories | `/a/:id/stories` |
| 09 | A story | `/a/:id/stories/:noteId` |
| 10 | Write a memory | `/a/:id/stories/new` |
| 11 | People & places (opens the first person) | `/a/:id/people` |
| 12 | Timeline | `/a/:id/timeline` |
| 13 | Ask | `/a/:id/ask` |
| 14 | Members | `/a/:id/members` |
| 15 | Settings | `/a/:id/settings` |
| 16 | Live interview, setup ("who's here") | `/a/:id?simulate`, then Start interview |
| 17 | Live interview, recording | `/a/:id?simulate`, then Skip setup |

Signed-in pages use demo mode's sample archive (Grandma Nell). Demo mode signs in on `/sign-in`,
so 01 and 02 come from a second dev server with demo mode off.

16 and 17 need no microphone: `?simulate` on any page under `vite dev` (`apps/web/src/lib/live-sim.ts`)
swaps the microphone and Deepgram for a scripted interview, spoken word by word. A production
build can't turn it on. The capture blocks the coach's model, so 17 shows the question bank's
suggestions ("AI suggestions unavailable"), the same on every run and with no API call. 16 and
17 were added 2026-10-28 from `8211089`, with no app changes between them and the rest.

## Retake them

`capture.mjs` drives your installed Google Chrome with `playwright-core`, which is not a project
dependency:

```sh
pnpm --filter @funmem/web dev --host 127.0.0.1 --port 3001
VITE_SKIP_LOGIN=false pnpm --filter @funmem/web dev --host 127.0.0.1 --port 3002
mkdir -p /tmp/capture && cp design-baseline/capture.mjs /tmp/capture/
cd /tmp/capture && npm i playwright-core@1.56.1
node capture.mjs http://127.0.0.1:3001 http://127.0.0.1:3002 ./after
```

The script sits next to its own `playwright-core` install because Node resolves imports from the
script's folder, and keeping the package out of the repo leaves the workspace's dependencies alone.
