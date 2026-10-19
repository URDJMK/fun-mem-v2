import { describe, expect, it } from 'vitest';
import { ingestTranscript, type IngestResult } from '../src/ingest-pipeline';

/**
 * `anchor`: which passage a memory is, the same from one preparation of an interview to the
 * next. The web page carries a person's edits by it when they re-prepare with a different
 * teller ("Use this choice"); turn numbers cannot do that, because an interviewer's "Mm-hm" is
 * folded into the answer it interrupted only once the teller is settled.
 */

/** the web review's example, exactly: B asks, A tells, B says "Mm-hm." once in the middle */
const WEB = {
  segments: [
    {
      start: 0,
      end: 9,
      speaker: 'B',
      text: 'Could you tell me a little about your father and what kind of work he did when you were young?',
    },
    {
      start: 10,
      end: 19,
      speaker: 'A',
      text: 'My father repaired boats and he had big hands and he did not talk much at all.',
    },
    { start: 20, end: 29, speaker: 'B', text: 'Mm-hm.' },
    {
      start: 30,
      end: 39,
      speaker: 'A',
      text: 'He took me to the harbour every morning before school and showed me the nets.',
    },
    {
      start: 40,
      end: 49,
      speaker: 'B',
      text: 'And what about your mother, what did she do all day while your father was at the harbour?',
    },
    {
      start: 50,
      end: 59,
      speaker: 'A',
      text: 'My mother sold fish at the market and she came home after sunset every single day.',
    },
    {
      start: 60,
      end: 69,
      speaker: 'B',
      text: 'Where did your family live in those years, and what was the house like inside?',
    },
    {
      start: 70,
      end: 79,
      speaker: 'A',
      text: 'We lived in a shack made of scrap boards and the wind came through the walls in winter.',
    },
  ],
};

const deps = { chat: null, titles: [] };
const holding = (r: IngestResult, words: string) => {
  const m = r.memories.find((x) => x.body.includes(words));
  expect(m, words).toBeDefined();
  return m!;
};

describe('a passage keeps its anchor across preparations', () => {
  it("the web review's example: guessed and chosen teller give the same anchors though the turn numbers differ", async () => {
    const guessed = await ingestTranscript(WEB, {}, deps);
    const chosen = await ingestTranscript(WEB, { interviewees: ['A'] }, deps);
    expect(guessed.interviewees).toEqual(['A']);
    const passages = [
      ['My father repaired boats', 'my father repaired boats and he had big'],
      ['My mother sold fish', 'my mother sold fish at the market and'],
      ['We lived in a shack', 'we lived in a shack made of scrap'],
    ] as const;
    for (const [words, anchor] of passages) {
      expect(holding(guessed, words).anchor).toBe(anchor);
      expect(holding(chosen, words).anchor).toBe(anchor);
    }
    // the turn numbers DO move: that is why the anchor exists
    const turnsOf = (r: IngestResult) => passages.map(([w]) => holding(r, w).turns.join(','));
    expect(turnsOf(guessed)).not.toEqual(turnsOf(chosen));
  });

  it('a first turn shorter than eight words is anchored by its own words, joined to the next turn or not', async () => {
    const t = {
      segments: [
        {
          start: 0,
          end: 5,
          speaker: 'B',
          text: 'Did you know your grandfather at all when you were small?',
        },
        { start: 6, end: 9, speaker: 'A', text: 'Yes, I remember him.' },
        { start: 10, end: 11, speaker: 'B', text: 'Mm-hm.' },
        {
          start: 12,
          end: 20,
          speaker: 'A',
          text: 'He repaired boats every day of his life and he whistled while he worked.',
        },
      ],
    };
    const a = await ingestTranscript(t, {}, deps);
    const b = await ingestTranscript(t, { interviewees: ['A'] }, deps);
    expect(holding(a, 'Yes, I remember him.').anchor).toBe('yes i remember him');
    expect(holding(b, 'Yes, I remember him.').anchor).toBe('yes i remember him');
  });

  it('every memory has one, Short answers notes too, and it is plain words', async () => {
    const r = await ingestTranscript(
      'Interviewer: Did he ever hit you?\nGrandma: No.\nInterviewer: Tell me about the house.\nGrandma: We lived in a shack made of scrap boards, by the [[Harbour|harbour]].',
      { interviewees: ['Grandma'] },
      deps,
    );
    expect(r.memories.map((m) => m.anchor)).toEqual(['we lived in a shack made of scrap', 'no']);
    for (const m of r.memories) expect(m.anchor).toMatch(/^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+){0,7}$/u);
  });
});
