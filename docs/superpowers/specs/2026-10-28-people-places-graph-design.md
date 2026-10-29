# Design: the people, places and things graph

- **Date:** 2026-10-28
- **Status:** Built (G1–G4), 2026-10-28; see section 11 for what building it changed
- **Changed by:** `2026-10-29-entity-notes-first-design.md`: entities are found before the stories are written, every entity has a note, and stories link to those notes (replaces G-D5, G-D6, 4.1–4.4, 5.1–5.3 and 6.3 here once built)
- **Replaces:** phase 2's "one name, one note" items in `2026-10-28-interviews-become-stories-prd.md` (D8, D9, step 6, the People and places review groups, merging people). The protagonist's profile (7.5, already built) stays as it is.
- **Scope:** a graph of the people, places and things in a project's stories: built when interviews are imported (and on demand for stories already saved), reviewed before it is saved, shown on Home and on People, places & things.

## 1. Problem

A story names "Noah Kim", "his mother", "Korea", "kimchi soup", and none of them is linked or shown anywhere.

- The import links a story only to note titles that already exist, matched exactly (`drafts.ts`, `linkKnownTitles`). It never creates a person, place or thing.
- A personal project gets its protagonist's person note only when a profile is entered, so even the protagonist's own name is often not linked.
- The only graph is `[[wikilinks]]` between notes (`links`). The People page draws one note and its direct neighbours, which are mostly stories. Home draws nothing.
- Linking people through "named in the same story" cannot show how people relate: every story is written about the protagonist and names them, so everyone ends up linked to the protagonist. A friend's brother should join the graph through the friend.

## 2. Decisions

