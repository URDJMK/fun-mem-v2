# PRD: Interviews become stories

- **Date:** 2026-10-28
- **Status:** Draft for review
- **Scope:** the interview import (`server/api/src/ingest-*.ts`), the notes and links it writes, and the screens that show them (Interviews, review, Stories, People)

## 1. Problem

An imported interview should become a set of readable family stories, connected to the people and places in them. Today it does not.

What the import does today, measured on a real run with NVIDIA working (live interview, 26 Oct 2026, 4 memories) and on the 30 real model proposals in `server/api/test/fixtures/grounding-golden.json`:

1. **Stories read like transcripts.**
   - The wording check (`grounding-check.ts`) rejects any word that was not said, and any rewrite that drops more than 10% of a turn's words.
   - So a "tidied" memory is the transcript minus fillers. In all 30 golden proposals the body is identical to what was said.
   - In the live run, 1 of 4 memories was tidied, and it still repeats a transcription error ("built the chicken coop up himself").
2. **Things that are not stories are called stories.**
   - The model is told to skip greetings, but the coverage rule ("every turn of the teller ends up in exactly one memory") turns each skipped line back into a memory. For example, "And I'm Nell. Hello, dear." became the memory "I'm Nell".
   - Short replies become "Short answers" notes.
   - Every imported note is saved as type `event`, so all of them appear under Stories.
3. **Titles are weak.**
   - A memory the AI could not tidy is titled with its first sentence ("I'm Nell", "I grew up on a farm outside Dayton, Ohio").
   - The live interview's name is the first thing said after the setup step ("Hi.").
4. **Stories are too small.** One memory is capped at 4 turns or 3,500 characters, so a single episode is cut into fragments.
5. **The AI sees 6,000 characters at a time.** Stories that cross a boundary are split, and later parts do not know who "he" or "Dad" is.
6. **The import never touches existing notes.** It only creates new ones. A second interview about the same farm makes a second farm story.
7. **People and places are not managed.**
   - The import never creates person or place notes.
   - Links resolve only by exact title (ignoring case), so "Mrs. Keller" and "Mrs Keller" are different targets.
   - There are no aliases.
8. **There is no real-model quality check.** All tests use scripted fake models.

The AI is also currently down in production: NVIDIA rejects the deployed key (403). That is an operations fix (a new key) and is not part of this PRD, but no part of this PRD can be evaluated without a working key.

## 2. Goals

1. Each imported interview becomes a small number of **stories**: whole episodes, written about the person like a biography, with titles that capture the story.
2. **Nothing is made up.** Wording is free: a story may paraphrase, condense, reorder and summarize. But every event, person, place, number and date in it was actually told, and every sentence is traceable to what was said and checked.
3. The full transcript is kept with the interview, so nothing said is lost. Greetings and small talk stay there and out of Stories.
4. A new interview **extends or merges** existing stories instead of duplicating them.
5. **One person or place, one note.** Names, nicknames and spelling variants resolve to it.
6. Every change is proposed on the review screen and saved only when a person accepts it. A whole import can be undone.
7. The workflow is the same fixed sequence of steps every time, resumable, and measurable on real transcripts.

### Non-goals

- The live interview coach, Deepgram transcription, the Ask page, and the AI assistant.
- Languages other than English (ADR 0003).
- Rewriting notes saved by imports before this change. They have no stored transcript to work from, so they stay as they are.
- Choosing an AI provider. This PRD uses the existing NVIDIA client (`nim.ts`), with the model configurable.

## 3. Decisions (from the 2026-10-28 discussion)

