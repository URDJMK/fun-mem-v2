import type { ChatModel } from '../nim';
import { textOf, type Line } from './lines';
import { runWithTools } from './tools';
import type { StoryDraft } from './write';

/**
 * Step 4, second half (PRD 6.4): the AI judge. A separate call, no tools, temperature 0, asked
 * one question per sentence: is anything in it made up? Wording is not its business (D11). The
 * code checks (check.ts) have already ruled on names, numbers, dates and quotations.
 */
export type Verdict =
  'supported' | 'made_up' | 'contradicts' | 'misattributed' | 'less_certain_in_source';

export interface Ruling {
  sentence: number;
  verdict: Verdict;
  reason: string;
}

/** the verdicts that fail a sentence; `less_certain_in_source` is only shown to the reviewer */
export const FAILING: readonly Verdict[] = ['made_up', 'contradicts', 'misattributed'];

const VERDICTS: readonly Verdict[] = ['supported', ...FAILING, 'less_certain_in_source'];

export const JUDGE_SYSTEM = `You check a story written for a family archive against the interview lines each sentence cites.

Wording is free: paraphrase, condensing, reordering and summary are all fine. Judge ONLY whether
anything is made up. For each sentence give one verdict:
- "supported": the cited lines tell this, in any wording.
- "made_up": it adds an event, action, detail or claim the cited lines do not tell.
- "contradicts": it says the opposite of the cited lines.
- "misattributed": the cited lines tell it, but someone else said it than the sentence claims.
- "less_certain_in_source": the speaker was unsure ("I think", "maybe") and the sentence is not.
Give a short reason for anything but "supported".

Result: {"rulings": [{"sentence": 0, "verdict": "supported", "reason": ""}]}`;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export async function judgeStory(
  chat: ChatModel,
  d: StoryDraft,
  lines: readonly Line[],
  signal?: AbortSignal,
): Promise<{ rulings: Ruling[]; calls: number }> {
  const task = d.sentences
    .map(
      (s, i) =>
        `${i}. ${s.text}\n   Cited lines:\n   ${textOf(lines, s.cites).replace(/\n/g, '\n   ')}`,
    )
    .join('\n\n');
  const out = await runWithTools(chat, {
    system: JUDGE_SYSTEM,
    task: `The story "${d.title}", sentence by sentence:\n\n${task}`,
    tools: [],
    maxToolCalls: 0,
    maxCalls: 2,
    temperature: 0,
    signal,
    parse: (v) => {
      if (!isObj(v) || !Array.isArray(v.rulings)) return 'give {"rulings": [...]}';
      const given = new Map<number, Ruling>();
      for (const r of v.rulings) {
        if (!isObj(r) || !Number.isInteger(r.sentence)) continue;
        const i = r.sentence as number;
        if (i < 0 || i >= d.sentences.length || given.has(i)) continue;
        const verdict = VERDICTS.find((x) => x === r.verdict);
        given.set(
          i,
          verdict
            ? { sentence: i, verdict, reason: typeof r.reason === 'string' ? r.reason.trim() : '' }
            : // a garbled verdict cannot fail a story: the code checks have ruled already
              { sentence: i, verdict: 'supported', reason: 'unreadable verdict' },
        );
      }
      return d.sentences.map(
        (_, i) =>
          given.get(i) ?? { sentence: i, verdict: 'supported' as const, reason: 'not judged' },
      );
    },
  });
  return { rulings: out.value, calls: out.calls };
}
