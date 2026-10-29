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
  nameWords,
  resolveMatch,
  str,
  uncovered,
} from './shared';
import type { EntityLookup, FoundEntity, KnownEntity } from './store';
import {
  ENTITY_TYPES,
  type EntityMatch,
  type EntityNote,
  type EntityType,
  type GraphProposal,
  type GraphSource,
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
/** the entities whose sentences and relationships the judge reads in one call */
const JUDGE_BATCH = 10;
/** what the checks call the sentences they read together */
const TITLE = 'People, places and things';
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
type Answer = { entities: RawFound[]; relationships: RawTold[] };

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
function merge(into: Answer, more: Answer): void {
  const earlier = new Set(into.entities.map((e) => e.ref));
  const taken = new Set(earlier);
  const rename = new Map<string, string>();
  for (const e of more.entities) {
    const same = into.entities.find(
      (x) => matchKey(x.name) === matchKey(e.name) && x.type === e.type,
    );
    let ref = same?.ref ?? e.ref;
    if (!same) {
      while (taken.has(ref)) ref = `${ref}+`;
      taken.add(ref);
      into.entities.push({ ...e, ref });
    }
    rename.set(e.ref, ref);
  }
  for (const r of more.relationships) {
    const a = rename.get(r.a) ?? (earlier.has(r.a) ? r.a : null);
    const b = rename.get(r.b) ?? (earlier.has(r.b) ? r.b : null);
    if (a && b && a !== b) into.relationships.push({ ...r, a, b });
  }
}

const knownLine = (k: KnownEntity): string =>
  `- ${k.name} (${k.type}, id ${k.id})${k.aliases.length ? `, also called ${k.aliases.join(', ')}` : ''}${k.subject ? ' — the person the archive is about' : ''}`;

/** interview lines as a proposal's sources; the profile (P) is not one */
const sourcesOf = (rs: readonly Range[]): GraphSource[] =>
  rs.filter((r) => r.from > 0).map((r) => ({ interviewId: null, from: r.from, to: r.to }));

export interface FindResult {
  /** each with `ways`, `description` and `note`; `mentions` are filled from the stories */
  entities: ProposedEntity[];
  /** each with `story: null`: the workflow ties it to the story whose lines tell it */
  relationships: ProposedRelationship[];
  stats: NonNullable<GraphProposal['stats']>;
}

/**
 * One part of an interview through the Entity step. Throws when the AI cannot be reached or its
 * answer cannot be read, so the import can say the list is pending; a failed recall pass does not.
 */
export async function findEntities(o: {
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
}): Promise<FindResult> {
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
  const task = [
    o.profile,
    o.known.length
      ? `Already known (use the id as "match"):\n${o.known.map(knownLine).join('\n')}`
      : '',
    `The interview:\n${renderLines(told)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  // 1. ask
  const first = await runWithTools(o.chat, {
    system: FIND_SYSTEM,
    task,
    tools: entityTools(lookup, offered),
    maxToolCalls: TOOL_CALLS,
    signal: o.signal,
    parse: (v) => parseFound(v),
  });
  const raw = first.value;
  let calls = first.calls;

  // 2. names the tellers say that the answer left out ("in Korea"): asked about once more, alone
  const missing = uncovered(
    told.filter((l) => l.teller).map((l) => l.text),
    [
      ...o.names,
      ...o.known.flatMap((k) => [k.name, ...k.aliases]),
      ...raw.entities.flatMap((e) => [e.name, ...e.ways]),
    ],
  );
  if (missing.length > 0) {
    try {
      const more = await runWithTools(o.chat, {
        system: FIND_SYSTEM,
        task: `${task}\n\nYour answer named: ${raw.entities.map((e) => e.name).join(', ') || 'nobody'}.\nThese names are in the lines but not in your answer: ${missing.join(', ')}. For each that is a person, place or thing, give it the same way, with the relationships the lines tell; leave out the rest. Its relationships may name the entities of your answer by their refs (${raw.entities.map((e) => `${e.ref} ${e.name}`).join(', ')}).`,
        tools: [],
        maxToolCalls: 0,
        maxCalls: 2,
        signal: o.signal,
        parse: (v) => parseFound(v, new Set(raw.entities.map((e) => e.ref))),
      });
      calls += more.calls;
      merge(raw, more.value);
    } catch (e) {
      // the first answer stands; only a cancel is passed on
      if (o.signal?.aborted) throw e;
    }
  }

  let dropped = 0;
  const proposed = raw.entities.length + raw.relationships.length;
  const left: Array<{ what: string; why: string }> = [];
  const leave = (what: string, why: string) => {
    dropped++;
    if (left.length < 30) left.push({ what, why });
  };

  // 3. relationships as told: knowing of someone only through another is no line between them
  // (graph design G-D1), the name is not said again after the dash, and a pair has one
  const pairs = new Set<string>();
  let rels = raw.relationships.filter((r) => {
    if (SECOND_HAND.test(r.description)) {
      leave(r.description, 'known only through another person');
      return false;
    }
    const pair = [r.a, r.b].sort().join(':');
    if (pairs.has(pair)) return false;
    pairs.add(pair);
    return true;
  });
  for (const r of rels) {
    const [before, after] = r.description.split(/\s+[—–-]\s+/, 2);
    if (before && after && matchKey(before) === matchKey(after)) r.description = before;
  }

  // 4. a name must come from the lines: every word of it is in them or in a known name; and the
  // limits (entity design 4.4)
  const knownWords = nameWords([...o.names, ...o.known.flatMap((k) => [k.name, ...k.aliases])]);
  const text = o.lines.map((l) => l.text).join('\n');
  let things = 0;
  const held = raw.entities.filter((e) => {
    if (!nameHeld(e.name, text, knownWords)) {
      leave(e.name, 'a word of the name is not in the lines');
      return false;
    }
    if (e.type === 'thing' && ++things > MAX_THINGS) {
      leave(e.name, 'over 20 things');
      return false;
    }
    return true;
  });
  for (const e of held.slice(MAX_ENTITIES)) leave(e.name, 'over 60 entities');
  const entities = held.slice(0, MAX_ENTITIES);
  const index = new Map(entities.map((e, i) => [e.ref, i]));
  rels = rels.filter((r) => index.has(r.a) && index.has(r.b));

  // 5. matches: an id it was shown, or a project entity of the same name; and the note it has.
  // The protagonist's description is never kept, so it is not checked.
  /** what the project has of an existing entity: the names it goes by, the note the member sees */
  const has = async (
    id: string,
    name: string,
  ): Promise<{ aliases: string[]; note: NoteRef | null }> => {
    const k = o.known.find((x) => x.id === id);
    if (k && k.note !== undefined) return { aliases: k.aliases, note: k.note };
    const row = seen.get(id) ?? (await lookup.find(name)).find((f) => f.id === id);
    return { aliases: k?.aliases ?? row?.aliases ?? [], note: row?.note ?? null };
  };
  const matched: Array<{
    match: EntityMatch;
    subject: boolean;
    aliases?: string[];
    note: EntityNote;
  }> = [];
  for (const e of entities) {
    const match = await resolveMatch(e, { lookup, known: o.known, offered });
    if (match.kind !== 'existing') {
      matched.push({ match, subject: false, note: { kind: 'new' } });
      continue;
    }
    const subject = o.known.some((k) => k.id === match.entityId && k.subject);
    if (subject) e.description = [];
    const { aliases, note } = await has(match.entityId, match.name);
    matched.push({
      match,
      subject,
      aliases,
      note: note ? { kind: 'existing', ...note } : { kind: 'new' },
    });
  }

  // 6. the sentences and relationships: the code checks, then the judge, ten entities at a time
  const nameList = [
    ...o.names,
    ...o.known.flatMap((k) => [k.name, ...k.aliases]),
    ...entities.map((e) => e.name),
  ];
  type Item = { text: string; cites: Range[]; batch: number; drop: () => void; why?: string };
  const batchOf = (ref: string) => Math.floor(index.get(ref)! / JUDGE_BATCH);
  const items: Item[] = [];
  for (const e of entities) {
    for (const s of e.description) {
      items.push({
        text: s.text,
        cites: s.cites,
        batch: batchOf(e.ref),
        // a sentence that fails goes; its entity stays
        drop: () => (e.description = e.description.filter((x) => x !== s)),
      });
    }
  }
  for (const r of rels) {
    items.push({
      text: r.description,
      cites: r.cites,
      // with the later of its two entities
      batch: Math.max(batchOf(r.a), batchOf(r.b)),
      drop: () => (rels = rels.filter((x) => x !== r)),
    });
  }
  // a sentence may cite the part's lines, and the profile
  const part: Range[] = told.length ? [{ from: told[0]!.n, to: told[told.length - 1]!.n }] : [];
  const failed = new Set<Item>();
  for (let b = 0; b * JUDGE_BATCH < entities.length; b++) {
    const mine = items.filter((i) => i.batch === b);
    if (mine.length === 0) continue;
    const draft = {
      title: TITLE,
      occurred: null,
      until: null,
      sentences: mine.map((i) => ({ text: i.text, cites: i.cites, paragraph: false })),
    };
    const problems = checkDraft(draft, o.lines, nameList, part).filter(
      (p) => p.sentence >= 0 && KEPT.includes(p.kind),
    );
    for (const p of problems) {
      const item = mine[p.sentence]!;
      item.why ??= `${p.kind}: ${p.detail}`;
      failed.add(item);
    }
    const rest = mine.filter((i) => !failed.has(i));
    if (rest.length === 0) continue;
    const judged = await judgeStory(
      o.judge,
      {
        ...draft,
        sentences: rest.map((i) => ({ text: i.text, cites: i.cites, paragraph: false })),
      },
      o.lines,
      o.signal,
      o.profile,
    );
    calls += judged.calls;
    for (const r of judged.rulings) {
      if (!FAILING.includes(r.verdict)) continue;
      const item = rest[r.sentence]!;
      item.why ??= `the judge: ${r.verdict}${r.reason ? ` (${r.reason})` : ''}`;
      failed.add(item);
    }
  }
  for (const i of failed) {
    i.drop();
    leave(i.text, i.why ?? 'failed');
  }

  // 7. what is left, numbered in order
  const refOf = new Map(entities.map((e, i) => [e.ref, `e${i + 1}`]));
  const out = entities.map((e, i): ProposedEntity => {
    const m = matched[i]!;
    return {
      ref: refOf.get(e.ref)!,
      name: e.name,
      type: e.type,
      match: m.match,
      mentions: [],
      ...(m.aliases ? { aliases: m.aliases } : {}),
      ways: e.ways,
      description: e.description.map((s) => ({ text: s.text, sources: sourcesOf(s.cites) })),
      note: m.note,
      ...(m.subject ? { subject: true } : {}),
    };
  });
  for (const r of rels.slice(MAX_RELATIONSHIPS)) leave(r.description, 'over 100 relationships');
  const relationships = rels.slice(0, MAX_RELATIONSHIPS).map((r, i): ProposedRelationship => ({
    ref: `r${i + 1}`,
    a: refOf.get(r.a)!,
    b: refOf.get(r.b)!,
    description: r.description,
    story: null,
    sources: sourcesOf(r.cites),
  }));
  return { entities: out, relationships, stats: { calls, proposed, dropped, left } };
}
