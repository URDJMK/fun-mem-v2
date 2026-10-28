# The people, places and things graph: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a project has a graph of the people, places and things in its stories: built by imports and by a button, reviewed before saving, drawn on Home and on People, places & things, and opened from the names in a story.

**Spec:** `docs/superpowers/specs/2026-10-28-people-places-graph-design.md` (G-D1–G-D8, sections 3–10). All four parts, G1–G4, in this plan.

**Architecture:**
- A new module `server/api/src/graph/`, small single-purpose files, over five new tables. The graph is apart from notes; an entity may point at a note.
- One name-matching rule, `matchKey`, in `@funmem/core`, used by the server, the web and the demo.
- The Graph step reuses the story workflow's pieces: the JSON tool loop (`stories/tools.ts`), the code checks (`stories/check.ts`) and the judge (`stories/judge.ts`).
- Saving rides on `persistImport`'s transaction (`after` hook); undo rides on `undoImport`. The button is an import job with `graph: true` and no transcript.
- The web draws the graph with `d3-force` (layout only; React renders SVG).

**Tech stack:** TypeScript, Hono, node-postgres, vitest, React 19, d3-force.

**Running tests locally** (the session's env points at hosted Supabase):

```sh
export FUNMEM_SUPABASE_URL=http://127.0.0.1:54321
export FUNMEM_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

Apply a new migration to the local database with
`docker exec -i sb-db psql -U postgres -v ON_ERROR_STOP=1 < supabase/migrations/<file>.sql`.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/20261028140000_graph.sql` | `graph_entities`, `graph_aliases`, `graph_mentions`, `graph_relationships`, `graph_changes`; `archives.graph_backfilled_at`; `ingest_runs.kind`, `note_count` may be 0 |
| `packages/core/src/match-key.ts` | `matchKey(name)` |
| `server/api/src/graph/types.ts` | the shared types below |
| `server/api/src/graph/store.ts` | visibility SQL; `entityForNote`; `ensureGraph` (protagonist, backfill); `entityLookup`; reading entities |
| `server/api/src/graph/view.ts` | the graph for a member: nodes, told and together lines |
| `server/api/src/graph/step.ts` | the Graph step: prompt, tools, parsing, checks, judge |
| `server/api/src/graph/save.ts` | applying the reviewer's choices; writing a proposal; undoing a run |
| `server/api/src/graph/edit.ts` | rename, retype, merge, remove entity, remove relationship |
| `server/api/src/graph/build.ts` | the button's job: saved stories → a proposal |
| `server/api/src/graph/routes.ts` | the routes of spec 6.4 |
| `server/api/src/notes.ts` | a person, place or object note made by hand gets its entity; `GET` note gains `mentions` |
| `server/api/src/app.ts` | provisioning always makes the protagonist's note; graph routes |
| `server/api/src/stories/workflow.ts` | runs the Graph step after the stories |
| `server/api/src/ingest-pipeline.ts` | `IngestResult.graph` |
| `server/api/src/ingest-jobs.ts` | graph patches on save; `graph: true` jobs; a graph-only save |
| `server/api/src/ingest-save.ts` | `persistImport` saves the graph; `undoImport` undoes it |
| `server/api/src/ingest.ts` | reads `graph` patches in the save body |
| `apps/web/src/lib/api.ts` | graph types and calls |
| `apps/web/src/lib/demo-api.ts` | the same routes, from the demo's notes |
| `apps/web/src/components/WhoAndWhere.tsx` | Home's graph |
| `apps/web/src/components/GraphReview.tsx` | the review group |
| `apps/web/src/components/NoteText.tsx` | names underlined from mentions |
| `apps/web/src/pages/People.tsx` | entities: list, page, its graph, editing, the button |
| `apps/web/src/pages/Home.tsx`, `NotePage.tsx`, `components/ImportRun.tsx` | wiring |
| `server/api/scripts/eval-graph.ts`, `server/api/test/fixtures/stories/noah.txt` | real-model evaluation |
| `docs/ingest/api.md`, `docs/deploy.md` | routes, migration |

## Interfaces (fixed here; every task uses these names)

```ts
// packages/core/src/match-key.ts
/** NFC, lowercase, punctuation removed, whitespace collapsed, a leading "the " dropped. */
export function matchKey(name: string): string;

// server/api/src/graph/types.ts
export type EntityType = 'person' | 'place' | 'thing';
export const NOTE_TYPE: Record<EntityType, 'person' | 'place' | 'object'>;
export const ENTITY_OF_NOTE: Record<string, EntityType | undefined>; // person, place, object

/** where a line comes from: interview lines, or a story's own sentence */
export type GraphSource =
  | { interviewId: string | null; from: number; to: number }
  | { noteId: string; sentence: number };

export interface ProposedMention {
  /** the story: a memory id ("m1") in an import, a note id in a graph-only run */
  story: string;
  words: string[];
  line: string;
  sources: GraphSource[];
}
export type EntityMatch =
  | { kind: 'new' }
  | { kind: 'existing'; entityId: string; name: string }
  | { kind: 'ask'; candidates: Array<{ entityId: string; name: string }> };
export interface ProposedEntity {
  ref: string; // "e1"
  name: string;
  type: EntityType;
  match: EntityMatch;
  mentions: ProposedMention[];
}
export interface ProposedRelationship {
  ref: string; // "r1"
  a: string; // entity ref
  b: string;
  description: string;
  story: string;
  sources: GraphSource[];
}
export interface GraphProposal {
  entities: ProposedEntity[];
  relationships: ProposedRelationship[];
  /** the Graph step could not run (yet); the stories are unaffected */
  pending?: { reason: StoriesPendingReason };
  stats?: { calls: number; proposed: number; dropped: number };
}
/** the reviewer's choices (the save body's `graph`) */
export interface GraphPatch {
  /** entity or relationship refs left out */
  leave?: string[];
  rename?: Record<string, string>;
  /** entity ref → an existing entity id */
  same?: Record<string, string>;
}

// graph/store.ts
export function entityVisibleSql(alias: string, userParam: string): string;
export async function ensureGraph(deps: AppDeps, archiveId: string): Promise<void>;
export async function entityForNote(client: Db, note: { id: string; archiveId: string; title: string; type: string; createdBy: string }): Promise<void>;
export interface EntityLookup {
  find(name: string): Promise<Array<{ id: string; name: string; type: EntityType; aliases: string[]; lines: string[] }>>;
  read(id: string): Promise<{ id: string; name: string; type: EntityType; aliases: string[]; description: string; relationships: string[] } | null>;
}
export function entityLookup(db: Db, archiveId: string, userId: string): EntityLookup;

// graph/view.ts
export interface GraphView {
  nodes: Array<{ id: string; name: string; type: EntityType; stories: number; subject: boolean; noteId: string | null }>;
  told: Array<{ a: string; b: string; lines: Array<{ id: string; description: string; storyId: string; storyTitle: string }> }>;
  together: Array<{ a: string; b: string; stories: number }>;
  more: number;
}
export async function graphFor(db: Db, archiveId: string, userId: string, opts?: { limit?: number; around?: string }): Promise<GraphView>;

// graph/step.ts
export interface StoryForGraph {
  ref: string; // memory id or note id
  title: string;
  /** what the mention words must appear in */
  text: string;
  sentences: Array<{ text: string; cites: Range[] }>;
  /** the lines the story may cite */
  ranges: Range[];
  tellers: string[];
}
export async function graphStep(o: {
  chat: ChatModel; judge: ChatModel;
  stories: StoryForGraph[];
  lines: readonly Line[]; // with the profile as line 0 when there is one
  profile: string;
  known: Array<{ id: string; name: string; type: EntityType; aliases: string[] }>; // the protagonist and the tellers
  lookup: EntityLookup;
  signal?: AbortSignal;
}): Promise<GraphProposal>;

// graph/save.ts
export function applyGraphPatch(p: GraphProposal, patch: GraphPatch, keptStories: Set<string>): GraphProposal;
export async function saveGraph(client: PoolClient, o: { archiveId: string; userId: string; runId: string; proposal: GraphProposal; storyNote: Map<string, string> }): Promise<void>;
export async function undoGraph(client: PoolClient, archiveId: string, runId: string): Promise<void>;
```

`IngestResult` gains `graph?: GraphProposal`. `IngestRequest` gains `graph?: boolean` (a graph-only job). The save body gains `graph?: GraphPatch`.

---

## G1: the graph from what exists

### Task 1: `matchKey`

**Files:** create `packages/core/src/match-key.ts`, `packages/core/test/match-key.test.ts`; modify `packages/core/src/index.ts`.

- [ ] Test first:
  - `matchKey('Mrs. Han') === matchKey('Mrs Han') === 'mrs han'`;
  - `matchKey('  Sarah   LEE ')` is `'sarah lee'`; `matchKey('Sarah-Lee')` is `'sarah lee'`;
  - `matchKey('The sewing machine') === matchKey('sewing machine')`;
  - NFC: `matchKey('José') === matchKey('José')`;
  - Korean and other scripts kept: `matchKey('김순자') === '김순자'`;
  - a name that is only punctuation gives `''`.
- [ ] Implement:

```ts
export function matchKey(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}
```

- [ ] Export it from `index.ts`; run `pnpm --filter @funmem/core test`; commit.

### Task 2: the migration

**Files:** create `supabase/migrations/20261028140000_graph.sql`.

- [ ] Write it:

```sql
create type public.graph_entity_type as enum ('person', 'place', 'thing');

create table public.graph_entities (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  type public.graph_entity_type not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  match_key text not null check (match_key <> ''),
  note_id uuid unique references public.notes (id) on delete set null,
  description text not null default '',
  created_by uuid not null,
  run_id uuid references public.ingest_runs (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (archive_id, type, match_key)
);
create index graph_entities_archive_idx on public.graph_entities (archive_id);

create table public.graph_aliases (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  entity_id uuid not null references public.graph_entities (id) on delete cascade,
  alias text not null,
  match_key text not null check (match_key <> ''),
  unique (archive_id, match_key)
);
create index graph_aliases_entity_idx on public.graph_aliases (entity_id);

create table public.graph_mentions (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  entity_id uuid not null references public.graph_entities (id) on delete cascade,
  note_id uuid not null references public.notes (id) on delete cascade,
  words text[] not null default '{}',
  line text not null default '',
  sources jsonb not null default '[]',
  run_id uuid references public.ingest_runs (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (entity_id, note_id)
);
create index graph_mentions_note_idx on public.graph_mentions (note_id);
create index graph_mentions_archive_idx on public.graph_mentions (archive_id);

create table public.graph_relationships (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  a_id uuid not null references public.graph_entities (id) on delete cascade,
  b_id uuid not null references public.graph_entities (id) on delete cascade,
  description text not null check (length(btrim(description)) between 1 and 500),
  note_id uuid not null references public.notes (id) on delete cascade,
  sources jsonb not null default '[]',
  run_id uuid references public.ingest_runs (id) on delete set null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  check (a_id <> b_id)
);
create unique index graph_relationships_pair_story_idx
  on public.graph_relationships (least(a_id, b_id), greatest(a_id, b_id), note_id);
create index graph_relationships_archive_idx on public.graph_relationships (archive_id);

create table public.graph_changes (
  id uuid primary key default gen_random_uuid(),
  archive_id uuid not null references public.archives (id) on delete cascade,
  entity_id uuid,
  kind text not null check (kind in ('rename', 'type', 'merge', 'remove', 'remove-relationship', 'note')),
  before jsonb not null default '{}',
  after jsonb not null default '{}',
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index graph_changes_entity_idx on public.graph_changes (entity_id);

alter table public.graph_entities enable row level security;
alter table public.graph_aliases enable row level security;
alter table public.graph_mentions enable row level security;
alter table public.graph_relationships enable row level security;
alter table public.graph_changes enable row level security;

alter table public.archives add column graph_backfilled_at timestamptz;
alter table public.ingest_runs add column kind text not null default 'import'
  check (kind in ('import', 'graph'));
```

(`ingest_runs.note_count` already allows 0.) Comments on each table, as the other migrations do.
- [ ] Apply locally; check with `\d public.graph_relationships`; commit.

### Task 3: types, visibility, and the entity of a hand-written note

**Files:** create `server/api/src/graph/types.ts`, `server/api/src/graph/store.ts`; modify `server/api/src/notes.ts` (`createNotesBatch`, inside its transaction after the insert); test `server/api/test/graph-store.test.ts`.

- [ ] Tests (database):
  - creating a `person` note by `POST /notes` makes a `graph_entities` row of type `person` with `note_id` and `name` = title; `place` gives `place`; `object` gives `thing`; `event` gives none;
  - a second note whose title has the same key ("Mrs Han" after "Mrs. Han") makes no second entity and does not fail the save;
  - `entityVisibleSql`: an entity with only a mention in a private story is invisible to another member and visible to the story's author.
- [ ] `entityForNote(client, note)`: for a person/place/object note, `insert … on conflict (archive_id, type, match_key) do update set note_id = coalesce(graph_entities.note_id, excluded.note_id)` when the existing entity has no note; otherwise do nothing.
- [ ] `entityVisibleSql(alias, userParam)`: visible when it is the protagonist's (`note_id = archives.subject_note_id`), or its note is visible (`visibleSql`), or a mention's or relationship's story is visible.
- [ ] Commit.

### Task 4: the protagonist always, and the backfill

**Files:** modify `server/api/src/app.ts` (provision), `server/api/src/stories/profile-store.ts` (`ensureSubjectNote` callable with the owner), `server/api/src/graph/store.ts` (`ensureGraph`); test `server/api/test/graph-backfill.test.ts`.

- [ ] Tests:
  - a new personal project has its protagonist's person note and entity, with no profile entered; a family project has neither;
  - `ensureGraph` on an older project (note and entity removed by SQL first, `graph_backfilled_at` null): makes the protagonist's note and entity (the note made as the project's owner); turns its person, place and object notes into entities; turns `[[links]]` from stories to them into mentions (words: the link's text; line: the link's snippet with `[[…]]` read as plain words); copies the profile's aliases into `graph_aliases`; sets `graph_backfilled_at`; running it twice changes nothing.
