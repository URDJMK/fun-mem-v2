# Stories from interviews (phase 1): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an imported interview becomes a few whole stories, written about the narrator, every sentence cited to the transcript and checked that nothing is made up. The transcript is kept with the interview, and every saved story carries its metadata.

**Spec:** `docs/superpowers/specs/2026-10-28-interviews-become-stories-prd.md`. This plan covers phase 1 (section 11): D1–D6, D10–D12, steps 1–5 and 9 of section 6, tables and metadata of section 7 for **new** notes, sections 5.1–5.4, 8 and 10. Not covered here: aliases, entities and linking (phase 2); extending and merging existing notes (phase 3).

**Deferred from the PRD, on purpose:**
- **Resuming a run from its last finished step** (PRD 6 and 8). In this plan a run that dies fails as `interrupted`, as imports do today. Because the interview and its transcript are already saved, "Write the stories" starts it again from the beginning, so nothing is lost.
- **The hour-long evaluation transcript** (PRD 10.1). No real one exists in the repo. The evaluation runs on the Sunja, Nell and WhisperX samples until one is provided.

**Architecture:**
- A new module `server/api/src/stories/` holds the workflow, as small single-purpose files.
- The AI steps call the existing NVIDIA client (`ChatModel.complete`), so its retries, slot limiter, hedging and timeouts are reused.
- Tools use a small JSON protocol in a loop: each answer is either a tool call or the result. Tests script the model as plain functions.
- The import job (`ingest-jobs.ts`) runs the story workflow instead of the old memory pipeline when `AppDeps.importMode === 'stories'`. The old pipeline stays selectable (`'memories'`) for rollback and keeps its tests.
- Saved stories reuse `persistImport`, which gains the metadata fields.

