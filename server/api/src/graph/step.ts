import { matchKey } from '@funmem/core';
import type { ChatModel } from '../nim';
import { checkDraft, type ProblemKind } from '../stories/check';
import { FAILING, judgeStory } from '../stories/judge';
import { parseCite, renderLines, type Line, type Range } from '../stories/lines';
import { runWithTools, type Tool } from '../stories/tools';
import type { EntityLookup } from './store';
import {
  ENTITY_TYPES,
  type EntityMatch,
  type EntityType,
  type GraphProposal,
  type GraphSource,
  type ProposedEntity,
  type ProposedMention,
  type ProposedRelationship,
} from './types';

/**
 * The Graph step (graph design 4.1, 4.2): after the stories are written, the AI names the people,
 * places and things in them and the relationships they tell, looking up the project's entities
 * with read-only tools. Then every line it wrote is checked like a story sentence: in code
 * (names, numbers and quotes in the cited lines; the words really in the story; citations inside
 * the story), then by the judge. What fails is left out; nothing is written again.
 */
export interface StoryForGraph {
  /** a memory id ("m1") in an import, a note id when building from saved stories */
  ref: string;
  title: string;
  /** what a mention's words must appear in */
  text: string;
  sentences: Array<{ text: string; cites: Range[] }>;
  /** the lines the story may cite */
  ranges: Range[];
  tellers: string[];
}

export interface KnownEntity {
  id: string;
  name: string;
  type: EntityType;
  aliases: string[];
}

export const GRAPH_SYSTEM = `You find the people, places and things in a family's stories, and the relationships the stories tell between them, for the family archive's graph.

Each story below was written from an interview, and its sentences cite the interview lines ("L12"; "P" is what the family entered about who the stories are about). For every PERSON, PLACE and THING the stories name, give:
- "ref": "e1", "e2", ...
- "name": what to file it under. A real name when one is given ("Sarah Lee", "Busan"). Someone named only by a family word or a relationship gets a name from it and the speaker: "my mother" said by Noah Kim is "Noah Kim's mother"; "my friend from the factory" said by Sunja is "Sunja's friend from the factory". Never "Mom", "Dad" or "my mother" on its own. Never add a surname or any word the lines do not give.
- "type": "person", "place" or "thing". A thing only when it is specific and the story is about it ("the sewing machine", "kimchi soup", "Mrs. Han's pencil box"), never an ordinary object ("a cup", "the door"); at most 3 things a story.
- "match": the id of the entity it already is (the people already known are listed; use find_entity when one may already exist), "new", or "ask" with "candidates" (their ids) when you cannot tell which.
- "mentions": one per story that names it: {"story": "S1", "words": [the words the story's text uses for it, exactly as written there], "line": one sentence in the third person on what this story says about it, "cites": ["L12"]}.
The person the stories are about is named in most of them: list them too, with their id.

"relationships": only what the lines TELL about how two of them relate ("my friend Sarah", "her brother Tom", "we lived in Busan", "she made it every birthday"). Being in the same story is not a relationship, and neither is anything you would have to guess. Give {"a": "e2", "b": "e1", "description": "Name — how they relate", "story": "S1", "cites": ["L12"]}, for example "Tom — Sarah's brother" or "Noah Kim — lived in Busan as a boy".

Use only what the cited lines say. Never invent a name, a place, a thing or a relationship.

Result: {"entities": [...], "relationships": [...]}`;

const TOOL_CALLS = 12;
const MAX_ENTITIES = 60;
const MAX_RELATIONSHIPS = 100;
const THINGS_PER_STORY = 3;
const KEPT: readonly ProblemKind[] = [
  'no_citation',
  'bad_citation',
  'not_in_source',
  'quote',
  'outside_story',
];
/** words a name may hold that need not be in the lines */
const NAME_FILLER = new Set(
  'the a an of from in at on and s his her their my our de la le van von'.split(' '),
);
const PRONOUNS = new Set(
  'he she they him her them his hers their i me my we us our you'.split(' '),
);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const lower = (s: string) => s.normalize('NFC').toLowerCase();

interface RawMention {
  story: string;
  words: string[];
  line: string;
  cites: Range[];
}
interface RawEntity {
  ref: string;
  name: string;
  type: EntityType;
  match: string;
  candidates: string[];
  mentions: RawMention[];
}
interface RawRelationship {
  a: string;
  b: string;
  description: string;
  story: string;
  cites: Range[];
}