| # | Decision |
|---|---|
| D1 | The AI reads the **whole transcript at once**, up to **200,000 tokens** (with the notes it looks up). A longer interview is read in 200k-token parts; the stories proposed so far are carried into the next part, which may revise them. |
| D2 | The AI reads everything but **writes in pieces**: a plan first, then each story separately. This is because the model's answer is limited to a few thousand tokens, much less than what it can read. |
| D3 | A note is a **story**: a whole episode or period told from start to finish. It is not a single moment, and there is no 4-turn cap. |
| D4 | Stories are written **about** the person, in the third person, like a biography ("Sunja was born in Busan, probably in the spring of 1946…"). When several relatives tell the same story, it says who remembers what ("Nell remembers…; Aunt Mae remembers…"). Disagreements are kept, attributed, and never resolved. |
| D5 | Titles come from the story's heart, like a book of family stories ("Mrs. Han's pencil box", "Gravy at the church supper"). Under 60 characters, and every word backed by the story. |
| D6 | The full transcript is stored with the interview. This replaces the rule that every spoken sentence must become a memory. The "Short answers" notes go away. |
| D7 | An import may **edit any note**. It may **delete only by merging**: the merged-away note's content is carried into the surviving note, and the old note is removed. Nothing is deleted outright. |
| D8 | People and places get **one note each, with aliases**. Family words ("Dad", "Grandma") are resolved per speaker, not stored as aliases. |
| D9 | The import proposes a note for **every named person and place**. A person can untick any. |
| D10 | Architecture: approach 1 (plan → write → judge) as a **fixed, repeatable workflow**, whose AI steps **use tools** to look things up (from approach 3). Tools can read and propose; they never write. |
| D11 | **Paraphrasing is free; only making things up fails.** The AI may reword, condense, reorder, summarize and add plain transitions ("Years later,"). It may not add an event, person, place, number, date or quote that was not told, contradict what was said, or credit one person's memory to another. A merge keeps the content of every merged note, not its exact wording. |

## 4. Definitions

- **Interview:** a stored transcript (turns with speaker, time and text) plus its name, date and who added it. It is shown on the Interviews page.
- **Story:** a note of type `event` written by this workflow (or by a person). Stories are what the Stories page lists.
- **Person / place note:** a note of type `person` / `place`. Its title is the canonical name.
- **Alias:** another name for a person or place note ("Tommy" for "Tom Marsh"). It is unique within a project, together with titles.
- **Match key:** the form used to compare names: lower case, Unicode NFC, punctuation removed, spaces collapsed. "Mrs. Keller" and "mrs keller" have the same match key.
- **Citation:** a sentence's source, either transcript lines (`interview, lines 12–15`) or a sentence of an existing note.
- **Change set:** everything one import proposes: new stories, edits, merges, new people and places, new aliases.

## 5. User experience

### 5.1 Adding an interview

The two ways in stay the same: the live interview's "Turn into memories" (renamed **"Write the stories"**), and "Bring in a recorded transcript".

- The interview is saved with its transcript immediately, then the workflow runs in the background, as imports do today.
- The interview's default name is the date plus the topics chosen at setup ("Interview, 26 Oct 2026 · Childhood"), never the first words spoken. It can be edited.

### 5.2 The review screen

One screen shows the change set, in four groups. Each item can be accepted, rejected or edited.

1. **New stories:**
   - title and body;
   - each sentence can show its source lines ("Where this comes from");
   - sentences the judge removed are listed under the story ("Left out, because the interview doesn't say this: …");
   - sentences more certain than the speaker was are marked ("She said she wasn't sure about the year").
2. **Changes to existing stories:**
   - the old and new text side by side, with additions marked;
   - for a merge, both old notes and the merged result.
3. **People and places:**
   - new notes ("Mrs. Keller", "Dayton, Ohio");
   - new aliases ("Tommy → Tom Marsh");
   - questions where the AI was unsure ("Is this John the uncle or John the neighbour?"), each answered by picking a note or "someone new".
4. **Disagreements** found by the existing contradiction check (unchanged).

"Save" applies the accepted items in one transaction. Nothing changes before that.

### 5.3 Stories, Interviews, People

- **Stories** lists notes that are not people or places, as today. The import adds only stories there (no greetings, no "Short answers").
- **Interviews** lists interviews with their transcripts. Each story links back to the lines it came from.
- **People** lists person notes with their aliases, and a place index alongside (person and place notes are already excluded from Stories).

### 5.4 When the AI is unavailable

- The interview and its transcript are saved, marked **"Stories not written yet"**.
- A "Write the stories" button re-runs the workflow when the AI is back.
- Nothing is chopped into "as spoken" fragments any more.

### 5.5 Undo

Undoing an import reverses its whole change set:
- **New notes** are erased.
- **Edited notes** go back to their previous revision.
- **Merged-away notes** are restored from their last revision, with their links and aliases.
- **Aliases** it added are removed.

As today, a note somebody has worked on since is kept, with the reason given.

## 6. The workflow

A fixed sequence of steps, built on the project's existing workflow runner (Mastra `createWorkflow`, as the current pipeline uses). It runs in the existing import job (queue consumer on Workers, background run on Node).

