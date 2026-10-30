# Design: people, places and things first, as notes the stories link to

- **Date:** 2026-10-29
- **Status:** Built (E1), 2026-10-29; E2 (the button) remains planned
- **Changes:** the graph design (`2026-10-28-people-places-graph-design.md`): G-D5 ("a note is optional") and G-D6 (the Graph step after the stories); its sections 4.1–4.4 (building), 5.1–5.3 (review, saving, undo) and 6.3 (names in stories). The graph's tables, Home's graph, the entity pages and editing (5.4) stay.
- **Scope:** when an interview is imported, find every person, place and thing in its transcript first, make a note for each, then write the stories with real `[[links]]` to those notes. The "Find people, places and things" button does the same for stories already saved.

## 1. Problem

After an import, a story names "his mother", "Korea" and "seaweed soup", but:

- **No note is made for them.** The Graph step (after the stories are written) makes graph rows; a note exists only if one was already there.
- **Links are weak.** A name is underlined only the first time, and only when the words the Graph step gave match the story exactly; it opens the entity page. Real `[[links]]` are added only for notes that already exist when the story is written (`linkKnownTitles`), so a new project gets almost none.
- **The writer does not know who is who.** It writes "his mother", "Mina" and "she" freely, and a later step has to guess which words mean whom.
- **If the Graph step fails,** the stories are saved with no names marked at all.

## 2. Decisions

