import { parseFuzzyDate } from '@funmem/core';
import { acceptTitle } from '../ingest-lang';
import type { ChatModel } from '../nim';
import type { Problem } from './check';
import { parseCite, renderLines, type Line, type Range } from './lines';
import type { PlannedStory } from './plan';
import { runWithTools, writeTools, type StoryLookup } from './tools';

/**
 * Step 3 of the story workflow (PRD 6.3): write one story, about the narrator, in the third
 * person. Wording is free (D11); every sentence names the lines it comes from, so the checks
 * in step 4 can read them back. With feedback, the story is written again knowing what failed.
 */
export interface Sentence {
  text: string;
  cites: Range[];
  /** starts a new paragraph */
  paragraph: boolean;
}

export interface StoryDraft {
  title: string;
  /** when it happened, as a fuzzy date ("1946", "~1946", "1966-06"), or null */
  occurred: string | null;
  /** when it ended, for a story that spans years */
  until: string | null;
  sentences: Sentence[];
}

export interface Feedback {
  draft: StoryDraft;
  problems: Problem[];
}

export const WRITE_SYSTEM = `You write one story for a family archive, from an interview.

How it reads:
- In the third person, past tense, about the narrator, like a short biography: "Sunja was born in
  Busan, probably in the spring of 1946, in a little house near the harbour."
- Call the narrator by the name given. Other people by what was said ("her father", "Mrs. Han").
- Wording is free: tidy, condense, reorder, summarize, and join it into flowing paragraphs. Leave
  out fillers, false starts, repetition and minor asides.
- Nothing may be made up: no event, person, place, number, date or detail that the lines do not
  tell. Do not explain causes or feelings the narrator did not give.
- Keep doubt where it matters: "I think it was 1946" becomes "probably in 1946".
- If several people tell it, say who remembers what. If they disagree, tell both accounts.
- A short quotation of a memorable phrase is welcome, in quotation marks, word for word as said.
- Tell ONLY this story, from its own lines. The rest of the interview is there to help you
  understand (who "he" is); it is told in other stories, so do not repeat it here.
- Paragraphs: start a new one for each part of the story, about every 3 to 5 sentences.
- Title: in the third person like the story (never "my" or "I"), 2 to 6 words from the story's heart, naming its most memorable image, object or moment,
  using only what the story says. Good: "Gravy at the church supper", "Mrs. Han's pencil box",
  "The tin of savings", "Sundays at the pier". Bad: a summary ("Met Minho at a church supper when
  he spilled gravy") or a label ("Childhood").
- Date: "occurred" is when it happened, as "1946", "1966-06" or "~1946" (when unsure), ONLY if a
  year is said in this story's lines; never work one out ("at eighteen" is not a year). Otherwise
  null. "until" is when it ended, for a story spanning years, else null.

Every sentence lists the lines it comes from in "cites" (like ["L3", "L7-L9"]). A summarizing
sentence may cite a wider range. Set "paragraph": true on a sentence that starts a new paragraph.

Result: {"title": "...", "occurred": "1946" | null, "until": null, "sentences": [{"text": "...", "cites": ["L3"], "paragraph": true}]}`;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const fuzzy = (v: unknown): string | null =>
  typeof v === 'string' && parseFuzzyDate(v.trim()) ? v.trim() : null;

export function parseDraft(v: unknown): StoryDraft | string {
  if (!isObj(v) || !Array.isArray(v.sentences)) {
    return 'give {"title": ..., "occurred": ..., "until": ..., "sentences": [...]}';
  }
  const sentences: Sentence[] = [];
  for (const s of v.sentences) {
    if (!isObj(s) || typeof s.text !== 'string' || s.text.trim() === '') continue;
    const cites = (Array.isArray(s.cites) ? s.cites : [s.cites])
      .map((c) => parseCite(c))
      .filter((r): r is Range => r !== null);
    sentences.push({
      text: s.text.replace(/\s+/g, ' ').trim(),
      cites,
      paragraph: sentences.length === 0 || s.paragraph === true,
    });
  }
  if (sentences.length === 0) return 'the story has no sentences: write it, sentence by sentence';
  return {
    title: typeof v.title === 'string' ? v.title.trim() : '',
    occurred: fuzzy(v.occurred),
    until: fuzzy(v.until),
    sentences,
  };
}

/** a draft as the model sees it again: numbered sentences with their lines */
export function showDraft(d: StoryDraft): string {
  const cite = (rs: Range[]) =>
    rs.map((r) => (r.from === r.to ? `L${r.from}` : `L${r.from}-L${r.to}`)).join(', ');
  return [
    `Title: ${d.title}`,
    `Occurred: ${d.occurred ?? 'none'}${d.until ? ` until ${d.until}` : ''}`,
    ...d.sentences.map((s, i) => `${i}. ${s.text} [${cite(s.cites)}]`),
  ].join('\n');
}

export async function writeStory(
  chat: ChatModel,
  o: {
    story: PlannedStory;
    lines: readonly Line[];
    subject: string;
    feedback: Feedback | null;
    lookup: StoryLookup;
    maxToolCalls: number;
    signal?: AbortSignal;
  },
): Promise<{ draft: StoryDraft; calls: number }> {
  const own = o.lines.filter((l) => o.story.ranges.some((r) => l.n >= r.from && l.n <= r.to));
  const task = [
    `The narrator: ${o.subject}. Told by: ${o.story.tellers.join(', ')}.`,
    `Working title: ${o.story.title}`,
    `The story's lines:\n${renderLines(own)}`,
    // only the story's own lines: shown the whole interview, the writer borrows from other
    // stories (a wedding date in the story of the savings tin), and the checks then cut it
    'If you need to understand something (who "he" is), read nearby lines with read_lines; tell nothing from them.',
    o.feedback
      ? `Your previous draft:\n${showDraft(o.feedback.draft)}\n\nProblems found (fix them; write the whole story again):\n${o.feedback.problems
          .map((p) =>
            p.sentence >= 0
              ? `- sentence ${p.sentence} (${p.kind}): ${p.detail}`
              : `- ${p.kind}: ${p.detail}`,
          )
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const out = await runWithTools(chat, {
    system: WRITE_SYSTEM,
    task,
    tools: writeTools(o.lookup, o.lines),
    maxToolCalls: o.maxToolCalls,
    parse: (v) => parseDraft(v),
    signal: o.signal,
  });
  const draft = out.value;
  if (!acceptTitle(draft.title)) draft.title = o.story.title;
  return { draft, calls: out.calls };
}
