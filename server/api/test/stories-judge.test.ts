import { describe, expect, it } from 'vitest';
import type { ChatModel } from '../src/nim';
import { FAILING, judgeStory } from '../src/stories/judge';
import { linesOf } from '../src/stories/lines';
import type { StoryDraft } from '../src/stories/write';

/** The AI judge: one question per sentence, is anything in it made up? */
const lines = linesOf(
  [
    { index: 0, speaker: 'S', start: null, end: null, text: 'My father repaired boats.' },
    { index: 1, speaker: 'S', start: null, end: null, text: 'I think it was nineteen forty-six.' },
  ],
  ['S'],
  [['S', 'Sunja']],
);
const draft: StoryDraft = {
  title: 'The boat yard',
  occurred: null,
  until: null,
  sentences: [
    { text: 'Her father repaired boats.', cites: [{ from: 1, to: 1 }], paragraph: true },
    { text: 'He was the best in Busan.', cites: [{ from: 1, to: 1 }], paragraph: false },
    { text: 'It was 1946.', cites: [{ from: 2, to: 2 }], paragraph: false },
  ],
};
const judgeWith = (answers: string[], seen: string[] = []): ChatModel => ({
  id: 'judge',
  complete: async (system, user, opts) => {
    seen.push(system, user, String(opts?.temperature));
    return answers.shift() ?? '';
  },
});

describe('judgeStory', () => {
  it('rules on every sentence, against its cited lines, at temperature 0', async () => {
    const seen: string[] = [];
    const out = await judgeStory(
      judgeWith(
        [
          JSON.stringify({
            rulings: [
              { sentence: 0, verdict: 'supported', reason: '' },
              { sentence: 1, verdict: 'made_up', reason: 'nothing says best in Busan' },
              { sentence: 2, verdict: 'less_certain_in_source', reason: 'she said I think' },
            ],
          }),
        ],
        seen,
      ),
      draft,
      lines,
    );
    expect(out.rulings.map((r) => r.verdict)).toEqual([
      'supported',
      'made_up',
      'less_certain_in_source',
    ]);
    expect(out.calls).toBe(1);
    expect(seen[0]).toMatch(/paraphrase/i);
    expect(seen[1]).toContain('1. He was the best in Busan.');
    expect(seen[1]).toContain('Sunja: My father repaired boats.');
    expect(seen[2]).toBe('0');
    expect(FAILING).toEqual(['made_up', 'contradicts', 'misattributed']);
  });

  it('a sentence the judge skipped, or a verdict it garbled, does not fail the story', async () => {
    const out = await judgeStory(
      judgeWith([JSON.stringify({ rulings: [{ sentence: 1, verdict: 'probably fine' }] })]),
      draft,
      lines,
    );
    expect(out.rulings).toEqual([
      { sentence: 0, verdict: 'supported', reason: 'not judged' },
      { sentence: 1, verdict: 'supported', reason: 'unreadable verdict' },
      { sentence: 2, verdict: 'supported', reason: 'not judged' },
    ]);
  });

  it('gives up on a judge that never answers in JSON', async () => {
    await expect(judgeStory(judgeWith(['fine', 'fine']), draft, lines)).rejects.toMatchObject({
      kind: 'bad_output',
    });
  });
});