const cites = (v: unknown): Range[] =>
  (Array.isArray(v) ? v : []).map((c) => parseCite(c)).filter((r): r is Range => r !== null);

/** the model's answer, read leniently: an item that is not right is left out, not argued over */
export function parseGraph(
  v: unknown,
  storyIds: ReadonlySet<string>,
): { entities: RawEntity[]; relationships: RawRelationship[] } | string {
  if (!isObj(v) || !Array.isArray(v.entities))
    return 'give {"entities": [...], "relationships": [...]}';
  const entities: RawEntity[] = [];
  const refs = new Set<string>();
  for (const e of v.entities) {
    if (!isObj(e)) continue;
    const ref = str(e.ref);
    const name = str(e.name).slice(0, 200);
    const type = ENTITY_TYPES.find((t) => t === e.type);
    if (!ref || refs.has(ref) || !name || !matchKey(name) || !type) continue;
    const mentions: RawMention[] = [];
    for (const m of Array.isArray(e.mentions) ? e.mentions : []) {
      if (!isObj(m) || !storyIds.has(str(m.story))) continue;
      // one mention per story: the first given
      if (mentions.some((x) => x.story === str(m.story))) continue;
      mentions.push({
        story: str(m.story),
        words: (Array.isArray(m.words) ? m.words : []).map(str).filter(Boolean).slice(0, 6),
        line: str(m.line).slice(0, 300),
        cites: cites(m.cites),
      });
    }
    refs.add(ref);
    entities.push({
      ref,
      name,
      type,
      match: str(e.match) || 'new',
      candidates: (Array.isArray(e.candidates) ? e.candidates : []).map(str).filter(Boolean),
      mentions,
    });
  }
  const relationships: RawRelationship[] = [];
  for (const r of Array.isArray(v.relationships) ? v.relationships : []) {
    if (!isObj(r)) continue;
    const a = str(r.a);
    const b = str(r.b);
    const description = str(r.description).slice(0, 500);
    if (!refs.has(a) || !refs.has(b) || a === b || !description || !storyIds.has(str(r.story)))
      continue;
    relationships.push({ a, b, description, story: str(r.story), cites: cites(r.cites) });
  }
  return { entities, relationships };
}

/** does `text` hold `words` as whole words, ignoring case? */
function holds(text: string, words: string): boolean {
  const t = lower(text);
  const w = lower(words);
  let at = t.indexOf(w);
  while (at >= 0) {
    const before = t[at - 1] ?? '';
    const after = t[at + w.length] ?? '';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    at = t.indexOf(w, at + 1);
  }
  return false;
}