Each step's input and output are stored on the job (`ingest_jobs`), so:
- a run that dies resumes from its last finished step;
- "Write the stories" again re-runs from the plan step.

| Step | Kind | In | Out |
|---|---|---|---|
| 1. Prepare | code | transcript | turns, roles (who is the narrator), parts of ≤ 200k tokens |
| 2. Plan | AI + tools | one part + carried proposals | the plan |
| 3. Write | AI + tools, once per story | plan entry, cited lines, notes it extends or merges | story with a citation on every sentence |
| 4. Judge | code, then AI | story + its sources | verdict per sentence |
| 5. Fix | back to 3, at most 2 times | failing sentences + reasons | story; sentences that still fail are removed and listed |
| 6. Link | code | stories + entity plan | `[[Canonical\|words used]]` links; entity and alias proposals |
| 7. Disagreements | existing check | change set | disagreement markers (unchanged policy) |
| 8. Roll forward | — | next part, if any | back to step 2, with every proposal so far as context |
| 9. Review and save | person, then code | change set | one transaction; an undo record |

### 6.1 Step 1, Prepare (code)

- Reuse today's parsing and narrator detection (`transcript.ts`, `roles.ts`), including asking the person to confirm the narrator when unsure.
- Count tokens (estimated at 4 characters per token, configurable).
- Split into parts of at most `FUNMEM_STORY_CONTEXT_TOKENS` (default 200,000), minus a reserve for tool results. Parts end only after a narrator turn.

### 6.2 Step 2, Plan (AI with tools)

Tools (all read-only):

| Tool | What it returns |
|---|---|
| `search_notes(query)` | matching notes (title, type, a snippet), using the existing search (keywords plus vectors) |
| `read_note(id)` | a note's full text, aliases and links |
| `find_entity(name)` | person or place notes whose title or alias has the same match key, plus close spellings |
| `stories_about(noteId)` | stories that link to a person or place |

The plan step must return JSON with:
- **stories:** working title; transcript line ranges; `new` / `extends <note>` / `merges <notes>`; who tells it.
- **entities:** each person or place mentioned, matched to an existing note, given a new alias, or new; or `ask` with the candidates when unsure. Family words are resolved per speaker ("Dad" said by Sunja → her father; a new person note "Sunja's father" if no name is given).
- **interview name:** a proposed name (date plus topics), used only when the person did not name it.

Limits:
- at most 20 tool calls;
- an answer that is not valid JSON is asked for once more, then the step fails (5.4).

### 6.3 Step 3, Write (AI with tools)

- One run per story in the plan, up to 3 at a time.
- Tools: `read_lines(from, to)`, `read_note(id)`.
- Writing rules (in the prompt; the hard ones are checked in step 4):
  - third person, past tense; the narrator is called by the project's name for them;
  - wording is free (D11): paraphrase, condense, reorder, summarize, plain transitions; minor details may be left out;
  - nothing is made up: no event, person, place, number, date or detail that was not told;
  - every sentence ends with its citation, e.g. `[L12-L15]`, or `[N:<noteId>#3]` for a sentence of an existing note; a summarizing sentence may cite a wide range;
  - direct quotes are allowed only in quotation marks and must match the transcript word for word;
  - doubt should be kept where it matters ("probably in 1946" for "I think it was 1946"); losing it is flagged on the review screen, not rejected;
  - when several people tell it, each account is attributed; a disagreement is told as both accounts;
  - a title under 60 characters, from the story's heart, using only what the story says.
- An extended or merged story must carry over the content of every sentence of the notes it absorbs (see 7.3).

### 6.4 Step 4, Judge

The judge asks one question: **is anything made up?** It does not judge wording.

**Code checks first** (cheap, certain). Each one fails the sentence:
1. Every sentence has at least one citation, and every citation points to real lines or note sentences.
2. Every name, number, date and place in a sentence appears in its cited source. Spoken numbers are compared as digits (`speech.ts`), and names by match key or alias.
3. A direct quote matches its source word for word.
4. Merges and extensions: every sentence of each absorbed note is cited by at least one sentence of the result, so no content is lost.
5. Title: names, numbers and heavy facts must come from the story (`checkTitleFacts`); length and shape as today (`acceptTitle`).

**Then the AI judge**: a separate call, no tools, temperature 0. It gets the story, sentence by sentence, with each sentence's cited source, and is told that paraphrase, condensing and summary are fine. It rules on each sentence:

| Verdict | Meaning | Effect |
|---|---|---|
| `supported` | the source tells this, in any wording | passes |
| `made_up` | adds an event, action, detail or claim the source does not tell | fails |
| `contradicts` | says the opposite of the source | fails |
| `misattributed` | someone else told it | fails |
| `less_certain_in_source` | the speaker was unsure and the sentence is not | passes, flagged on the review screen |

A story passes when no sentence is `made_up`, `contradicts` or `misattributed`.

### 6.5 Step 5, Fix

- Failing sentences go back to step 3 with the verdicts and reasons. At most 2 rounds per story.
- After that, sentences that still fail are removed and listed on the review screen.
- A story left with fewer than 2 sentences is dropped. Its lines stay in the transcript.

### 6.6 Step 6, Link (code)

- Each person or place mention becomes `[[Canonical title|words used]]` ("[[Tom Marsh|her father]]"). The words in the story do not change.
- New person and place notes are proposed with a one-line body built from the story ("Sunja's teacher in Busan, who gave her a pencil box when she left school.") and checked like any story sentence.
- New aliases are proposed for real names and nicknames only, never for family words.

### 6.7 Budgets and time

| | Default | Env var |
|---|---|---|
| Plan tool calls | 20 | `FUNMEM_STORY_PLAN_TOOLS` |
| Write tool calls per story | 8 | `FUNMEM_STORY_WRITE_TOOLS` |
| Fix rounds per story | 2 | |
| AI calls per import | at most 2 per part (plan, one JSON retry) + 6 per story (write and judge, plus 2 fix rounds of both), capped at 200 | |
| Deadline per job | 12 minutes (the Workers queue consumer allows 15) | `FUNMEM_STORY_DEADLINE_MS` |
| Models | `STORY_MODEL` (default `NIM_MODEL`) for plan and write; `STORY_JUDGE_MODEL` (default the same) for the judge | |

A run that hits a budget or the deadline keeps the stories that passed, lists the rest as "not written", and offers "Write the stories" again.

## 7. Data

### 7.1 New tables

- **`public.interviews`:**
  - `id`, `archive_id`, `name`, `recorded_at`, `created_by`, `created_at`;
  - `turns jsonb` (index, speaker, start, end, text), `speakers jsonb` (who is the narrator, display names);
  - `stories_status` (`pending` | `written` | `failed`);
  - `run_id` (the import that wrote its stories).
  - Deleted with its project. The transcript is new stored data, so it is covered by project deletion and undo.
- **`public.note_aliases`:** `archive_id`, `note_id`, `alias`, `match_key`. Unique on `(archive_id, match_key)`. A new alias may not equal any note title's match key, and a new title may not equal an alias.

### 7.2 Changed

- **`links`:** link resolution matches a target against titles and aliases by match key (`notes.ts:194–230`, and the unresolved-target index). Existing exact-title links keep working.
- **`notes.extra.sources`:** per-sentence citations for stories (`[{ sentence, interviewId, from, to } | { sentence, noteId, index }]`), used by "Where this comes from".
- **`ingest_runs`:**
  - gains `interview_id`;
  - gains `changes jsonb`, recording each edited or merged note and the revision it replaced, for undo.
- **`ingest_jobs.outcome`:** holds the change set and each step's output (6).

### 7.3 Policy change

`docs/ingest/conflict-policy.md` says the AI may only add sentences and may not delete notes. It changes to:

- The AI may **propose** any edit to any note, and a **merge** of notes. A person accepts or rejects each on the review screen.
- The AI may paraphrase freely (D11); it may not make anything up.
- A merge carries over the content of every sentence of the merged notes, each cited (6.4, check 4), not the exact wording. The merged-away note's text stays in its revision history and comes back on undo.
- Disagreements are still never resolved: both accounts stay, attributed.
- People editing by hand are not restricted (unchanged).

## 8. Failure handling

| Situation | What happens |
|---|---|
| No AI configured, or the key is rejected | Interview saved, "Stories not written yet", button to retry. No calls are made after a rejected key (as today). |
| AI slow or erroring | Each call retried as `nim.ts` does today; a step that still fails stops the run at that step; the job resumes from it. |
| Plan is not valid JSON | Asked once more, then the run stops with "Stories not written yet". |
| A story fails the judge twice | Unsupported sentences removed and listed (6.5). |
| Budget or deadline reached | Passed stories kept; the rest listed as not written (6.7). |
| Worker restarts mid-run | The job's heartbeat marks it interrupted, and it resumes from the last stored step (today it fails as `interrupted`). |
| Two imports touch the same note | The second save re-checks each edited note's revision; a note changed since the proposal is shown again for review, not overwritten. |

