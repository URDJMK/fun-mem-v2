import { describe, expect, it } from 'vitest';
import {
  MAX_TURN_CHARS,
  MIN_TAIL_CHARS,
  QUESTIONS,
  VOICE,
  parseTranscript,
  stripAnnotations,
  stripSoundNotes,
} from '../src/transcript';

/** Cleaning removes what is not anyone's words, and nothing else: nothing lost, nothing invented. */

const seg = (speaker: string | undefined, i: number, text: string) => ({
  start: i * 5,
  end: i * 5 + 4.5,
  text,
  ...(speaker === undefined ? {} : { speaker }),
});
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
const warned = (t: ReturnType<typeof parseTranscript>) =>
  Object.fromEntries(t.warnings.map((w) => [w.code, w.count]));

describe('only KNOWN sound notes are removed', () => {
  it('bracketed words that are not sounds stay, word for word', () => {
    for (const s of [
      'He wrote it [sic] on the wall.',
      'We moved to [Busan] in 1950.',
      '[그 당시에는] 쌀이 귀했어요.',
      'My mother [Kim Sunja] sold fish.',
      'She said [to me] that we would leave.',
      'He was born in [1946].',
      'It was [unclear: maybe Tongyeong] where we lived.',
    ]) {
      expect(tidy(stripAnnotations(s))).toBe(s);
    }
  });

  it('sound notes go: recogniser tags, Rev notes with a time, all-capital tags, Korean notes, music, times in brackets', () => {
    expect(
      tidy(
        stripAnnotations(
          '[Music] hello (laughs) there [inaudible 00:01:23] friend [CROSSTALK] and [BLANK_AUDIO] (웃음) ♪ la la ♪ [00:12] end',
        ),
      ),
    ).toBe('hello there friend and end');
    expect(tidy(stripAnnotations('We sat. [Note: the tape was paused here] Then we ate.'))).toBe(
      'We sat. Then we ate.',
    );
  });

  it('a speaker label is never a sound note, whatever its case', () => {
    for (const s of ['[SPEAKER_00] hi', '[화자1] 안녕', '[INTERVIEWER] hi', '[Q] where?']) {
      expect(tidy(stripAnnotations(s))).toBe(s);
    }
  });

  it('notes are counted one by one, and the words around them are untouched', () => {
    expect(stripSoundNotes('[Music] a (laughs) b [inaudible] c').removed).toBe(3);
    const t = parseTranscript({
      segments: [seg('A', 0, 'We moved to [Busan]. [laughter] It was [sic] cold. (coughs)')],
    });
    expect(t.turns[0]!.text).toBe('We moved to [Busan]. It was [sic] cold.');
    expect(warned(t).annotations_removed).toBe(2);
  });
});

describe('emphasis is testimony; only a recogniser stuck in a loop is collapsed', () => {
  it('"I miss her." four times, and "No. No. No. No.", stay as they were said', () => {
    for (const text of [
      'I miss her. I miss her. I miss her. I miss her.',
      'No. No. No. No. It was not him.',
    ]) {
      const t = parseTranscript({ segments: [seg('A', 0, text)] });
      expect(t.turns[0]!.text).toBe(text);
      expect(warned(t).repeats_collapsed).toBeUndefined();
    }
    // the same, as four separate segments of one speaker
    const four = parseTranscript({ segments: [0, 1, 2, 3].map((i) => seg('A', i, 'I miss her.')) });
    expect(four.turns[0]!.text).toBe('I miss her. I miss her. I miss her. I miss her.');
  });

  it('a loop is collapsed: a longer sentence four times, a short one eight times, by the same speaker', () => {
    const long = parseTranscript({
      segments: [0, 1, 2, 3].map((i) => seg('A', i, 'Okay so we left then.')),
    });
    expect(long.turns[0]!.text).toBe('Okay so we left then.');
    expect(warned(long).repeats_collapsed).toBe(3);
    const short = parseTranscript({
      segments: [seg('A', 0, `We left. ${'Thank you. '.repeat(8)}Then it rained.`)],
    });
    expect(short.turns[0]!.text).toBe('We left. Thank you. Then it rained.');
  });

  it('the same words from two speakers in a row are never merged: the answer is kept', () => {
    const t = parseTranscript({
      segments: [
        seg('SPEAKER_01', 0, 'Where were you born?'),
        seg('SPEAKER_00', 1, 'Oh, it was a long time ago, I was very small, I hardly remember.'),
        seg('SPEAKER_01', 2, 'In Tongyeong?'),
        seg('SPEAKER_00', 3, 'In Tongyeong.'),
        seg('SPEAKER_01', 4, 'In Tongyeong.'),
        seg('SPEAKER_01', 5, 'And how old were you?'),
      ],
    });
    expect(t.turns.map((x) => [x.speaker, x.text])).toContainEqual(['SPEAKER_00', 'In Tongyeong.']);
    expect(warned(t).repeats_collapsed).toBeUndefined();
  });
});