- [ ] Provision: call `setSubjectProfile` for every personal project (an empty profile when none was entered). Fix the tests that counted a fresh project's notes (they now see one person note).
- [ ] `ensureGraph(deps, archiveId)`: under the archive's transaction (`inTransaction`), `select graph_backfilled_at … for update`; return when set. The owner is `memberships.role = 'owner'`.
- [ ] Profile aliases: `setProfile` also replaces the protagonist entity's aliases that came from the profile (aliases whose key is not the name's), so Settings stays the source of them.
- [ ] Commit.

### Task 5: the graph view and the read routes

**Files:** create `server/api/src/graph/view.ts`, `server/api/src/graph/routes.ts`; modify `server/api/src/app.ts`, `server/api/src/notes.ts` (`GET` note gains `mentions`); test `server/api/test/graph-routes.test.ts`.

- [ ] Tests (seed entities, mentions and relationships with SQL):
  - `GET /graph`: nodes with story counts and `subject`; `told` lines grouped by pair; `together` pairs from shared stories, never including the protagonist or a story's tellers (`notes.contributors`); a lone entity is a node with no lines; a private story's lines are hidden from another member; `more` counts nodes over the limit (80);
  - `GET /entities`: name, type, aliases, story counts; `GET /entities/:id` takes an entity id or its note's id: mentions (line, story id and title), relationships (description, the other entity, story), note id, `subject`, `profile` for the protagonist, and `graph` (the same shape as `/graph`, around this entity: its told and together neighbours);
  - `GET /notes/:id` of a story has `mentions: [{ entityId, words }]` for visible entities only;
  - a stranger gets 404 everywhere; every read calls `ensureGraph` first.
