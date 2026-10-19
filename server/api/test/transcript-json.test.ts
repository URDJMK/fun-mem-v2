import { describe, expect, it } from 'vitest';
import { TranscriptError, applyRoles, parseTranscript } from '../src/transcript';

/**
 * JSON and subtitle files. A JSON file the reader cannot follow used to be read as plain
 * text, so its keys and braces became "testimony" of one confident voice.
 */

const failure = (input: unknown): { code: string; message: string } | null => {
  try {
    parseTranscript(input);
    return null;
  } catch (e) {
    if (!(e instanceof TranscriptError)) throw e;
    return { code: e.code, message: e.message };
  }
};

const whisperx = JSON.stringify(
  {
    segments: [
      { start: 0, end: 4, text: ' Where were you born?', speaker: 'SPEAKER_01' },
      { start: 4, end: 9, text: ' I was born in Busan.', speaker: 'SPEAKER_00' },
      { start: 9, end: 12, text: ' And your father?', speaker: 'SPEAKER_01' },
      { start: 12, end: 20, text: ' He repaired boats.', speaker: 'SPEAKER_00' },
    ],
  },
  null,
  2,
);

describe('JSON is read as JSON or refused, never as words', () => {
  it('a damaged or cut-off file is refused with a message that says what to do', () => {
    for (const broken of [
      whisperx.slice(0, -40),
      `${whisperx.slice(0, 200)}`,
      '{"segments": [{"text": "hi"',
    ]) {
      const f = failure(broken);
      expect(f?.code).toBe('unreadable');
      expect(f?.message).toMatch(/damaged or cut off/);
      expect(f?.message).toMatch(/export it again/i);
    }
  });

  it('a JSON layout we do not know is refused, as text and as an object', () => {
    const odd = {
      results: [{ alternatives: 'nope' }],
      foo: [{ content_text: 'I was born in Busan.' }],
    };
    expect(failure(JSON.stringify(odd, null, 2))?.code).toBe('unreadable');
    expect(failure(odd)?.code).toBe('unreadable');
    expect(failure('[{"nope": 1}, {"also": "no"}]')?.code).toBe('unreadable');
  });

  it("OpenAI Whisper's default answer, { text }, is the words and nothing else", () => {
    const t = parseTranscript(
      JSON.stringify({
        text: 'Where were you born, Grandma? I was born in Busan, by the harbour.',
      }),
    );
    expect(t.format).toBe('plain-text');
    expect(t.turns.map((x) => x.text).join(' ')).toBe(
      'Where were you born, Grandma? I was born in Busan, by the harbour.',
    );
    expect(t.turns.map((x) => x.text).join(' ')).not.toMatch(/[{}"]|text/);
    // one voice that asks questions: the file cannot say who is who, so a person confirms
    expect(applyRoles(t).roles.needsConfirmation).toBe(true);
  });

  it('`content` is read like `text`', () => {
    const t = parseTranscript({
      segments: [
        { speaker: 'SPEAKER_01', start: 0, end: 3, content: 'Where were you born?' },
        { speaker: 'SPEAKER_00', start: 3, end: 9, content: 'I was born in Busan by the sea.' },
      ],
    });
    expect(t.turns.map((x) => [x.speaker, x.text])).toEqual([
      ['SPEAKER_01', 'Where were you born?'],
      ['SPEAKER_00', 'I was born in Busan by the sea.'],
    ]);
  });

  it('Rev.ai monologues', () => {
    const t = parseTranscript({
      monologues: [
        {
          speaker: 0,
          elements: [
            { type: 'text', value: 'Where', ts: 0.1, end_ts: 0.3 },
            { type: 'punct', value: ' ' },
            { type: 'text', value: 'were', ts: 0.3, end_ts: 0.5 },
            { type: 'punct', value: ' ' },
            { type: 'text', value: 'you', ts: 0.5, end_ts: 0.7 },
            { type: 'punct', value: ' ' },
            { type: 'text', value: 'born', ts: 0.7, end_ts: 0.9 },
            { type: 'punct', value: '?' },
          ],
        },
        {
          speaker: 1,
          speaker_name: 'Grandma',
          elements: [{ type: 'text', value: 'Busan.', ts: 1.1, end_ts: 1.6 }],
        },
      ],
    });
    expect(t.turns.map((x) => [x.speaker, x.start, x.end, x.text])).toEqual([
      ['SPEAKER_00', 0.1, 0.9, 'Where were you born?'],
      ['Grandma', 1.1, 1.6, 'Busan.'],
    ]);
  });

  it('Speechmatics words, with punctuation joined to the word before', () => {
    const w = (content: string, start: number, speaker: string, type = 'word') => ({
      type,
      start_time: start,
      end_time: start + 0.3,
      alternatives: [{ content, speaker, confidence: 0.9 }],
    });
    const t = parseTranscript({
      format: '2.9',
      results: [
        w('Where', 0.1, 'S1'),
        w('were', 0.4, 'S1'),
        w('you', 0.7, 'S1'),
        w('born', 1.0, 'S1'),
        w('?', 1.3, 'S1', 'punctuation'),
        w('In', 2.0, 'S2'),
        w('Busan', 2.3, 'S2'),
        w('.', 2.6, 'S2', 'punctuation'),
      ],
    });
    expect(t.turns.map((x) => [x.speaker, x.text])).toEqual([
      ['S1', 'Where were you born?'],
      ['S2', 'In Busan.'],
    ]);
  });
});

describe('the interviewee the file names', () => {
  const segs = [
    {
      start: 0,
      end: 4,
      speaker: 1,
      text: 'Tell me about your father. I know he was a boat builder, and he worked down at the pier from before sunrise every day.',
    },
    { start: 4, end: 6, speaker: 0, text: 'He repaired boats.' },
    {
      start: 6,
      end: 12,
      speaker: 1,
      text: 'And I remember you told me he sang while he worked, the old songs from the island.',
    },
    { start: 12, end: 14, speaker: 0, text: 'He did. Every morning.' },
  ];

  it('is found when written the way the speakers are: 0, "0", "speaker_00"', () => {
    for (const interviewee of [0, '0', '00', 'SPEAKER_00', 'speaker_00', ' SPEAKER_00 ']) {
      const t = parseTranscript({ interviewee, segments: segs });
      expect(t.interviewee).toBe('SPEAKER_00');
      expect(applyRoles(t).roles).toMatchObject({
        interviewees: ['SPEAKER_00'],
        source: 'sender',
        confidence: 'high',
        needsConfirmation: false,
      });
    }
  });

  it('a named interviewee who is not in the file means a person must confirm', () => {
    const r = applyRoles(parseTranscript({ interviewee: 'Grandma', segments: segs })).roles;
    expect(r).toMatchObject({ source: 'guess', confidence: 'low', needsConfirmation: true });
    expect(r.reasons).toContain('named_speaker_not_found');
  });
});

describe('times', () => {
  it('milliseconds are recognised by how slow the speech would be, even for a short clip', () => {
    const t = parseTranscript({
      utterances: [
        { speaker: 'A', start: 240, end: 4600, text: 'Where were you born?' },
        { speaker: 'B', start: 4600, end: 30000, text: 'In Busan, by the sea, in a small house.' },
      ],
    });
    expect(t.turns.map((x) => [x.start, x.end])).toEqual([
      [0.24, 4.6],
      [4.6, 30],
    ]);
    const words = parseTranscript({
      words: [
        { text: 'I', start: 100, end: 300 },
        { text: 'was', start: 350, end: 500 },
        { text: 'born', start: 550, end: 800 },
        { text: 'in', start: 850, end: 900 },
        { text: 'Busan.', start: 950, end: 1400 },
      ],
    });
    expect(words.turns.map((x) => [x.start, x.end, x.text])).toEqual([
      [0.1, 1.4, 'I was born in Busan.'],
    ]);
    const startTime = parseTranscript({
      segments: [
        { speaker: 'A', start_time: 240, end_time: 4600, text: 'Where were you born?' },
        { speaker: 'B', start_time: 4600, end_time: 61300, text: 'In Busan.' },
      ],
    });
    expect(startTime.turns[1]).toMatchObject({ start: 4.6, end: 61.3 });
  });

  it('whole seconds stay seconds, even with short answers and long pauses', () => {
    const t = parseTranscript({
      segments: [
        { speaker: 'Q', start: 0, end: 9, text: 'Did he ever hit you?' },
        { speaker: 'A', start: 10, end: 19, text: 'No.' },
        { speaker: 'Q', start: 20, end: 29, text: 'Did he hit your brother?' },
        { speaker: 'A', start: 30, end: 39, text: 'No.' },
      ],
    });
    expect(t.turns.map((x) => x.start)).toEqual([0, 10, 20, 30]);
  });
});

describe('subtitles', () => {
  it('SRT without milliseconds, or with a colon before them, is still subtitles (cue numbers are not words)', () => {
    for (const sep of ['', ':000']) {
      const srt = [1, 2, 3]
        .map(
          (i) =>
            `${i}\n00:00:0${i * 2}${sep} --> 00:00:0${i * 2 + 1}${sep}\nLine number ${i} of the story.\n`,
        )
        .join('\n');
      const t = parseTranscript(srt);
      expect(t.format).toBe('subtitles');
      expect(t.turns.map((x) => x.text).join(' ')).toBe(
        'Line number 1 of the story. Line number 2 of the story. Line number 3 of the story.',
      );
      expect(t.turns[0]!.start).toBe(2);
    }
  });

  it('a cue with two voices is two turns, the cue time shared by length and exact at the ends', () => {
    const t = parseTranscript(
      'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Interviewer>Where were you born?</v>\n<v Grandma>In Busan, by the sea.</v>\n\n' +
        '00:00:04.000 --> 00:00:09.000\n<v Interviewer>And your father?</v>\n<v Grandma>He repaired boats.</v>\n',
    );
    expect(t.turns.map((x) => [x.speaker, x.text])).toEqual([
      ['Interviewer', 'Where were you born?'],
      ['Grandma', 'In Busan, by the sea.'],
      ['Interviewer', 'And your father?'],
      ['Grandma', 'He repaired boats.'],
    ]);
    expect(t.turns[0]!.start).toBe(1);
    expect(t.turns[1]!.end).toBe(4);
    expect(t.turns[0]!.end).toBeGreaterThan(1);
    expect(t.turns[0]!.end).toBeLessThan(4);
  });

  it('a cue with two labelled lines, or two speakers on one line, is split; the labels are not sound notes', () => {
    for (const cue of [
      '[SPEAKER_01]: Where were you born?\n[SPEAKER_00]: In Busan.',
      '[SPEAKER_01]: Where were you born? [SPEAKER_00]: In Busan.',
    ]) {
      const t = parseTranscript(
        `1\n00:00:01,000 --> 00:00:04,000\n${cue}\n\n2\n00:00:04,000 --> 00:00:09,000\n[SPEAKER_01]: And your father?\n`,
      );
      expect(t.turns.map((x) => [x.speaker, x.text])).toEqual([
        ['SPEAKER_01', 'Where were you born?'],
        ['SPEAKER_00', 'In Busan.'],
        ['SPEAKER_01', 'And your father?'],
      ]);
      expect(t.warnings.map((w) => w.code)).not.toContain('annotations_removed');
    }
  });

  it('dialogue dashes in a cue are separate lines, so questions can be set apart', () => {
    const t = parseTranscript(
      '1\n00:00:01,000 --> 00:00:04,000\n- Where were you born?\n- In Busan.\n\n2\n00:00:04,000 --> 00:00:09,000\n- And your father?\n- He repaired boats.\n',
    );
    expect(t.turns.map((x) => x.text)).toEqual([
      'Where were you born?',
      'In Busan.',
      'And your father?',
      'He repaired boats.',
    ]);
  });
});
