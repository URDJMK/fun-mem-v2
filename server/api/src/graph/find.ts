/**
 * The Entity step (entity design 4): before the stories of an interview are written, the AI names
 * every person, place and thing in its lines, the ways a story may call each, a short description
 * of each, and the relationships the lines tell, looking up the project's entities with read-only
 * tools. Then every sentence it wrote is checked like a story sentence: in code (names, numbers
 * and quotes in the cited lines; citations inside the part), then by the judge. A sentence that
 * fails is left out, and its entity stays; nothing is written again.
 */
import { matchKey } from '@funmem/core';
import type { ChatModel } from '../nim';
import { checkDraft } from '../stories/check';
import { FAILING, judgeStory } from '../stories/judge';
import { renderLines, type Line, type Range } from '../stories/lines';
import { runWithTools } from '../stories/tools';
import type { StoryDraft } from '../stories/write';
import {
  KEPT,
  MAX_WORDS,
  PRONOUNS,
  SECOND_HAND,
  cites,
  entityTools,
  isObj,
  lower,
  nameHeld,
  resolveMatch,
  sourcesOf,
  str,
  uncovered,
  wordsOf,
} from './shared';
import type { EntityLookup, FoundEntity, KnownEntity } from './store';
import {
  ENTITY_TYPES,
  type EntityMatch,
  type EntityNote,
  type EntityType,
  type GraphProposal,
  type NoteRef,
  type ProposedEntity,
  type ProposedRelationship,
} from './types';

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

const TOOL_CALLS = 12;
const MAX_ENTITIES = 60;
const MAX_THINGS = 20;
const MAX_RELATIONSHIPS = 100;
const MAX_SENTENCES = 4;
const MAX_WAYS = 8;
/**
 * the names the recall pass may ask about: a whole part of an interview holds more capitalized
 * words that are not names (a holiday, a brand, a title) than one story does
 */
