import { matchKey } from '@funmem/core';
import { linkKnownTitles } from '../drafts';
import { acceptTitle, isPersonLabel } from '../ingest-lang';
import {
  anchorsFor,
  hashTurns,
  IngestCancelled,
  namesFor,
  type IngestOptions,
  type IngestResult,
  type ProposedMemory,
  type StoriesPendingReason,
  type StorySource,
} from '../ingest-pipeline';
import { findEntities, mergeFound, type FindResult } from '../graph/find';
import { checkMark, linkSentences, unmarked, type Listed, type Mark } from '../graph/marks';
import { findIn } from '../graph/shared';
import type { EntityLookup, KnownEntity } from '../graph/store';
import type { GraphProposal, GraphSource, ProposedEntity, ProposedMention } from '../graph/types';
import { asModelError, ModelError, type ChatModel } from '../nim';
import { mapPool } from '../pool';
import { applyRoles, type ParsedTranscript } from '../transcript';
import { agesSaid, checkDraft, type Problem } from './check';
import { FAILING, judgeStory, type Ruling } from './judge';
import { clock, linesOf, partsOf, PROFILE_LINE, textOf, type Line } from './lines';
import { planPart, type PlannedStory } from './plan';
import { ageYear, profileBlock, profileLine, saidDate, type Profile } from './profile';
import type { StoryLookup } from './tools';
import { writeStory, type Sentence, type StoryDraft } from './write';

/**
 * The story workflow (PRD section 6, phase 1): an interview in, its stories out, as proposals for
 * the review screen. The same steps every time:
 *
 *   1. prepare   who is telling; numbered lines; parts of at most ~200k tokens
 *   2. find      with the project's graph, per part, the people, places and things in the lines
 *                (graph/find.ts), before any story is planned (entity design 3)
 *   3. plan      per part, the AI (with read-only tools) finds the stories and their lines;
 *                a later part may carry on a story from an earlier one
 *   4. write     per story, the AI writes it in the third person, every sentence cited, and
 *                marks the names from the list each sentence uses
 *   5. judge     code checks the facts (check.ts), then the AI judge rules on each sentence
 *   6. fix       a failing story is written again with the reasons, at most twice; what still
 *                fails is left out and listed for the reviewer
 *   7. link      the marks are checked, names the writer missed are found, and the first time a
 *                story names each one becomes a link (graph/marks.ts)
 *
 * Nothing here touches the archive: the result is saved, or not, by a person (ingest-save.ts).
 * When the stories cannot be written (no AI, a rejected key, out of time) the result says so in
 * `pending` and holds no memories: the interview's transcript is kept, and they can be written
 * later. Nothing is ever chopped into fragments instead.
 */
export const WORKFLOW_VERSION = 'stories-1';

export interface StoriesDeps {
  chat: ChatModel | null;
  /** the judge's model; the writer's when absent */
  judge?: ChatModel | null;
  lookup: StoryLookup;
  /** the project's note titles, linked where a story names them */
  titles: string[];
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number }) => void;
  /** default 12 minutes (the Workers queue consumer allows 15) */
  deadlineMs?: number;
  /** how much one read may hold; default 200,000 tokens (PRD D1) */
  contextTokens?: number;
  /** the interview's name when a person gave one; else the plan names it */
  interviewName?: string | null;
  /** who the project is about: the narrator's name when the transcript gives none ("SPEAKER_00") */
  subject?: string | null;
  /** the protagonist's profile, and each narrator's (PRD D14): in every step's prompt */
  profiles?: Profile[];
  /** the project's graph: with it, the people, places and things are found first (entity design 3) */
  graph?: { lookup: EntityLookup; known: KnownEntity[] };
}

export const DEFAULT_STORY_DEADLINE_MS = 12 * 60_000;
export const DEFAULT_CONTEXT_TOKENS = 200_000;
const PLAN_TOOL_CALLS = 20;
const WRITE_TOOL_CALLS = 8;
const FIX_ROUNDS = 2;
const AT_ONCE = 3;
const CALL_CAP = 200;
/** a story left with fewer sentences than this after the checks is not kept */
const MIN_SENTENCES = 2;
const SOURCE_CHARS = 600;

