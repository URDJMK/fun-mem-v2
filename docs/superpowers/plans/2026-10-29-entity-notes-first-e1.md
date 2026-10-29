# People, places and things first (E1, imports): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** when an interview is imported, every person, place and thing in its transcript is found first and gets a note (or a paragraph on the note it has), and the stories are written with real `[[links]]` to those notes.

**Spec:** `docs/superpowers/specs/2026-10-29-entity-notes-first-design.md`, sections 3–7 and 9–11 (E1). The button (section 8, E2) gets its own plan; until then it keeps working as it does today.

**Architecture:**

- A new step, `graph/find.ts`, runs before the stories are planned, per part of the interview. It reuses the Graph step's pieces, moved to `graph/shared.ts`: the tools, `findIn`, `waysToSay`, `uncovered`, `SECOND_HAND`, the name rule and the match resolution.
- The writer gets the list and marks names per sentence. `graph/marks.ts` (pure) checks the marks, finds names the writer missed, and writes the links. The checks and the judge still read plain sentences: links are added only when the story is assembled.
- At save, the new notes are written in the same `createNotesBatch` as the stories. Titles are settled together, and links follow the final titles (`relink`). `saveGraph` ties each entity to its note, appends paragraphs (`appendParagraph` in `notes.ts`), and writes mentions and relationships.
- Undo tells notes the run made from notes it changed, and puts changed notes back.
- The new fields on `ProposedEntity` are optional. The button's proposals (from `graph/step.ts`) do not have them and are saved exactly as today.

**Tech stack:** TypeScript, Hono, node-postgres, vitest, React 19.

**Running tests locally:**

```sh
export FUNMEM_SUPABASE_URL=http://127.0.0.1:54321
export FUNMEM_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
# one file
cd server/api && npx vitest run test/graph-marks.test.ts
# everything
pnpm -r typecheck && pnpm lint && pnpm format && pnpm -r test
```

If the local stack is down: `bash <scratchpad>/stack/stack-up.sh /home/user/fun-mem-v2` (it rebuilds the database from the migrations).

---

## File map

| File                                                                       | Responsibility                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/api/src/graph/types.ts`                                            | `ProposedEntity` gains `ways`, `description`, `note`, `subject`; `ProposedRelationship.story` may be `null`; `GraphPatch.leaveParagraph`                                          |
| `server/api/src/graph/store.ts`                                            | `FoundEntity` gains `note`; `knownFor` gains `subject` and `note`                                                                                                                |
| `server/api/src/graph/shared.ts` (new)                                     | moved from `step.ts`: `findIn`, `waysToSay`, `uncovered`, `SECOND_HAND`, `PRONOUNS`, `NAME_FILLER`, `entityTools`, `resolveMatch`                                                 |
| `server/api/src/graph/marks.ts` (new)                                      | pure: `allowedWords`, `checkMark`, `unmarked`, `linkSentences`, `linkText`, `relink`, `plainOf`                                                                                    |
| `server/api/src/graph/find.ts` (new)                                       | the Entity step: `FIND_SYSTEM`, `parseFound`, `findEntities`                                                                                                                      |
| `server/api/src/stories/write.ts`, `plan.ts`                               | the list in the prompt; `names` on each sentence                                                                                                                                 |
| `server/api/src/stories/workflow.ts`                                       | the new order; marks, links, mentions, relationships; `findGraph` removed                                                                                                         |
| `server/api/src/graph/save.ts`                                             | `applyGraphPatch` (notes stay; `leaveParagraph`), `relinkMemories`, `notePlan`, `entityNoteInputs`, `saveGraph` (notes, paragraphs, relationships without a story)                |
| `server/api/src/notes.ts`                                                  | `NewNoteInput.entity`; `appendParagraph`                                                                                                                                         |
| `server/api/src/ingest-save.ts`                                            | `persistImport` writes the entity notes and settles titles; `undoImport` puts changed notes back                                                                                 |
| `server/api/src/ingest-jobs.ts`                                            | `relinkMemories` after the reviewer's choices                                                                                                                                    |
| `apps/web/src/lib/api.ts`, `lib/links.ts`, `components/NoteText.tsx`       | types; links to notes still to be made shown as such in review                                                                                                                   |
| `apps/web/src/components/GraphReview.tsx`, `ImportRun.tsx`                 | the review group: descriptions, "New note" / "Adds to …", leave a paragraph out                                                                                                  |
| `server/api/scripts/eval-graph.ts`                                         | the real-model checks of spec 11                                                                                                                                                 |
| `docs/ingest/api.md`, both specs                                           | what changed                                                                                                                                                                     |

---

## Shared types (Task 1 defines them; every later task uses these names)

```ts
// graph/types.ts
export interface DescriptionSentence {
  text: string;
  sources: GraphSource[];
}

/** the note an entity gets, as the preview saw it; decided again at save (notePlan) */
export type EntityNote = { kind: 'new' } | { kind: 'existing'; noteId: string; title: string };

export interface ProposedEntity {
  ref: string;
  name: string;
  type: EntityType;
  match: EntityMatch;
  mentions: ProposedMention[];
  aliases?: string[];
  /** how the stories may call it, from the protagonist's side ("his mother", "Mom"); never aliases */
  ways?: string[];
  /** checked sentences about it from this interview: a new note's text, or a paragraph */
  description?: DescriptionSentence[];
  /** absent on the button's proposals (graph/step.ts): those make no notes */
  note?: EntityNote;
  /** the person the project is about: never linked, no paragraph */
  subject?: boolean;
}

export interface ProposedRelationship {
  ref: string;
  a: string;
  b: string;
  description: string;
  /** the story whose lines tell it; null when no story uses them (tied to a note at save) */
  story: string | null;
  sources: GraphSource[];
}

export interface GraphPatch {
  leave?: string[];
  rename?: Record<string, string>;
  same?: Record<string, string>;
  /** entity refs whose paragraph for an existing note is left out (their links stay) */
  leaveParagraph?: string[];
}
```

```ts
// graph/store.ts
export interface FoundEntity {
  id: string;
  name: string;
  type: EntityType;
  aliases: string[];
  lines: string[];
  close?: boolean;
  /** its note, when the member can see it */
  note: { noteId: string; title: string } | null;
}
export interface KnownEntity {
  id: string;
  name: string;
  type: EntityType;
  aliases: string[];
  subject?: boolean;
  note?: { noteId: string; title: string } | null;
}
```

```ts
// graph/marks.ts
export interface Listed {
  ref: string;
  name: string;
  aliases: readonly string[];
  ways: readonly string[];
  subject?: boolean;
}
export interface Mark {
  e: string;
  words: string;
}
```

---

### Task 1: types, and what the lookup knows about notes

**Files:**

- Modify: `server/api/src/graph/types.ts`
- Modify: `server/api/src/graph/store.ts` (`FoundEntity`, `entityLookup.find`, `knownFor`)
- Modify: `server/api/src/graph/step.ts` (move `KnownEntity` to `store.ts`; re-export it)
- Test: `server/api/test/graph-store.test.ts`

- [ ] **Step 1: Write the failing test.** In `graph-store.test.ts`, add:

```ts
it('the lookup and the known entities say which note each has', async () => {
  const { owner, archive, api } = await setup();
  const made = await api('POST', '/notes', { title: 'Grandpa Walt', type: 'person' });
  const noteId = ((await made.json()) as { id: string }).id;
  const found = await entityLookup(ctx.pool, archive, owner.userId).find('grandpa walt');
  expect(found[0]!.note).toEqual({ noteId, title: 'Grandpa Walt' });
  const known = await knownFor(ctx.pool, archive, owner.userId, []);
  const subject = known.find((k) => k.subject);
  expect(subject?.note?.noteId).toBeTruthy();
});
```

(`setup()` is the file's existing helper; if it is named differently, use the one that provisions a project and returns `{ owner, archive, api }`.)

- [ ] **Step 2: Run it:** `npx vitest run test/graph-store.test.ts`. Expected: FAIL, `note` is undefined.
- [ ] **Step 3: Implement.**
  - Add the types above to `types.ts`, and to `store.ts`.
  - In `entityLookup.find`, select the note when the member can see it, and return `note` on every row:

    ```sql
    select e.id, e.name, e.type::text as type, e.match_key,
           ...,
           (select json_build_object('noteId', n.id, 'title', n.title) from public.notes n
             where n.id = e.note_id and ${visibleSql('n', '$2')}) as note
    ```

  - In `knownFor`, add `(e.note_id = a.subject_note_id) as subject` and the same `note` column.
  - `step.ts` imports `KnownEntity` from `store.ts`, and `export type { KnownEntity }` keeps old imports working.

- [ ] **Step 4: Run it:** `npx vitest run test/graph-store.test.ts test/graph-step.test.ts`. Expected: PASS. Then `pnpm --filter @funmem/api typecheck`.
- [ ] **Step 5: Commit:** `feat(graph): entities say which note they have; new proposal fields`.

---

### Task 2: the Graph step's pieces, shared

**Files:**

- Create: `server/api/src/graph/shared.ts`
- Modify: `server/api/src/graph/step.ts` (import from `shared.ts`; no behaviour change)
- Test: the existing `test/graph-step.test.ts` must stay green

- [ ] **Step 1: Move**, unchanged, from `step.ts` to `shared.ts`, and export them:
  - `findIn`, `fold`, `waysToSay`, `uncovered`, `NOT_A_NAME`, `SECOND_HAND`, `PRONOUNS`, `NAME_FILLER`, `MAX_WORDS`, `str`, `lower`, `isObj`, `cites`.
  - The two tools, as a factory:

    ```ts
    /** the read-only tools both steps use; `offered` collects every entity id the AI was shown */
    export function entityTools(lookup: EntityLookup, offered: Map<string, string>): Tool[] {
      return [
        /* find_entity and read_entity, exactly as in graphStep today */
      ];
    }
    ```

  - The match resolution (step 4 of `graphStep`), as a function:

    ```ts
    /** the AI's "match" made safe: an id it was shown, or a project entity of the same name */
    export async function resolveMatch(
      e: { name: string; match: string; candidates: string[] },
      o: {
        lookup: EntityLookup;
        known: readonly KnownEntity[];
        offered: Map<string, string>;
      },
    ): Promise<EntityMatch> {
      if (e.match === 'ask') {
        const found = await o.lookup.find(e.name);
        for (const f of found) o.offered.set(f.id, f.name);
        const candidates = e.candidates
          .filter((c) => o.offered.has(c))
          .map((c) => ({ entityId: c, name: o.offered.get(c)! }));
        if (candidates.length) return { kind: 'ask', candidates };
      } else if (e.match !== 'new' && o.offered.has(e.match)) {
        return { kind: 'existing', entityId: e.match, name: o.offered.get(e.match)! };
      }
      const exact = (await o.lookup.find(e.name)).find((f) => !f.close);
      const known = o.known.find((k) =>
        [k.name, ...k.aliases].some((n) => matchKey(n) === matchKey(e.name)),
      );
      const same = exact ?? known;
      return same ? { kind: 'existing', entityId: same.id, name: same.name } : { kind: 'new' };
    }
    ```

- [ ] **Step 2: Run:** `npx vitest run test/graph-step.test.ts test/graph-build.test.ts`. Expected: PASS, unchanged.
- [ ] **Step 3: Commit:** `refactor(graph): share the Graph step's tools and name rules`.

