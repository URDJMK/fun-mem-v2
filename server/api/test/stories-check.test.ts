import { describe, expect, it } from 'vitest';
import { checkDraft } from '../src/stories/check';
import { linesOf } from '../src/stories/lines';
import type { StoryDraft } from '../src/stories/write';

/**
 * The code checks (PRD 6.4): cheap and certain. Wording is free; what they catch is a name,
 * number, date, place or quotation that the cited lines do not hold.
 */
const say = (speaker: string, text: string) => ({
  index: 0,
  speaker,
  start: null,
  end: null,
  text,
});
const lines = linesOf(
  [
    say('Q', 'Where were you born?'),
    say('S', 'Um, I was born in Busan, near the harbour, I think it was nineteen forty-six.'),
    say('Q', 'And at home?'),
    say(
      'S',
      'We kept about forty hens. I only finished fifth grade. My teacher, Mrs. Han, gave me a pencil box. That was the whole conversation for the evening.',
    ),
  ],
  ['S'],
  [['S', 'Sunja']],
);
const draft = (
  sentences: Array<[string, string[]]>,
  more: Partial<StoryDraft> = {},
): StoryDraft => ({
  title: 'The early years',
  occurred: null,
  until: null,
  sentences: sentences.map(([text, cites], i) => ({
    text,
    cites: cites.map((c) => {
      const [a, b] = c.replace(/L/g, '').split('-').map(Number);
      return { from: a!, to: b ?? a! };
    }),
    paragraph: i === 0,
  })),
  ...more,
});
const kinds = (d: StoryDraft, known: string[] = ['Sunja']) =>
  checkDraft(d, lines, known).map((p) => `${p.sentence}:${p.kind}`);

describe('checkDraft', () => {
  it('passes a story told in other words that adds nothing', () => {
    expect(
      kinds(
        draft(
          [
            ['Sunja was born in Busan near the harbour, probably in 1946.', ['L2']],
            ['The family kept some 40 hens, and she left school after 5th grade.', ['L4']],
            ['Her teacher, Mrs. Han, gave her a pencil box.', ['L4']],
          ],
          { occurred: '~1946' },
        ),
      ),
    ).toEqual([]);
  });

  it('a sentence must say where it comes from, in lines that exist', () => {
    expect(kinds(draft([['Sunja was born in Busan.', []]]))).toEqual(['0:no_citation']);
    expect(kinds(draft([['Sunja was born in Busan.', ['L2-L9']]]))).toEqual(['0:bad_citation']);
  });

  it('a number must be in the cited lines, however it was said', () => {
    expect(kinds(draft([['They kept forty hens.', ['L4']]]))).toEqual([]);
    expect(kinds(draft([['They kept 50 hens.', ['L4']]]))).toEqual(['0:not_in_source']);
    // said in another line than the one cited
    expect(kinds(draft([['She was born in 1946.', ['L4']]]))).toEqual(['0:not_in_source']);
  });

  it('a name or place must be in the cited lines, or be the narrator', () => {
    expect(kinds(draft([['Later Sunja lived near the harbour in Busan.', ['L2']]]))).toEqual([]);
    expect(kinds(draft([['She was born in Seoul.', ['L2']]]))).toEqual(['0:not_in_source']);
    // a capitalized word that is no name: a month, a relative, a sentence start
    expect(kinds(draft([['In those years Mother kept hens.', ['L4']]]))).toEqual([]);
  });

  it('a quotation must be word for word', () => {
    expect(
      kinds(draft([['That was, she said, “the whole conversation for the evening.”', ['L4']]])),
    ).toEqual([]);
    expect(kinds(draft([['She called it “the only talk all day.”', ['L4']]]))).toEqual(['0:quote']);
  });

  it('the story’s date must be told somewhere in its lines', () => {
    expect(kinds(draft([['Sunja was born in Busan.', ['L2']]], { occurred: '~1946' }))).toEqual([]);
    expect(kinds(draft([['Sunja was born in Busan.', ['L2']]], { occurred: '1952' }))).toEqual([
      '-1:date',
    ]);
    expect(kinds(draft([['Sunja was born in Busan.', ['L2']]], { until: '1960' }))).toEqual([
      '-1:date',
    ]);
  });

  it('the title may not add a name or a number the story does not hold', () => {
    expect(kinds(draft([['She was born in Busan.', ['L2']]], { title: 'Born in Busan' }))).toEqual(
      [],
    );
    expect(
      kinds(draft([['She was born in Busan.', ['L2']]], { title: 'Born in Seoul in 1950' })),
    ).toEqual(['-1:title']);
  });

  it('finds a year said near a word about money', () => {
    const wed = linesOf(
      [
        say(
          'S',
          'We married in June of nineteen sixty-seven, in a small ceremony, because we did not have money for anything bigger.',
        ),
      ],
      ['S'],
      [['S', 'Sunja']],
    );
    expect(
      checkDraft(
        {
          title: 'A small wedding',
          occurred: '1967-06',
          until: null,
          sentences: [
            { text: 'They married in June 1967.', cites: [{ from: 1, to: 1 }], paragraph: true },
          ],
        },
        wed,
        ['Sunja'],
      ),
    ).toEqual([]);
  });

  it('a story tells only its own lines (and the questions just before them)', () => {
    const d = draft([
      ['Her teacher, Mrs. Han, gave her a pencil box.', ['L4']],
      ['Sunja was born in Busan.', ['L2']],
    ]);
    expect(
      checkDraft(d, lines, ['Sunja'], [{ from: 4, to: 4 }]).map((p) => `${p.sentence}:${p.kind}`),
    ).toEqual(['1:outside_story']);
    // the line just before is part of it only when it is a question, not another answer
    expect(
      checkDraft(
        draft([['Sunja was born in Busan.', ['L2']]]),
        lines,
        ['Sunja'],
        [{ from: 3, to: 4 }],
      ).map((p) => p.kind),
    ).toEqual(['outside_story']);
    // the question just before the story's lines is part of it
    expect(
      checkDraft(
        draft([['Her teacher gave her a pencil box.', ['L3-L4']]]),
        lines,
        ['Sunja'],
        [{ from: 4, to: 4 }],
      ),
    ).toEqual([]);
  });

  it('a title is a few words from the story’s heart, not a summary', () => {
    expect(
      kinds(
        draft([['Her teacher, Mrs. Han, gave her a pencil box.', ['L4']]], {
          title: 'Teacher Mrs. Han gave her a pencil box as a prize for handwriting',
        }),
      ),
    ).toEqual(['-1:title']);
  });

  it('a title is about the narrator, not in her voice', () => {
    expect(
      kinds(
        draft([['Her teacher, Mrs. Han, gave her a pencil box.', ['L4']]], {
          title: 'My pencil box',
        }),
      ),
    ).toEqual(['-1:title']);
  });
});