**Tech stack:** TypeScript, Hono, node-postgres, vitest 5, React 19, the existing NVIDIA NIM client.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/20261028120000_interviews.sql` | `interviews` table; `ingest_runs.interview_id`; `revision_reason` gains `import` |
| `server/api/src/stories/lines.ts` | numbered transcript lines; citations (`L12-L15`); token estimate; splitting into parts |
| `server/api/src/stories/tools.ts` | the JSON tool loop over `ChatModel.complete`; the read-only tools |
| `server/api/src/stories/plan.ts` | plan prompt, parse and validate |
| `server/api/src/stories/write.ts` | write prompt (with fix feedback), parse and validate a draft |
| `server/api/src/stories/check.ts` | code checks: citations, names, numbers, dates, quotes, title |
| `server/api/src/stories/judge.ts` | AI judge prompt and verdicts |
| `server/api/src/stories/workflow.ts` | the steps in order, budgets, deadline, fix loop, assembling the result |
| `server/api/src/stories/interviews.ts` | interview rows: create or reuse, mark written, list, read; routes |
| `server/api/src/ingest-pipeline.ts` | `MemoryMethod` gains `'story'`; `ProposedMemory` gains optional story fields |
| `server/api/src/ingest-jobs.ts` | runs the story workflow in stories mode; links the job to its interview |
| `server/api/src/ingest-save.ts` | writes metadata; records the interview on the run; undo removes the interview |
| `server/api/src/notes.ts` | `NewNoteInput` gains `recorded`, `contributors`, `extra`; batch insert writes them |
| `server/api/src/app.ts`, `main.ts`, `worker.ts` | `importMode` dep (env `FUNMEM_IMPORT_MODE`, default `stories`); interview routes |
| `server/api/test/helpers.ts` | the shared test context keeps `importMode: 'memories'` (existing tests) |
| `server/api/test/stories-*.test.ts` | tests per module, plus jobs and routes |
| `server/api/scripts/eval-stories.ts`, `server/api/test/fixtures/stories/*` | the real-model evaluation (section 10 of the spec) |
| `apps/web/src/lib/api.ts` | story fields, pending outcome, interview API |
| `apps/web/src/components/ImportRun.tsx` | story view: metadata line, sources, "not written yet" |
| `apps/web/src/pages/Interviews.tsx` | interviews with status and "Write the stories" |
| `apps/web/src/components/InterviewReview.tsx` | default interview name (date and topics); button label |
| `docs/ingest/api.md`, `docs/ingest/conflict-policy.md`, `docs/deploy.md` | the new behaviour and env vars |

## Interfaces (fixed here; every task uses these names)

```ts
// stories/lines.ts
export interface Line {
  n: number; speaker: string; name: string; teller: boolean;
  start: number | null; end: number | null; text: string;
}
export interface Range { from: number; to: number }
export function linesOf(turns: Turn[], tellers: string[], names: Array<[string, string]>): Line[];
export function renderLines(lines: Line[]): string;          // "L3 Sunja: …" / "L2 Interviewer (asking): …"
export function parseCite(s: unknown): Range | null;          // "L12", "L12-L15", "L12–15", "12-15"
export function textOf(lines: Line[], ranges: Range[]): string;
export function estimateTokens(text: string): number;          // ceil(chars / 4)
export function partsOf(lines: Line[], maxTokens: number): Line[][]; // a part ends after a teller line
export function clock(sec: number | null): string | null;     // 63.2 -> "1:03"

// stories/tools.ts
export interface Tool {
  name: string; description: string; args: string;
  run(args: Record<string, unknown>): Promise<string>;
}
export interface ToolLoopResult<T> { value: T; calls: number; toolCalls: number }
export async function runWithTools<T>(chat: ChatModel, o: {
  system: string; task: string; tools: Tool[]; maxToolCalls: number;
  parse: (v: unknown) => T | string; signal?: AbortSignal; temperature?: number; maxCalls?: number;
}): Promise<ToolLoopResult<T>>;
export interface StoryLookup {                      // backed by the archive in the job, faked in tests
  search(query: string): Promise<Array<{ id: string; title: string; type: string; snippet: string }>>;
  read(idOrTitle: string): Promise<{ id: string; title: string; type: string; body: string } | null>;
}
export function planTools(lookup: StoryLookup): Tool[];       // search_notes, read_note
export function writeTools(lookup: StoryLookup, lines: Line[]): Tool[]; // read_lines, read_note

// stories/plan.ts
export interface PlannedStory { title: string; ranges: Range[]; tellers: string[]; continues: string | null }
export interface StoryPlan { interviewName: string | null; stories: PlannedStory[] }
export function parsePlan(v: unknown, lines: Line[], carried: string[]): StoryPlan | string;
export async function planPart(chat: ChatModel, o: { lines: Line[]; subject: string; carried: PlannedStory[];
  lookup: StoryLookup; maxToolCalls: number; signal?: AbortSignal }): Promise<{ plan: StoryPlan; calls: number }>;

// stories/write.ts
export interface Sentence { text: string; cites: Range[]; paragraph: boolean }
export interface StoryDraft { title: string; occurred: string | null; until: string | null; sentences: Sentence[] }
export interface Feedback { draft: StoryDraft; problems: Problem[] }
export function parseDraft(v: unknown, lines: Line[]): StoryDraft | string;
export async function writeStory(chat: ChatModel, o: { story: PlannedStory; lines: Line[]; subject: string;
  feedback: Feedback | null; lookup: StoryLookup; maxToolCalls: number; signal?: AbortSignal }): Promise<{ draft: StoryDraft; calls: number }>;

// stories/check.ts
export type ProblemKind = 'no_citation' | 'bad_citation' | 'not_in_source' | 'quote' | 'date' | 'title'
  | 'made_up' | 'contradicts' | 'misattributed';
export interface Problem { sentence: number; kind: ProblemKind; detail: string } // sentence -1 = title/date
export function checkDraft(d: StoryDraft, lines: Line[], known: string[]): Problem[];

// stories/judge.ts
export type Verdict = 'supported' | 'made_up' | 'contradicts' | 'misattributed' | 'less_certain_in_source';
export interface Ruling { sentence: number; verdict: Verdict; reason: string }
export const FAILING: readonly Verdict[];                     // made_up, contradicts, misattributed
export async function judgeStory(chat: ChatModel, d: StoryDraft, lines: Line[],
  signal?: AbortSignal): Promise<{ rulings: Ruling[]; calls: number }>;

// stories/workflow.ts
export interface StoriesDeps {
  chat: ChatModel | null; judge?: ChatModel | null; lookup: StoryLookup; titles: string[];
  signal?: AbortSignal; onProgress?: (p: { done: number; total: number }) => void;
  deadlineMs?: number; contextTokens?: number; recordedAt?: string; interviewName?: string | null;
}
export async function writeStories(parsed: ParsedTranscript, opts: IngestOptions, deps: StoriesDeps): Promise<IngestResult>;
```

`ProposedMemory` (ingest-pipeline.ts) gains, all optional, used when `method === 'story'`:

```ts
until?: string | null;
tellers?: string[];
sources?: Array<{ sentence: string; from: number; to: number; start: number | null; end: number | null; text: string }>;
flags?: string[];
writtenBy?: { workflow: string; writer: string; judge: string };
```

`IngestResult` gains `pending?: { reason: 'no_model' | 'auth' | 'unavailable' | 'deadline' | 'budget' | 'bad_plan' }` and `interviewId?: string`, and its `stats` gains optional `stories?: { planned: number; written: number; dropped: number; firstPass: number; sentences: number; removed: number; flagged: number; calls: number }`.

---

## Tasks

### Task 1: Migration

**Files:** create `supabase/migrations/20261028120000_interviews.sql`.

- [ ] Write the migration:

```sql
-- Interviews: a transcript kept with the project, whose stories the import writes
-- (docs/superpowers/specs/2026-10-28-interviews-become-stories-prd.md, 7.1). API only, like
-- every table here (ADR 0002): row security on, no grants.
create table public.interviews (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  created_by uuid not null references auth.users (id),
  name text not null,
  recorded_at timestamptz not null default now(),
  source_hash text not null,
  -- the transcript as it arrived (text, or JSON as text) and the options it came with, so the
  -- stories can be written again from it
  transcript text not null,
  options jsonb not null default '{}'::jsonb,
  stories_status text not null default 'pending' check (stories_status in ('pending', 'written')),
  created_at timestamptz not null default now()
);
create index interviews_archive_idx on public.interviews (archive_id, created_at desc);
-- one waiting interview per transcript: bringing the same words in again picks it up
create unique index interviews_pending_hash_idx on public.interviews (archive_id, source_hash)
  where stories_status = 'pending';
alter table public.interviews enable row level security;

alter table public.ingest_runs
  add column interview_id uuid references public.interviews (id) on delete set null;

alter type public.revision_reason add value if not exists 'import';
```

- [ ] Apply it to the local stack (`psql … -f`); check `\d public.interviews`.
- [ ] Commit: `feat(db): interviews keep their transcript`.

### Task 2: `stories/lines.ts`

**Files:** create `server/api/src/stories/lines.ts`, `server/api/test/stories-lines.test.ts`.

- [ ] Test first. Required cases:
  - `linesOf` numbers from 1, marks tellers, and uses the name map with a fallback to the speaker id.
  - `renderLines` writes `L1 Interviewer (asking): …` for others and `L2 Sunja: …` for tellers.
  - `parseCite` accepts `L12`, `L12-L15`, `L12–15`, `12-15` and `{from,to}`; rejects `L0`, reversed ranges and non-text.
  - `textOf` joins the ranged lines with speaker names.
  - `estimateTokens('a'.repeat(8)) === 2`.
  - `partsOf` with a small budget splits only after teller lines, and never returns an empty part.
  - `clock(63.2) === '1:03'`, `clock(null) === null`.
- [ ] Implement; run `pnpm --filter @funmem/api exec vitest run test/stories-lines.test.ts`; commit.

### Task 3: `stories/tools.ts` (the tool loop)

**Files:** create `server/api/src/stories/tools.ts`, `server/api/test/stories-tools.test.ts`.

**Protocol (in the system prompt the loop appends):**

```
You can use tools. Answer with ONE JSON object and nothing else:
  {"tool": "<name>", "args": {...}}   to use a tool, or
  {"result": <your result>}           when you are done.
Tools:
- search_notes(query): …
```

Each call sends the task plus a "Tool calls so far" section (`#1 search_notes({"query":"Busan"}) → …`). Results are cut to 4,000 characters each.

- [ ] Tests (scripted `ChatModel`):
  - returns `result` directly with 0 tool calls;
  - runs a tool and feeds its output into the next call's user text;
  - an answer that is not JSON is asked again once ("Answer with one JSON object"); a second failure throws `ModelError('bad_output')`;
  - a `parse` error string is sent back as feedback and the model can correct it;
  - after `maxToolCalls` the next call says "No more tools" and a further tool call is rejected (`bad_output`);
  - an unknown tool name gets the answer `unknown tool` (not a crash);
  - `maxCalls` (default `maxToolCalls + 4`) bounds total calls;
  - `planTools` and `writeTools` call the lookup and format results; `read_lines` uses `parseCite` and `textOf`.
- [ ] Implement; run; commit.

### Task 4: `stories/plan.ts`

**Files:** create `server/api/src/stories/plan.ts`, `server/api/test/stories-plan.test.ts`.

The prompt (system) states D3, D5 and the rules below. The task text holds the subject, the carried stories (title and ranges) and `renderLines(lines)`.

```
Find the STORIES in this interview: whole episodes or periods of the narrator's life told from
start to finish (a childhood, a journey, a job, how two people met), not single moments.
Usually 3–8 for an hour. Greetings, small talk, talk about the recording, and the interviewer's
own stories are not stories. Each story lists the line ranges that tell it (the narrator's lines,
and the questions that led to them). A story may use several ranges. A line may belong to only
one story. Give each a working title from the story's heart (under 60 characters). Name the
interview from its topics, not its first words.
Result: {"interviewName": "...", "stories": [{"title": "...", "lines": ["L3-L9","L14"],
"tellers": ["Sunja"], "continues": null}]}
"continues" is the title of a story from an earlier part that this one carries on, or null.
```

- [ ] Tests for `parsePlan`:
  - accepts a valid plan;
  - drops ranges outside the lines;
  - rejects a story whose ranges hold no teller line ("story X has none of the narrator's lines");
  - removes a line claimed twice (first wins);
  - rejects zero stories when the narrator said at least 40 words;
  - accepts zero stories for a transcript that is only greetings;
  - `continues` must name a carried title (else null);
  - titles go through `acceptTitle`, with the fallback "A story from the interview".
- [ ] Test `planPart` with a scripted model, including one `search_notes` call.
- [ ] Implement; run; commit.

### Task 5: `stories/write.ts`

**Files:** create `server/api/src/stories/write.ts`, `server/api/test/stories-write.test.ts`.

The prompt states D4 and D11 and the rules of PRD 6.3. Result shape:

```
{"title": "...", "occurred": "1946" | "~1946" | null, "until": null,
 "sentences": [{"text": "...", "cites": ["L3-L4"], "paragraph": true}]}
```

With feedback, the task adds "Your previous draft" and "Problems found", one line each, and asks for the whole story again.

- [ ] Tests for `parseDraft`:
  - valid draft;
  - a sentence without valid cites is kept with empty `cites` (the checker reports it);
  - `occurred` normalized through `validateFrontmatter`'s fuzzy date rule, with an invalid value becoming null;
  - empty sentences are dropped;
  - zero sentences is an error string.
- [ ] Test `writeStory` with a scripted model, including the feedback text.
- [ ] Implement; run; commit.

### Task 6: `stories/check.ts`

**Files:** create `server/api/src/stories/check.ts`, `server/api/test/stories-check.test.ts`.

Rules (PRD 6.4, code checks):
1. `no_citation`: a sentence with no cites. `bad_citation`: a cite outside the lines.
2. `not_in_source`, numbers: every number in the sentence must appear in its cited text after `spokenNumbersToDigits` and `spokenYearsToDigits`. "forty hens" ↔ "40 hens" passes.
3. `not_in_source`, names: a capitalized word that is not the first word of the sentence must appear in the cited text, in `known`, or in the speaker names of the cited lines, case-insensitive with a trailing `'s` removed. Exempt: months, weekdays, `I`, and common capitalized words (`Mom`, `Dad`, `Grandma`, `Grandpa`, `Mother`, `Father`, `God`, `Christmas`, `Sunday` …).
4. `quote`: text inside “…” or "…" must appear in the cited text after normalizing case, punctuation and spaces.
5. `date`: a year in `occurred` (or `until`) must appear somewhere in the cited text of the whole story.
6. `title`: `checkTitleFacts(title, bodyAndSources)` must pass; `acceptTitle(title)` must not be null.

- [ ] Tests, one per rule, each with a passing and a failing case. Include: "forty hens" vs "40 hens"; the subject's name not in the lines (passes through `known`); "Seoul" not said (fails); a misquote (fails); `occurred` 1952 when the lines say 1946 (fails).
- [ ] Implement; run; commit.

### Task 7: `stories/judge.ts`

**Files:** create `server/api/src/stories/judge.ts`, `server/api/test/stories-judge.test.ts`.

System prompt: the five verdicts with the PRD 6.4 meanings, and "Wording is free: paraphrase, condensing and summary are fine. Judge only whether anything is made up." The task lists each sentence with its cited source text. Temperature 0. Result: `{"rulings":[{"sentence":0,"verdict":"supported","reason":""}]}`.

- [ ] Tests:
  - parses rulings;
  - a missing sentence is `supported` with reason `not judged` (so a lazy judge cannot fail a story), but is counted;
  - an unknown verdict counts as `supported` with reason `unreadable verdict`;
  - not JSON twice throws `bad_output`.
- [ ] Implement; run; commit.

### Task 8: `stories/workflow.ts`

**Files:** create `server/api/src/stories/workflow.ts`, `server/api/test/stories-workflow.test.ts`.

**Steps:**
1. `applyRoles` and `namesFor`, as `ingestParsed` does. Export `namesFor` from `ingest-pipeline.ts`.
2. `linesOf`, then `partsOf(lines, contextTokens ?? 200_000 − 20_000 reserve)`.
3. For each part, `planPart` with the stories carried so far. A `continues` entry appends its ranges to the carried story.
4. Write and judge each story, 3 at a time (`mapPool`):
   - `writeStory` → `checkDraft` → if no code problems, `judgeStory`;
   - failing items become `Problem`s of kind `made_up` / `contradicts` / `misattributed`;
   - fix up to 2 rounds;
   - then remove failing sentences (listed in `notes`) and drop a story left with fewer than 2 sentences.
5. Assemble each story as a `ProposedMemory`:
   - body: paragraphs (a sentence with `paragraph: true` starts one) passed through `linkKnownTitles(…, titles)`, then `> Told by {tellers}, “{interviewName}”, {start}–{end}`;
   - `type 'event'`, `method 'story'`, `turns` = the cited line numbers, `startSec`/`endSec`, `speaker`/`speakerName` from the first teller;
   - `anchor`: first 8 words of the first cited teller line (same rule as today);
   - `sources` with each sentence's cited text (cut to 600 characters) and times;
   - `flags`: sentences judged `less_certain_in_source`;
   - `notes` for the reviewer: removed sentences and flags in plain words;
   - `until`, `tellers`, `writtenBy`.
6. **Budgets:**
   - calls: at most 2 per part plus 6 per story, capped at 200;
   - deadline: `deadlineMs`, default 12 minutes.

   A model failure with `auth`, a plan that fails twice, or no `chat` → return with `memories: []` and `pending`. A deadline or budget reached during writing keeps the finished stories and sets `pending` only when none finished.
7. `providerVersion = "${chat.id}+stories-1"`; `stats.stories` as in the interfaces.

- [ ] Tests (scripted models routed by system prompt):
  - happy path: 2 stories, each passes on the first try; check body, footer, sources, metadata;
  - a story whose first draft invents "Seoul" is fixed in round 2;
  - a sentence the judge keeps failing is removed and listed in notes;
  - a story left with 1 sentence is dropped;
  - `chat: null` → `pending.reason 'no_model'`;
  - an `auth` failure → `pending.reason 'auth'`, and no further calls are made;
  - a deadline of 1 ms → `pending` or partial, never a throw;
  - a cancelled signal → `IngestCancelled`;
  - two parts (tiny `contextTokens`) with `continues` merging ranges.
- [ ] Implement; run; commit.

### Task 9: Interviews (rows and routes)

**Files:** create `server/api/src/stories/interviews.ts`, `server/api/test/stories-interviews.test.ts`; modify `server/api/src/app.ts`.

- **`openInterview(pool, {archiveId, userId, hash, name, transcript, options})`:** reuses the pending row with the same `(archive_id, source_hash)`; otherwise inserts one. Returns its id. `transcript` is stored as the request sent it (a string, or JSON as text).
- **`markWritten(client, interviewId, runId)`:** sets `stories_status = 'written'` and sets `ingest_runs.interview_id`.
- **Routes:** members may read, writers may start.
  - `GET /v1/archives/:archiveId/interviews` → `[{ id, name, recordedAt, status, mine, stories }]`, where `stories` counts the notes of its active run.
  - `GET /v1/archives/:archiveId/interviews/:id` → the row with `transcript`, `options` and parsed `turns` (`parseTranscript`).
- Tests:
  - reuse of a pending row;
  - list and read, with a non-member getting 404;
  - `markWritten` changes the status, and a new import of the same words then makes a new row;
  - undo removes the interview (task 11).
- Implement; run; commit.

### Task 10: Notes metadata on insert

**Files:** modify `server/api/src/notes.ts` (`NewNoteInput`, `createNotesBatch`); test in `server/api/test/stories-save.test.ts`.

- `NewNoteInput` gains `recorded?: string | null`, `contributors?: string[]` and `extra?: Record<string, unknown>`.
- The insert writes `recorded`, `contributors`, `extra` (defaulting to null, `{}` and `{}`).
- Test: a batch insert with metadata reads back the same values.
- Implement; run; commit.

### Task 11: Jobs and save in stories mode

**Files:** modify `server/api/src/app.ts` (`importMode?: 'stories' | 'memories'`), `ingest-jobs.ts`, `ingest-save.ts`, `server/api/test/helpers.ts` (`importMode: 'memories'`), `main.ts`, `worker.ts`; test in `server/api/test/stories-jobs.test.ts`.

**In `run()`, stories mode:**
1. After the parse and the duplicate check: `job.interviewId = await openInterview(...)`. The name is `req.source` or `Interview, {date}`.
2. Call `writeStories(parsed, req, { chat, judge: chat, lookup: archiveLookup(deps, archiveId, userId), titles, signal, onProgress, recordedAt, interviewName })`. `archiveLookup` uses `hybridQuery(…, 'search')` and a visible-note read.
3. Set `result.interviewId`. With `result.pending`, the job finishes `succeeded` with the outcome (status `previewed`, no memories) and the interview stays pending.
4. Save as today.

**`persistImport`:**
- maps story metadata (`recorded` = the interview's `recorded_at` or now; `contributors` = tellers; `extra` = `{ interviewId, sources, until, flags, writtenBy, tellings: [{ interviewId, at }] }`);
- revision reason `'import'` for story memories;
- calls `markWritten` in `hooks.after` when `interviewId` is set.

**`undoImport`** deletes the run's interview, as part of "the import keeps no words after undo".

**Save patches:** `title`, `body` and `occurred` edits behave as today. A body edit keeps `sources` (each source carries its sentence text; one that no longer matches is simply not shown).

- Tests:
  - stories mode with a scripted model: preview → save writes 2 notes with metadata (`recorded`, `contributors`, `extra.sources`, revision reason `import`); the interview becomes written; the run has `interview_id`;
  - no model: the job outcome has `pending`, 0 memories, and the interview is pending; a second import of the same words reuses it;
  - undo deletes the notes and the interview;
  - memories mode still behaves as before (the existing suite).
- Implement; run the whole server suite; commit.

### Task 12: Web

**Files:**
- modify `apps/web/src/lib/api.ts`, `components/ImportRun.tsx`, `pages/Interviews.tsx`, `components/InterviewReview.tsx`;
- create `apps/web/src/lib/interview-name.ts` and `apps/web/test/interview-name.test.ts`.

**`api.ts`:**
- `ImportMemory.method` gains `'story'`;
- optional `until`, `tellers`, `sources`, `flags`;
- `ImportOutcome` gains `pending?: { reason: string }` and `interviewId?: string`;
- `listInterviews`, `getInterview`.

**`ImportRun.tsx`:**
- the pill reads "Written by Firepit from what was said, checked that nothing is made up";
- a metadata line: `{when} · told by {tellers} · {start}–{end}`;
- "Where this comes from" toggles each sentence with its source text;
- with `outcome.pending`: heading "Stories not written yet", a reason line ("The AI isn't available right now" / "It took too long" / …), "Your transcript is kept with the interview", and a "Try again" button that restarts the same request;
- the count words become "story/stories" in stories mode.

**`Interviews.tsx`:** an "Interviews" list from `listInterviews`: name, date, status ("Stories not written yet" / "N stories"), and for pending ones "Write the stories". That button calls `getInterview`, then navigates to `/interviews/new` with `{ request: { transcript, teller, source } }`.

**`interview-name.ts`:** `interviewName(startedAt: string, topics: string[]): string` returns "Interview, 26 Oct 2026 · Childhood, Work" (at most 2 topics). `InterviewReview` uses it as the default name, never `setup.about`. Its button reads "Write the stories".

- Tests: `interviewName` (no topics, two topics, three topics trimmed to two).
- Then run the web typecheck, lint and tests; commit.

### Task 13: Evaluation script and fixtures

**Files:**
- create `server/api/test/fixtures/stories/nell.txt` (the live test interview's words) and `server/api/scripts/eval-stories.ts`;
- add `"eval:stories": "vite-node scripts/eval-stories.ts"` to `server/api/package.json`;
- `scripts/` is not part of `tsc`'s include; check `tsconfig.json` and add it if needed so the script is typechecked.

The script runs `writeStories` with `createNimChat()` on:
- `docs/ingest/samples/grandma-sunja-en.txt` (teller "Sunja");
- `nell.txt` (teller "Nell");
- `docs/ingest/sample-whisperx.json`.

It uses an empty lookup. For each, it prints the stories (title, date, first 2 sentences), the `stats.stories` numbers, removed and flagged sentences, the calls and the seconds. It ends with a JSON summary line. It exits 1 if any saved sentence lacks a citation.

- Run it with the real key; record the results in the PR or commit message; commit.

### Task 14: Docs, full check, end to end

- [ ] Update the docs:
  - `docs/ingest/api.md`: stories mode, `pending`, the interview routes, `FUNMEM_IMPORT_MODE`;
  - `docs/ingest/conflict-policy.md`: paraphrase is allowed (D11); editing and merging come in phase 3, so the existing rows stand until then;
  - `docs/deploy.md`: run the new migration; NVIDIA now reads the transcript when stories are written; `FUNMEM_IMPORT_MODE`.
- [ ] `pnpm lint && pnpm format && pnpm typecheck && pnpm test` (the known `grounding-meaning` timing test aside).
- [ ] End to end on the local stack with the real NVIDIA key:
  - bring in the Sunja transcript through the web app;
  - review the stories, save, and check Stories and Interviews;
  - undo.
- [ ] Commit and push.