const RECALL_NAMES = 30;
/** the entities whose sentences and relationships the judge reads in one call */
const JUDGE_BATCH = 10;
/** what the checks call the sentences they read */
const TITLE = 'People, places and things';
/** why the protagonist's sentences are left out: their note is the profile */
const NO_DESCRIPTION = 'the person the archive is about has no description';
/** a note title may not hold these (validateNoteTitle) */
const NOT_IN_TITLE = /[[\]#^|\p{Cc}]/gu;

/** a sentence with the lines it comes from */
type Cited = { text: string; cites: Range[] };
interface RawFound {
  ref: string;
  name: string;
  type: EntityType;
  match: string;
  candidates: string[];
  ways: string[];
  description: Cited[];
}
interface RawTold {
  a: string;
  b: string;
  description: string;
  cites: Range[];
}
type Answer = { entities: RawFound[]; relationships: RawTold[] };

/** an entity once its match is settled */
interface Settled {
  ref: string;
  name: string;
  type: EntityType;
  match: EntityMatch;
  subject: boolean;
  aliases?: string[];
  note: EntityNote;
  ways: string[];
  description: Cited[];
  /** its name, and those of the entities found to be the same one: what its sentences may name */
  names: string[];
}

export interface FindInput {
  chat: ChatModel;
  judge: ChatModel;
  /** the part's lines; with the profile as line 0 when there is one */
  lines: readonly Line[];
  /** "Who this is about" (stories/profile.ts), or '' */
  profile: string;
  /** the protagonist and the tellers, already in the graph */
  known: readonly KnownEntity[];
  /** names the checks accept without a citation: speakers, the profile's */
  names: readonly string[];
  lookup: EntityLookup;
  signal?: AbortSignal;
}

export interface FindResult {
  /** each with `ways`, `description` and `note`; `mentions` are filled from the stories */
  entities: ProposedEntity[];
  /** each with `story: null`: the workflow ties it to the story whose lines tell it */
  relationships: ProposedRelationship[];
  /**
   * `proposed` and `dropped` count entities and relationships, so `proposed - dropped` are kept;
   * `left` also names the description sentences left out
   */
  stats: NonNullable<GraphProposal['stats']>;
}

/** the model's answer, read leniently: an item that is not right is left out, not argued over */
export function parseFound(
  v: unknown,
  /** entity refs of an earlier answer its relationships may name */
  earlier: ReadonlySet<string> = new Set(),
): Answer | string {
  if (!isObj(v) || !Array.isArray(v.entities))
    return 'give {"entities": [...], "relationships": [...]}';
  const entities: RawFound[] = [];
  const refs = new Set<string>();
  let things = 0;
  for (const e of v.entities) {
    if (!isObj(e)) continue;
    const ref = str(e.ref);
    const name = str(e.name).replace(NOT_IN_TITLE, '').replace(/\s+/g, ' ').slice(0, 200).trim();
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
            .filter((w) => w && !PRONOUNS.has(lower(w)) && w.split(/\s+/).length <= MAX_WORDS),
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

/**
 * The recall answer joined to the first: an entity the first already has (same name and type) is
 * not added twice, a ref already taken gets a "+", and the relationships follow. The recall
 * answer's own refs come first; a ref it does not give is the first answer's.
 */
function merge(first: Answer, more: Answer): Answer {
  const entities = [...first.entities];
  const relationships = [...first.relationships];
  const earlier = new Set(first.entities.map((e) => e.ref));
  const taken = new Set(earlier);
  const rename = new Map<string, string>();
  for (const e of more.entities) {
    const same = entities.find((x) => matchKey(x.name) === matchKey(e.name) && x.type === e.type);
    let ref = same?.ref ?? e.ref;
    if (!same) {
      while (taken.has(ref)) ref = `${ref}+`;
      taken.add(ref);
      entities.push({ ...e, ref });
    }
    rename.set(e.ref, ref);
  }
  for (const r of more.relationships) {
    const a = rename.get(r.a) ?? (earlier.has(r.a) ? r.a : null);
    const b = rename.get(r.b) ?? (earlier.has(r.b) ? r.b : null);
    if (a && b && a !== b) relationships.push({ ...r, a, b });
  }
  return { entities, relationships };
}

/**
 * Names the tellers say that the first answer left out ("in Korea"): asked about once more,
 * alone, and joined to that answer. If this fails, the first answer stands; only a cancel is
 * passed on.
 */
async function recall(
  o: FindInput,
  task: string,
  first: Answer,
): Promise<{ answer: Answer; calls: number }> {
  const missing = uncovered(
    o.lines.filter((l) => l.n > 0 && l.teller).map((l) => l.text),
    [
      ...o.names,
      ...o.known.flatMap((k) => [k.name, ...k.aliases]),
      ...first.entities.flatMap((e) => [e.name, ...e.ways]),
    ],
    RECALL_NAMES,
  );
  if (missing.length === 0) return { answer: first, calls: 0 };
  const named = first.entities;
  try {
    const more = await runWithTools(o.chat, {
      system: FIND_SYSTEM,
      task: `${task}\n\nYour answer named: ${named.map((e) => e.name).join(', ') || 'nobody'}.\nThese names are in the lines but not in your answer: ${missing.join(', ')}. For each that is a person, place or thing, give it the same way, with the relationships the lines tell; leave out the rest. Its relationships may name the entities of your answer by their refs (${named.map((e) => `${e.ref} ${e.name}`).join(', ')}).`,
      tools: [],
      maxToolCalls: 0,
      maxCalls: 2,
      signal: o.signal,
      parse: (v) => parseFound(v, new Set(named.map((e) => e.ref))),
    });
    return { answer: merge(first, more.value), calls: more.calls };
  } catch (e) {
    if (o.signal?.aborted) throw e;
    return { answer: first, calls: 0 };
  }
}

/**
 * The note an existing entity has, as the member sees it, and the names it goes by: what a known
 * entity says, else the row a lookup gave for that very id (never a close spelling's).
 */
async function noteOf(
  id: string,
  name: string,
  o: {
    known: readonly KnownEntity[];
    seen: ReadonlyMap<string, FoundEntity>;
    lookup: EntityLookup;
  },
): Promise<{ note: EntityNote; aliases: string[] }> {
  const k = o.known.find((x) => x.id === id);
  if (k?.note !== undefined) return { note: noteFrom(k.note), aliases: k.aliases };
  const row = o.seen.get(id) ?? (await o.lookup.find(name)).find((f) => f.id === id);
  return { note: noteFrom(row?.note ?? null), aliases: k?.aliases ?? row?.aliases ?? [] };
}

const noteFrom = (n: NoteRef | null): EntityNote =>
  n ? { kind: 'existing', ...n } : { kind: 'new' };

/**
 * Another entity found to be the same existing one, joined to the first: its name and its ways
 * become ways, and its sentences follow the first's, up to 4. Gives the sentences that did not fit.
 */
function join(into: Settled, e: RawFound): Cited[] {
  into.names.push(e.name);
  const name =
    matchKey(e.name) !== matchKey(into.name) && e.name.split(/\s+/).length <= MAX_WORDS
      ? [e.name]
      : [];
  into.ways = [...new Set([...into.ways, ...name, ...e.ways])].slice(0, MAX_WAYS);
  const room = Math.max(0, MAX_SENTENCES - into.description.length);
  into.description.push(...e.description.slice(0, room));
  return e.description.slice(room);
}

/** a line the checks read: a sentence about an entity, or a relationship */
interface Item {
  text: string;
  cites: Range[];
  /** the names it may hold besides the known ones: its entity's, or those of both it joins */
  names: readonly string[];
  /** whom a sentence is about, told to the judge ("About Sarah: She …"); never saved */
  about?: string;
  /** the judge reads one batch a call */
  batch: number;
}

/** the lines the checks read, as the draft they check */
const draftOf = (sentences: readonly Cited[]): StoryDraft => ({
  title: TITLE,
  occurred: null,
  until: null,
  sentences: sentences.map((s) => ({ text: s.text, cites: s.cites, paragraph: false })),
});

/**
 * The checks a story sentence gets: in code (names, numbers and quotes in the cited lines; the
 * citations inside the part), each item against the known names and its own; then the judge, a
 * batch a call. Gives each item that fails, with why.
 */
async function checkAll<I extends Item>(
  items: readonly I[],
  o: {
    judge: ChatModel;
    lines: readonly Line[];
    profile: string;
    /** names any item may hold without its lines giving them */
    names: readonly string[];
    /** the lines an item may cite (the profile too) */
    part: readonly Range[];
    signal?: AbortSignal;
  },
): Promise<{ failed: Map<I, string>; calls: number }> {
  const failed = new Map<I, string>();
  for (const i of items) {
    const p = checkDraft(draftOf([i]), o.lines, [...o.names, ...i.names], o.part).find(
      (x) => x.sentence === 0 && KEPT.includes(x.kind),
    );
    if (p) failed.set(i, `${p.kind}: ${p.detail}`);
  }
  let calls = 0;
  for (const batch of [...new Set(items.map((i) => i.batch))].sort((a, b) => a - b)) {
    const rest = items.filter((i) => i.batch === batch && !failed.has(i));
    if (rest.length === 0) continue;
    const judged = await judgeStory(
      o.judge,
      draftOf(
        rest.map((i) => ({
          text: i.about ? `About ${i.about}: ${i.text}` : i.text,
          cites: i.cites,
        })),
      ),
      o.lines,
      o.signal,
      o.profile,
    );
    calls += judged.calls;
    for (const r of judged.rulings) {
      if (!FAILING.includes(r.verdict)) continue;
      failed.set(rest[r.sentence]!, `the judge: ${r.verdict}${r.reason ? ` (${r.reason})` : ''}`);
    }
  }
  return { failed, calls };
}

const knownLine = (k: KnownEntity): string =>
  `- ${k.name} (${k.type}, id ${k.id})${k.aliases.length ? `, also called ${k.aliases.join(', ')}` : ''}${k.subject ? ' — the person the archive is about' : ''}`;

/** "Tom — Tom": a description that says the name again after the dash is only the name */
const unrepeated = (d: string): string => {
  const [before, after] = d.split(/\s+[—–-]\s+/, 2);
  return before && after && matchKey(before) === matchKey(after) ? before : d;
};

/**
 * One part of an interview through the Entity step. Throws when the AI cannot be reached or its
 * answer cannot be read, so the import can say the list is pending; a failed recall pass does not.
 */
export async function findEntities(o: FindInput): Promise<FindResult> {
  // every row a lookup gave, by id: what an existing match has (its aliases, its note)
  const seen = new Map<string, FoundEntity>();
  const lookup: EntityLookup = {
    find: async (name) => {
      const found = await o.lookup.find(name);
      for (const f of found) seen.set(f.id, f);
      return found;
    },
    read: (id) => o.lookup.read(id),
  };
  // every entity id the AI was shown: the known ones, and what its tools found
  const offered = new Map<string, string>(o.known.map((k) => [k.id, k.name]));
  const told = o.lines.filter((l) => l.n > 0);
  const knownNames = [...o.names, ...o.known.flatMap((k) => [k.name, ...k.aliases])];
  const task = [
    o.profile,
    o.known.length
      ? `Already known (use the id as "match"):\n${o.known.map(knownLine).join('\n')}`
      : '',
    `The interview:\n${renderLines(told)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  // 1. ask, then once more about the names the answer left out
  const asked = await runWithTools(o.chat, {
    system: FIND_SYSTEM,
    task,
    tools: entityTools(lookup, offered),
    maxToolCalls: TOOL_CALLS,
    signal: o.signal,
    parse: (v) => parseFound(v),
  });
  const recalled = await recall(o, task, asked.value);
  const raw = recalled.answer;
  let calls = asked.calls + recalled.calls;

  let dropped = 0;
  const proposed = raw.entities.length + raw.relationships.length;
  const left: Array<{ what: string; why: string }> = [];
  /** what was left out and why: where the prompt needs work */
  const list = (what: string, why: string) => {
    if (left.length < 30) left.push({ what, why });
  };
  /** an entity or a relationship left out */
  const leave = (what: string, why: string) => {
    dropped++;
    list(what, why);
  };

  // 2. relationships as told: knowing of someone only through another is no line between them
  // (graph design G-D1), and the part after the dash never says the name again
  let rels = raw.relationships
    .filter((r) => {
      if (!SECOND_HAND.test(r.description)) return true;
      leave(r.description, 'known only through another person');
      return false;
    })
    .map((r) => ({ ...r, description: unrepeated(r.description) }));

  // 3. a name must come from the lines: every word of it is said there or is a known name's; and
  // the limits (entity design 4.4)
  const said = wordsOf(o.lines.map((l) => l.text).join('\n'));
  const knownWords = wordsOf(knownNames.join('\n'));
  let things = 0;
  const held = raw.entities.filter((e) => {
    if (!nameHeld(e.name, said, knownWords, { asPeople: e.type === 'place' })) {
      leave(e.name, 'a word of the name is not in the lines');
      return false;
    }
    if (e.type === 'thing' && ++things > MAX_THINGS) {
      leave(e.name, `over ${MAX_THINGS} things`);
      return false;
    }
    return true;
  });
  for (const e of held.slice(MAX_ENTITIES)) leave(e.name, `over ${MAX_ENTITIES} entities`);
  const capped = held.slice(0, MAX_ENTITIES);
  const kept = new Set(capped.map((e) => e.ref));
  rels = rels.filter((r) => {
    if (kept.has(r.a) && kept.has(r.b)) return true;
    leave(r.description, 'an entity it joins was left out');
    return false;
  });

  // 4. matches: an id it was shown, or a project entity of the same name, with the note it has.
  // Two found to be the same existing entity are one.
  const entities: Settled[] = [];
  const sameAs = new Map<string, string>();
  for (const e of capped) {
    const match = await resolveMatch(e, { lookup, known: o.known, offered });
    const id = match.kind === 'existing' ? match.entityId : null;
    const into = id
      ? entities.find((x) => x.match.kind === 'existing' && x.match.entityId === id)
      : undefined;
    if (into) {
      for (const s of join(into, e)) list(s.text, `over ${MAX_SENTENCES} sentences`);
      sameAs.set(e.ref, into.ref);
      leave(e.name, `the same entity as ${into.name}`);
      continue;
    }
    const has =
      match.kind === 'existing'
        ? await noteOf(match.entityId, match.name, { known: o.known, seen, lookup })
        : null;
    entities.push({
      ref: e.ref,
      name: e.name,
      type: e.type,
      match,
      subject: o.known.some((k) => k.id === id && k.subject),
      ...(has ? { aliases: has.aliases } : {}),
      note: has?.note ?? { kind: 'new' },
      ways: [...e.ways],
      description: [...e.description],
      names: [e.name],
    });
  }
  // the protagonist's note is the profile: no description, so none is checked
  for (const e of entities.filter((x) => x.subject)) {
    for (const s of e.description) list(s.text, NO_DESCRIPTION);
    e.description = [];
  }
  rels = rels.flatMap((r) => {
    const a = sameAs.get(r.a) ?? r.a;
    const b = sameAs.get(r.b) ?? r.b;
    if (a !== b) return [{ ...r, a, b }];
    leave(r.description, 'it joins an entity to itself');
    return [];
  });

  // 5. the sentences and relationships: the code checks, then the judge, ten entities a call
  const at = new Map(entities.map((e, i) => [e.ref, i]));
  const batchOf = (ref: string) => Math.floor(at.get(ref)! / JUDGE_BATCH);
  const namesOf = (ref: string) => entities[at.get(ref)!]!.names;
  const items: Array<
    (Item & { kind: 'sentence'; sentence: Cited }) | (Item & { kind: 'told'; told: RawTold })
  > = [
    ...entities.flatMap((e) =>
      e.description.map((s) => ({
        kind: 'sentence' as const,
        text: s.text,
        cites: s.cites,
        names: e.names,
        about: e.name,
        batch: batchOf(e.ref),
        sentence: s,
      })),
    ),
    ...rels.map((r) => ({
      kind: 'told' as const,
      text: r.description,
      cites: r.cites,
      names: [...namesOf(r.a), ...namesOf(r.b)],
      // with the later of the two it joins
      batch: Math.max(batchOf(r.a), batchOf(r.b)),
      told: r,
    })),
  ];
  const checked = await checkAll(items, {
    judge: o.judge,
    lines: o.lines,
    profile: o.profile,
    names: knownNames,
    part: told.length ? [{ from: told[0]!.n, to: told[told.length - 1]!.n }] : [],
    signal: o.signal,
  });
  calls += checked.calls;
  const failed = new Set<Cited | RawTold>();
  for (const [i, why] of checked.failed) {
    if (i.kind === 'told') {
      failed.add(i.told);
      leave(i.text, why);
    } else {
      // a sentence that fails goes; its entity stays
      failed.add(i.sentence);
      list(i.text, why);
    }
  }
  for (const e of entities) e.description = e.description.filter((s) => !failed.has(s));

  // 6. one relationship for a pair: the first that held
  const pairs = new Set<string>();
  rels = rels.filter((r) => {
    if (failed.has(r)) return false;
    const pair = [r.a, r.b].sort().join(':');
    if (!pairs.has(pair)) {
      pairs.add(pair);
      return true;
    }
    leave(r.description, 'a second relationship for the pair');
    return false;
  });
  for (const r of rels.slice(MAX_RELATIONSHIPS)) {
    leave(r.description, `over ${MAX_RELATIONSHIPS} relationships`);
  }

  // 7. what is left, numbered in order
  const refOf = new Map(entities.map((e, i) => [e.ref, `e${i + 1}`]));
  return {
    entities: entities.map((e): ProposedEntity => ({
      ref: refOf.get(e.ref)!,
      name: e.name,
      type: e.type,
      match: e.match,
      mentions: [],
      ...(e.aliases ? { aliases: e.aliases } : {}),
      ways: e.ways,
      description: e.description.map((s) => ({ text: s.text, sources: sourcesOf(s.cites) })),
      note: e.note,
      ...(e.subject ? { subject: true } : {}),
    })),
    relationships: rels.slice(0, MAX_RELATIONSHIPS).map((r, i): ProposedRelationship => ({
      ref: `r${i + 1}`,
      a: refOf.get(r.a)!,
      b: refOf.get(r.b)!,
      description: r.description,
      story: null,
      sources: sourcesOf(r.cites),
    })),
    stats: { calls, proposed, dropped, left },
  };
}

/** the project's entity it is, when it is one */
const idOf = (e: ProposedEntity): string | null =>
  e.match.kind === 'existing' ? e.match.entityId : null;

/**
 * The same entity, found in two parts: the same existing one; else the same name and type, but
 * never two different entities the project has ("John Lee" and another "John Lee")
 */
const sameFound = (a: ProposedEntity, b: ProposedEntity): boolean => {
  const ia = idOf(a);
  const ib = idOf(b);
  if (ia && ib) return ia === ib;
  return a.type === b.type && matchKey(a.name) === matchKey(b.name);
};

/**
 * A later part's entity joined to the same one from an earlier part: what the project has, if
 * only the later part knew it; their aliases and ways together, the later name a way when it
 * differs; and the later sentences after the earlier ones, up to 4. Gives the sentences left out,
 * with why: past 4, or every one once it is the person the archive is about.
 */
function joinFound(into: ProposedEntity, e: ProposedEntity): Array<{ what: string; why: string }> {
  if (into.match.kind !== 'existing' && e.match.kind === 'existing') {
    into.match = e.match;
    if (e.note) into.note = e.note;
  }
  if (e.subject) into.subject = true;
  const aliases = [...new Set([...(into.aliases ?? []), ...(e.aliases ?? [])])];
  if (aliases.length) into.aliases = aliases;
  const name =
    matchKey(e.name) !== matchKey(into.name) && e.name.split(/\s+/).length <= MAX_WORDS
      ? [e.name]
      : [];
  into.ways = [...new Set([...(into.ways ?? []), ...name, ...(e.ways ?? [])])].slice(0, MAX_WAYS);
  const description = [...(into.description ?? []), ...(e.description ?? [])];
  if (into.subject) {
    into.description = [];
    return description.map((d) => ({ what: d.text, why: NO_DESCRIPTION }));
  }
  into.description = description.slice(0, MAX_SENTENCES);
  return description
    .slice(MAX_SENTENCES)
    .map((d) => ({ what: d.text, why: `over ${MAX_SENTENCES} sentences` }));
}

/**
 * The Entity step's answers for each part of a long interview, as one (entity design 4.4): refs
 * numbered across the parts, an entity found in two parts made one, one relationship for a pair,
 * and the limits kept for the whole interview. The stats are added up; an entity or relationship
 * joined to an earlier one counts as dropped, so `proposed - dropped` are still the ones kept.
 */
export function mergeFound(results: readonly FindResult[]): FindResult {
  const entities: ProposedEntity[] = [];
  const relationships: ProposedRelationship[] = [];
  const stats = {
    calls: 0,
    proposed: 0,
    dropped: 0,
    left: [] as Array<{ what: string; why: string }>,
  };
  const list = (what: string, why: string) => {
    if (stats.left.length < 30) stats.left.push({ what, why });
  };
  const leave = (what: string, why: string) => {
    stats.dropped++;
    list(what, why);
  };
  const pairs = new Set<string>();
  let things = 0;
  for (const r of results) {
    stats.calls += r.stats.calls;
    stats.proposed += r.stats.proposed;
    stats.dropped += r.stats.dropped;
    for (const l of r.stats.left ?? []) list(l.what, l.why);
    // this part's refs → the merged ones
    const refOf = new Map<string, string>();
    for (const e of r.entities) {
      // the project's entity first: a name alone never joins two of them
      const id = idOf(e);
      const into =
        (id && entities.find((x) => idOf(x) === id)) || entities.find((x) => sameFound(x, e));
      if (into) {
        for (const l of joinFound(into, e)) list(l.what, l.why);
        refOf.set(e.ref, into.ref);
        stats.dropped++;
        continue;
      }
      if (entities.length >= MAX_ENTITIES) {
        leave(e.name, `over ${MAX_ENTITIES} entities`);
        continue;
      }
      if (e.type === 'thing' && ++things > MAX_THINGS) {
        leave(e.name, `over ${MAX_THINGS} things`);
        continue;
      }
      const ref = `e${entities.length + 1}`;
      refOf.set(e.ref, ref);
      entities.push({
        ...e,
        ref,
        ...(e.aliases ? { aliases: [...e.aliases] } : {}),
        ways: [...(e.ways ?? [])],
        description: [...(e.description ?? [])],
      });
    }
    for (const t of r.relationships) {
      const a = refOf.get(t.a);
      const b = refOf.get(t.b);
      if (!a || !b) {
        leave(t.description, 'an entity it joins was left out');
        continue;
      }
      if (a === b) {
        leave(t.description, 'it joins an entity to itself');
        continue;
      }
      const pair = [a, b].sort().join(':');
      if (pairs.has(pair)) {
        leave(t.description, 'a second relationship for the pair');
        continue;
      }
      if (relationships.length >= MAX_RELATIONSHIPS) {
        leave(t.description, `over ${MAX_RELATIONSHIPS} relationships`);
        continue;
      }
      pairs.add(pair);
      relationships.push({ ...t, ref: `r${relationships.length + 1}`, a, b });
    }
  }
  return { entities, relationships, stats };
}
