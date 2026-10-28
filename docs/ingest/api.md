# Interview import — the API

> **In fun-mem v2** this is the contract for whatever sends a transcript in: there is no interview
> page in this repository yet (v1's lived in `apps/web/src/pages/Ingest.tsx` there). A client signs
> the person in, then calls these routes with their session token.

All routes need a signed-in member of the archive (`Authorization: Bearer <session token>`);
anyone else gets `404`, never a hint that the archive or a job exists. Ids in paths may be in any
case: they are read in lower case, so one archive is one archive.

**Who may.** Starting an import, saving a preview and undoing your own import need a role that adds
memories: **owner, steward or contributor** (FR-100). Undoing somebody else's import needs **owner or
steward**. Any other role (viewer, minor viewer, reviewer, gifter, sponsor admin) gets
`403 { code: "forbidden", reason: "role" }` and nothing is started or written. Listing the imports is
open to every member. The ordinary note routes (create, edit, delete, restore) follow the same rule, so a
read-only member cannot change an imported memory by hand either: `403 { code: "forbidden", reason: "role" }`. Membership and role are checked again *inside* the transaction that writes the
notes: a member removed (or made read-only) while their import runs gets nothing written, and the job
fails with `code: "forbidden"` (`reason: "membership"` or `"role"`; someone no longer a member is
answered `404` for it, like any stranger).

An import is a **job**: an hour of speech is tens of model calls, so it is started, polled and its
outcome fetched, and survives the page being closed. The synchronous form simply waits on the same job.

## Stories mode (the default)

With `FUNMEM_IMPORT_MODE` unset or `stories`, an import writes the interview's **stories**
(`server/api/src/stories/`; design: `docs/superpowers/specs/2026-10-28-interviews-become-stories-prd.md`):

1. The interview is kept with its transcript as soon as the import starts (`public.interviews`).
   Bringing the same words in again picks up the interview that is still waiting.
2. The AI reads the whole interview (up to ~200k tokens a part) and plans its stories, one per period
   of the narrator's life, looking up the project's notes as it goes (read-only).
3. Each story is written in the third person; every sentence cites the transcript lines it comes from.
4. Code checks every name, number, date, place and quotation against the cited lines; an AI judge
   rules only on whether anything is made up (wording is free). A failing story is written again with
   the reasons, twice at most; what still fails is left out and listed in the memory's `notes`.

Each outcome memory then has `method: "story"`, plus `tellers`, `until`, `sources` (each sentence with
its lines `from`/`to`, times and words) and `flags` (sentences more certain than the speaker was).
Greetings and small talk are in no story: they stay in the interview's transcript.

When the stories cannot be written (no `NVIDIA_API_KEY`, a rejected key, the 12-minute deadline, the
call budget), the outcome is `previewed` with no memories and `pending: { reason }` (`no_model`,
`auth`, `unavailable`, `deadline`, `budget`, `bad_plan`); the interview waits with its transcript.

Saved stories carry their metadata: `recorded` (when it was told), `contributors` (who told it),
`extra.sources`, `extra.interviewId`, `extra.writtenBy`; their revision reason is `import`. Undoing
the import also deletes its interview.

| Route | |
|---|---|
| `GET /v1/archives/:id/interviews` | members: `[{ id, name, recordedAt, status: "pending" \| "written", mine, stories }]`, newest first |
| `GET /v1/archives/:id/interviews/:interviewId` | members: the same, plus `transcript` (as it arrived), `options` and parsed `turns` |

`FUNMEM_IMPORT_MODE=memories` brings back the earlier import described below, where every spoken line
becomes a memory.

## Start

`POST /v1/archives/:archive/ingest`

```jsonc
{
  "transcript": "…" | { "segments": [ … ] },   // required: text, or the JSON itself
  "save": true,          // write the notes now. Default false: a preview to read, edit and save.
  "async": true,         // answer 202 with the job at once (otherwise wait and answer with the outcome)
  "teller": "Grandma Sunja",            // the person telling, when one person is
  "interviewees": ["SPEAKER_00"],       // speaker ids whose words are testimony (omit: decided from the transcript)
  "speakerNames": { "SPEAKER_00": "Grandma Sunja" },   // per speaker, when several people tell
  "source": "Sunja, spring 2026",       // written under each memory
  "confirm": true,       // go ahead although who is telling was only a low-confidence guess
  "force": true          // import again although this interview was already imported
}
```

## Follow

| | |
|---|---|
| `GET …/ingest/:job` | `{ id, status: running\|succeeded\|failed\|cancelled, stage: reading\|organizing\|checking\|saving\|done, progress: {done,total}, startedAt, finishedAt?, elapsedMs, canCancel, outcome?, error? }`. Reading a job also **keeps it alive** (see below): a review page that stays open polls this. |
| `POST …/ingest/:job/cancel` | Stops it while it is `reading`, `organizing` or `checking`: `200` with the job, which then ends `cancelled` and nothing is saved. Once it is `saving` it can no longer be stopped: `409 { code: "too_late" }` (it finishes, and can be undone). On a job that has already finished: `200`, nothing changes. `canCancel` in the job says which applies. |
| `POST …/ingest/:job/save` | Writes the preview the job is holding. Body: `{ "memories": [{ "index", "skip"?, "title"?, "type"?, "body"?, "occurred"? }], "force"? }` (no body: save it as it is). All or nothing; once only. A change the server cannot read is **refused** (`400 bad_request`), never ignored: `index` must be a whole number from 0, `skip` a boolean, `title`/`type`/`body` strings, `occurred` a string or null, and `memories` a list. |
| `GET …/ingest-runs` | the archive's imports, newest first: `{ id, createdAt, source, mine, notes, undone }`. `source` is `null` once an import is undone or its notes are all gone. Every member. |
| `POST …/ingest-runs/:run/undo` | takes an import back as a unit → `{ erased, kept: [{ id, title, reason }], alreadyUndone }`. Erases the notes it made, except any somebody has worked on since, which are kept and say why: `edited` (a revision other than the import's own; a rename cascade from another note does not count), `linked` (a note a person wrote, edited or restored since links to it, including one memory of the same import that a person has edited; a link between memories nobody touched does not count, and a kept note never pulls others in). The notes are locked first and the decision is made afterwards, so an edit or a link committed while the undo waited is seen. Undo (and deleting a note by hand) also removes, from the OTHER notes, the machine-written `> ⚠ May disagree with [[erased title]] … that note says “…”` lines that quote an erased note, as revisions with the reason `erasure-cascade` (which, like `rename-cascade`, does not count as somebody having worked on the note); a person's own text and links are never touched. A preview prepared earlier is re-checked at save and drops markers whose source is gone. One residue: the OLDER saved versions of the other note still hold the line (the revision log is append-only). Two undos at once erase once: the second answers `alreadyUndone: true`. Afterwards the import keeps no file name and no hash of its words, and the job that made it no longer holds them (`outcome.undone: true`, `memories: []`). |

**How long a job is kept.** A job lives on *idle* time, refreshed whenever its owner reads, saves or
cancels it: an unsaved preview 60 minutes, any other finished job 15. An unsaved preview also has an
absolute life of 3 hours, however often it is read. Nobody else's activity can take a preview from
someone who is looking at it: when the server is full of fresh previews, a new import is told to wait
(`429 busy`, `reason: "server"`).

Memory is bounded by size, not only by count. One person keeps at most 10 finished jobs and 8 MB of
them; one archive at most 20 unsaved previews (`429 busy`, `reason: "previews"`: save or finish
reviewing one, then try again); the server at most 500 finished jobs and 256 MB. A hard limit of 15
minutes stops an import that hangs, in any stage before `saving` (`INGEST_HARD_LIMIT_MS` overrides it;
`INGEST_USER_BYTES` and `INGEST_TOTAL_BYTES` override the byte caps).

Jobs are kept in the database (`public.ingest_jobs`), so every instance of the API sees the same ones:
a job started through one can be followed, cancelled and saved through another, and "the server" in
the limits above is the whole deployment. A job whose runner stopped (a server restart, a Worker
isolate let go) is reported `failed` with `code: "interrupted"` once it has been silent for two
minutes; nothing of it was saved, and importing again is safe. The transcript itself is never kept:
only while a job waits for the Worker's queue, and it is cleared the moment the job is picked up.

## The outcome

`outcome.status` is one of

- `saved` — notes written; `saved: [{id, title, index}]`, `runId` for undo
- `previewed` — nothing written; `memories` to read and `…/save`
- `needs_confirmation` — who is telling was a close call; pick `interviewees` (or `confirm`)
- `duplicate` — this interview (the same words, whatever the file format or speaker labels) is already
  in the archive; `duplicateOf` says when. Any import of it whose notes are still there counts, so
  "import it again anyway" followed by an undo of the second copy still finds the first.

with `memories[]` (`id, title, type, occurred, body, notes, turns, anchor, startSec, endSec, method: ai-grounded|verbatim, speaker, speakerName?, conflicts?`),
`speakers`, `roles` (`source`, `confidence`, `reasons`, `needsConfirmation`), `warnings` (what was tidied or assumed),
`degraded` (`windows` the AI service could not process, and why: those were saved as the speaker's own words),
`check` (`complete`, `skipped`: every sentence of every memory is compared with what the archive already
says, within 60 seconds. `complete: false` means something cut it short: the time limit, the call budget or
a failure of the AI judge; `skipped` counts the memories the time limit kept it from reaching, and
`reason` says why when it is not complete: `time` (the minute ran out or it was cancelled), `ai` (a judge call
failed or timed out, even after the duplicate call), `budget` (the import's judge calls were used up). Their words
are untouched either way), and `stats`
(`turns`, `windows`, `rounds`, `retried`, `exit`, `coverage`).

**Memory ids.** Every memory has an `id` (`m1`, `m2`, …) that stays the same from preview to save.
A disagreement with *another memory of the same interview* names it as `source.id = "run:<memory id>"`
in a preview (link to that card, not to a note); once saved, `source` is the real note. When a save
changes a title (an edit, or because the archive gained a note with that title meanwhile), every link
to the old title in the other memories follows it; a memory left out takes the disagreement markers
that named it with it.

**Anchor.** `anchor` identifies the *passage* a memory was made from, not its position: the first (up to
8) words of its first source turn, lower-cased, letters and digits only. It is identical for the same
passage whether who is telling was guessed or chosen, while `turns` (turn numbers) shift between the two
(the interviewer's "mm-hm" lines are folded in only once the teller is settled). A review screen uses it
to carry a person's edits from one preparation of an interview to the next (v1's page did). Two memories can share an
anchor; a client must then treat the passage as ambiguous and not carry an edit onto either.

An import links only to notes **every member** can read: never to a note marked private, even the
importer's own.

## Errors

`{ "error": "…", "code": "…" }` with one of: `empty` · `unreadable` · `no_speech` · `too_long` (413) ·
`too_many_segments` · `too_large` (413, the request) · `bad_request` · `busy` (429, with `retry-after`
and `reason: archive|user|server|previews`) · `duplicate` (409) · `cannot_save` · `forbidden` (403, with
`reason: "role"`) · `too_late` (409, cancel while saving) · `timeout` (504) · `cancelled` (409) ·
`interrupted` (a job's `error` only: its runner stopped) · `internal` (500). A transcript the reader cannot make sense of is `unreadable` (400), whatever went wrong
inside the reader. No answer and no log line repeats the transcript's or a note's words.

A refused save (`cannot_save`) says why in a code, so a page need not read the sentence:
`{ "code": "cannot_save", "reason": "no_memory" | "title" | "type" | "body_too_long" | "date" |
"nothing_selected" | "nothing_to_save" | "already_saving", "index": <0-based memory, when it is about one> }`.
Control characters (NUL and the rest of C0, except tab and line ends) in a person's edited title or text are
removed, not refused. `source`, `teller` and `speakerNames` are normalised to NFC and one line (a macOS file name
arrives decomposed), and an import's file name is scrubbed from the record as soon as its last note is erased, by any path.

## The ordinary note routes this feature relies on

- **Roles.** `POST/PUT/DELETE /notes`, `…/restore` and `POST /chunks/rebuild` need owner, steward or contributor (403 `{code:"forbidden",reason:"role"}` otherwise; strangers 404). The role is read again, `FOR SHARE`, as the first statement inside the write's transaction, so a member demoted or removed while their write waited in the queue is refused (403 / 404). The assistant's `create_note` / `update_note` tools refuse for read-only roles.
- **Limits and refusals.** A note body may hold 200,000 characters (413 `too_long`) and 1,000 `[[links]]` (400 `too_many_links`); a request over 2 MB is 413 `too_large`; a body that is not a JSON object, text that is not JSON, a field that is not text, or a missing title or type is 400 `bad_request`; a new `occurred` must look like `1987`, `1987-03`, `1987-03-15`, `~1948` or `unknown` (400 `date`). C0 control characters in a title or body are removed. All of this is decided before the archive's write lock is taken.
- **Writers queue.** Writers to one archive wait their turn inside the API process before they take a database connection (the database advisory lock, keyed on the lower-cased archive id, still serialises across processes), so many waiting saves cannot hold every connection.
- **Shutdown.** On SIGTERM/SIGINT the embedding pass stops between batches; the server waits at most 5 s for it and 2 s for requests in flight, then closes the pool. A second signal at least a second later exits at once. A lost database connection is logged (`database connection lost: pg <code>`) and does not stop the server.
- **Migrations.** v2's one migration (`supabase/migrations/20261019180000_initial_schema.sql`) holds all of v1's, including the import records and their scrub-on-erase trigger and the revision reason `erasure-cascade`.
- **Links by title.** Links an import makes are by title, read when the job starts: a note renamed before the save leaves those links unresolved (`[[Busan]]`); her words are intact; re-link by editing.

## Configuration

| Variable | Default | |
|---|---|---|
| `FUNMEM_IMPORT_MODE` | `stories` | `memories` for the earlier import |
| `NVIDIA_API_KEY` | — | stories mode: without it the interview is kept and its stories wait; memories mode: every memory is the speaker's own words |
| `NIM_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b` | |
| `NIM_CONCURRENCY` | 4 | model calls in flight across the whole server |
| `NIM_HEDGE_MS` | 40000 | a call this slow gets one duplicate beside it; `0`, a negative number or `off` turns it off |
| `FUNMEM_TZ` | `UTC` | the time zone of the date written in a "may disagree" marker (an invalid zone falls back to UTC) |
| `INGEST_HARD_LIMIT_MS` | 900000 | |