class BudgetSpent extends Error {}

/** a story as written: its memory, its sentences as kept, and the names each sentence marks */
interface Made {
  memory: ProposedMemory;
  story: PlannedStory;
  sentences: Sentence[];
  marks: Mark[][];
}

/** what the stories are written with, from what the find step found */
interface Cast {
  /** every entity found, the person the project is about too: what the marks are checked against */
  listed: Listed[];
  byRef: Map<string, Listed>;
  /** for the writer, one per line: `ref  Name (type): ways` */
  forWriter: string;
  /** for the planner, one per line: `Name (type)` */
  forPlanner: string;
  /** names, aliases and note titles of what was found (matchKey): linked only by the marks */
  taken: Set<string>;
}

function castOf(found: FindResult | null): Cast {
  const entities = found?.entities ?? [];
  const listed: Listed[] = entities.map((e) => ({
    ref: e.ref,
    name: e.name,
    aliases: e.aliases ?? [],
    ways: e.ways ?? [],
    ...(e.subject ? { subject: true } : {}),
  }));
  const others = entities.filter((e) => !e.subject);
  return {
    listed,
    byRef: new Map(listed.map((l) => [l.ref, l])),
    forWriter: others
      .map(
        (e) => `${e.ref}  ${e.name} (${e.type})${e.ways?.length ? `: ${e.ways.join(', ')}` : ''}`,
      )
      .join('\n'),
    forPlanner: others.map((e) => `${e.name} (${e.type})`).join('\n'),
    taken: new Set(
      entities
        .flatMap((e) => [
          e.name,
          ...(e.aliases ?? []),
          ...(e.note?.kind === 'existing' ? [e.note.title] : []),
        ])
        .map(matchKey)
        .filter(Boolean),
    ),
  };
}

/** a sentence's cites as a proposal's sources: interview lines only, the profile (P) is not one */
const sourcesOf = (s: Sentence): GraphSource[] =>
  s.cites.filter((r) => r.from > 0).map((r) => ({ interviewId: null, from: r.from, to: r.to }));

/**
 * Where a story names an entity: one mention, with every distinct word it uses, and the first
 * sentence naming it as the line. The person the project is about is never marked: they are
 * found by their name or a name they go by, so Home still counts the stories they are in.
 */
function mentionIn(e: ProposedEntity, m: Made): ProposedMention[] {
  const names = [e.name, ...(e.aliases ?? [])].sort((a, b) => b.length - a.length);
  const words = m.sentences.map((s, i) =>
    e.subject
      ? names
          .map((n) => findIn(s.text, n))
          .filter((w): w is string => w !== null)
          .slice(0, 1)
      : m.marks[i]!.filter((k) => k.e === e.ref).map((k) => k.words),
  );
  const first = words.findIndex((w) => w.length > 0);
  if (first < 0) return [];
  return [
    {
      story: m.memory.id!,
      words: [...new Set(words.flat())],
      line: m.sentences[first]!.text,
      sources: sourcesOf(m.sentences[first]!),
    },
  ];
}

/**
 * The proposal for review: each entity found with its mentions in the stories as written, and
 * each relationship tied to the first story whose lines hold the first line it cites, or to none.
 */