---

### Task 3: marks and links (pure)

**Files:**

- Create: `server/api/src/graph/marks.ts`
- Test: `server/api/test/graph-marks.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, expect, it } from 'vitest';
import {
  checkMark,
  linkSentences,
  plainOf,
  relink,
  unmarked,
  type Listed,
} from '../src/graph/marks';

const MOTHER: Listed = { ref: 'e3', name: "Noah's mother", aliases: [], ways: ['his mother', 'Mom'] };
const MINA: Listed = { ref: 'e4', name: 'Mina Kim', aliases: ['Mina'], ways: ['his aunt'] };
const BUSAN: Listed = { ref: 'e7', name: 'Busan', aliases: [], ways: [] };
const NOAH: Listed = { ref: 'e1', name: 'Noah Kim', aliases: ['Noah'], ways: [], subject: true };
const list = new Map([MOTHER, MINA, BUSAN, NOAH].map((e) => [e.ref, e]));

describe('checkMark', () => {
  it('keeps words that are in the sentence and are a way to call it', () => {
    expect(checkMark('His mother made soup.', { e: 'e3', words: 'his mother' }, list)).toBe('His mother');
    expect(checkMark('Mina came.', { e: 'e4', words: 'Mina' }, list)).toBe('Mina');
    expect(checkMark("Kim's house was big.", { e: 'e4', words: "Kim's" }, list)).toBe("Kim's");
  });
  it('drops words not in the sentence, not its ways, or the protagonist', () => {
    expect(checkMark('His father came.', { e: 'e3', words: 'his father' }, list)).toBeNull();
    expect(checkMark('His mother came.', { e: 'e3', words: 'mother came' }, list)).toBeNull();
    expect(checkMark('Noah came.', { e: 'e1', words: 'Noah' }, list)).toBeNull();
    expect(checkMark('Mina came.', { e: 'e9', words: 'Mina' }, list)).toBeNull();
    expect(checkMark('Minato came.', { e: 'e4', words: 'Mina' }, list)).toBeNull();
  });
});

describe('unmarked', () => {
  it('finds a name or alias the writer left unmarked, never a way', () => {
    const found = unmarked(
      ['They lived in Busan.', 'His mother cooked.', 'Mina visited.'],
      [...list.values()],
      new Set(),
    );
    expect(found).toEqual([
      { sentence: 2, mark: { e: 'e4', words: 'Mina' } },
      { sentence: 0, mark: { e: 'e7', words: 'Busan' } },
    ]);
  });
});

describe('linkSentences', () => {
  it('links the first time each is named, the longer words first, and only there', () => {
    const out = linkSentences(
      ['His mother lived in Busan.', 'His mother loved Busan.'],
      [[{ e: 'e3', words: 'His mother' }, { e: 'e7', words: 'Busan' }], [{ e: 'e3', words: 'His mother' }]],
      (ref) => list.get(ref)!.name,
    );
    expect(out).toEqual([
      "[[Noah's mother|His mother]] lived in [[Busan]].",
      'His mother loved Busan.',
    ]);
  });
});

describe('relink and plainOf', () => {
  it('unlinks the left out, retargets the renamed, keeps the words shown', () => {
    const body = "[[Noah's mother|His mother]] lived in [[Busan]]. [[Tom]] came.";
    const out = relink(
      body,
      new Set(['tom']),
      new Map([
        ["noah's mother", 'Mina Kim'],
        ['busan', 'Busan (place)'],
      ]),
    );
    expect(out).toBe('[[Mina Kim|His mother]] lived in [[Busan (place)|Busan]]. Tom came.');
    expect(plainOf(out)).toBe('His mother lived in Busan. Tom came.');
  });
});
```

- [ ] **Step 2: Run it:** `npx vitest run test/graph-marks.test.ts`. Expected: FAIL, the module does not exist.
- [ ] **Step 3: Implement `marks.ts`.**