| #    | Decision                                                                                                                                                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-D1 | **Lines are relationships told in the interviews** ("Sarah Lee — Noah's friend from school"), drawn solid. **Being named in the same story** is drawn as a faint line, leaving out the protagonist and the story's tellers (they are in every story). |
| G-D2 | **Nodes are people, places and things** (objects and foods that matter to a story: "the sewing machine", "kimchi soup").                                                                                                                              |
| G-D3 | **Someone mentioned only by relationship becomes a node named by it** ("Noah's mother"). When a name is given later, the node is renamed and the old wording kept as an alias.                                                                        |
| G-D4 | **A separate graph, LightRAG-style:** entities and relationships live in their own tables, apart from notes.                                                                                                                                          |
| G-D5 | **One entity per person, place or thing; a note is optional.** An entity may point at a note written about it. The protagonist's entity points at their profile note. People, places & things lists entities.                                         |
| G-D6 | **Imports build the graph**, as a step after the stories are written, and the person reviews it before it is saved (as PRD D9: anything can be left out).                                                                                             |
| G-D7 | **A button builds it from stories already saved**, with the same review.                                                                                                                                                                              |
| G-D8 | **Ask does not use the graph yet.** Graph retrieval (LightRAG's entity and relationship matching) is the next step, once the graph has been seen to be right.                                                                                         |

What LightRAG does, and what is taken from it: an AI reads each chunk and extracts entities (name, type, description) and relationships between them (two entities and a description); entities with the same name are merged; questions are later matched against entities (specific) and relationships (broader themes). Taken here: entities as nodes of their own, relationships as described edges between them, merging by name (with aliases), and incremental building. Left for later: the retrieval side (G-D8) and AI-written entity summaries.

## 3. Data

Migration `supabase/migrations/20261028140000_graph.sql`. RLS on for every table, like the others; the API connects as the table owner and applies the visibility rules below in every query.

### 3.1 Tables

**`public.graph_entities`**

- `id`, `archive_id` (cascade with the project), `type` (`person` | `place` | `thing`), `name`, `match_key`;
- `note_id` (nullable, unique, `references notes(id) on delete set null`): the note written about it;
- `description` (text, default ''): its lines from the stories every member can see, joined in code (3.3);
- `created_by`, `created_at`, `updated_at`, `run_id` (the import run that made it; null when made by hand or by the backfill).
- Unique on `(archive_id, type, match_key)`.

**`public.graph_aliases`**

- `archive_id`, `entity_id` (cascade), `alias`, `match_key`.
- Unique on `(archive_id, match_key)`. An alias may not equal another entity's name key in the same project.
- Family words ("Dad", "Grandma", "my mother") are never aliases: they mean someone different to each speaker (3.4). A name made from a relationship ("Noah's mother") is an alias once the entity is renamed.

**`public.graph_mentions`**: one row per entity per story.

- `archive_id`, `entity_id` (cascade), `note_id` (the story; cascade), `words` (text[]: as written in the story, "his mother"), `line` (one sentence about the entity from this story, in the third person), `sources` (jsonb: the interview lines, `[{ interviewId, from, to }]`, or the story's own sentences for stories without an interview), `run_id`, `created_at`.
- Unique on `(entity_id, note_id)`.

**`public.graph_relationships`**: one row per relationship per story. Rows are added or deleted, never changed.

- `archive_id`, `a_id`, `b_id` (entities, cascade), `description` ("Sarah Lee — Noah's friend from school"), `note_id` (the story it came from; cascade), `sources` (as mentions), `run_id`, `created_by`, `created_at`.
- `a_id <> b_id`. The pair is unordered for drawing; the description carries the direction.
- Unique on `(least(a_id, b_id), greatest(a_id, b_id), note_id)`: one relationship per pair per story.

**`public.graph_changes`**: who changed the graph by hand, and when (G4).

- `archive_id`, `entity_id`, `kind` (`rename` | `type` | `merge` | `remove` | `remove-relationship` | `note`), `before` and `after` (jsonb), `created_by`, `created_at`.

**Changed:**

- `ingest_runs`: a run may make no notes (a graph-only run from the button), and gains `kind` (`import` | `graph`).
- `archives`: gains `graph_backfilled_at` (3.5).

### 3.2 Match keys

`matchKey(name)`, in `@funmem/core`, used everywhere a name is compared:

- Unicode NFC, lowercased, trimmed, inner whitespace collapsed;
- punctuation removed ("Mrs. Han" = "Mrs Han"; "Sarah-Lee" = "Sarah Lee");
- a leading "the " removed for things and places ("the sewing machine" = "sewing machine").

A name and its aliases resolve to one entity: `find_entity` and the review's "same as…" list use the key, plus close spellings (edit distance ≤ 1 on keys of 5 or more characters) as candidates, never as automatic matches.

### 3.3 Visibility

Notes can be private to their author (`visibleSql`). The graph never shows what someone cannot read:

- A **mention** or **relationship** is visible to a member if they can see its story.
- An **entity** is visible if they can see its note, or at least one of its mentions or relationships. The protagonist's entity is always visible to members.
- An entity's **name and aliases** are visible with the entity.
- An entity's **description** is built only from the lines of stories every member can see. A private story's lines appear only on its author's view of the entity page, as its own lines.

### 3.4 Family words

Family words are resolved per speaker, as in the PRD: "my mother" said by Noah is Noah's mother. With no name given, the entity is named from the relationship and the teller's name ("Noah's mother"). The story's `tellers` and the profile name the speakers.

### 3.5 What exists from day one

- **The protagonist is always a node.** Every personal project gets its protagonist's person note when it is made (this reverses the "only when a profile is entered" rule in `stories/profile-store.ts`), and their entity pointing at it. The profile's aliases are kept as the entity's aliases. An older project gets both the first time its graph is read or built, or a story job runs.
- **Today's person, place and object notes become entities** pointing at them, once per project, in code, the first time its graph is read or built (`archives.graph_backfilled_at`). Done in code, not SQL, so match keys have one implementation.
- **Today's `[[links]]` from stories to those notes become mentions** in the same backfill (words: the link's text; line: the sentence around it, from `links.snippet`).
- **Writing a person, place or object note by hand** creates its entity, or attaches to the entity with the same key. A family narrator added before an interview gets one this way.
- No note is edited by any of this.

## 4. Building the graph

### 4.1 The Graph step (imports)

A new step in `server/api/src/stories/workflow.ts`, after the stories are written, judged and fixed, for each part of the interview (the same 200k-token parts). It uses the same deadline and call budget.

**In:** the stories written in this part (every sentence cited), the part's numbered lines, the "Who this is about" block, and the story tellers.

**Tools** (read-only, `stories/tools.ts` style):

| Tool                | Returns                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `find_entity(name)` | entities whose name or alias has the same match key, plus close spellings as candidates: id, name, type, aliases, a few of its lines |
| `read_entity(id)`   | its description, aliases, and relationships (descriptions only)                                                                      |

**Out** (JSON):

- **entities:** `{ ref, name, type, match: <entityId> | "new" | "ask", candidates?: [ids], mentions: [{ story, words: [..], line, cites: [..] }] }`.
- **relationships:** `{ a: ref, b: ref, description, story, cites: [..] }`. Only what the lines say: being in the same story is not a relationship.

**Things** become entities only when specific ("the sewing machine", "kimchi soup", not "a cup") and the story is about them: in its title, in two or more stories, or one of at most 3 things the AI names for a story. Code enforces the cap and that the words are in the story.

### 4.2 Checks

Every mention line and relationship description is checked like a story sentence (`stories/check.ts`, `stories/judge.ts`):

1. **Code:** every name and number in it appears in its cited lines (or the profile, `P`); the mention's words appear in the story's text; citations stay within the story's own lines; a relationship's two entities are both mentioned in that story.
2. **AI judge** (temperature 0, one call for all of a part's lines): `supported` or `made_up` (and the other verdicts as for stories). A mention's line that fails is cleared (the mention stays: its words are in the story); a relationship that fails is dropped; an entity left with no mention is dropped. There is no rewrite round: the graph is cheap to leave out and easy to build again.

### 4.3 Limits

- One AI call per part for the Graph step, plus one judge call per part, within the 200-call and 12-minute budget.
- At most 60 entities and 100 relationships proposed per import; at most 3 things per story.
- If the step fails or runs out of time, the stories are kept and only the graph waits: `graph.pending` with a reason (the same reasons as `pending`). The button (4.4) builds it later.

### 4.4 The button: "Find people, places and things"

On People, places & things (for members who can add memories). It starts a background job like an import (`POST /v1/archives/:id/graph/build`), which:

- groups the project's saved stories by interview, and for each group runs the Graph step over the stories and their interview's transcript;
- for stories without an interview (hand-written, or older memories), uses the story's own sentences as its numbered lines;
- proposes only what is new: mentions and relationships already in the graph are not proposed again.

It shows the same review as an import (5.1) and saves nothing until the person saves. Its run has `kind = 'graph'`.

## 5. Review, saving, undo and editing

### 5.1 Review

The import review (`ImportRun.tsx`) gets a group under the stories, **People, places and things**, using the stories' "Looks right / Leave it out" pattern. Each row shows:

- the name and type, marked **New** or **Already here as "Sarah Lee"** (or, for `ask`, "Is this Sarah Lee?" with the candidates);
- the words used, and its line from each story;
- its relationships, each of which can be left out on its own.

Quick fixes:

- **Rename** a new entity ("Noah's mother" → "Mina Kim"): the old name becomes an alias.
- **Same as…** an existing entity, chosen from a list (by match key and close spellings).

Leaving out an entity leaves out its relationships. Leaving out a story leaves out the mentions and relationships that came only from it.

### 5.2 Saving

One transaction with the stories (`ingest-save.ts`): entities, aliases, mentions and relationships are written with the run's id, and the descriptions of the entities touched are rebuilt (3.1). If two imports make the same name at once, the unique key catches it and the second attaches to the first.

### 5.3 Undo

Undoing a run deletes its mentions and relationships, and the entities it made unless they have since been worked on: renamed, merged into, retyped, given a note, or mentioned by another run. This follows the existing rule: never erase what someone has worked on.

### 5.4 Editing (on the entity page)

For members who can add memories; each change is recorded in `graph_changes`.

- **Rename**: the old name becomes an alias.
- **Change type**: person, place or thing.
- **Merge** another entity into this one: its mentions, relationships and aliases move here (its name becomes an alias); it is removed. A relationship that would join the entity to itself is dropped.
- **Remove a relationship.**
- **Remove an entity**: its mentions and relationships go with it; stories are never touched.
- **Write a note** about it: opens the note editor for a person, place or object note, linked to the entity.

## 6. What people see

### 6.1 Home: "Who and where"

A graph under the interview area of Home.

- People as circles with initials, places as pins, things as small squares; size grows with the number of stories.
- The protagonist is a little larger and starts in the centre; only told relationships connect to them.
- Solid lines: told relationships. Faint dashed lines: in the same story (G-D1), with a switch to hide them.
- Entities with no lines sit around the edge.
- Tap a node: its lines and neighbours light up, and it opens its page. Tap a line: its descriptions and the stories they come from.
- Chips filter People, Places and Things.
- At most 80 nodes, most-mentioned first, then "and N more on People, places & things".
- On a phone it fills the width and can be panned and zoomed. A plain list of everyone in it follows, for screen readers and small screens.
- Empty: "No people or places yet. They appear as interviews are brought in.", with "Find them in your stories" when there are stories.
- Layout: `d3-force` (a small, standard library; the app has none today).

### 6.2 People, places & things

The People & places page lists entities in three tabs, with story counts. An entity's page shows:

- its name, aliases and type, and its note if it has one (the protagonist's shows their profile);
- **What the stories say**: each visible mention's line, linking to its story;
- **Relationships**: each description, linking to the other entity and the story;
- its own graph ("How X fits in", drawn from the graph, both kinds of line);
- the editing actions (5.4).

### 6.3 Names in stories

On a story's page and in the review, the words of each mention are underlined and open the entity's page: the first occurrence of each mention's words in each paragraph. The story's text is never changed for this; `[[links]]` in it keep working as before.

### 6.4 API

| Route                                                   |                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/archives/:id/graph`                            | members: `{ nodes: [{ id, name, type, stories, subject, noteId }], told: [{ a, b, lines: [{ description, storyId, storyTitle }] }], together: [{ a, b, stories }], more }`, all filtered by visibility |
| `GET /v1/archives/:id/entities`                         | members: entities with type, aliases and story counts                                                                                                                                                  |
| `GET /v1/archives/:id/entities/:entityId`               | members: the entity, its mentions, relationships and note                                                                                                                                              |
| `PATCH /v1/archives/:id/entities/:entityId`             | writers: `{ name?, type? }`                                                                                                                                                                            |
| `DELETE /v1/archives/:id/entities/:entityId`            | writers                                                                                                                                                                                                |
| `POST /v1/archives/:id/entities/:entityId/merge`        | writers: `{ from: entityId }`                                                                                                                                                                          |
| `DELETE /v1/archives/:id/relationships/:relationshipId` | writers                                                                                                                                                                                                |
| `POST /v1/archives/:id/graph/build`                     | writers: starts the button's job; returns the job like an import                                                                                                                                       |
| `GET /v1/archives/:id/notes/:noteId`                    | gains `mentions: [{ entityId, words }]`                                                                                                                                                                |

The browser-only demo (`lib/demo-api.ts`) answers the same routes.

## 7. Code layout

- `packages/core/src/match-key.ts`: `matchKey`.
- `server/api/src/graph/`:
  - `store.ts`: the tables, visibility SQL, the backfill, the protagonist entity;
  - `step.ts`: the Graph step (prompt, tools, JSON parsing);
  - `check.ts`: its code checks (reusing `stories/check.ts`);
  - `save.ts`: saving with an import, undo;
  - `edit.ts`: rename, type, merge, remove;
  - `routes.ts`: the routes in 6.4;
  - `build.ts`: the button's job.
- `server/api/src/stories/workflow.ts`: calls the Graph step after the stories.
- `apps/web/src/components/WhoAndWhere.tsx` (Home graph), `pages/People.tsx` (entities), `components/NoteText.tsx` (underlined names), `components/ImportRun.tsx` (review group).

## 8. Testing

No test calls a live AI.

- **Unit:** `matchKey`; the code checks; the things rule; faint lines leave out the protagonist and the tellers.
- **Scripted-model workflow tests:**
  - "my mother" said by Noah becomes "Noah's mother";
  - `ask` with candidates;
  - a made-up relationship is dropped, and an entity with no supported line is dropped;
  - the bridge: "My friend Sarah introduced me to her brother Tom" gives Noah–Sarah and Sarah–Tom, and no Noah–Tom relationship;
  - the step failing leaves the stories intact, with `graph.pending`.
- **Database tests:**
  - a private story's mentions, relationships and entity are hidden from another member;
  - undo removes a run's rows and spares a renamed or merged entity;
  - merge moves mentions, relationships and aliases, and drops a self-relationship;
  - the backfill turns person, place and object notes and their links into entities and mentions, once;
  - the protagonist entity exists for new and older personal projects.
- **Real model:** an eval over Sunja and a Noah fixture with the example above (`scripts/eval-graph.ts`), and a click-through in the browser.

**Done when:**

- On the Noah fixture: Noah, his mother, Korea, kimchi soup and seaweed soup are nodes; Tom joins only through Sarah.
- No duplicate entities on name variants ("Sarah" / "Sarah Lee" / "sarah lee"; "Mrs. Han" / "Mrs Han").
- Undo returns the graph to how it was before the run.

## 9. Left out

- Ask using the graph (G-D8), and embeddings of entity and relationship descriptions.
- AI-written entity summaries (descriptions are joined lines for now).
- Automatic duplicate suggestions (merging is by hand).
- A family-tree layout.
- Adding an entity or a relationship by hand, other than by writing a note.

## 10. Delivery

Each part ships on its own and gets its own implementation plan.

1. **G1, the graph from what exists:** the migration, `matchKey`, the protagonist always present, entities for hand-written notes and the backfill, the read routes, Home's graph, the entity pages, underlined names.
2. **G2, imports fill it:** the Graph step, its checks, the review group, saving and undo.
3. **G3, the button** for stories already saved.
4. **G4, editing:** rename, type, merge, remove, write a note.

## 11. What building it changed

Measured on the real model (`eval:graph`, Noah and Sunja) and in the browser:

- **Answers a brace short.** Long Graph step answers ended one `}` short (and with a lone `</think>`), so
  every one failed to parse. `readJson` (`stories/tools.ts`) now closes what an answer left open; it
  never mends a cut string.
- **Second-hand lines.** Told that knowing of someone through another is not a relationship, the model
  still wrote "Noah Kim — knew Tom only from Sarah's stories". Code drops descriptions of that shape
  (`SECOND_HAND` in `graph/step.ts`), so Tom joins only through Sarah.
- **Places in passing.** The model skipped places named in passing ("in Korea") in about half of the
  runs. The step asks once more, alone, about capitalized names in the stories its answer left out;
  what it adds is checked like the rest.
- **Words.** A mention's words are what the story writes, at most four words; otherwise the way the
  story writes the name ("Noah's mother" for "Noah Kim's mother"), never a name's first word.
- **Names.** A relative named in the lines ("my father Walter") is filed under the name; the relation
  is a relationship. One relationship per pair per story; a description repeating the name is cut to
  one side.
- **The protagonist from day one.** Every personal project gets its protagonist's person note when it
  is made (tests that counted a fresh project's notes now leave it out: `NOT_PROTAGONIST`).
- **Backfill in code, not SQL.** Existing notes become entities the first time a project's graph is
  read, so `matchKey` has one implementation.