function withStories(found: FindResult, made: readonly Made[]): GraphProposal {
  const storyOf = (sources: readonly GraphSource[]): string | null => {
    const lines = sources.flatMap((s) => ('from' in s && s.from > 0 ? [s.from] : []));
    if (lines.length === 0) return null;
    const line = Math.min(...lines);
    const m = made.find((x) => x.story.ranges.some((r) => line >= r.from && line <= r.to));
    return m?.memory.id ?? null;
  };
  return {
    entities: found.entities.map((e) => ({
      ...e,
      mentions: made.flatMap((m) => mentionIn(e, m)),
    })),
    relationships: found.relationships.map((r) => ({ ...r, story: storyOf(r.sources) })),
    stats: found.stats,
  };
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/**
 * An interview's numbered lines, its tellers decided as the memory import decides them. A
 * narrator known only as a voice ("SPEAKER_00") is the person the project is about (`subject`).
 * The button that finds the graph in saved stories reads an interview the same way.
 */
export function interviewLines(
  parsed: ParsedTranscript,
  opts: IngestOptions,
  subject?: string | null,
) {
  const asked = (Array.isArray(opts.interviewees) ? opts.interviewees : []).filter(
    (x): x is string => typeof x === 'string' && x.trim() !== '',
  );
  const named = asked.length
    ? asked
    : str(opts.interviewee)
      ? [opts.interviewee!]
      : parsed.interviewee
        ? [parsed.interviewee]
        : undefined;
  const { turns, roles, warnings } = applyRoles(parsed, named);
  const names = namesFor(opts, roles.interviewees);
  const lines = linesOf(turns, roles.interviewees, names);
  const subjectName = str(subject);
  if (subjectName) {
    for (const l of lines) {
      if (l.teller && l.name === l.speaker && !isPersonLabel(l.speaker)) l.name = subjectName;
    }
  }
  return { turns, roles, warnings, names, lines };
}

export async function writeStories(
  parsed: ParsedTranscript,
  opts: IngestOptions,
  deps: StoriesDeps,
): Promise<IngestResult> {
  if (deps.signal?.aborted) throw new IngestCancelled();

  // 1. prepare: who is telling, as the memory import decides it
  const { turns, roles, warnings, names, lines } = interviewLines(parsed, opts, deps.subject);
  const anchors = new Map(anchorsFor(parsed.turns, turns));
  const tellerLines = lines.filter((l) => l.teller && /[\p{L}\p{N}]/u.test(l.text));
  const subject =
    [...new Set(tellerLines.map((l) => l.name))].join(' and ') ||
    roles.interviewee ||
    'the narrator';
  const profiles = deps.profiles ?? [];
  const profile = profileBlock(profiles);
  // what the checks and the judge read: the transcript, and the profile as line 0 (cited "P")
  const asLine: Line[] = profiles.length
    ? [
        {
          n: PROFILE_LINE,
          speaker: 'profile',
          name: 'Profile',
          teller: false,
          start: null,
          end: null,
          text: profileLine(profiles),
        },
      ]
    : [];
  const withProfile: Line[] = [...asLine, ...lines];
  const known = [
    ...new Set([
      ...names.map(([, n]) => n),
      ...lines.map((l) => l.name),
      subject,
      ...profiles.flatMap((p) => [p.name, ...p.aliases]),
    ]),
  ];

  const counts = {
    planned: 0,
    written: 0,
    dropped: 0,
    firstPass: 0,
    sentences: 0,
    removed: 0,
    flagged: 0,
    calls: 0,
    /** what the checks found in every draft, by kind: where the prompts need work */
    problems: {} as Record<string, number>,
  };
  let rounds = 0;
  let retried = 0;
  /** what the stories are written and linked with; nothing until the find step has run */
  let cast = castOf(null);
  const result = (
    memories: ProposedMemory[],
    pending?: StoriesPendingReason,
    name?: string | null,
  ): IngestResult => {
    const cited = new Set(memories.flatMap((m) => m.turns));
    return {
      format: parsed.format,
      providerVersion: `${deps.chat?.id ?? 'no-model'}+${WORKFLOW_VERSION}`,
      interviewee: roles.interviewees[0] ?? '',
      interviewees: roles.interviewees,
      speakers: roles.speakers,
      roles: {
        source: roles.source,
        confidence: roles.confidence,
        reasons: roles.reasons,
        needsConfirmation: roles.needsConfirmation,
      },
      warnings,
      degraded: { windows: 0, reasons: [] },
      ...(str(opts.source) ? { source: str(opts.source)! } : {}),
      sourceHash: hashTurns(parsed.turns),
      memories,
      ...(pending ? { pending: { reason: pending } } : {}),
      interviewName: name ?? null,
      stats: {
        turns: turns.length,
        intervieweeTurns: tellerLines.length,
        windows: parts.length,
        failedWindows: 0,
        rounds,
        retried,
        exit: pending === 'no_model' ? 'no_model' : 'converged',
        coverage: {
          covered: tellerLines.filter((l) => cited.has(turns[l.n - 1]!.index)).length,
          total: tellerLines.length,
        },
        stories: counts,
      },
    };
  };

  const parts = partsOf(
    lines,
    Math.max(1, Math.floor((deps.contextTokens ?? DEFAULT_CONTEXT_TOKENS) * 0.9)),
  );
  if (!deps.chat) return result([], 'no_model');

  // the import's signal and its deadline, as one: a cancel is the person's, a deadline is ours
  const stop = new AbortController();
  let outOfTime = false;
  const timer = setTimeout(() => {
    outOfTime = true;
    stop.abort();
  }, deps.deadlineMs ?? DEFAULT_STORY_DEADLINE_MS);
  timer.unref?.();
  const onCancel = () => stop.abort();
  deps.signal?.addEventListener('abort', onCancel, { once: true });
  const signal = stop.signal;

  // every model call counts against the import's budget (PRD 6.7)
  let fatal: StoriesPendingReason | null = null;
  const counted = (m: ChatModel): ChatModel => ({
    id: m.id,
    queued: m.queued,
    complete: async (system, user, o) => {
      if (fatal === 'auth') throw new ModelError('the AI refused the key', 'auth', false);
      if (counts.calls >= CALL_CAP) throw new BudgetSpent();
      counts.calls++;
      return m.complete(system, user, o);
    },
  });
  const writer = counted(deps.chat);
  const judge = counted(deps.judge ?? deps.chat);
  /** what a failure means for the import; a cancel is thrown on */
  const reasonOf = (e: unknown): StoriesPendingReason => {
    if (deps.signal?.aborted) throw new IngestCancelled();
    if (e instanceof BudgetSpent) return 'budget';
    if (outOfTime) return 'deadline';
    const kind = asModelError(e).kind;
    if (kind === 'auth') return (fatal = 'auth');
    if (kind === 'bad_output' || kind === 'truncated') return 'bad_plan';
    return 'unavailable';
  };

  try {
    // 2. who and what is in the interview, before any story is planned (entity design 3). If
    // this fails the stories are written as before, without links, and the list waits.
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
    cast = castOf(found);

    // 3. plan, part by part; a story may carry on from an earlier part
    const stories: PlannedStory[] = [];
    let interviewName: string | null = str(deps.interviewName);
    for (const part of parts) {
      let plan;
      try {
        ({ plan } = await planPart(writer, {
          lines: part,
          subject,
          carried: stories,
          lookup: deps.lookup,
          maxToolCalls: PLAN_TOOL_CALLS,
          signal,
          profile,
          cast: cast.forPlanner,
        }));
      } catch (e) {
        const why = reasonOf(e);
        if (stories.length === 0 || why === 'auth') return result([], why);
        break; // keep what earlier parts planned
      }
      interviewName ??= plan.interviewName;
      for (const s of plan.stories) {
        const carried = s.continues ? stories.find((c) => c.title === s.continues) : undefined;
        if (carried) carried.ranges.push(...s.ranges);
        else stories.push(s);
      }
    }
    counts.planned = stories.length;
    const name = interviewName ?? (str(opts.source) || 'an interview');
    let done = 0;
    deps.onProgress?.({ done, total: stories.length });

    // 4–7. write, judge, fix and link each story, a few at a time
    const failures: StoriesPendingReason[] = [];
    const made = await mapPool(stories, AT_ONCE, async (story) => {
      try {
        const m = await makeStory(story);
        return m;
      } catch (e) {
        failures.push(reasonOf(e));
        return null;
      } finally {
        deps.onProgress?.({ done: ++done, total: stories.length });
      }
    });
    const written = made.filter((m): m is Made => m !== null);
    const memories = written.map((m) => m.memory);
    counts.written = memories.length;
    if (memories.length === 0 && stories.length > 0 && failures.length > 0) {
      return result([], failures.includes('auth') ? 'auth' : failures[0]!, interviewName);
    }
    memories.forEach((m, i) => (m.id = `m${i + 1}`));
    const out = result(memories, undefined, interviewName);
    if (deps.graph) {
      out.graph = found
        ? withStories(found, written)
        : { entities: [], relationships: [], pending: { reason: foundPending ?? 'unavailable' } };
    }
    return out;

    /** the find step for each part of the interview, as one list */
    async function findAll(graph: NonNullable<StoriesDeps['graph']>): Promise<FindResult> {
      const each: FindResult[] = [];
      for (const part of parts) {
        each.push(
          await findEntities({
            chat: writer,
            judge,
            lines: [...asLine, ...part],
            profile,
            known: graph.known,
            names: known,
            lookup: graph.lookup,
            signal,
          }),
        );
      }
      return mergeFound(each);
    }

    /** one story through write → check → judge → fix, and its names marked */
    async function makeStory(story: PlannedStory): Promise<Made | null> {
      let feedback: { draft: StoryDraft; problems: Problem[] } | null = null;
      let draft!: StoryDraft;
      let problems: Problem[] = [];
      let rulings: Ruling[] = [];
      // an age found in one draft stays with the story when it is written again
      let foundAge: StoryDraft['age'];
      for (let round = 0; round <= FIX_ROUNDS; round++) {
        rounds = Math.max(rounds, round + 1);
        if (round > 0) retried++;
        draft = (
          await writeStory(writer, {
            story,
            lines,
            subject,
            feedback,
            lookup: deps.lookup,
            maxToolCalls: WRITE_TOOL_CALLS,
            signal,
            profile,
            cast: cast.forWriter,
          })
        ).draft;
        problems = checkDraft(draft, withProfile, known, story.ranges);
        // a date the lines do not give is simply dropped: not worth writing the story again. A
        // year the writer worked out from an age said in them is kept, as that age (below).
        if (problems.some((p) => p.kind === 'date')) {
          draft.age ??= ageBehind(draft, story.tellers);
          for (const p of problems)
            if (p.kind === 'date') counts.problems.date = (counts.problems.date ?? 0) + 1;
          draft.occurred = null;
          draft.until = null;
          problems = problems.filter((p) => p.kind !== 'date');
        }
        foundAge = draft.age ?? foundAge;
        rulings = [];
        if (problems.length === 0) {
          rulings = (await judgeStory(judge, draft, withProfile, signal, profile)).rulings;
          problems = failing(rulings);
        }
        for (const p of problems) counts.problems[p.kind] = (counts.problems[p.kind] ?? 0) + 1;
        if (problems.length === 0) {
          if (round === 0) counts.firstPass++;
          break;
        }
        feedback = { draft, problems };
      }

      // what still fails is left out, and the reviewer is told
      const notes: string[] = [];
      if (problems.length > 0) {
        if (problems.some((p) => p.kind === 'title')) {
          draft.title = acceptTitle(story.title) ?? 'A story from the interview';
        }
        const out = new Set(problems.filter((p) => p.sentence >= 0).map((p) => p.sentence));
        const judged = rulings.length > 0;
        const kept = draft.sentences.filter((_, i) => !out.has(i));
        for (const i of out) notes.push(leftOut(draft.sentences[i]!.text));
        draft = { ...draft, sentences: kept };
        counts.removed += out.size;
        if (!judged && kept.length > 0) {
          // the code checks stopped the last draft before the judge saw it: judge what is left
          rulings = (await judgeStory(judge, draft, withProfile, signal, profile)).rulings;
          const fail = new Set(failing(rulings).map((p) => p.sentence));
          for (const i of fail) notes.push(leftOut(draft.sentences[i]!.text));
          counts.removed += fail.size;
          rulings = rulings.filter((r) => !fail.has(r.sentence));
          const rest = draft.sentences.filter((_, i) => !fail.has(i));
          rulings = rulings.map((r) => ({
            ...r,
            sentence: rest.indexOf(draft.sentences[r.sentence]!),
          }));
          draft = { ...draft, sentences: rest };
        }
      }
      if (draft.sentences.length < MIN_SENTENCES) {
        counts.dropped++;
        return null;
      }
      const flags = rulings
        .filter((r) => r.verdict === 'less_certain_in_source' && draft.sentences[r.sentence])
        .map((r) => draft.sentences[r.sentence]!.text);
      counts.flagged += flags.length;
      counts.sentences += draft.sentences.length;
      for (const f of flags)
        notes.push(`${subject} may have been less sure than this says: “${f}”`);
      // an age said in the story's lines becomes a year, in code (PRD 7.5)
      draft.age ??= foundAge;
      let dateBasis: string | undefined;
      if (!draft.occurred && draft.age) {
        const who = profileOf(story.tellers);
        const year = who ? ageYear(who.born, draft.age.years) : null;
        const cites = draft.age.cites.filter((r) => r.from >= 1);
        if (
          who &&
          year &&
          cites.length &&
          agesSaid(textOf(lines, cites)).includes(draft.age.years)
        ) {
          draft.occurred = year;
          dateBasis = `${who.name} was ${draft.age.years}; born ${saidDate(who.born!)}`;
        }
      }
      const marks = marksOf(draft.sentences);
      return {
        memory: assemble(story, draft, marks, flags, notes, name, dateBasis),
        story,
        sentences: draft.sentences,
        marks,
      };
    }
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onCancel);
  }

  /**
   * The names each sentence uses (entity design 6.2, 6.3): the writer's marks that hold, and the
   * name or alias of an entity it did not mark, found in the first sentence holding it. A mark
   * that does not hold is dropped and counted; one of the person the project is about is only
   * dropped, as they are never linked.
   */
  function marksOf(sentences: readonly Sentence[]): Mark[][] {
    if (cast.listed.length === 0) return sentences.map(() => []);
    const marks = sentences.map((s) =>
      (s.names ?? []).flatMap((m): Mark[] => {
        if (cast.byRef.get(m.e)?.subject) return [];
        const words = checkMark(s.text, m, cast.byRef);
        if (words !== null) return [{ e: m.e, words }];
        counts.problems.mark = (counts.problems.mark ?? 0) + 1;
        return [];
      }),
    );
    const marked = new Set(marks.flat().map((m) => m.e));
    const texts = sentences.map((s) => s.text);
    for (const u of unmarked(texts, cast.listed, marked)) marks[u.sentence]!.push(u.mark);
    return marks;
  }

  /**
   * The age behind a year the writer worked out itself ("~1964" from "at eighteen", born ~1946):
   * only when born + an age said in the story's lines gives that very year.
   */
  function ageBehind(d: StoryDraft, tellers: readonly string[]): StoryDraft['age'] {
    const born = Number(/\d{4}/.exec(profileOf(tellers)?.born ?? '')?.[0]);
    const year = Number(/\d{4}/.exec(d.occurred ?? '')?.[0]);
    if (!born || !year) return undefined;
    const cites = d.sentences.flatMap((s) => s.cites).filter((r) => r.from >= 1);
    return agesSaid(textOf(lines, cites)).includes(year - born)
      ? { years: year - born, cites }
      : undefined;
  }

  /** the teller's profile: by name or by a name the family uses; the only one when there is one */
  function profileOf(tellers: readonly string[]): Profile | undefined {
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    return (
      profiles.find((p) =>
        tellers.some((t) => same(t, p.name) || p.aliases.some((a) => same(t, a))),
      ) ?? (profiles.length === 1 ? profiles[0] : undefined)
    );
  }

  function failing(rulings: Ruling[]): Problem[] {
    return rulings
      .filter((r) => FAILING.includes(r.verdict))
      .map((r) => ({
        sentence: r.sentence,
        kind: r.verdict as Problem['kind'],
        detail: r.reason || r.verdict.replace(/_/g, ' '),
      }));
  }

  function leftOut(sentence: string): string {
    return `Left out, because the interview does not say this: “${sentence}”`;
  }

  /** the story as a memory to review: body, source line, citations and metadata (PRD 7.3) */
  function assemble(
    story: PlannedStory,
    draft: StoryDraft,
    marks: ReadonlyArray<ReadonlyArray<Mark>>,
    flags: string[],
    notes: string[],
    interviewName: string,
    dateBasis?: string,
  ): ProposedMemory {
    // the first time the story names each one is a link to its note, by its name until saved
    const linked = linkSentences(
      draft.sentences.map((s) => s.text),
      marks,
      (ref) => cast.byRef.get(ref)!.name,
    );
    const paragraphs: string[][] = [];
    draft.sentences.forEach((s, i) => {
      if (s.paragraph || paragraphs.length === 0) paragraphs.push([linked[i]!]);
      else paragraphs[paragraphs.length - 1]!.push(linked[i]!);
    });
    // other notes the story names (another story's title): never one of those found, which the
    // marks link once
    const others = titles().filter((t) => !cast.taken.has(matchKey(t)));
    // transcript lines only: the profile (line 0) has no time and no turn
    const cited: Line[] = lines.filter((l) =>
      draft.sentences.some((s) => s.cites.some((r) => l.n >= r.from && l.n <= r.to)),
    );
    const starts = cited.map((l) => l.start).filter((n): n is number => n !== null);
    const ends = cited.map((l) => l.end ?? l.start).filter((n): n is number => n !== null);
    const start = starts.length ? Math.min(...starts) : null;
    const end = ends.length ? Math.max(...ends) : null;
    const span =
      start === null
        ? ''
        : end === null || clock(end) === clock(start)
          ? `, ${clock(start)}`
          : `, ${clock(start)}–${clock(end)}`;
    const body = [
      ...paragraphs.map((p) => linkKnownTitles(p.join(' '), others).body),
      `> Told by ${story.tellers.join(' and ')}, “${interviewName}”${span}`,
    ].join('\n\n');
    const firstTeller = cited.find((l) => l.teller) ?? cited[0]!;
    const sources: StorySource[] = draft.sentences.map((s) => {
      const within = withProfile.filter((l) => s.cites.some((r) => l.n >= r.from && l.n <= r.to));
      return {
        sentence: s.text,
        from: Math.min(...s.cites.map((r) => r.from)),
        to: Math.max(...s.cites.map((r) => r.to)),
        start: within.find((l) => l.start !== null)?.start ?? null,
        end: [...within].reverse().find((l) => l.end !== null)?.end ?? null,
        text: textOf(withProfile, s.cites).slice(0, SOURCE_CHARS),
      };
    });
    const turnIndex = (l: Line) => turns[l.n - 1]!.index;
    return {
      title: draft.title,
      type: 'event',
      occurred: draft.occurred,
      until: draft.until,
      body,
      notes,
      turns: cited.map(turnIndex),
      startSec: start,
      endSec: end,
      method: 'story',
      speaker: firstTeller.speaker,
      speakerName: firstTeller.name,
      anchor: anchors.get(turnIndex(firstTeller)) ?? '',
      tellers: story.tellers,
      sources,
      flags,
      ...(dateBasis ? { dateBasis } : {}),
      writtenBy: {
        workflow: WORKFLOW_VERSION,
        writer: deps.chat!.id,
        judge: (deps.judge ?? deps.chat)!.id,
      },
    };
  }

  function titles(): string[] {
    return Array.isArray(deps.titles) ? deps.titles.filter((t) => typeof t === 'string') : [];
  }
}
