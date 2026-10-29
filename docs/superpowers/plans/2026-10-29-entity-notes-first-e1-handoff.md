# E1 handoff: where the build stopped

**Plan:** `docs/superpowers/plans/2026-10-29-entity-notes-first-e1.md` (12 tasks).
**Spec:** `docs/superpowers/specs/2026-10-29-entity-notes-first-design.md`.
**Branch:** `claude/dreamy-euler-z5cgvh`. Everything below is committed and pushed.

## Status

E1 was completed in the continuation on 2026-10-29. The remaining sections preserve the original
review findings and implementation guidance; the fixes below have been applied. See the design's
section 15 for findings, and `docs/deploy.md` for required hosted migrations and redeployment.

| Task | State |
| --- | --- |
| 1–8 | Done and reviewed before this handoff |
| 9 (save notes, links, mentions, relationships) | Restored in `d7d2d80`, reviewed fixes in `f14de6d` and `571e01c`; complete |
| 10 (undo restores changed notes) | Complete in `1cf7c19`, including both new undo migrations |
| 11 (web review) | Complete in `f4a4cec` |
| 12 (eval, docs, full check, browser) | Eval, docs and full check done. The browser click-through was not run in this session (see the completion report) |

The original stop warning is resolved: imports now create the notes their stories link to, and
undo restores added paragraphs. Hosted use still requires applying the migrations before
redeploying the Worker and web app. E2 (the button's entity notes and story links) remains separate.

## Where the plan text was changed by what was built

Read the plan's tasks with these changes:

- **Entity step (`graph/find.ts`)**:
  - The name rule matches whole words (`wordsOf`, `nameHeld`).
  - A place may be named by its people or language ("Korea" from "Korean", plus a table of irregular ones); a person may not.
  - The Entity step has its own slice: `min(deadline/3, 4 min)` and 60 calls, which `deps.findDeadlineMs` and `deps.findCallCap` override. When the slice runs out, the stories are still written, without links, and `graph.pending` is set. Parts run in parallel. The spec says this too.
- **`mergeFound` (in `find.ts`)** merges by existing entity id first, and never merges two different existing ids.
- **`graph/proposal.ts`** holds `castOf`, `withStories`, `mentionIn` and `storyOf`. `marksOf(sentences, cast)` is pure, in `graph/marks.ts`.
- **Story bodies:**
  - **Proposal (Tasks 6–7):** a story holds `[[Proposed name|words]]`. Review relinks it (`relinkMemories`, Task 7), and save relinks it again to the final titles (`linkStories`, Task 9).
  - **The button:** the button's graph-only run is recognised by `outcome.format === 'graph'` (`isGraphOnly` in `graph/build.ts`).
  - **Renames:** a rename is cleaned of `[ ] # ^ |`, and a rename onto the name of another kept entity of a different type is ignored.
- **`appendParagraph` (`notes.ts`)**:
  - It checks visibility itself and returns false on empty text.
  - Sources go to `extra.paragraphs: [{ runId, sources }]`, not `extra.sources`. The spec text still needs fixing for this (Task 12).
- **`notePlan` (in the dropped Task 9 commits; keep it when redoing)**:
  - An `existing` note is used only when it is shared with every member (the `sharedTitles` rule).
  - A note that is private, even the importer's own, gives `none`: plain words and no paragraph.
  - It returns `make` / `existing` / `none`; `make` carries `name` and `type`.
  - `entityNoteInputs` returns `{ refs, hint, input }`; `saveGraph` takes `notes: { plan, made, interviewName, changeId }`.
  - `persistImport`'s `note_count` is the number of stories.

## 9b. Task 9: the fixes to make when redoing it

This is the code review of the dropped commits `5df4409..ee80536`. Apart from these items, the reviewer judged them sound. **Important**

1. **`linkStories` and `relinkMemories` rewrite the "May disagree with [[X]]" marker lines** (`relink` at `graph/save.ts` ~364 and ~124).
   - With a note "Busan" in the archive and a new place "Busan", a marker `> ⚠ May disagree with [[Busan]] · …` becomes `[[Busan (place)|Busan]]`. `markerTarget` then returns the wrong title, so the quote is never scrubbed when a note is erased.
   - Fix: relink line by line and leave every line starting with `>` alone. Use one shared helper for both functions.
   - Test: the marker stays `[[Busan]]` while the prose link becomes `[[Busan (place)|Busan]]`.
2. **A run counts as alive through notes that only got a paragraph** (`aliveSql` ~766 and `forgetEmptyRuns` ~800 in `ingest-save.ts`).
   - Both count any note with a revision under the run's `change_id`. Delete the import's only story and the run is still "active", so re-importing the same interview is refused as a duplicate.
   - Fix (with Task 10): count only the notes the run made, meaning those whose first revision has the run's `change_id`. Change both places, and `listRuns`.

**Minor**

3. **The same name in two types:** the last one wins in `linkStories`' `to` map (~358). Keep the first.
4. **`entityFor` can silently leave a new note without an entity** (~393–408). Use `returning note_id` and throw if it is not the new note.
5. **Descriptions are not cleaned of `[[`/`]]`,** so a sentence can create a real link in a new note.
   - Strip them.
   - `sourcesFor` keeps a leading `>` that the body strips; clean each sentence the same way.
6. **`entityNoteInputs` merges refs without the 4-sentence cap.** Cap it at 4, or at `MAX_NOTE_CHARS`.
7. **The "shared with every member" SQL exists twice** (`save.ts` ~224 and `sharedTitles`). Extract `sharedNoteSql(alias)`.
8. **`entityNoteInputs` dedups by object identity.** Key it by `entityId ?? type:matchKey(name)`.
9. **The `appendParagraph` return value is ignored.** Count or log a refusal.
10. **`paragraphText`:** escape `_` and `*` in the interview name.
11. **Optional:** split the note-planning code (~230 lines) into `graph/entity-notes.ts`.
12. **Missing tests:**
    - a retry of the whole save;
    - a relationship that falls back to b's note;
    - a thing note;
    - the marker preserved (1);
    - an entity renamed onto an existing note's title;
    - one name used in two types;
    - an entity whose note is the protagonist's while `e.subject` is false.

Also for Task 10: if import 2 only links to a note made by import 1, undoing import 1 erases that note. Import 2's story revisions have reason `import`, which `undoImport`'s `linked` check ignores, so its links are left pointing at nothing.

## Notes for Task 10 (undo)

- **Leftover rows:** a run's relationships can be tied to an existing note, or to an entity note that the undo keeps. Delete `graph_mentions`/`graph_relationships` by `run_id` for import runs too (`undoGraph`), not only by cascade.
- **Counts:** `runsOf` / `aliveSql` / `forgetEmptyRuns` / `listRuns` should count only the notes the run made (see 9b, Important 2). Keep the meaning of `alive` and `note_count`.
- **Paragraph sources:** undo removes the run's `extra.paragraphs` entry.
- **Restore point:** a note can get two paragraphs in one run (two revisions, one `change_id`). Restore it to the revision before the run's first one.

## Notes for Task 11 (web)

- `apps/web/src/components/ImportRun.tsx` (~363, ~760) still tests `memories.length === 0 && outcome.graph` for the button's run. Add `format?: string` to the client outcome type and test `outcome.format === 'graph'`.
- The review page should warn about a rename onto the name of another kept entity of a different type (the server ignores it).

## Notes for Task 12 (eval, docs)

- **Spec 5.2 and 9:** change "`extra.sources`" to "`extra.paragraphs: [{ runId, sources }]`" for paragraphs.
- **`docs/ingest/api.md`:**
  - `leaveParagraph`;
  - the proposal fields `ways`, `description`, `note`, `subject` and `story: null`;
  - the undo outcome's `restored`;
  - the Entity step's own slice;
  - `stats.stories.calls` includes the Entity step's calls.
- **Nit:** rename the inner `timer` in `workflow.ts` `findAll` to `findTimer`.
- **`scripts/eval-graph.ts`** still describes the old Graph step. Rewrite it per the plan's Task 12.

## Running the tests

- A local Supabase stack runs in Docker. If it is down, recreate it as `docs/deploy.md` and the earlier plans describe.
- Then:

  ```sh
  export FUNMEM_SUPABASE_URL=http://127.0.0.1:54321
  export FUNMEM_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
  cd server/api && npx vitest run test/graph-save.test.ts
  ```

- One wall-clock test, `grounding-meaning.test.ts` "each under 1 s", fails on a slow machine and is unrelated.
