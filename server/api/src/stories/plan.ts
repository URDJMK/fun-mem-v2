import { acceptTitle } from '../ingest-lang';
import type { ChatModel } from '../nim';
import { parseCite, renderLines, type Line, type Range } from './lines';
import { planTools, runWithTools, type StoryLookup } from './tools';

/**
 * Step 2 of the story workflow (PRD 6.2): read the whole interview (or one part of a long one)
 * and say which STORIES it tells, and which lines tell each. The AI may look in the project
 * first. Nothing is written here; the plan only decides what each story is made of.
 */
export interface PlannedStory {
  title: string;
  ranges: Range[];
  /** the names of the people telling it */
  tellers: string[];
  /** the title of a story from an earlier part that this one carries on, or null */
  continues: string | null;
}

export interface StoryPlan {
  interviewName: string | null;
  stories: PlannedStory[];
}

export const PLAN_SYSTEM = `You read interview transcripts for a family archive and find the STORIES in them.

A story is a whole episode or period of the narrator's life, told from start to finish: a childhood
in one place, a job, a journey, how two people met, a war, a move. It is not a single moment or a
single fact. Prefer FEWER, LARGER stories: everything about one period or place belongs together
(a childhood: birth, parents, home and brothers and sisters are ONE story; meeting a husband and
the wedding are ONE story). Do not make one story per question: first group the answers into the
periods of the narrator's life (childhood, school, work, marriage, a move…), then give each period
one story, unless it holds a long, separate episode of its own. A few minutes of interview usually
hold 2 to 5 stories; an hour 4 to 10.

Not stories: greetings, small talk, talk about the recording, and the interviewer's own remarks.
Leave those lines out.

For each story:
- "lines": the line ranges that tell it, like ["L3-L9", "L14"]. Include the narrator's lines and
  the questions that led to them. A story may use several ranges. A line belongs to ONE story only.
- "title": a working title from the story's heart: 2 to 6 words naming its most memorable image,
  object or moment, using only what was said. Good: "Gravy at the church supper", "Mrs. Han's
  pencil box", "The tin of savings", "Sundays at the pier". Bad (a summary): "Met Minho at a church
  supper when he spilled gravy".
- "tellers": the names of the people telling it, as the transcript shows them.
- "period": the period of the narrator's life it belongs to, in a few words ("childhood in Busan",
  "school", "the factory years", "marriage", "life in Daegu"). Stories with the same period are
  joined into one story, so use the same words for the same period.
- "continues": the exact title of a story from an earlier part that this one carries on, or null.

Also give "interviewName": a short name for the whole interview from its topics (for example
"Sunja on Busan and the move to Daegu"), never its first words.

Result: {"interviewName": "...", "stories": [{"title": "...", "period": "...", "lines": ["L3-L9"], "tellers": ["..."], "continues": null}]}`;

const FALLBACK_TITLE = 'A story from the interview';
/** below this many words from the narrator, an interview may hold no story at all */
const WORDS_FOR_A_STORY = 25;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const spread = (r: Range): number[] =>
  Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i);

/** line numbers → ranges of consecutive numbers */
function toRanges(ns: number[]): Range[] {
  const sorted = [...new Set(ns)].sort((a, b) => a - b);
  const out: Range[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last.to + 1) last.to = n;
    else out.push({ from: n, to: n });
  }
  return out;
}

/**
 * The model's plan, checked against the lines: ranges outside this part are dropped, a line
 * claimed twice stays with the first story, and a "story" left with none of the narrator's
 * lines is no story. Returns a sentence for the model when the plan cannot be used.
 */
