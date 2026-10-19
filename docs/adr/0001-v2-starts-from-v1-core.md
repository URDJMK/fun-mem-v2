# 0001 — v2 starts from v1's core and server, without v1's UI

Date: 2026-10-19 · Status: accepted

## Context

fun_mem v1 (github.com/URDJMK/fun_mem) grew through many rounds: three web designs, an agent
"gauntlet" harness with its ledger and evidence files, photos, markdown export and import, and
the interview ingestion that the competition demo depends on. Its UI was going to be rebuilt
anyway, by someone else, and the interview screen with it.

## Decision

v2 is a new repository with a fresh history.

- **Carried over unchanged:** `packages/core`, `packages/persona`, and the server, including all of
  its AI (ingestion, the assistant, the draft composer, Q&A) and v1's tests for it.
- **Left in v1:** photos and markdown export (the server code, its tests and the photo table), the
  CodeMirror editor package, every page and design, the interview page, and the harness. The commits
  that remove photos and export say what changed where the rest of the code touched them.
- **New:** a plain web app with only sign-in and the wiki notes, keeping v1's words; the schema as
  one migration ([0002](0002-data-api-reaches-no-table.md)); simple conventions
  ([docs/conventions.md](../conventions.md)).

## Consequences

- The code that works keeps working: the server's v1 tests run here against v2's database.
- The welcome page's words still promise things v2 does not have yet (markdown export, answers to
  questions). They are v1's words, kept on purpose until the new design decides.
- Anything left in v1 can be copied back later: v1 is unchanged, and its `main` holds everything.