describe('a turn is never made empty', () => {
  it('a turn that is only "Mm-hm." stays "Mm-hm." (it is often the answer "yes")', () => {
    const t = parseTranscript({
      segments: [
        seg('SPEAKER_01', 0, 'So you were born in Tongyeong?'),
        seg('SPEAKER_00', 1, 'Mm-hm.'),
        seg('SPEAKER_01', 2, 'And your father repaired boats there?'),
        seg('SPEAKER_00', 3, 'He did, every day, until the war came.'),
      ],
    });
    expect(t.turns.map((x) => [x.speaker, x.text])).toContainEqual(['SPEAKER_00', 'Mm-hm.']);
    expect(t.turns).toHaveLength(4);
  });

  it('a lone "um" between two fragments of one turn adds nothing to it', () => {
    const t = parseTranscript({
      segments: [
        seg('A', 0, 'We went to'),
        seg('A', 1, 'Um.'),
        seg('A', 2, 'the market every day.'),
      ],
    });
    expect(t.turns.map((x) => x.text)).toEqual(['We went to the market every day.']);
  });
});

describe('structure is never part of anybody’s words', () => {
  it('a quote mark, a heading, a code fence or a rule at the start of a line goes', () => {
    const t = parseTranscript({
      segments: [
        seg('A', 0, '> He was the kindest man in the whole town.'),
        seg('B', 1, 'And?'),
        seg(
          'A',
          2,
          '# 1 thing I remember is how he sang.\n``` he said that every day\n--- and then we left',
        ),
      ],
    });
    expect(t.turns.map((x) => x.text)).toEqual([
      'He was the kindest man in the whole town.',
      'And?',
      '1 thing I remember is how he sang. He said that every day and then we left',
    ]);
    expect(t.turns.map((x) => x.text).join('\n')).not.toMatch(/^[>#`-]/m);
  });

  it('an email reply (most lines quoted with ">") is read as the transcript it quotes', () => {
    const t = parseTranscript(
      '> Interviewer: Tell me about him.\n> Grandma: He was the kindest man in the whole town.\n> Interviewer: And then?\n> Grandma: He died in 1989, in March.',
    );
    expect(t.format).toBe('labelled-text');
    expect(t.turns.map((x) => x.speaker)).toEqual([
      'Interviewer',
      'Grandma',
      'Interviewer',
      'Grandma',
    ]);
    expect(t.turns[1]!.text).toBe('He was the kindest man in the whole town.');
  });
});

describe('control characters and odd ids', () => {
  it('NUL and other control characters are stripped from text, JSON strings and labels', () => {
    const text = parseTranscript(
      'Interviewer: Where?\u0000\nGran\u0001dma: In Bu\u0007san.\nInterviewer: And?\nGrandma: Yes.',
    );
    expect(text.turns.map((x) => x.speaker)).toEqual([
      'Interviewer',
      'Grandma',
      'Interviewer',
      'Grandma',
    ]);
    expect(text.turns[1]!.text).toBe('In Busan.');
    const json = parseTranscript({ segments: [seg('Gr\u0000andma', 0, 'In Bu\u0000san.')] });
    expect(json.turns[0]).toMatchObject({ speaker: 'Grandma', text: 'In Busan.' });
  });

  it('a speaker called like one of our own ids, or like an object property, gets " (speaker)"', () => {
    const t = parseTranscript({
      segments: [
        seg('QUESTIONS', 0, 'I was born in Busan by the sea.'),
        seg('UNKNOWN', 1, 'Where exactly?'),
        seg('constructor', 2, 'By the harbour.'),
        seg('__proto__', 3, 'And then?'),
        seg('toString', 4, 'We left.'),
      ],
    });
    expect(t.turns.map((x) => x.speaker)).toEqual([
      'QUESTIONS (speaker)',
      'UNKNOWN (speaker)',
      'constructor (speaker)',
      '__proto__ (speaker)',
      'toString (speaker)',
    ]);
  });
});

describe('long turns', () => {
  it('never leave a scrap of a sentence on its own (it would be dropped as too short later)', () => {
    let body = '';
    for (let i = 1; body.length < 2470; i++) {
      body += `On day number ${i} we worked on the farm from dawn to dusk behind the old barn. `;
    }
    const answer = `${body.trim()} He died at 52.`;
    const t = parseTranscript(`Interviewer: Tell me about your father.\nGrandma: ${answer}`);
    const mine = t.turns.filter((x) => x.speaker === 'Grandma');
    expect(mine.length).toBeGreaterThan(1);
    expect(
      mine.every((x) => x.text.length >= MIN_TAIL_CHARS && x.text.length <= MAX_TURN_CHARS),
    ).toBe(true);
    expect(mine.map((x) => x.text).join(' ')).toBe(answer);
    expect(mine.at(-1)!.text.endsWith('He died at 52.')).toBe(true);
  });

  it('the same with no punctuation at all: words move, never a cut inside a word', () => {
    const text = `${'and then we went to the market '.repeat(81).trim()} at last`;
    const t = parseTranscript({ segments: [seg('A', 0, text)] });
    expect(t.turns.at(-1)!.text.length).toBeGreaterThanOrEqual(MIN_TAIL_CHARS);
    expect(t.turns.every((x) => x.text.length <= MAX_TURN_CHARS)).toBe(true);
    // every word, in order (the turn starts with a capital)
    expect(t.turns.map((x) => x.text).join(' ')).toBe(`A${text.slice(1)}`);
  });
});

describe('speech-to-text fragments become paragraphs', () => {
  it('no capital where a fragment happens to start; a capital at the start of the turn and after a full stop', () => {
    const t = parseTranscript({
      segments: [
        seg('A', 0, ' my father, who was a fisherman all his life,'),
        seg('A', 1, ' repaired boats down at the pier.'),
        seg('A', 2, ' and iPhones did not exist, eBay did not exist.'),
      ],
    });
    expect(t.turns[0]!.text).toBe(
      'My father, who was a fisherman all his life, repaired boats down at the pier. And iPhones did not exist, eBay did not exist.',
    );
  });

  it('a long monologue is cut only at sentence ends (or at a pause), never mid-sentence', () => {
    const words =
      'my mother used to wake up at four in the morning and light the fire and cook the rice for all of us '
        .repeat(12)
        .trim();
    const fragments = words.split(' ').reduce<string[]>((out, w, i) => {
      if (i % 8 === 0) out.push(w);
      else out[out.length - 1] += ` ${w}`;
      return out;
    }, []);
    fragments[fragments.length - 1] += '.';
    fragments[30] += '.';
    const t = parseTranscript({ segments: fragments.map((f, i) => seg(undefined, i, f)) });
    // every word kept, in order; each paragraph but the last ends at a full stop
    expect(
      t.turns
        .map((x) => x.text)
        .join(' ')
        .toLowerCase(),
    ).toBe(fragments.join(' ').toLowerCase());
    expect(t.turns.length).toBeGreaterThan(1);
    for (const x of t.turns.slice(0, -1)) expect(x.text).toMatch(/\.$/);
    // with a pause of two seconds, the paragraph may end there
    const paused = parseTranscript({
      segments: [
        { start: 0, end: 2, text: 'we waited for the boat' },
        { start: 4.5, end: 6, text: 'and it never came' },
      ],
    });
    expect(paused.turns).toHaveLength(2);
  });
});

describe('questions are guessed only when the file clearly alternates', () => {
  it('a monologue with a few questions of its own stays one voice', () => {
    const t = parseTranscript(
      [
        'We left Busan in the spring, all of us, with what we could carry.',
        'There was no food on the road, and my mother was sick for most of it.',
        'My brother carried the rice and I carried my little sister on my back.',
        'Who would help us?',
        'Nobody came, so we walked north for eleven days until we reached my uncle.',
        'He gave us one room, and we slept there, six of us, for the whole winter.',
      ].join('\n'),
    );
    expect(new Set(t.turns.map((x) => x.speaker))).toEqual(new Set([VOICE]));
    expect(t.warnings.map((w) => w.code)).not.toContain('questions_guessed');
  });

  it('questions that are mostly answered are set apart, and the caller is told', () => {
    const t = parseTranscript(
      'Where were you born?\nIn a small town by the sea.\nAnd your father?\nHe repaired boats.\nAnd your mother?\nShe sold fish.',
    );
    expect(t.turns.map((x) => x.speaker)).toEqual([
      QUESTIONS,
      VOICE,
      QUESTIONS,
      VOICE,
      QUESTIONS,
      VOICE,
    ]);
    expect(warned(t).questions_guessed).toBe(3);
  });

  it('questions that are not followed by answers are not set apart', () => {
    const t = parseTranscript('Why?\nWhy not?\nWho knows?\nI do.');
    expect(t.turns.every((x) => x.speaker === VOICE)).toBe(true);
  });
});
