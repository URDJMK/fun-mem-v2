# The protagonist's profile: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task.

**Goal:** a project knows who it is about (born, died, what the family calls them). That profile goes with every AI step that writes or checks a story, and ages said in an interview become years.

**Spec:** PRD D13, D14 and 7.5 (`docs/superpowers/specs/2026-10-28-interviews-become-stories-prd.md`).

**Deferred from 7.5:** an interview proposing to fill in an empty birth date ("I was born in 1946"). Phase 2 proper does that with the rest of the people work.

**Architecture:**
- The profile is stored on the protagonist's person note, in `extra.profile` (`{ born, died, aliases }`), with fuzzy dates checked by `parseFuzzyDate`. Personal projects point at that note through `archives.subject_note_id`; it is created with the project, or lazily for older projects. In a family project each narrator's person note holds their own profile.
- The story workflow gets `profiles` and treats them as a line of their own, `L0`, cited as `P`. Every check therefore reads it like a transcript line, and the transcript shown to the AI stays as it was.
- Ages: the writer may return `age: { years, cites }`. Code turns it into `~(born + years)` only when the age is said in the cited lines, and records `dateBasis`.

## Tasks

1. **Migration** `supabase/migrations/20261028130000_profiles.sql`: `archives.subject_note_id uuid references notes(id) on delete set null`.
2. **`server/api/src/stories/profile.ts`** (test: `test/stories-profile.test.ts`):
   - `parseProfileInput(v)`: accepts "1946", "about 1946", "c. 1946", "~1946" and "1946-04-12"; aliases as a list or comma-separated, at most 10 of up to 60 characters; an error string otherwise.
   - `profileBlock(profiles)` and `profileLine(profiles)` (the `L0` text).
   - `ageYear(born, years)`.
   - `profilesFor(db, archiveId, tellerNames)`: the subject note, plus person notes whose title or alias matches a teller.
   - `ensureSubjectNote(deps, archiveId, userId)`.
   - routes `GET/PUT /v1/archives/:id/profile` (personal; write roles to change) and `PUT /v1/archives/:id/people/:noteId/profile`.
3. **Provision:** `POST /v1/provision` accepts `profile`. A personal project gets its subject's person note, holding the profile, right after it is made.
4. **Workflow** (tests in `test/stories-workflow.test.ts`):
   - `profiles` in `StoriesDeps`; the "Who this is about" block in plan, write and judge;
   - `P` citations (`parseCite('P')` gives `{from: 0, to: 0}`; the workflow adds line 0);
   - `age` in the draft becomes `occurred` `~YYYY` plus `dateBasis` when the age is said in its lines;
   - names in the profile count as known.
5. **Job:** `writeStoriesOf` loads `profilesFor` the tellers. Save writes `extra.dateBasis`.
6. **Web:**
   - `NewArchive`: born, died, and what the family calls them (personal projects);
   - `ProjectSettings`: an "About {name}" card;
   - `Home` `ChooseNarrator`: born, for someone new;
   - review: "Around 1964 (Sunja was 18; born ~1946)".
7. **Eval:** Sunja with a profile (born ~1946): "At eighteen" becomes ~1964 in "The tin of savings".
8. **Docs and the full check;** commit and push.