- [ ] Implement `graphFor` in TypeScript over three queries (visible entities with counts; visible relationships; visible mentions with each story's contributors) and pair them up in code.
- [ ] Commit.

### Task 6: the web: API, demo, Home graph, People, names in stories

**Files:** `apps/web/package.json` (`d3-force`, `@types/d3-force`), `apps/web/src/lib/api.ts`, `apps/web/src/lib/demo-api.ts`, create `apps/web/src/components/WhoAndWhere.tsx`, `apps/web/src/lib/graph-layout.ts` (+ test), modify `components/NoteText.tsx`, `pages/People.tsx`, `pages/Home.tsx`, `pages/NotePage.tsx`, `lib/archive.tsx` (`isEntity` includes `object`), `styles.css`.

- [ ] `graph-layout.ts` (tested): `layout(view, { width, height })` → positions; runs `d3-force` (`forceLink` on told lines strong, together lines weak; `forceManyBody`; `forceCollide`; the protagonist pinned at the centre; lone nodes pushed to a ring) for 300 ticks synchronously; same input gives the same positions (seeded start positions).
- [ ] `WhoAndWhere` on Home under the interview area: shapes per type, size by stories, solid and dashed lines, "Show same-story lines" switch, People/Places/Things chips, tap a node to highlight then open, tap a line for its descriptions, pan and zoom (pointer drag, wheel and pinch on the SVG viewBox), a list below, empty state, "and N more".
- [ ] People, places & things: three tabs of entities; the entity page (name, aliases, type, its note or profile, what the stories say, relationships, its graph using `graph` from the entity route).
- [ ] `Linked` gains `mentions?: Array<{ entityId; words }>`: the first occurrence of each word group per paragraph, outside `[[links]]`, is a link to `/people/<entityId>`.
- [ ] Demo: `/graph`, `/entities`, `/entities/:id` built from the demo's person, place and object notes and their `[[links]]` (no relationships), `mentions` on notes.
- [ ] Commit; then G1's check: server and web tests, typecheck, a browser look at Home and People on the local stack.

## G2: imports fill it

### Task 7: the Graph step

**Files:** create `server/api/src/graph/step.ts`; test `server/api/test/graph-step.test.ts`.

- [ ] Tests with a scripted model:
  - entities and relationships parsed, refs checked (`a`/`b` must name entities), types checked;
  - the bridge: Sarah–Noah and Sarah–Tom kept; no Noah–Tom when the model does not propose one;
  - a mention whose words are not in the story is dropped; a line naming someone not in its cited lines is dropped; a relationship whose description the judge rules `made_up` is dropped; an entity left with no mention is dropped, and its relationships with it;
  - things capped at 3 per story; at most 60 entities and 100 relationships kept per import (the rest dropped, counted in `stats.dropped`);
  - `find_entity` returns entities with the same key or alias, and close spellings (edit distance ≤ 1 on keys of 5 or more characters) marked as candidates only;
  - `match` to an entity id that `find_entity` did not return, or that does not exist, becomes `new` with the name kept;
  - the model's failure gives `pending` with the stories' reasons (`auth`, `unavailable`, `bad_plan`, `deadline`, `budget`).
- [ ] The prompt (`GRAPH_SYSTEM`): who to list (people, places, things that matter), family words resolved per speaker and named from the relation ("Noah's mother"), only relationships the lines tell, a description written "Name — relation", the JSON shape; the known entities (protagonist, tellers) given with their ids in the task.
- [ ] Tools: `find_entity`, `read_entity` over `EntityLookup` (at most 12 tool calls).
- [ ] Checks: reuse `checkDraft` on a draft made of the lines (keeping `not_in_source`, `quote`, `bad_citation`, `no_citation`, `outside_story` problems), then `judgeStory` on the same draft.
- [ ] Commit.

### Task 8: the workflow runs it; the job gives it what it needs

**Files:** modify `server/api/src/stories/workflow.ts`, `server/api/src/ingest-pipeline.ts`, `server/api/src/ingest-jobs.ts`; tests in `server/api/test/stories-workflow.test.ts` and `server/api/test/graph-jobs.test.ts`.

- [ ] `StoriesDeps` gains `graph?: { lookup: EntityLookup; known: … }`; after the stories, the Graph step runs once per part over the stories that cite that part, sharing the budget and deadline; the result carries `graph`. Without `deps.graph` (the eval, old tests) it does not run.
- [ ] The job: `ensureGraph`, then the known entities (protagonist and tellers by name or alias) and `entityLookup` go into `writeStories`.
- [ ] Tests: a scripted import's preview has `graph.entities` with mentions pointing at memory ids; the Graph step failing leaves the stories and sets `graph.pending`.
- [ ] Commit.

### Task 9: review choices, saving, undo

**Files:** create `server/api/src/graph/save.ts`; modify `server/api/src/ingest.ts` (read `graph` from the save body), `server/api/src/ingest-jobs.ts` (`save` passes the patch), `server/api/src/ingest-save.ts` (`persistImport` `after` hook calls `saveGraph`; `undoImport` calls `undoGraph` before erasing notes); test `server/api/test/graph-save.test.ts`.

- [ ] Tests:
  - saving writes entities (with `run_id`), mentions on the saved stories' note ids, relationships, and aliases (a renamed entity keeps its first name as an alias);
  - `leave` drops entities (and their relationships) and relationships; a left-out story drops what came only from it;
  - `same` attaches mentions to the chosen existing entity and adds the proposed name as an alias when its key differs;
  - an entity proposed as `new` whose key now exists (made since the preview) attaches to it;
  - descriptions rebuilt from lines of stories every member can see;
  - undo removes the run's mentions and relationships, and its entities except one renamed since (a `graph_changes` row), one with a note, or one mentioned by another run.
- [ ] Commit.

### Task 10: the review group on the web

**Files:** create `apps/web/src/components/GraphReview.tsx`; modify `components/ImportRun.tsx` (the group under the story card; the save sends `graph`), `lib/api.ts` (`saveImport` takes the patch).

- [ ] The group: one row per entity (name, type, New / Already here as …, "Is this …?" with candidates for `ask`, words and lines per story), its relationships, Looks right / Leave it out, Rename (inline), Same as… (a select of existing entities from `/entities`). A story left out greys out what came only from it.
- [ ] `graph.pending`: "People and places not found yet. You can find them later from People, places & things."
- [ ] Commit; then G2's check: a browser import of the Noah fixture on the local stack with the real model.

## G3: the button

### Task 11: graph-only jobs and their save

**Files:** create `server/api/src/graph/build.ts`; modify `server/api/src/ingest-jobs.ts` (`run`: `req.graph` → `buildGraphOf`; `save`: a graph-only outcome saves with `saveGraphOnly`), `server/api/src/graph/routes.ts` (`POST /graph/build`); test `server/api/test/graph-build.test.ts`.

- [ ] `buildGraphOf`: the project's visible-to-all stories (`type in ('event','period')`), grouped by `extra.interviewId`; for a group with an interview, its transcript's lines (`linesOf` as the workflow does) and each story's `extra.sources` as its sentences' cites; for other stories, the story's own sentences as numbered lines (`{ noteId, sentence }` sources). One Graph step per group, sharing one budget and deadline. Drops proposals already in the graph (same entity and story; same pair and story).
- [ ] `saveGraphOnly`: a run row with `kind = 'graph'`, `note_count = 0`, no hash; then `saveGraph`. Undo of a `graph` run undoes only the graph.
- [ ] Tests: a project with two saved stories (one from an interview, one hand-written) and a scripted model gives a proposal; saving it writes rows; running it again proposes nothing already there; undo removes them.
- [ ] Commit.

### Task 12: the button on the web

**Files:** modify `pages/People.tsx` (button for writers; runs the job with `useImportRun`'s polling; shows `Running`, then the graph-only review), `components/ImportRun.tsx` (`Review` with no memories and a `graph` shows only the graph group, and the save button says "Save N people, places and things").

- [ ] Commit; G3's check in the browser: a project with saved stories and no graph, the button, the review, the graph on Home.

## G4: editing

### Task 13: rename, retype, merge, remove

**Files:** create `server/api/src/graph/edit.ts`; modify `server/api/src/graph/routes.ts`; test `server/api/test/graph-edit.test.ts`.

- [ ] Tests:
  - rename keeps the old name as an alias; renaming to another entity's name is refused (409, "merge instead");
  - retype changes the type; a clash with an existing key of that type is refused (409);
  - merge moves mentions (a story mentioning both keeps one mention, words joined), relationships (a self-relationship dropped, a duplicate pair-and-story dropped), aliases and the name (as an alias); the merged-away entity is removed; its note, if any, stays a note and is linked to the kept entity only when the kept one has none;
  - remove deletes the entity with its mentions, relationships and aliases; no note or story is touched;
  - remove-relationship deletes one row;
  - every change writes `graph_changes`; viewers get 403; strangers 404.
- [ ] Commit.

### Task 14: editing on the web

**Files:** modify `pages/People.tsx` (Rename, Type, Merge with… (a select), Remove (confirm), per-relationship Remove, Write a note → `NewNote` with the type and title, then the entity points at it), `lib/api.ts`, `lib/demo-api.ts`.

- [ ] Commit.

## Finishing

### Task 15: evaluation, docs, the full check

- [ ] `server/api/test/fixtures/stories/noah.txt`: an interview with Noah Kim telling of his mother's seaweed soup on his birthday, kimchi soup in Korea, and "my friend Sarah introduced me to her brother Tom".
- [ ] `server/api/scripts/eval-graph.ts` (`pnpm --filter @funmem/api eval:graph`): runs the stories and the Graph step on Sunja and Noah with the real model and prints entities, relationships and the checks of spec 8 ("Done when").
- [ ] Docs: `docs/ingest/api.md` (graph routes, the save body's `graph`, `graph.pending`), `docs/deploy.md` (migration `20261028140000_graph.sql`; the Noah check).
- [ ] Full check: `pnpm lint`, `pnpm format`, `pnpm typecheck`, `pnpm test` (local env), `vite build`; a browser click-through on the local stack with the real model: import Noah, review, save, Home graph, entity page, names in the story, edit, undo.
- [ ] Commit and push to `claude/dreamy-euler-z5cgvh`.