export async function graphStep(o: {
  chat: ChatModel;
  judge: ChatModel;
  stories: readonly StoryForGraph[];
  /** the transcript's lines, with the profile as line 0 when there is one */
  lines: readonly Line[];
  /** "Who this is about" (stories/profile.ts), or '' */
  profile: string;
  /** the protagonist and the tellers, already in the graph */
  known: readonly KnownEntity[];
  /** names the checks accept without a citation: speakers, the profile's */
  names: readonly string[];
  lookup: EntityLookup;
  signal?: AbortSignal;
  /** where a cited range comes from; interview lines by default */
  sourceOf?: (r: Range) => GraphSource[];
}): Promise<GraphProposal> {
  const sourceOf = o.sourceOf ?? ((r: Range) => [{ interviewId: null, from: r.from, to: r.to }]);
  const sRef = new Map(o.stories.map((s, i) => [`S${i + 1}`, s]));
  // every entity id the AI was shown: the known ones, and what its tools found
  const offered = new Map<string, string>(o.known.map((k) => [k.id, k.name]));
  const tools: Tool[] = [
    {
      name: 'find_entity',
      description: 'finds people, places and things already in the project by name or alias',
      args: '{"name": string}',
      run: async (a) => {
        const name = str(a.name);
        if (!name) return 'give a name';
        const found = await o.lookup.find(name);
        for (const f of found) offered.set(f.id, f.name);
        return found.length
          ? found
              .map(
                (f) =>
                  `- ${f.name} (${f.type}, id ${f.id})${f.aliases.length ? `, also called ${f.aliases.join(', ')}` : ''}${f.close ? ' [only a similar spelling]' : ''}${f.lines.length ? `: ${f.lines.join(' ')}` : ''}`,
              )
              .join('\n')
          : 'nobody by that name yet';
      },
    },
    {
      name: 'read_entity',
      description: 'reads one entity: what the stories say about it and its relationships',
      args: '{"id": string}',
      run: async (a) => {
        const e = await o.lookup.read(str(a.id));
        if (!e) return 'no such entity';
        offered.set(e.id, e.name);
        return `${e.name} (${e.type}, id ${e.id})${e.aliases.length ? `, also called ${e.aliases.join(', ')}` : ''}\n${e.description}\n${e.relationships.join('\n')}`;
      },
    },
  ];

  const shownLines = o.lines.filter(
    (l) => l.n === 0 || o.stories.some((s) => s.ranges.some((r) => l.n >= r.from && l.n <= r.to)),
  );
  const task = [
    o.profile,
    o.known.length
      ? `Already known (use the id as "match"):\n${o.known
          .map(
            (k) =>
              `- ${k.name} (${k.type}, id ${k.id})${k.aliases.length ? `, also called ${k.aliases.join(', ')}` : ''}`,
          )
          .join('\n')}`
      : '',
    `The stories:\n${[...sRef]
      .map(
        ([id, s]) =>
          `${id} "${s.title}"\n${s.sentences
            .map(
              (x, i) =>
                `  ${i}. ${x.text} [${x.cites.map((r) => (r.from === 0 ? 'P' : r.from === r.to ? `L${r.from}` : `L${r.from}-L${r.to}`)).join(', ')}]`,
            )
            .join('\n')}`,
      )
      .join('\n\n')}`,
    `The interview lines they cite:\n${renderLines(shownLines.filter((l) => l.n > 0))}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const { value: raw, calls } = await runWithTools(o.chat, {
    system: GRAPH_SYSTEM,
    task,
    tools,
    maxToolCalls: TOOL_CALLS,
    signal: o.signal,
    parse: (v) => parseGraph(v, new Set(sRef.keys())),
  });
  let dropped = 0;
  const proposed = raw.entities.length + raw.relationships.length;

  // a name must come from the lines: every word of it is in them, the story, or a known name
  const knownWords = new Set(
    [...o.names, ...o.known.flatMap((k) => [k.name, ...k.aliases])].flatMap((n) =>
      lower(n).split(/[^\p{L}\p{N}]+/u),
    ),
  );
  const nameHeld = (e: RawEntity): boolean => {
    const where = lower(
      [
        ...e.mentions.map((m) => sRef.get(m.story)!.text),
        ...o.lines
          .filter((l) => e.mentions.some((m) => m.cites.some((r) => l.n >= r.from && l.n <= r.to)))
          .map((l) => l.text),
      ].join(' '),
    );
    return lower(e.name)
      .replace(/['’]s\b/g, ' ')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w && !NAME_FILLER.has(w))
      .every((w) => knownWords.has(w) || where.includes(w));
  };

  // 1. the words each mention uses must be in its story; things capped per story
  const things = new Map<string, number>();
  const entities = raw.entities.filter((e) => {
    if (!nameHeld(e)) {
      dropped++;
      return false;
    }
    e.mentions = e.mentions.filter((m) => {
      const story = sRef.get(m.story)!;
      m.words = m.words.filter((w) => !PRONOUNS.has(lower(w)) && holds(story.text, w));
      if (m.words.length === 0) return false;
      if (e.type === 'thing') {
        const n = things.get(m.story) ?? 0;
        if (n >= THINGS_PER_STORY) return false;
        things.set(m.story, n + 1);
      }
      return true;
    });
    if (e.mentions.length === 0) dropped++;
    return e.mentions.length > 0;
  });

  // 2. the lines: the code checks, then the judge, per story
  const nameList = [
    ...o.names,
    ...o.known.flatMap((k) => [k.name, ...k.aliases]),
    ...entities.map((e) => e.name),
  ];
  type Item = { text: string; cites: Range[]; story: string; drop: () => void };
  const items: Item[] = [];
  for (const e of entities) {
    for (const m of e.mentions) {
      items.push({
        text: m.line || `${e.name} is named in this story.`,
        cites: m.cites,
        story: m.story,
        drop: () => (e.mentions = e.mentions.filter((x) => x !== m)),
      });
    }
  }
  const kept = new Set(entities.map((e) => e.ref));
  let rels = raw.relationships.filter((r) => kept.has(r.a) && kept.has(r.b));
  for (const r of rels) {
    items.push({
      text: r.description,
      cites: r.cites,
      story: r.story,
      drop: () => (rels = rels.filter((x) => x !== r)),
    });
  }
  const failed = new Set<Item>();
  for (const [sid, story] of sRef) {
    const mine = items.filter((i) => i.story === sid);
    if (mine.length === 0) continue;
    const draft = {
      title: story.title,
      occurred: null,
      until: null,
      sentences: mine.map((i) => ({ text: i.text, cites: i.cites, paragraph: false })),
    };
    const problems = checkDraft(draft, o.lines, nameList, story.ranges).filter(
      (p) => p.sentence >= 0 && KEPT.includes(p.kind),
    );
    for (const p of problems) failed.add(mine[p.sentence]!);
    const left = mine.filter((i) => !failed.has(i));
    if (left.length === 0) continue;
    const { rulings } = await judgeStory(
      o.judge,
      {
        ...draft,
        sentences: left.map((i) => ({ text: i.text, cites: i.cites, paragraph: false })),
      },
      o.lines,
      o.signal,
      o.profile,
    );
    for (const r of rulings) if (FAILING.includes(r.verdict)) failed.add(left[r.sentence]!);
  }
  for (const i of failed) {
    i.drop();
    dropped++;
  }

  // 3. what is left: an entity with no mention goes, and its relationships with it
  const live = entities.filter((e) => e.mentions.length > 0);
  dropped += entities.length - live.length;
  const liveRefs = new Set(live.map((e) => e.ref));
  rels = rels.filter(
    (r) =>
      liveRefs.has(r.a) &&
      liveRefs.has(r.b) &&
      [r.a, r.b].every((ref) =>
        live.find((e) => e.ref === ref)!.mentions.some((m) => m.story === r.story),
      ),
  );

  // 4. matches: an id it was shown; a "new" one whose name the project already has is that one
  const out: ProposedEntity[] = [];
  const renamed = new Map<string, string>();
  for (const e of live.slice(0, MAX_ENTITIES)) {
    let match: EntityMatch = { kind: 'new' };
    if (e.match === 'ask') {
      const found = await o.lookup.find(e.name);
      for (const f of found) offered.set(f.id, f.name);
      const candidates = e.candidates
        .filter((c) => offered.has(c))
        .map((c) => ({ entityId: c, name: offered.get(c)! }));
      if (candidates.length) match = { kind: 'ask', candidates };
    } else if (e.match !== 'new' && offered.has(e.match)) {
      match = { kind: 'existing', entityId: e.match, name: offered.get(e.match)! };
    }
    if (match.kind === 'new') {
      const exact = (await o.lookup.find(e.name)).find((f) => !f.close);
      const known = o.known.find((k) =>
        [k.name, ...k.aliases].some((n) => matchKey(n) === matchKey(e.name)),
      );
      const same = exact ?? known;
      if (same) match = { kind: 'existing', entityId: same.id, name: same.name };
    }
    const ref = `e${out.length + 1}`;
    renamed.set(e.ref, ref);
    out.push({
      ref,
      name: e.name,
      type: e.type,
      match,
      mentions: e.mentions.map((m): ProposedMention => ({
        story: sRef.get(m.story)!.ref,
        words: m.words,
        line: m.line,
        sources: m.cites.filter((r) => r.from > 0).flatMap(sourceOf),
      })),
    });
  }
  dropped += Math.max(0, live.length - MAX_ENTITIES);
  const relationships: ProposedRelationship[] = rels
    .filter((r) => renamed.has(r.a) && renamed.has(r.b))
    .slice(0, MAX_RELATIONSHIPS)
    .map((r, i) => ({
      ref: `r${i + 1}`,
      a: renamed.get(r.a)!,
      b: renamed.get(r.b)!,
      description: r.description,
      story: sRef.get(r.story)!.ref,
      sources: r.cites.filter((c) => c.from > 0).flatMap(sourceOf),
    }));
  return {
    entities: out,
    relationships,
    stats: { calls, proposed, dropped },
  };
}