```ts
import { extractWikilinks, normalizeTitle } from '@funmem/core';
import { findIn, NAME_FILLER } from './shared';

/**
 * The names a story uses, as links (entity design 6): the writer marks who each sentence names
 * and with which words; code keeps a mark only when the words are in the sentence and are a way
 * to call that entity, finds the names the writer did not mark, and links the first time a story
 * names each one. Pure functions: no AI, no database.
 */
export interface Listed {
  ref: string;
  name: string;
  aliases: readonly string[];
  ways: readonly string[];
  subject?: boolean;
}
export interface Mark {
  e: string;
  words: string;
}

const bare = (w: string) =>
  w.replace(/[’‘]/g, "'").toLowerCase().replace(/'s$/u, '').replace(/\s+/g, ' ').trim();

/** what a mark's words may be: a name, an alias, a way, or a word of a name (3 letters or more) */
export function allowedWords(e: Listed): Set<string> {
  const out = new Set<string>();
  for (const n of [e.name, ...e.aliases, ...e.ways]) out.add(bare(n));
  for (const n of [e.name, ...e.aliases]) {
    for (const w of n.split(/\s+/)) {
      const b = bare(w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''));
      if (b.length >= 3 && !NAME_FILLER.has(b)) out.add(b);
    }
  }
  return out;
}

/** the words as the sentence writes them, when the mark holds; else null */
export function checkMark(
  sentence: string,
  m: Mark,
  list: ReadonlyMap<string, Listed>,
): string | null {
  const e = list.get(m.e);
  if (!e || e.subject) return null;
  const found = findIn(sentence, m.words);
  if (!found) return null;
  return allowedWords(e).has(bare(found)) ? found : null;
}

/** an entity's name or alias in a sentence the writer did not mark; never its ways */
export function unmarked(
  sentences: readonly string[],
  list: readonly Listed[],
  marked: ReadonlySet<string>,
): Array<{ sentence: number; mark: Mark }> {
  const out: Array<{ sentence: number; mark: Mark }> = [];
  for (const e of list) {
    if (e.subject || marked.has(e.ref)) continue;
    const names = [e.name, ...e.aliases].sort((a, b) => b.length - a.length);
    for (let i = 0; i < sentences.length; i++) {
      const words = names.map((n) => findIn(sentences[i]!, n)).find((w) => w !== null);
      if (words) {
        out.push({ sentence: i, mark: { e: e.ref, words } });
        break;
      }
    }
  }
  return out;
}

export const linkText = (title: string, words: string) =>
  words === title ? `[[${title}]]` : `[[${title}|${words}]]`;

/** where `words` stand in `text` as whole words, outside the spans already taken */
function placeOf(text: string, words: string, taken: ReadonlyArray<[number, number]>): number {
  const t = text.replace(/[’‘]/g, "'").toLowerCase();
  const w = words.replace(/[’‘]/g, "'").toLowerCase();
  for (let at = t.indexOf(w); at >= 0; at = t.indexOf(w, at + 1)) {
    const before = t[at - 1] ?? '';
    const after = t[at + w.length] ?? '';
    if (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after)) continue;
    if (taken.some(([s, e]) => at < e && at + w.length > s)) continue;
    return at;
  }
  return -1;
}

/** each sentence with a link at the first mark of each entity in the story */
export function linkSentences(
  sentences: readonly string[],
  marks: ReadonlyArray<ReadonlyArray<Mark>>,
  titleOf: (ref: string) => string,
): string[] {
  const done = new Set<string>();
  return sentences.map((text, i) => {
    const wanted = [...(marks[i] ?? [])]
      .filter((m) => !done.has(m.e))
      .sort((a, b) => b.words.length - a.words.length);
    const taken: Array<[number, number]> = [];
    const edits: Array<{ at: number; len: number; link: string }> = [];
    for (const m of wanted) {
      if (done.has(m.e)) continue;
      const at = placeOf(text, m.words, taken);
      if (at < 0) continue;
      taken.push([at, at + m.words.length]);
      edits.push({
        at,
        len: m.words.length,
        link: linkText(titleOf(m.e), text.slice(at, at + m.words.length)),
      });
      done.add(m.e);
    }
    let out = text;
    for (const x of edits.sort((a, b) => b.at - a.at))
      out = out.slice(0, x.at) + x.link + out.slice(x.at + x.len);
    return out;
  });
}

/**
 * Links to `unlink` (normalized titles) become the words they show; links to a key of `to` get
 * its title, still showing the words they showed. Everything else is left byte for byte.
 */
export function relink(
  body: string,
  unlink: ReadonlySet<string>,
  to: ReadonlyMap<string, string>,
): string {
  if (!body.includes('[[')) return body;
  let out = '';
  let at = 0;
  for (const l of extractWikilinks(body)) {
    if (l.embed || l.heading || l.blockId) continue;
    const key = normalizeTitle(l.target);
    const shown = l.alias?.trim() || l.target;
    const next = to.get(key);
    if (!unlink.has(key) && next === undefined) continue;
    out += body.slice(at, l.start) + (unlink.has(key) ? shown : linkText(next!, shown));
    at = l.end;
  }
  return out + body.slice(at);
}

/** the text with every link read as the words it shows */
export function plainOf(body: string): string {
  let out = '';
  let at = 0;
  for (const l of extractWikilinks(body)) {
    if (l.embed) continue;
    out += body.slice(at, l.start) + (l.alias?.trim() || l.target);
    at = l.end;
  }
  return out + body.slice(at);
}
```

The `unmarked` test expects its results in list order (Mina, e4, before Busan, e7). The list passed is `[MOTHER, MINA, BUSAN, NOAH]`. MOTHER has no name or alias in any sentence ("His mother" is a way, not a name), so it is skipped.

- [ ] **Step 4: Run it:** `npx vitest run test/graph-marks.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(graph): marks, links and relinking for stories`.

---

### Task 4: the Entity step

**Files:**

- Create: `server/api/src/graph/find.ts`
- Test: `server/api/test/graph-find.test.ts`

- [ ] **Step 1: Write the failing tests.** Use the lines and helpers of `graph-step.test.ts` (copy `line`, `LINES` and `lookup`, and a `model()` routed by `FIND_SYSTEM`). The answer:

```ts
const FOUND = {
  entities: [
    { ref: 'e1', name: 'Noah Kim', type: 'person', match: 'k-noah', ways: [], description: [] },
    {
      ref: 'e2', name: 'Sarah', type: 'person', match: 'new', ways: ['his friend Sarah'],
      description: [{ text: 'Sarah sat next to Noah on his first day at school.', cites: ['L2'] }],
    },
    {
      ref: 'e3', name: 'Tom', type: 'person', match: 'new', ways: [],
      description: [{ text: 'Tom is Sarah’s brother.', cites: ['L2'] }],
    },
    {
      ref: 'e4', name: 'Noah Kim’s mother', type: 'person', match: 'new', ways: ['his mother', 'he'],
      description: [{ text: 'She always made seaweed soup.', cites: ['L4'] }],
    },
    {
      ref: 'e5', name: 'Seaweed soup', type: 'thing', match: 'new', ways: ['seaweed soup'],
      description: [{ text: 'Noah’s mother made it in the Korean way.', cites: ['L4'] }],
    },
  ],
  relationships: [
    { a: 'e2', b: 'e1', description: 'Sarah — Noah’s friend from school', cites: ['L2'] },
    { a: 'e3', b: 'e2', description: 'Tom — Sarah’s brother', cites: ['L2'] },
    { a: 'e3', b: 'e1', description: 'Noah Kim — knew Tom only through Sarah', cites: ['L2'] },
  ],
};
```

Tests:

- every entity comes back with `ways` (pronouns dropped: "he"), `description` with `sources: [{interviewId: null, from: 2, to: 2}]`, `note: {kind: 'new'}`, and `mentions: []`;
- Noah Kim is `subject: true` (pass `known: [{ ...NOAH, subject: true, note: { noteId: 'n-noah', title: 'Noah Kim' } }]`), with `description: []` and `note: {kind: 'existing', noteId: 'n-noah', title: 'Noah Kim'}`;
- the recall pass adds Korea. "Korea" is capitalized in line 4 and not covered. Script the second call to answer `{ entities: [{ ref: 'e1', name: 'Korea', type: 'place', match: 'new', ways: [], description: [{ text: 'Noah’s mother made soup the way they did in Korea.', cites: ['L4'] }] }], relationships: [] }`;
- the SECOND_HAND relationship is dropped; Tom–Sarah and Sarah–Noah stay, with `story: null` (the workflow ties them);
- a description sentence the judge rules `made_up` is dropped, and the entity stays with the rest (`judge: (u) => ['Korean way']` drops the soup's only sentence; the soup stays, `description: []`);
- a name with a word the lines do not give ("Sarah Lee") is left out;
- more than 20 things: only the first 20 stay. A unit test of `parseFound` with 25 things is enough;
- an entity that matches an existing one with a note gets `note: {kind: 'existing', …}` from `lookup.find`'s `note`;
- the answer that cannot be read throws (`runWithTools` gives up), so the workflow can mark it pending.

- [ ] **Step 2: Run:** `npx vitest run test/graph-find.test.ts`. Expected: FAIL, the module does not exist.
- [ ] **Step 3: Implement `find.ts`.**

The prompt:

```ts
export const FIND_SYSTEM = `You find every person, place and thing in an interview for a family archive, before its stories are written, so that each one gets a note of its own.

The interview's lines are numbered ("L12"); "P" is what the family entered about the person the archive is about. For every PERSON, PLACE and THING the lines name (every place counts, even one named in passing: a country, a city, a school, a church), give:
- "ref": "e1", "e2", ...
- "name": what to file it under. A real name when the lines give one ("Sarah Lee", "Busan"). Someone named only by a family word or a relationship gets a name from it and the person the archive is about: "my mother" said by Noah Kim is "Noah Kim's mother". When the lines give a name with the relationship ("my father Walter"), file them under the name ("Walter"): the relationship goes in "relationships". Never add a surname or any word the lines do not give.
- "type": "person", "place" or "thing". A thing only when it is specific and remembered for itself ("the sewing machine", "seaweed soup", "Mrs. Han's pencil box"), never an ordinary object ("a cup", "the door").
- "match": the id of the entity it already is (those already known are listed; use find_entity when one may already exist), "new", or "ask" with "candidates" (their ids) when you cannot tell which.
- "ways": how a story about the person the archive is about may call it, in the third person: "my mother" said by Noah becomes "his mother"; a nickname ("Mom"); a first name. At most 4 words each, never "he", "she" or another pronoun.
- "description": 1 to 4 short sentences in the third person on what the lines tell about it, each with the lines it comes from: [{"text": "...", "cites": ["L12"]}]. For one already known, only what these lines add, or [] when they add nothing.
List the person the archive is about too, with their id, and "description": [].

"relationships": only what the lines TELL about how two of them relate ("my friend Sarah", "her brother Tom", "we lived in Busan", "she made it every birthday"). Being named in the same part of the interview is not a relationship, and neither is anything you would have to guess. Knowing of someone only through another person ("I only knew him from her stories") is not a relationship between them: they are joined through that person. Give {"a": "e2", "b": "e1", "description": "Name — how they relate", "cites": ["L12"]}, for example "Tom — Sarah's brother". The part after the dash says how they relate, never the name again. One relationship for a pair.

Before answering, go through every capitalized name in the lines: each person or place among them belongs in your answer.
Use only what the cited lines say. Never invent a name, a place, a thing or a relationship.

Result: {"entities": [...], "relationships": [...]}`;
```

The limits and the parser:

```ts
const TOOL_CALLS = 12;
const MAX_ENTITIES = 60;
const MAX_THINGS = 20;
const MAX_RELATIONSHIPS = 100;
const MAX_SENTENCES = 4;
const MAX_WAYS = 8;
/** a note title may not hold these (validateNoteTitle) */
const NOT_IN_TITLE = /[[\]#^|\p{Cc}]/gu;

interface RawFound {
  ref: string;
  name: string;
  type: EntityType;
  match: string;
  candidates: string[];
  ways: string[];
  description: Array<{ text: string; cites: Range[] }>;
}
interface RawTold {
  a: string;
  b: string;
  description: string;
  cites: Range[];
}

/** the model's answer, read leniently: an item that is not right is left out */
export function parseFound(
  v: unknown,
  earlier: ReadonlySet<string> = new Set(),
): { entities: RawFound[]; relationships: RawTold[] } | string {
  if (!isObj(v) || !Array.isArray(v.entities))
    return 'give {"entities": [...], "relationships": [...]}';
  const entities: RawFound[] = [];
  const refs = new Set<string>();
  let things = 0;
  for (const e of v.entities) {
    if (!isObj(e)) continue;
    const ref = str(e.ref);
    const name = str(e.name).replace(NOT_IN_TITLE, '').trim().slice(0, 200);
    const type = ENTITY_TYPES.find((t) => t === e.type);
    if (!ref || refs.has(ref) || !name || !matchKey(name) || !type) continue;
    if (type === 'thing' && ++things > MAX_THINGS) continue;
    refs.add(ref);
    entities.push({
      ref,
      name,
      type,
      match: str(e.match) || 'new',
      candidates: (Array.isArray(e.candidates) ? e.candidates : []).map(str).filter(Boolean),
      ways: [
        ...new Set(
          (Array.isArray(e.ways) ? e.ways : [])
            .map(str)
            .filter(
              (w) => w && !PRONOUNS.has(lower(w)) && w.split(/\s+/).length <= MAX_WORDS,
            ),
        ),
      ].slice(0, MAX_WAYS),
      description: (Array.isArray(e.description) ? e.description : [])
        .filter(isObj)
        .map((s) => ({ text: str(s.text).slice(0, 300), cites: cites(s.cites) }))
        .filter((s) => s.text)
        .slice(0, MAX_SENTENCES),
    });
  }
  const relationships: RawTold[] = [];
  const known = (x: string) => refs.has(x) || earlier.has(x);
  for (const r of Array.isArray(v.relationships) ? v.relationships : []) {
    if (!isObj(r)) continue;
    const a = str(r.a);
    const b = str(r.b);
    const description = str(r.description).slice(0, 500);
    if (!known(a) || !known(b) || a === b || !description) continue;
    relationships.push({ a, b, description, cites: cites(r.cites) });
  }
  return { entities, relationships };
}
```

The step, in this order. It mirrors `graphStep`, so read that function alongside:

```ts
export interface FindResult {
  entities: ProposedEntity[];
  relationships: ProposedRelationship[];
  stats: NonNullable<GraphProposal['stats']>;
}

export async function findEntities(o: {
  chat: ChatModel;
  judge: ChatModel;
  /** the part's lines; with the profile as line 0 when there is one */
  lines: readonly Line[];
  profile: string;
  /** the protagonist and the tellers */
  known: readonly KnownEntity[];
  /** names the checks accept without a citation */
  names: readonly string[];
  lookup: EntityLookup;
  signal?: AbortSignal;
}): Promise<FindResult>;
```

1. **Ask.** `offered = new Map(known ids → names)`, `tools = entityTools(lookup, offered)`. The task is the profile, "Already known" (as in `graphStep`, marking the protagonist: `- Noah Kim (person, id …) — the person the archive is about`), and `The interview:\n${renderLines(lines.filter((l) => l.n > 0))}`. Then `runWithTools(chat, { system: FIND_SYSTEM, task, tools, maxToolCalls: TOOL_CALLS, signal, parse: (v) => parseFound(v) })`.
2. **Recall.** `uncovered(tellerLines.map((l) => l.text), [...names, ...known names and aliases, ...entity names and ways])`. If any are found, ask once more, as `graphStep` does, with `parseFound(v, earlierRefs)`, and merge in the same way.
3. **Relationships:** drop `SECOND_HAND`; trim a description that repeats the name (`graphStep`'s loop); one per pair.
4. **Names:** `nameHeld`: every word of the name (less `NAME_FILLER`) is in the lines' text or among the known names' words. Otherwise the entity is left out, with its relationships.
5. **Checks.** Build items from every description sentence and relationship. In batches of 10 entities (with their relationships):
   - code: `checkDraft({ title: 'People, places and things', occurred: null, until: null, sentences }, lines, nameList, [{ from: first, to: last }])`, keeping the problem kinds `KEPT` from `graphStep`;
   - then `judgeStory(judge, { …, sentences: rest }, lines, signal, profile)`.

   A failing sentence is removed from its entity's description, and a failing relationship is dropped. Entities are never dropped here.
6. **Matches:** `resolveMatch` for each kept entity, at most `MAX_ENTITIES`, then:
   - `subject`: when the match is the known entity with `subject`. Its description is cleared.
   - `note`: for a match that is existing, the matched entity's note: the known entity's `note`, else `lookup.find(name)`'s row with that id. It is `{ kind: 'existing', noteId, title }` when it has a note the member sees, else `{ kind: 'new' }`. For a new match it is `{ kind: 'new' }`.
   - `aliases`: for an existing match, the known or found aliases (for the writer's list only; adding them again at save is harmless).
   - `sources`: `cites.filter((r) => r.from > 0).map((r) => ({ interviewId: null, from: r.from, to: r.to }))`.
   - `mentions: []`. The workflow fills them from the stories.
7. **Relationships:** `ref: r1…`, `story: null`, `sources` as above, at most `MAX_RELATIONSHIPS`.

- [ ] **Step 4: Run:** `npx vitest run test/graph-find.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(graph): the Entity step finds people, places and things in the transcript`.

---

### Task 5: the writer and the planner get the list

**Files:**

- Modify: `server/api/src/stories/write.ts`
- Modify: `server/api/src/stories/plan.ts`
- Test: `server/api/test/stories-write.test.ts`, `server/api/test/stories-plan.test.ts`

- [ ] **Step 1: Write the failing tests.**

```ts
// stories-write.test.ts
it('reads the names each sentence marks', () => {
  const d = parseDraft({
    title: 'Seaweed soup',
    occurred: null,
    until: null,
    sentences: [
      {
        text: 'His mother made seaweed soup.',
        cites: ['L4'],
        names: [{ e: 'e4', words: 'His mother' }, { e: 'e5', words: '' }, 'x'],
      },
    ],
  });
  expect(typeof d === 'string' ? d : d.sentences[0]!.names).toEqual([
    { e: 'e4', words: 'His mother' },
  ]);
});

it('shows the writer the list of people, places and things', async () => {
  const seen: string[] = [];
  const chat = {
    id: 't',
    complete: async (_s: string, user: string) => {
      seen.push(user);
      return JSON.stringify({
        result: { title: 'T', occurred: null, until: null, sentences: [{ text: 'A.', cites: ['L1'] }] },
      });
    },
  };
  await writeStory(chat, { ...BASE, cast: "e4  Noah Kim's mother (person): his mother" });
  expect(seen[0]).toContain("People, places and things in this interview:\ne4  Noah Kim's mother (person): his mother");
});
```

(`BASE` is the write test file's existing options object; if it has none, build one from its existing calls.)

```ts
// stories-plan.test.ts
it('shows the planner who is in the interview', async () => {
  /* as above, with planPart(chat, { …, cast: "Noah Kim's mother (person)\nBusan (place)" }) */
  expect(seen[0]).toContain("Who is in it:\nNoah Kim's mother (person)");
});
```

- [ ] **Step 2: Run:** `npx vitest run test/stories-write.test.ts test/stories-plan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `Sentence` gains `names?: Array<{ e: string; words: string }>`. `parseDraft` reads it: objects with a non-empty `e` and `words`, at most 12.
  - `WRITE_SYSTEM`: add before "Every sentence lists the lines…":

    ```
    - People, places and things: when a list of them is given, call each one as the list does (its
      name, or one of the ways after the colon), and for each sentence give "names": the ones it
      names and the exact words it uses, like [{"e": "e4", "words": "His mother"}]. Not the narrator.
    ```

    And the result line becomes `{"title": "...", "occurred": "1946" | null, "until": null, "sentences": [{"text": "...", "cites": ["L3"], "paragraph": true, "names": [{"e": "e4", "words": "His mother"}]}]}`.
  - `writeStory` gains `cast?: string` and adds `People, places and things in this interview:\n${cast}` to the task, after the narrator line, when it is not empty.
  - `planPart` gains `cast?: string` and adds `Who is in it:\n${cast}` after the narrator line.
  - `showDraft` is unchanged: the fix round shows sentences without names, and the writer gives them again.

- [ ] **Step 4: Run:** both files. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(stories): the writer and planner see who is in the interview; sentences mark names`.

---

### Task 6: the workflow, in the new order

**Files:**

- Modify: `server/api/src/stories/workflow.ts`
- Modify: `server/api/src/ingest-pipeline.ts` (nothing new: `IngestResult.graph` already exists)
- Test: `server/api/test/stories-workflow.test.ts` (replace the "Graph step after the stories" block)

- [ ] **Step 1: Write the failing tests.** In `stories-workflow.test.ts`:
  - Route `FIND_SYSTEM` as step `'find'` (replacing `'graph'` in `stepOf`).
  - The find answer: Minho (person) and Busan (place), each with a description; Sunja known as the subject (`graphDeps.known = [{ id: 'k-sunja', name: 'Sunja Kim', type: 'person', aliases: ['Sunja'], subject: true, note: { noteId: 'n1', title: 'Sunja Kim' } }]`).
  - The write answers mark names: `GRAVY`'s first sentence gets `names: [{ e: 'e2', words: 'Minho' }, { e: 'e1', words: 'Sunja' }]`, and `HARBOUR`'s first sentence `names: [{ e: 'e3', words: 'a small house' }]` (a wrong mark: not a way of anything).

  Tests:
  - find runs before plan (`chat.calls[0].step === 'find'`), once per part;
  - the plan and write prompts contain the list (`Who is in it:` / `People, places and things in this interview:`), without Sunja;
  - the gravy story's body has `[[Minho]]` exactly once, and no link to Sunja;
  - the harbour story's body has `[[Busan]]`, found by `unmarked` because the writer did not mark it; "a small house" is not linked; `stats.stories.problems.mark` is 1;
  - `out.graph.entities` for Minho has `mentions: [{ story: 'm2', words: ['Minho'], line: 'Sunja met Minho at a church supper in 1966.', sources: [{ interviewId: null, from: 8, to: 8 }] }]`;
  - a relationship citing L8 has `story: 'm2'`; one citing a line no story uses has `story: null`;
  - when find throws a `ModelError('bad', 'bad_output', false)`, the stories are still written, with no `[[`, and `out.graph` is `{ entities: [], relationships: [], pending: { reason: 'bad_plan' } }`;
  - without `deps.graph`, there is no find call and no `out.graph` (as today).

- [ ] **Step 2: Run:** `npx vitest run test/stories-workflow.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, in `writeStories`:
  1. After `if (!deps.chat) return result([], 'no_model');` and the budget set-up, inside the `try`, before planning:

     ```ts
     // 2. who and what is in the interview, before any story is planned (entity design 3)
     let found: FindResult | null = null;
     let foundPending: StoriesPendingReason | null = null;
     if (deps.graph) {
       try {
         found = await findAll(deps.graph);
       } catch (e) {
         foundPending = reasonOf(e);
         if (foundPending === 'auth') return result([], 'auth');
       }
     }
     const listed: Listed[] = (found?.entities ?? []).map((e) => ({
       ref: e.ref,
       name: e.name,
       aliases: e.aliases ?? [],
       ways: e.ways ?? [],
       subject: e.subject,
     }));
     const byRef = new Map(listed.map((l) => [l.ref, l]));
     const cast = listed
       .filter((l) => !l.subject)
       .map((l) => {
         const type = found!.entities.find((e) => e.ref === l.ref)!.type;
         return `${l.ref}  ${l.name} (${type})${l.ways.length ? `: ${l.ways.join(', ')}` : ''}`;
       })
       .join('\n');
     const castNames = listed
       .filter((l) => !l.subject)
       .map((l) => `${l.name} (${found!.entities.find((e) => e.ref === l.ref)!.type})`)
       .join('\n');
     ```

     `findAll` runs `findEntities` per part (`lines` = the part's lines, plus the profile line when there is one), and merges the results:
     - refs are renumbered `e1…` across parts;
     - an entity whose `matchKey(name)` and `type` match one from an earlier part merges into it (ways and aliases joined, description sentences appended up to 4);
     - relationships follow the renumbering;
     - stats are added up.
  2. Pass `cast: castNames` to `planPart` and `cast` to `writeStory`.
  3. In `makeStory`, once the last draft is settled (after the age lines, before `assemble`), work out the marks:

     ```ts
     const texts = draft.sentences.map((s) => s.text);
     const marks: Mark[][] = draft.sentences.map((s) =>
       (s.names ?? []).flatMap((m) => {
         const words = checkMark(s.text, m, byRef);
         if (words === null) {
           counts.problems.mark = (counts.problems.mark ?? 0) + 1;
           return [];
         }
         return [{ e: m.e, words }];
       }),
     );
     const marked = new Set(marks.flat().map((m) => m.e));
     for (const u of unmarked(texts, listed, marked)) marks[u.sentence]!.push(u.mark);
     ```

     Pass `marks` to `assemble`, and return them with the memory: `makeStory` returns `{ memory, marks, story } | null`.
  4. In `assemble`, build the paragraphs from `linkSentences(texts, marks, (ref) => byRef.get(ref)!.name)` instead of the plain texts. `linkKnownTitles` still runs per paragraph with `titles()` minus every listed name and alias (`matchKey` compared), so those are linked only once, by the marks.
  5. After `memories.forEach((m, i) => (m.id = …))`, when `deps.graph` is set:

     ```ts
     out.graph = found
       ? withStories(found, made)
       : { entities: [], relationships: [], pending: { reason: foundPending ?? 'unavailable' } };
     ```

     `withStories` fills each entity's `mentions` from the marks: one per story, `words` being every distinct word used there, `line` the first marked sentence's plain text, and `sources` that sentence's cites as `{ interviewId: null, from, to }`. It ties each relationship to the first story whose planned ranges include its first source line (`story: memory.id`), else `story: null`. It sets `stats` from the find. The protagonist is never marked, so their mentions come from their name or aliases found in each story's sentences (`findIn`), without a link: Home still counts the stories they are in.
  6. Remove `findGraph` and the `graphStep` import.

- [ ] **Step 4: Run:** `npx vitest run test/stories-workflow.test.ts test/stories-jobs.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(stories): find who is in the interview first, and write the stories with links`.

---

### Task 7: the reviewer's choices, on the proposal and the stories

**Files:**

- Modify: `server/api/src/graph/save.ts` (`applyGraphPatch`, new `relinkMemories`)
- Modify: `server/api/src/ingest-jobs.ts` (`save`)
- Modify: `server/api/src/ingest.ts` (`readGraphPatch` reads `leaveParagraph`)
- Test: `server/api/test/graph-save.test.ts` (the unit part)

- [ ] **Step 1: Write the failing tests.**

```ts
const NOTED = (ref: string, name: string, story?: string): ProposedEntity => ({
  ref,
  name,
  type: 'person',
  match: { kind: 'new' },
  mentions: story ? [{ story, words: [name], line: `${name}.`, sources: [] }] : [],
  ways: [],
  description: [{ text: `${name} came.`, sources: [] }],
  note: { kind: 'new' },
});

it('a note stays when its only story is left out; the button’s entities do not', () => {
  const p: GraphProposal = {
    entities: [NOTED('e1', 'Minho', 'm2'), { ...NOTED('e2', 'Tom', 'm2'), note: undefined }],
    relationships: [{ ref: 'r1', a: 'e1', b: 'e2', description: 'x', story: 'm2', sources: [] }],
  };
  const out = applyGraphPatch(p, {}, new Set(['m1']));
  expect(out.entities.map((e) => [e.name, e.mentions.length])).toEqual([['Minho', 0]]);
});

it('leaving out a paragraph keeps the entity and its links', () => {
  const e = { ...NOTED('e1', 'Mina', 'm1'), note: { kind: 'existing' as const, noteId: 'n', title: 'Mina' } };
  const out = applyGraphPatch({ entities: [e], relationships: [] }, { leaveParagraph: ['e1'] }, new Set(['m1']));
  expect(out.entities[0]!.description).toEqual([]);
});

it('a relationship from a story left out is tied to a note instead', () => {
  const p: GraphProposal = {
    entities: [NOTED('e1', 'Minho'), NOTED('e2', 'Busan')],
    relationships: [{ ref: 'r1', a: 'e1', b: 'e2', description: 'x', story: 'm2', sources: [] }],
  };
  expect(applyGraphPatch(p, {}, new Set(['m1'])).relationships[0]!.story).toBeNull();
});

it('relinkMemories unlinks what was left out and follows renames', () => {
  const memories = [{ id: 'm1', body: "[[Noah Kim's mother|His mother]] met [[Tom]]." }];
  const before: GraphProposal = {
    entities: [NOTED('e1', "Noah Kim's mother", 'm1'), NOTED('e2', 'Tom', 'm1')],
    relationships: [],
  };
  const after = applyGraphPatch(before, { leave: ['e2'], rename: { e1: 'Mina Kim' } }, new Set(['m1']));
  relinkMemories(memories, before, after);
  expect(memories[0]!.body).toBe('[[Mina Kim|His mother]] met Tom.');
});
```

- [ ] **Step 2: Run:** `npx vitest run test/graph-save.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `applyGraphPatch`:
    - **An entity with a `note`** (the new shape) stays when it is not in `leave`, even with no kept mention. Its mentions are still filtered to the kept stories.
    - **An entity without a `note`** (the button's) keeps today's rule.
    - **`leaveParagraph`** sets `description: []` on an entity whose `note.kind === 'existing'`.
    - **`same`:** besides `match`, set `note` to `{ kind: 'new' }`. `notePlan` (Task 9) looks the note up again at save.
    - **Relationships with a story:** for the new shape, a story not kept becomes `story: null`. For the old shape it is dropped, as today. Relationships with `story: null` are kept when both ends are kept.
  - `relinkMemories(memories, before, after)`:
    - `unlink` holds the normalized names of the entities in `before` that are not in `after`;
    - `to` maps a renamed entity's old name (normalized) to its new name;
    - then `m.body = relink(m.body, unlink, to)`.
  - In `ingest-jobs.ts` `save`, right after `edited.graph = applyGraphPatch(…)`: `relinkMemories(edited.memories, all, edited.graph)`, where `all` is the proposal before the patch.
  - `readGraphPatch` (in `ingest.ts`): read `leaveParagraph` like `leave` (strings, at most 200).
- [ ] **Step 4: Run:** `npx vitest run test/graph-save.test.ts test/ingest-jobs.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(graph): review choices keep notes, leave paragraphs out, and relink the stories`.

---

### Task 8: notes the import makes, and paragraphs

**Files:**

- Modify: `server/api/src/notes.ts` (`NewNoteInput.entity`, `appendParagraph`)
- Test: `server/api/test/notes-paragraph.test.ts` (new)

- [ ] **Step 1: Write the failing tests** (database):
  - `createNotesBatch` with `{ title: 'Busan (place)', type: 'place', entity: false }` makes no `graph_entities` row for it, and without `entity` a place note still gets one (as today);
  - `appendParagraph`:
    - adds `\n\n_From “Noah's birthdays”:_ She made soup.` to the end of a note's body;
    - appends a revision with reason `import` and the change id given;
    - pushes `{ runId, sources }` onto `extra.paragraphs`;
    - reindexes links: a `[[Minho]]` in the paragraph shows in `links` for that note.
  - `appendParagraph` on a note whose body would pass the size limit (`checkBody` throws) changes nothing and returns `false`.

- [ ] **Step 2: Run:** `npx vitest run test/notes-paragraph.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** in `notes.ts`:

```ts
// NewNoteInput: whether a person, place or object note gets its graph entity here (default
// true); an import that ties the note to its entity itself says false
entity?: boolean;
```

In `createNotesBatch`, call `entityForNote` only when `input.entity !== false` (carry `entity` through `prepare`).

```ts
/**
 * Add a paragraph to the end of a note, as a new revision of it (entity design 5.2): what is
 * written is never changed. The paragraph's sources go in `extra.paragraphs` with the run, so
 * an undo can take them back. A note the paragraph would make too long is left as it is.
 */
export async function appendParagraph(
  client: PoolClient,
  o: {
    archiveId: string;
    noteId: string;
    userId: string;
    text: string;
    sources: unknown[];
    runId: string;
    changeId: string;
  },
): Promise<boolean> {
  const cur = await client.query(
    `select title, body, extra from public.notes where id = $1 and archive_id = $2 for update`,
    [o.noteId, o.archiveId],
  );
  const head = cur.rows[0] as
    { title: string; body: string; extra: Record<string, unknown> | null } | undefined;
  if (!head) return false;
  const body = head.body.trim() ? `${head.body.trimEnd()}\n\n${o.text}` : o.text;
  try {
    checkBody(body);
  } catch {
    return false;
  }
  const extra = head.extra ?? {};
  const paragraphs = Array.isArray(extra.paragraphs) ? extra.paragraphs : [];
  await client.query(
    `update public.notes set body = $1, extra = $2::jsonb, revised = now() where id = $3`,
    [
      body,
      JSON.stringify({ ...extra, paragraphs: [...paragraphs, { runId: o.runId, sources: o.sources }] }),
      o.noteId,
    ],
  );
  const rev = await appendRevision(
    client,
    o.archiveId,
    o.noteId,
    o.userId,
    head.title,
    body,
    'import',
    o.changeId,
  );
  await reindexLinks(client, o.archiveId, o.noteId, body);
  await reindexChunks(client, o.archiveId, o.noteId, rev, body);
  return true;
}
```

- [ ] **Step 4: Run:** `npx vitest run test/notes-paragraph.test.ts test/notes.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(notes): add a paragraph to a note as a revision; imports may skip the entity`.

---

### Task 9: saving the notes, links, mentions and relationships

**Files:**

- Modify: `server/api/src/graph/save.ts` (`notePlan`, `entityNoteInputs`, `paragraphText`, `saveGraph`)
- Modify: `server/api/src/ingest-save.ts` (`persistImport`)
- Test: `server/api/test/graph-save.test.ts` (database part), `server/api/test/graph-routes.test.ts` (the note page shows backlinks)

- [ ] **Step 1: Write the failing tests** (database; build an `IngestResult` by hand with two stories whose bodies hold links, and a proposal). After `persistImport`:
  - a note "Minho" (type `person`) exists, with the description as its body and `extra.sources`, tied to its entity (`graph_entities.note_id`);
  - "Busan", whose title is already taken by a story "Busan" in the project, is saved as "Busan (place)". The harbour story's body reads `[[Busan (place)|Busan]]`, and `links` resolves it to the place note;
  - Sunja's note (the subject) is unchanged: no paragraph;
  - an entity matched to an existing person note "Mina Kim" with one description sentence gets that note's paragraph `_From “Sunja on Busan and Minho”:_ …`, and no new note;
  - the same, with an empty description: no paragraph, and the story links to "Mina Kim";
  - an entity already in the graph without a note gets a new note, and its entity row gets the `note_id` (no second entity);
  - each story's mentions are saved (`graph_mentions` with its words), and a relationship with `story: null` is tied to its first entity's note;
  - `persistImport` returns `saved` for the stories only (entity notes are not in it);
  - the note page's `GET /backlinks` for "Minho" lists the gravy story.

- [ ] **Step 2: Run:** `npx vitest run test/graph-save.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**

  In `graph/save.ts`:

  ```ts
  /** what each entity gets at save, decided again now: the project may have changed since the preview */
  export type NoteChoice =
    | { kind: 'make'; entityId: string | null }
    | { kind: 'existing'; entityId: string; noteId: string; title: string }
    | { kind: 'none' };

  export async function notePlan(
    client: PoolClient,
    archiveId: string,
    userId: string,
    p: GraphProposal | undefined,
  ): Promise<Map<string, NoteChoice>> {
    const out = new Map<string, NoteChoice>();
    for (const e of p?.entities ?? []) {
      if (!e.note) continue; // the button's: no notes
      if (e.subject) {
        out.set(e.ref, { kind: 'none' });
        continue;
      }
      // the entity it is: chosen or matched, else one of the same name or alias by now
      const id =
        e.match.kind === 'existing'
          ? e.match.entityId
          : await entityIdByName(client, archiveId, e.type, matchKey(e.name));
      if (!id) {
        out.set(e.ref, { kind: 'make', entityId: null });
        continue;
      }
      const r = await client.query(
        `select e.note_id, n.title, (n.id is not null and ${visibleSql('n', '$3')}) as seen
           from public.graph_entities e left join public.notes n on n.id = e.note_id
          where e.id = $1 and e.archive_id = $2`,
        [id, archiveId, userId],
      );
      const row = r.rows[0] as
        { note_id: string | null; title: string | null; seen: boolean } | undefined;
      if (!row) out.set(e.ref, { kind: 'make', entityId: null });
      else if (!row.note_id) out.set(e.ref, { kind: 'make', entityId: id });
      else if (row.seen)
        out.set(e.ref, { kind: 'existing', entityId: id, noteId: row.note_id, title: row.title! });
      else out.set(e.ref, { kind: 'none' }); // a note the importer cannot see: no link to it
    }
    return out;
  }
  ```

  `entityIdByName` is the query `saveGraph` already runs (an entity of the type and key, or an alias of the key). Take it out as a function and use it in both places.

  ```ts
  export const TYPE_HINT: Record<EntityType, string> = { person: 'person', place: 'place', thing: 'thing' };

  /** a new note's text: the description as one paragraph */
  export function entityNoteInputs(
    p: GraphProposal,
    plan: ReadonlyMap<string, NoteChoice>,
    interviewId: string | null,
  ): Array<{ ref: string; input: NewNoteInput }> {
    return p.entities
      .filter((e) => plan.get(e.ref)?.kind === 'make')
      .map((e) => ({
        ref: e.ref,
        input: {
          title: e.name,
          type: NOTE_TYPE[e.type],
          body: (e.description ?? []).map((s) => s.text).join(' '),
          entity: false,
          extra: {
            sources: (e.description ?? []).map((s) => ({
              sentence: s.text,
              sources: withInterview(s.sources, interviewId),
            })),
          },
        },
      }));
  }

  export const paragraphText = (interviewName: string, d: DescriptionSentence[]) =>
    `_From “${interviewName}”:_ ${d.map((s) => s.text).join(' ')}`;
  ```

  In `persistImport` (`ingest-save.ts`), inside the `prepare` callback:

  ```ts
  const plan = await notePlan(client, archiveId, userId, result.graph);
  const extra = result.graph ? entityNoteInputs(result.graph, plan, result.interviewId ?? null) : [];
  const settled = await resolveTitles(client, archiveId, [
    ...memories.map((m) => ({ title: m.title, hint: hintOf(m) })),
    ...extra.map((x) => ({
      title: x.input.title!,
      hint: TYPE_HINT[result.graph!.entities.find((e) => e.ref === x.ref)!.type],
    })),
  ]);
  // the stories' links to people, places and things: the final title, or the words alone
  const to = new Map<string, string>();
  const unlink = new Set<string>();
  for (const e of result.graph?.entities ?? []) {
    const c = plan.get(e.ref);
    const key = normalizeTitle(e.name);
    if (!c) continue;
    if (c.kind === 'none') unlink.add(key);
    else if (c.kind === 'existing') to.set(key, c.title);
    else to.set(key, settled[memories.length + extra.findIndex((x) => x.ref === e.ref)]!);
  }
  for (const m of memories) m.body = relink(m.body, unlink, to);
  retitle(memories, settled.slice(0, memories.length));
  entityNotes = extra.map((x, i) => ({ ref: x.ref, title: settled[memories.length + i]! }));
  return [
    ...memories.map(/* as today */),
    ...extra.map((x, i) => ({ ...x.input, title: settled[memories.length + i]! })),
  ];
  ```

  - `entityNotes` is a variable declared before `createNotesBatch`.
  - `resolveTitles` and `retitle` already run here today for memories. Replace that call with the combined one above; do not run both.
  - The stories' `retitle` in `ingest-jobs.save` (before `persistImport`) stays as it is: it settles story titles against the project.
  - In the `after` hook, pass `saveGraph` more:

    ```ts
    await saveGraph(client, {
      archiveId,
      userId,
      runId,
      proposal: result.graph,
      storyNote: new Map(memories.map((m, i) => [m.id, ctx.notes[i]!.id])),
      interviewId: result.interviewId ?? null,
      plan,
      entityNote: new Map(entityNotes.map((x, i) => [x.ref, ctx.notes[memories.length + i]!.id])),
      interviewName: result.interviewName ?? 'an interview',
      changeId: ctx.changeId,
    });
    ```

  - `saved` maps only `notes.slice(0, memories.length)`.

  In `saveGraph`, for an entity with a `note` (new shape):
  - **Its id:**
    - `make` with `entityId`: `update graph_entities set note_id = $note where id = $id and note_id is null`, and use that id;
    - `make` without: insert the entity (`name` = `e.name`, the key of it) with `note_id` = its new note, `on conflict (archive_id, type, match_key) do update set note_id = coalesce(public.graph_entities.note_id, excluded.note_id)`;
    - `existing`: its `entityId`;
    - `none`: the entity found as today, with no note change.
  - **Aliases:** `[e.name, ...(e.aliases ?? [])]`, as today. Never `ways`.
  - **A paragraph:** `existing` with a non-empty `description` gets `appendParagraph(client, { …, text: paragraphText(interviewName, e.description), sources: … , runId, changeId })`.
  - **A relationship with `story: null`:** its note is the first of a's, then b's: the new note id (`entityNote`), else the existing `noteId`. With neither, it is skipped.
  - Entities without a `note` (the button's) are saved exactly as today.

- [ ] **Step 4: Run:** `npx vitest run test/graph-save.test.ts test/graph-routes.test.ts test/stories-jobs.test.ts test/ingest-persist.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(graph): save a note for every person, place and thing, and the stories' links to them`.

---

### Task 10: undo puts changed notes back

**Files:**

- Modify: `server/api/src/ingest-save.ts` (`undoImport`, `UndoOutcome`)
- Test: `server/api/test/graph-save.test.ts` (undo cases)

- [ ] **Step 1: Write the failing tests** (database, after a save as in Task 9). After `undoImport`:
  - the stories and the new notes "Minho" and "Busan (place)" are gone, and their entities with them;
  - "Mina Kim"'s body is back to what it was, a `restore` revision was added, its `extra.paragraphs` has no entry for the run, and `outcome.restored === 1`;
  - edit "Mina Kim" after the import, then undo: the paragraph stays, `kept` lists it with reason `edited`, and `restored === 0`;
  - edit the new note "Minho" after the import, then undo: it is kept (`edited`), as stories are today.

- [ ] **Step 2: Run:** `npx vitest run test/graph-save.test.ts`. Expected: FAIL. "Mina Kim" is listed as kept and its paragraph stays.
- [ ] **Step 3: Implement** in `undoImport`, after locking the run's notes (step 1) and before the `flags` query:

```ts
// a note the run CHANGED (its first revision is older than the run): put back, not erased
const changed = await client.query(
  `select n.id, n.title, n.extra,
          (select v.change_id from public.revisions v where v.note_id = n.id
            order by v.seq desc limit 1) = $2 as ours_last,
          (select v.body from public.revisions v where v.note_id = n.id
             and v.seq < (select min(w.seq) from public.revisions w
                           where w.note_id = n.id and w.change_id = $2)
            order by v.seq desc limit 1) as before
     from public.notes n
    where n.archive_id = $1 and n.id = any($3::uuid[])
      and (select v.change_id from public.revisions v where v.note_id = n.id
            order by v.seq asc limit 1) is distinct from $2`,
  [archiveId, run.change_id, ids],
);
const restored: string[] = [];
const keptChanged: UndoOutcome['kept'] = [];
for (const r of changed.rows as Array<{
  id: string;
  title: string;
  extra: Record<string, unknown> | null;
  ours_last: boolean;
  before: string | null;
}>) {
  if (!r.ours_last || r.before === null) {
    keptChanged.push({ id: r.id, title: r.title, reason: 'edited' });
    continue;
  }
  const extra = r.extra ?? {};
  const paragraphs = Array.isArray(extra.paragraphs)
    ? extra.paragraphs.filter((p) => (p as { runId?: string }).runId !== runId)
    : undefined;
  await client.query(
    `update public.notes set body = $1, extra = $2::jsonb, revised = now() where id = $3`,
    [r.before, JSON.stringify(paragraphs ? { ...extra, paragraphs } : extra), r.id],
  );
  const rev = await appendRevision(client, archiveId, r.id, userId, r.title, r.before, 'restore', changeId);
  await reindexLinks(client, archiveId, r.id, r.before);
  await reindexChunks(client, archiveId, r.id, rev, r.before);
  restored.push(r.id);
}
const changedIds = new Set((changed.rows as Array<{ id: string }>).map((r) => r.id));
```

- Run the `flags` query and the erase on `ids.filter((id) => !changedIds.has(id))` only.
- `kept` becomes `[...kept, ...keptChanged]`.
- `UndoOutcome` gains `restored: number`. It is `0` on `alreadyUndone`.
- Export `reindexLinks` and `reindexChunks` from where they live, if they are not exported yet.
- The web's `undoImport` response type gains `restored` (optional).

- [ ] **Step 4: Run:** `npx vitest run test/graph-save.test.ts test/ingest-undo.test.ts`. Expected: PASS. (Use whichever test files cover `undoImport` today: `grep -l undoImport server/api/test`.)
- [ ] **Step 5: Commit:** `feat(ingest): undo puts back the notes an import added to`.

---

### Task 11: the review on the web

**Files:**

- Modify: `apps/web/src/lib/api.ts` (types of the shared types section)
- Modify: `apps/web/src/lib/links.ts` (`piecesOf` gains `proposed`), `components/NoteText.tsx` (`Linked` renders it)
- Modify: `apps/web/src/components/GraphReview.tsx`, `components/ImportRun.tsx`
- Modify: `apps/web/src/styles.css` (`.proposed-link`)
- Test: `apps/web/src/lib/links.test.ts`, `apps/web/src/components/GraphReview.test.tsx` (new, if the web has component tests; else a `keptCount`/`patchOf` unit test in `links.test.ts` style)

- [ ] **Step 1: Write the failing tests.**

```ts
// links.test.ts
it('a link to a note still to be made reads as such; one left out reads as its words', () => {
  const pieces = piecesOf("[[Minho]] met [[Noah's mother|his mother]].", [], {
    proposed: new Map([
      ['minho', true],
      ["noah's mother", false],
    ]),
  });
  expect(pieces).toEqual([
    { kind: 'proposed', label: 'Minho' },
    { kind: 'text', text: ' met his mother.' },
  ]);
});
```

```ts
// GraphReview: patchOf
expect(patchOf({ ...NO_CHOICES, paragraphOut: new Set(['e4']) })).toEqual({ leaveParagraph: ['e4'] });
```

- [ ] **Step 2: Run:** `pnpm --filter @funmem/web test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`api.ts`:** mirror the server types (`ways?`, `description?`, `note?`, `subject?`; `story: string | null`; `leaveParagraph?`). Add `restored?: number` to the undo outcome.
  - **`piecesOf(body, notes, opts?: { proposed?: ReadonlyMap<string, boolean> })`:** a link whose target (normalized) is a key of `proposed` is checked before the notes:
    - `true`: `{ kind: 'proposed', label }`;
    - `false`: text (the label).
  - **`Piece`** gains `{ kind: 'proposed'; label: string }`. `Linked` takes `proposed` and renders `<span className="proposed-link" title="A new note, made when you save">{label}</span>`.
  - **`GraphChoices`** gains `paragraphOut: Set<string>`. `patchOf` adds `leaveParagraph`.
  - **`GraphReview`, each row:**
    - **The description,** under the name: the sentences joined, in the muted style.
    - **A badge:**
      - `note.kind === 'new'`: "New note";
      - existing with a description: "Adds to “Title”";
      - existing without one: "Links to “Title”";
      - no `note` (the button's): as today.
    - **Existing with a description:** a toggle "Leave the paragraph out" (`paragraphOut`).
    - **Leaving out** a new note says "Its links in the stories become plain words".
    - The protagonist (`subject`) is not listed.
  - **`keptCount`:** an entity with a `note` counts when not left out, whatever stories are kept.
  - **`ImportRun`:** the story preview passes `proposed` to `Linked`. It is built from the proposal's entities (name → not left out), and for renamed ones the new name too, so a renamed link still shows as kept. `rename` must also follow in the preview: show `piecesOf` over the body with renames applied by the same rule the server uses (a small client `relink`, or pass the old name as kept).
  - **`styles.css`:** `.proposed-link { border-bottom: 1px dashed var(--sage-ink); }`.
- [ ] **Step 4: Run:** `pnpm --filter @funmem/web test && pnpm --filter @funmem/web typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(web): review the notes for people, places and things, and the stories' links`.

---

### Task 12: real model, docs, full check, browser, push

**Files:**

- Modify: `server/api/scripts/eval-graph.ts`
- Modify: `docs/ingest/api.md`, `docs/superpowers/specs/2026-10-28-people-places-graph-design.md` (section 11 points here), `docs/superpowers/specs/2026-10-29-entity-notes-first-design.md` (status, and a "What building it changed" section)

- [ ] **Step 1: The eval.** After `writeStories`, print per entity: name, type, `note.kind`, ways, description, and its mentions. Add these checks, each PASS or FAIL:
  - every entity except the subject has `note`;
  - the expected nodes (as today);
  - Tom only through Sarah (as today);
  - every story body has at least one `[[`, and none links the subject's name;
  - the marks dropped (`stats.stories.problems.mark`), printed.
- [ ] **Step 2: Run it** with the real model: `cd server/api && NODE_USE_ENV_PROXY=1 pnpm eval:graph`. Expected: all PASS for noah and sunja. Where the model fails a check, fix the prompt or the code the way the graph design's section 11 did, add a scripted test for the case, and write the finding in the spec's "What building it changed".
- [ ] **Step 3: Docs.**
  - **`docs/ingest/api.md`:**
    - the proposal's new fields;
    - `leaveParagraph`;
    - the undo outcome's `restored`;
    - the note `extra.paragraphs`.
  - **The spec's status:** "Built (E1), 2026-10-29".
- [ ] **Step 4: Full check:** `pnpm -r typecheck && pnpm lint && pnpm format && pnpm -r test`. Expected: all pass. The one known slow-container timing test (`grounding-meaning` "each under 1 s") may fail on a loaded machine. Re-run that file alone and report it as it is.
- [ ] **Step 5: In the browser**, with the real API (`VITE_SKIP_LOGIN=false` and local Supabase URL and anon key; the API with `NODE_USE_ENV_PROXY=1`):
  1. import the Noah fixture;
  2. review: the notes group shows "New note" rows with descriptions, and story previews show dashed links;
  3. rename "Noah Kim's mother" to "Mina Kim" and leave out one thing;
  4. save. The story links open the notes, the note "Mina Kim" shows the backlink, and the left-out thing's words are plain;
  5. undo: everything the import made is gone.
- [ ] **Step 6: Commit and push:** `git push -u origin claude/dreamy-euler-z5cgvh`.

---

## Self-review

- **Spec coverage:**
  - Section 3 (order) and the pending case: Task 6.
  - Section 4 (the Entity step, checks, limits): Task 4.
  - Section 5:
    - 5.1, 5.2 and 5.3 (notes, paragraphs, an entity without a note): Tasks 8 and 9;
    - 5.4 (the protagonist): Tasks 4, 6 and 9;
    - 5.5 (titles): Task 9;
    - 5.6 (rename): existing code.
  - Section 6 (marks, the search, links, mentions): Tasks 3, 5 and 6.
  - Section 7:
    - 7.1 (review): Tasks 7 and 11;
    - 7.2 (saving): Task 9;
    - 7.3 (undo): Task 10.
  - Section 9 (no migration): no migration task. The table comment waits for the next migration that touches it.
  - Section 11 (testing): every task has its tests, and Task 12 covers the real model and the browser.
  - Section 8 (the button) is E2, a later plan. The button keeps working through the optional fields (Task 7).
- **Names used across tasks:**
  - `Listed`, `Mark`, `checkMark`, `unmarked`, `linkSentences`, `relink`, `plainOf`, `linkText` (Task 3);
  - `findEntities`, `FindResult`, `parseFound`, `FIND_SYSTEM` (Task 4);
  - `cast` (Task 5);
  - `relinkMemories` (Task 7);
  - `appendParagraph`, `NewNoteInput.entity` (Task 8);
  - `notePlan`, `NoteChoice`, `entityNoteInputs`, `paragraphText`, `TYPE_HINT`, `entityIdByName` (Task 9);
  - `UndoOutcome.restored` (Task 10);
  - `GraphChoices.paragraphOut` and the `proposed` piece (Task 11).