| #    | Decision                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-D1 | **Find first.** The people, places and things (objects and foods too) are found in the transcript **before** the stories are planned. The Graph step after the stories goes away. (Replaces G-D6's order.)                |
| E-D2 | **Every entity has a note.** Its text is a short description written from the interview, one to four sentences, every sentence cited and checked like a story sentence. (Replaces G-D5's "a note is optional".)           |
| E-D3 | **An existing note gets a paragraph, never a rewrite.** The new interview proposes a paragraph to add at the end, reviewed like a story. What is already written is never changed.                                       |
| E-D4 | **Stories link with real links.** The writer marks who each sentence names and with which words; code checks each mark and writes `[[Note title\|words]]` at the first time a story names each one.                       |
| E-D5 | **The button does the same for saved stories:** notes and paragraphs, and links added into the stories (brackets only, checked), reviewed first.                                                                          |
| E-D6 | **The protagonist** gets no paragraph and is not linked: every story is about them, and their note is the profile.                                                                                                        |
| E-D7 | **Approach:** find first (chosen) over "notes and links added after the stories" (the writer still would not know who is who) and "names first, notes written last from the stories" (one more pass; notes depend on review). |

## 3. The import, step by step

`server/api/src/stories/workflow.ts`, within the import's deadline (12 minutes) and call budget (200). Step 2 has its own slice of them, at most a third of the deadline (and never more than 4 minutes) and 60 calls, so it can never use up what the stories need:

1. **Prepare** (as today): who is telling, numbered lines, parts of at most ~200k tokens.
2. **Find everything** (new, 4): for each part, the people, places and things, their descriptions, the ways they are called, and the relationships told.
3. **Check what was found** (4.3): code checks, then the judge; failing sentences are dropped.
4. **Plan** (as today), the planner also given the list (names and types only).
5. **Write** each story with the list; each sentence marks the names it uses (6).
6. **Check, judge and fix** each story (as today: the checks and the judge read the sentences without links).
7. **Review** (7): the stories, and a group "People, places and things".

If step 2 fails (no AI, out of its slice of time or calls, an answer that cannot be read), steps 4–6 run as today without a list, the stories have no links, and the result says `graph.pending` with the reason. A cancel by the person still ends the import. The button (8) finds them later: it takes exactly the stories without links.

## 4. Finding everything (the Entity step)

`server/api/src/graph/find.ts`, replacing the story-reading part of `graph/step.ts`; its tools, checks and fixes (section 11 of the graph design) carry over.

### 4.1 In and tools

**In:** the part's numbered lines, the "Who this is about" block (cited `P`), the tellers, and the project's known entities (name, type, aliases, note title).

**Tools** (read-only, as today): `find_entity(name)`, `read_entity(id)`.

### 4.2 Out

```json
{
  "entities": [
    {
      "ref": "e3",
      "name": "Noah's mother",
      "type": "person",
      "match": "new",
      "candidates": [],
      "ways": ["his mother", "Mom"],
      "description": [
        { "text": "Noah's mother made seaweed soup on every birthday.", "cites": ["L12"] }
      ]
    }
  ],
  "relationships": [
    { "a": "e3", "b": "e1", "description": "Noah's mother — made his birthday soup", "cites": ["L12"] }
  ]
}
```

- **name:** a real name when the lines give one ("my father Walter" is filed under "Walter"; the relation is a relationship); else one built from the relation, from the protagonist's side ("Noah's mother").
- **match:** an existing entity's id, `"new"`, or `"ask"` with `candidates` (as today).
- **ways:** how the narrator calls it, in the third person from the protagonist's side ("my mother" → "his mother"), at most four words each, and at most 8 ways. Never pronouns.
- **description:** one to four sentences in the third person, about this entity, each with its cites. For an entity that already has a note: only what this interview adds; empty when it adds nothing.
- **Things** only when specific and remembered for themselves ("the tin of savings", "seaweed soup"), never passing objects ("a cup").
- **Relationships:** only what the lines tell; knowing of someone through another is not a relationship (the `SECOND_HAND` rule).
- The recall pass (graph design 11, "places in passing") asks once more about capitalized names in the lines that the answer left out.

### 4.3 Checks

1. **Code** (`stories/check.ts`): every name and number in a description sentence or relationship appears in its cited lines (or the profile); cites are within the part; a way to call it is at most four words and is not a pronoun.
2. **The judge** (`stories/judge.ts`, temperature 0): one call for every ten or so entities' sentences and relationships. A sentence that fails is dropped; a relationship that fails is dropped. No rewrite round.
3. **Entities are never dropped** for failing sentences: an entity with no sentence left keeps its note with only its title.

### 4.4 Limits

Per import: at most 60 entities, of which at most 20 things; at most 100 relationships; at most 4 sentences per description; at most 8 ways per entity. One Entity-step call per part (plus its tool calls and the recall call), and one judge call per ten or so entities, within the step's own 60 calls (section 3). The parts are read side by side.

## 5. The notes

### 5.1 Someone new

A proposed note:

- **Title:** the entity's name.
- **Type:** `person`, `place`, or `object` (for a thing; `NOTE_TYPE` in `graph/types.ts`).
- **Body:** the checked description, as one paragraph. Empty when every sentence failed.
- **`extra.sources`:** `[{ sentence, sources: [{ interviewId, from, to }] }]`, retaining the checked sentence and its cited lines.
- **Graph:** its entity is made with `note_id` set; real names and nicknames given become aliases; ways that are family words ("his mother", "Mom") do not (graph design 3.4).

### 5.2 Someone who already has a note

A proposed paragraph at the end of that note, saved as a new version of it:

> _From “Noah's birthdays”:_ She made seaweed soup every year.

- The interview's name, then the description. Its sources are added to `extra.paragraphs: [{ runId, sources }]`, keeping each import's paragraph sources together for undo.
- Nothing already in the note changes. No paragraph when the description is empty; the stories still link to the note.

### 5.3 Someone in the graph without a note

An entity from before this change (made by the Graph step, or the backfill) gets a new note as in 5.1, attached to it.

### 5.4 The protagonist

No paragraph, no links (E-D6). Other tellers are treated like anyone else.

### 5.5 Titles

Note titles are unique in a project. A new note whose title is already taken by a note of another type gets its type added: "Busan (place)"; after that, "Busan (2)" (as `resolveTitles` already does for stories). Titles are settled at save time for the stories and the new notes together (`resolveTitles`), and every link is written with the final title, including after a rename in review.

### 5.6 Renaming later

Renaming a note already updates every link to it (`packages/core/src/rename.ts`). Renaming "Noah's mother" to "Mina Kim" (on the note or the entity page) renames both; the old name becomes an alias.

## 6. Writing the stories with links

### 6.1 What the writer gets and gives

`stories/write.ts`. The prompt gains the list:

```
e3  Noah's mother (person): his mother, Mom
e7  Busan (place): Busan
e9  Seaweed soup (thing): seaweed soup, miyeokguk
```

Each sentence gains `names`:

```json
{ "text": "His mother made seaweed soup.", "cites": ["L12"], "paragraph": false,
  "names": [{ "e": "e3", "words": "His mother" }, { "e": "e9", "words": "seaweed soup" }] }
```

The planner (`stories/plan.ts`) is given the names and types only, to tell people apart.

### 6.2 Code checks on each mark

A mark is kept when:

- `e` is on the list and is not the protagonist;
- `words` is in the sentence as whole words, ignoring case;
- `words` is one of the entity's ways, its name or an alias, or a word of its name of three letters or more ("Mina" for "Mina Kim"); a trailing "'s" is allowed.

A mark that fails is dropped and counted (`stats.stories.problems.mark`); the sentence stays. A mark never makes a story be written again.

### 6.3 Names the writer did not mark

After writing, code looks in each sentence for each entity's name and aliases (never its ways: "his mother" may mean someone else in another sentence) and marks the first one found, if that entity is not yet marked in the story.

### 6.4 Where the links go

- The first time a story names each entity, the words become a link: `[[Noah's mother|His mother]]`, or `[[Busan]]` when the words are the title exactly.
- Later mentions in the story stay plain text.
- Every kept mark, linked or not, is recorded as a mention (`graph_mentions`: the story, the words, the sentence as `line`, its cites as `sources`).
- `linkKnownTitles` still runs, only for titles that are not an entity's note (another story's title, for example), never for the protagonist's, and never inside a link already written.