export function parsePlan(
  v: unknown,
  lines: readonly Line[],
  carried: readonly string[],
): StoryPlan | string {
  if (!isObj(v) || !Array.isArray(v.stories)) {
    return 'give {"interviewName": ..., "stories": [...]}';
  }
  const byN = new Map(lines.map((l) => [l.n, l]));
  const claimed = new Set<number>();
  const stories: PlannedStory[] = [];
  const titles = new Set<string>();
  const periods = new Map<string, PlannedStory>();
  for (const raw of v.stories) {
    if (!isObj(raw) || !Array.isArray(raw.lines)) continue;
    const ns: number[] = [];
    for (const c of raw.lines) {
      const r = parseCite(c);
      if (!r) continue;
      for (let n = r.from; n <= r.to; n++) {
        if (byN.has(n) && !claimed.has(n)) ns.push(n);
      }
    }
    const own = ns.filter((n) => byN.get(n)!.teller);
    if (own.length === 0) continue;
    for (const n of ns) claimed.add(n);

    let title = acceptTitle(raw.title) ?? FALLBACK_TITLE;
    for (let k = 2; titles.has(title.toLowerCase()); k++) {
      title = `${acceptTitle(raw.title) ?? FALLBACK_TITLE} (${k})`;
    }
    titles.add(title.toLowerCase());

    const named = Array.isArray(raw.tellers)
      ? raw.tellers.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      : [];
    const tellers = named.length
      ? named.map((t) => t.trim())
      : [...new Set(own.map((n) => byN.get(n)!.name))];
    const continues =
      typeof raw.continues === 'string' && carried.includes(raw.continues) ? raw.continues : null;
    // one period of the narrator's life is one story: the model splits by question, but labels
    // periods reliably, so stories that share one are joined here
    const period = typeof raw.period === 'string' ? raw.period.trim().toLowerCase() : '';
    const same = period ? periods.get(period) : undefined;
    if (same) {
      same.ranges = toRanges([...same.ranges.flatMap(spread), ...ns]);
      same.tellers = [...new Set([...same.tellers, ...tellers])];
      same.continues ??= continues;
      continue;
    }
    const planned: PlannedStory = { title, ranges: toRanges(ns), tellers, continues };
    if (period) periods.set(period, planned);
    stories.push(planned);
  }

  const said = lines
    .filter((l) => l.teller)
    .reduce((n, l) => n + (l.text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0), 0);
  if (stories.length === 0 && said >= WORDS_FOR_A_STORY) {
    return 'there are no stories in your plan, but the narrator tells some: find them, each with the lines that tell it';
  }
  const name =
    typeof v.interviewName === 'string' && v.interviewName.trim()
      ? v.interviewName.trim().slice(0, 80)
      : null;
  return { interviewName: name, stories };
}

export async function planPart(
  chat: ChatModel,
  o: {
    lines: readonly Line[];
    /** who the interview is about, to tell the model whose stories these are */
    subject: string;
    /** stories from earlier parts of a long interview */
    carried: readonly PlannedStory[];
    lookup: StoryLookup;
    maxToolCalls: number;
    signal?: AbortSignal;
    /** "Who this is about" (stories/profile.ts), or '' */
    profile?: string;
    /** the people, places and things of the interview with their types, one per line, or '' */
    cast?: string;
  },
): Promise<{ plan: StoryPlan; calls: number }> {
  const carriedText = o.carried.length
    ? `Stories found in earlier parts of this interview (a story here may carry one on):\n${o.carried
        .map((s) => `- ${s.title}`)
        .join('\n')}`
    : '';
  const task = [
    o.profile ?? '',
    `The narrator: ${o.subject}.`,
    o.cast ? `Who is in it:\n${o.cast}` : '',
    carriedText,
    `The transcript:\n${renderLines(o.lines)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const out = await runWithTools(chat, {
    system: PLAN_SYSTEM,
    task,
    tools: planTools(o.lookup),
    maxToolCalls: o.maxToolCalls,
    parse: (v) =>
      parsePlan(
        v,
        o.lines,
        o.carried.map((s) => s.title),
      ),
    signal: o.signal,
  });
  return { plan: out.value, calls: out.calls };
}