## 9. Privacy

- The transcript is now kept, deleted by undo or by deleting the project.
- The AI now sees the transcript **and** the existing notes it looks up. That is more family text sent to NVIDIA than today. The trial terms on NVIDIA's free API do not allow personal data, so production needs a paid plan or another provider. `docs/deploy.md` ("Who sees the data") is updated to say this.

## 10. Measuring it

### 10.1 Evaluation set

`server/api/test/fixtures/stories/`:
- the Sunja sample (`docs/ingest/samples/grandma-sunja-en.txt`);
- the live Nell interview (from 26 Oct 2026);
- one long transcript (about an hour);
- a second Sunja interview that retells her childhood.

Expected results:

| Transcript | Expected |
|---|---|
| Sunja | 4–6 stories (childhood by the harbour; school and the pencil box; the factory and the tin; meeting Minho and the wedding; Daegu). People: father, mother, Jaesung, Mrs. Han, Minho, Mr. Baek. Places: Busan, Daegu. No greeting in any story. |
| Nell | 1 story (the farm and the eggs). Mrs. Keller as a person. "Hi." never a title or name. |
| Second Sunja interview | Extends the childhood story; adds no duplicate people. |
| Name variants | "Mrs. Keller" and "Mrs Keller" resolve to one note. |

### 10.2 Metrics

`pnpm --filter @funmem/api eval:stories` runs the set against the real model and reports:
- story count and titles;
- the share of sentences that pass on the first try, and how many are flagged `less_certain_in_source`;
- sentences removed;
- judge disagreements with a second judge run;
- duplicate entities;
- time and AI calls per import.

### 10.3 Release bar

- 100% of saved sentences cited, and none judged `made_up`, `contradicts` or `misattributed`.
- At least 90% of sentences pass on the first try.
- No greeting or small talk in Stories.
- Zero duplicate people on the name-variant cases.
- An hour-long interview finishes within the 12-minute deadline.

### 10.4 Automated tests

Run in CI, with scripted fake models as today:
- every code check in 6.4;
- the fix loop and its limits;
- resume after a crash;
- aliases and match keys;
- link resolution through aliases;
- merge and undo (an edited and a merged note restored);
- the review screen's change set save, all or nothing.

No test calls a live AI.

## 11. Delivery in phases

Each phase ships on its own and gets its own implementation plan.

1. **Stories from interviews.**
   - Interviews with stored transcripts.
   - Steps 1–5 and 9 for **new** stories only.
   - The review screen's new-stories group.
   - "Stories not written yet".
   - The evaluation set and metrics.
   - This removes problems 1–5 from section 1.
2. **One name, one note.**
   - Aliases and match keys, and link resolution through aliases.
   - Step 6 (people, places and aliases proposed).
   - The People and places groups on the review screen.
   - Merging duplicate person and place notes.
3. **Extending and merging stories.**
   - Plan targets `extends` / `merges`.
   - Merge carry-over checks, edits on the review screen.
   - Undo of edits and merges.
   - The policy change in 7.3.

## 12. Risks and open questions

1. **NVIDIA.**
   - The key is currently rejected.
   - The free tier is slow and fails about 1 call in 4 (measured on the coach), and its terms exclude personal data.
   - The hosted endpoint's real context limit is unknown, and must be measured before relying on 200k tokens.
2. **Judge reliability.** An AI judge can wave through a made-up sentence, and a looser wording rule (D11) leaves more to it. The code checks catch names, numbers, dates, places and quotes; the AI judge covers made-up events and details. The evaluation set measures how often it is wrong, by comparing two judge runs and spot checks by a person.
3. **Cost and time.** About 2–4 AI calls per story, plus the plan. A two-hour interview with 20 stories is about 60–80 calls. Paid Workers plan needed for CPU time (as already noted in `docs/deploy.md`).
4. **Merges of first-person notes.** Older notes are in the speaker's own words. Under D4 and D11, carried-over content is rewritten in the third person and cited to the old note sentence by sentence, and the original text stays in the revision history. (Confirmed 2026-10-28: a merge keeps content, not wording.)
5. **Existing archives** keep their old imported notes. They have no stored transcript, so they cannot be rewritten as stories (non-goal).