## 7. Review, saving and undo

### 7.1 Review

`components/ImportRun.tsx`, the group **People, places and things** (replacing today's graph group, `GraphReview.tsx`):

- **A new note:** its title, type, description, and the stories that name it. Keep it, rename it, say it is the same as someone already in the project (its description becomes a paragraph for that note, or that entity's first note if it has none, 5.3), or leave it out.
- **A paragraph for an existing note:** the note's title and the paragraph. Keep it or leave it out.
- **Relationships:** under each entity, each can be left out (as today).

What leaving out does:

- A note left out: its links in the stories become their plain words, and its relationships go.
- A story left out: the notes stay (they come from the transcript), without that story's links and mentions; a relationship tied to it is tied to its first entity's note instead (7.2).

The review's choices travel as today's `graphPatch`, extended: `{ leave, rename, same, leaveParagraph }`.

### 7.2 Saving

One transaction with the stories (`ingest-save.ts`, `persistImport`):

1. Settle every title: the stories and the new notes together (5.5).
2. Write the new notes (`revision_reason` `import`), their entities with `note_id`, and their aliases.
3. Add each kept paragraph to its note as a new revision (`import`, the run's `change_id`).
4. Write the stories with their links, pointed at the final titles. The link index is updated by the existing note writes, so backlinks work at once.
5. Write the mentions and the relationships with the run's id. A relationship is tied (`note_id`) to the story whose lines include its cites; if none, to the note of its first entity.

### 7.3 Undo

`undoImport` tells apart the notes a run **made** (their first revision is the run's) from the notes it **changed** (an earlier revision exists):

- Notes it made (stories and new notes) are removed, as stories are today: what a person has since edited, or linked to from their own writing, is kept and listed.
- Notes it changed (an added paragraph, or links added by the button) are restored to the revision before the run's (`restore`), unless the note has a later revision; then it stays and is listed.
- Mentions and relationships of the run go; entities go with their notes unless worked on (as today, `undoGraph`).

## 8. The button: "Find people, places and things"

`graph/build.ts`, `POST /v1/archives/:id/graph/build`, a run of `kind = 'graph'`:

1. **Which stories:** saved stories with no mentions yet. Running it twice does not redo work.
2. **Find everything:** the Entity step (4), per interview over its transcript; for stories without an interview, over their own sentences as numbered lines, so descriptions cite those.
3. **Notes:** new notes and paragraphs, as in 5.
4. **Marking:** an AI pass reads up to 8 stories at a time with the list and returns, for each story's sentences, `names` as in 6.1, without changing text. The checks in 6.2 and the search in 6.3 apply.
5. **Links:** code adds brackets at the first mention of each entity, then checks that the story with the brackets taken out is exactly the story before; if not, the story is left as it was.
6. **Review:** the notes and paragraphs (as 7.1), and each story with its new links shown; drop all of a story's links, or leave out one.
7. **Saving:** each changed story gets a new revision (`ai-suggestion`, the run's `change_id`).
8. **Undo:** as 7.3: the notes it made go, and each story it changed is restored to its revision without the links, unless edited since; then it stays and is listed.

## 9. Data

The entity-note fields reuse existing tables. Undo adds two migrations:

- `graph_entities.note_id` is now always set for entities this work makes; older entities get theirs when the button or an import reaches them.
- A new entity note's sentence sources go in `notes.extra.sources` as `[{ sentence, sources }]` (a story's are flat `{ sentence, from, to, start, end, text }`).
- Paragraph sources go in `notes.extra.paragraphs: [{ runId, sources }]`; a paragraph is an `import` revision.
- `20261029120000_import_created_notes.sql` changes deletion-time run cleanup to count only notes whose first revision belongs to the run.
- `20261029130000_import_undo_changes.sql` records `ingest_runs.undo_change_id`, distinguishing import undo restores from a person restoring history during later undos.
- The graph design's wording "a note is optional" (its section 2 and the table comment) changes to "every entity has a note"; the table comment changes in the next migration that touches the table.

## 10. Code layout

- `server/api/src/graph/find.ts` (new): the Entity step: prompt, tools, parsing, the recall pass; reuses `SECOND_HAND`, `uncovered`, `waysToSay` from `graph/step.ts`.
- `server/api/src/graph/marks.ts` (new): the mark checks (6.2), the search (6.3), link placement (6.4), and the brackets-only check (8.5). Pure functions.
- `server/api/src/graph/mark-step.ts` (new): the button's marking pass (8.4).
- `server/api/src/graph/step.ts`: what is left of the Graph step is removed once nothing calls it.
- `server/api/src/stories/workflow.ts`, `plan.ts`, `write.ts`: the new order and the list.
- `server/api/src/graph/save.ts`, `ingest-save.ts`: notes, paragraphs, links, undo.
- `apps/web/src/components/GraphReview.tsx` → the new review group; `lib/demo-api.ts`: demo data with entity notes and links.
- Docs: this spec, the graph spec's changed sections, `docs/ingest/api.md`.

## 11. Testing

No test calls a live AI.

- **Unit:**
  - parsing the Entity step's answer (ways, description, the caps, things);
  - the mark checks: whole words, ways, a word of the name, "'s", the protagonist refused;
  - the search for unmarked names, never by ways;
  - first-mention links and `[[Title]]` when the words are the title;
  - the brackets-only check, both ways;
  - title clashes: "Busan (place)", then "Busan (2)".
- **Scripted-model workflow tests:**
  - the list reaches the writer; a story with "his mother" links to "Noah's mother";
  - a wrong mark ("his father" for e3) is dropped and the sentence stays;
  - the Entity step failing: stories without links, `entities.pending`;
  - Tom joins only through Sarah.
- **Database tests:**
  - saving: new notes with entities, paragraphs as revisions, stories with links and backlinks, mentions, relationships;
  - a note left out: its links become plain words; a story left out: the notes stay;
  - undo: notes removed, a paragraph restored, an edited note kept and listed;
  - the button: links added to saved stories, a story whose text would change is left alone, undo restores them;
  - visibility as before.
- **Web:** the review group (keep, rename, same as, leave out; paragraphs); a story's links open notes.
- **Real model:** `eval:graph` over Sunja and Noah: every entity has a note; Noah's mother, Korea, kimchi soup and seaweed soup are notes; Tom joins only through Sarah; the stories have links and none to the protagonist. The eval reports the marks dropped by the checks, by reason.
- **Browser:** import → review → save → click a link → the note with its backlinks → undo.

**Done when:** on the Noah fixture, every person, place and thing in the transcript has a note, every story links its first mention of each, and undo returns the project to how it was.

## 12. Delivery

Two parts, each with its own implementation plan:

1. **E1, imports:** the Entity step and its checks (4), the notes (5), writing with links (6), review, saving and undo (7).
2. **E2, the button:** finding, marking and linking saved stories (8).

## 13. Left out

- Rewriting an existing note from old and new text (E-D3 keeps what is written).
- Linking every mention, not only the first.
- Ask using the graph (graph design G-D8).
- Automatic duplicate suggestions (merging stays by hand).

## 14. Before it can run in the preview

The hosted database needs the three migrations from the last round (`20261028120000_interviews.sql`, `20261028130000_profiles.sql`, `20261028140000_graph.sql`), followed by `20261029120000_import_created_notes.sql` and `20261029130000_import_undo_changes.sql`. Then the Worker and the web app need redeploying (`docs/deploy.md`). A person has to do this; nothing here does it.

## 15. What building E1 changed

- Names are checked as whole words. A place may be named through its people or language
  ("Korea" from "Korean"); a person's name may not. The Entity step reads parts in parallel,
  with its own deadline and call slice so stories still have a budget when finding fails.
- An existing note is used only when every member may read it. Private notes never receive a
  paragraph or public story link, even when the importer owns them. Save checks this again.
- Shared proposed refs get one note and at most four description sentences. Description text
  cannot create links or marker lines. Both entity attachment paths reject a competing note;
  a complete transaction retry replans titles and keeps disagreement markers unchanged.
- Undo restores before the run's first revision, removes its paragraph source entry, and
  rebuilds links and chunks. It clears graph rows by run even when their notes stay. Liveness
  and duplicate detection count notes created by the run, including deletion-time cleanup.
- A later import's links preserve an entity note. Import undo restore revisions are recorded
  as bookkeeping so neither the current nor an earlier undo invents evidence of human work.
- The review distinguishes graph-only outcomes using `format: "graph"`; entity notes survive
  skipped stories. A rename conflicting with another kept type is warned about and ignored.
- E2 still uses the earlier graph-only workflow: no new notes or paragraphs from the button.

The real-model eval on 2026-10-29 (`eval:graph`, run alone) passed every check for both fixtures:
Noah produced 3 stories in 245.6 s with 3 writer marks dropped; Sunja produced 5 in 363 s with 12
dropped (sentences kept). Entity notes, first-mention prose links, expected nodes, protagonist
exclusion and Tom's relationship through Sarah all passed. The first Sunja run, made while the
full test suite and two reviewers shared the machine, ended with `graph.pending: deadline`: the
Entity step's 4-minute slice ran out and the stories were saved without links, as designed. Run
the eval on an idle machine. The eval uses the installed `vite-node` runner and loads the ignored
root `.env`; its assertions have pure tests that never call a live model.

Browser click-through (local stack, real API and model): the Noah fixture reviewed after 279 s with
10 "New note" rows, "Sarah" shown as "Adds to", and 5 dashed story links. Renaming his mother to
"Mina Kim" and leaving out "seaweed soup" saved links to Mina's note ("In 2 stories") and plain
words for the soup; Sarah's note gained its paragraph. Undo erased 12 notes, restored 1, and
Sarah read as before. No page errors. The full suite (1975 server, 80 web, 60 core, 43 persona
tests), typecheck, eslint and prettier passed.

Review of the finished work fixed: undoing two imports that both added to one note, newest first,
no longer leaves the older paragraph behind (revisions from an undone import, or from an import's
undo, are not later work); "Same as" in the review drops a stale paragraph choice; an interview
name cannot write a `[[link]]` into a note's paragraph.
