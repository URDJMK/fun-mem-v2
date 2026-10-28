import { describe, expect, it } from 'vitest';
import {
  alignRecorded,
  applyCorrections,
  linesNearNotes,
  noteTerms,
  respell,
  resolveVoices,
  tellerVoices,
  unsettledVoices,
  type Setup,
} from '../src/lib/interview';
import type { Segment } from '../src/lib/live';
import { topicOrder } from '../src/lib/questions';

const setup: Setup = {
  about: '',
  topics: [],
  people: [
    { id: 'teller', name: 'Nell', role: 'teller' },
    { id: 'asker', name: 'Theo', role: 'asker' },
  ],
  voices: { S1: 'asker', S2: 'teller' },
};

let id = 0;
const seg = (speaker: string, start: number, end: number, text: string): Segment => ({
  id: ++id,
  speaker,
  start,
  end,
  text,
});

describe('resolveVoices', () => {
  it('gives a moment of a stray voice inside one person’s talk back to them', () => {
    const out = resolveVoices(
      [
        seg('S2', 0, 4, 'We lived above the bakery on Marsh Street'),
        seg('S3', 4.3, 5, 'and my mother'),
        seg('S2', 5.4, 9, 'baked the bread every morning before dawn.'),
      ],
      setup,
    );
    expect(out.map((s) => s.speaker)).toEqual(['S2', 'S2', 'S2']);
  });

  it('places a stray voice that answers the interviewer as the narrator', () => {
    const out = resolveVoices(
      [
        seg('S1', 0, 2, 'Tell me about your school.'),
        seg(
          'S3',
          3,
          12,
          'I went to a girls’ school in London, and every morning we walked there through the park together.',
        ),
        seg('S1', 13, 15, 'What did the library look like?'),
      ],
      setup,
    );
    expect(out[1]!.speaker).toBe('S2');
  });

  it('leaves the transcript alone when nobody was introduced', () => {
    const segs = [seg('S3', 0, 1, 'Hello there.')];
    expect(resolveVoices(segs, { ...setup, voices: {} })).toBe(segs);
  });
});

describe('alignRecorded', () => {
  it('names the full recording’s voices after the live voices they overlap', () => {
    const live = [seg('S1', 0, 2.4, 'Tell me about'), seg('S2', 3.8, 6.5, 'I went to THCL.')];
    const out = alignRecorded(
      [
        {
          source: null,
          segments: [
            { speaker: 0, start: 0, end: 2.5, text: 'Tell me about your school.' },
            { speaker: 1, start: 3.9, end: 6.4, text: 'I went to NLCS.' },
            { speaker: 2, start: 40, end: 41, text: 'Hm.' },
          ],
        },
      ],
      live,
    );
    expect(out.map((s) => [s.id, s.speaker, s.text])).toEqual([
      [1, 'S1', 'Tell me about your school.'],
      [2, 'S2', 'I went to NLCS.'],
      [3, 'R3', 'Hm.'],
    ]);
  });

  it('keeps a call’s two channels as they are, in time order', () => {
    const out = alignRecorded(
      [
        { source: 'mic', segments: [{ speaker: null, start: 0, end: 1, text: 'Hi Nell.' }] },
        { source: 'call', segments: [{ speaker: null, start: 0.5, end: 2, text: 'Hello.' }] },
      ],
      [],
    );
    expect(out.map((s) => s.speaker)).toEqual(['mic', 'call']);
  });
});

describe('notes', () => {
  it('listens for acronyms and names, not the capital that starts a note', () => {
    expect(
      noteTerms(['NLCS', 'Went to North London Collegiate', 'Moved to Seoul in 1998']),
    ).toEqual(['NLCS', 'North London Collegiate', 'Seoul']);
    expect(noteTerms(['Mrs Park'])).toEqual(['Mrs Park']);
    expect(noteTerms(['loved the library'])).toEqual([]);
  });

  it('sends only the lines said around each note', () => {
    const segs = [
      seg('S2', 10, 12, 'early'),
      seg('S2', 300, 302, 'near'),
      seg('S2', 900, 902, 'late'),
    ];
    expect(linesNearNotes([{ at: 330, text: 'NLCS' }], segs).map((l) => l.text)).toEqual(['near']);
  });

  it('makes an accepted correction in its own line only', () => {
    const segs = [seg('S2', 0, 1, 'I went to THCL.'), seg('S2', 1, 2, 'THCL again.')];
    const out = applyCorrections(segs, [{ id: segs[0]!.id, from: 'THCL', to: 'NLCS' }]);
    expect(out.map((s) => s.text)).toEqual(['I went to NLCS.', 'THCL again.']);
  });
});

describe('topicOrder', () => {
  it('puts the interviewer’s own topics first, and is a life story when nothing is named', () => {
    const own = topicOrder([], [{ label: 'NLCS', opener: 'Tell me about NLCS.' }]);
    expect(own.map((t) => t.label)).toEqual(['NLCS']);
    expect(topicOrder([]).length).toBeGreaterThan(5);
    expect(topicOrder(['family'], [{ label: 'NLCS', opener: 'x' }]).map((t) => t.id)).toEqual([
      'free:NLCS',
      'family',
    ]);
  });
});

describe('respell', () => {
  it('makes a mishearing right everywhere, as a whole word only', () => {
    const segs = [seg('S2', 0, 1, 'I went to THCL.'), seg('S2', 1, 2, 'THCLS and THCL again.')];
    expect(respell(segs, [{ from: 'THCL', to: 'NLCS' }]).map((s) => s.text)).toEqual([
      'I went to NLCS.',
      'THCLS and NLCS again.',
    ]);
    expect(respell(segs, [])).toBe(segs);
  });
});

describe('voices', () => {
  const heard = [
    seg('S1', 0, 2, 'Tell me about the house.'),
    seg('S3', 2, 6, 'It had a green door.'),
    seg('S2', 6, 9, 'And chickens in the yard.'),
  ];

  it('asks about every voice the introductions didn’t settle, in the order first heard', () => {
    expect(unsettledVoices('room', heard, setup.voices)).toEqual(['S3']);
    expect(unsettledVoices('room', heard, {})).toEqual(['S1', 'S3', 'S2']);
  });

  it('asks nothing on a call: the two channels already say who is who', () => {
    expect(
      unsettledVoices('call', [seg('mic', 0, 1, 'Hi.'), seg('call', 1, 2, 'Hello.')], {}),
    ).toEqual([]);
  });

  it('finds the person being remembered in every voice said to be theirs, and in none by default', () => {
    expect(tellerVoices('room', setup.people, {})).toEqual([]);
    expect(tellerVoices('room', setup.people, { ...setup.voices, S3: 'teller' })).toEqual([
      'S2',
      'S3',
    ]);
    expect(tellerVoices('call', setup.people, {})).toEqual(['call']);
  });
});
