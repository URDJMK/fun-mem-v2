import { describe, expect, it } from 'vitest';
import { parseJson } from '../src/transcript-formats';
import {
  MAX_JSON_CHARS,
  MAX_SEGMENTS,
  MAX_TRANSCRIPT_CHARS,
  MAX_TURN_CHARS,
  QUESTIONS,
  TranscriptError,
  applyRoles,
  assignRoles,
  parseTranscript,
  stripAnnotations,
} from '../src/transcript';

const Q = 'What was your father like?';
const A = 'He repaired boats. He had big hands and he did not talk much.';
const speakersOf = (t: ReturnType<typeof parseTranscript>) => [
  ...new Set(t.turns.map((x) => x.speaker)),
];
const warnings = (t: ReturnType<typeof parseTranscript>) =>
  Object.fromEntries(t.warnings.map((w) => [w.code, w.count]));

describe('formats a speech-to-text box really produces', () => {
  it('WhisperX .txt: [SPEAKER_01]: text', () => {
    const t = parseTranscript(
      `[SPEAKER_01]: ${Q}\n[SPEAKER_00]: ${A}\n[SPEAKER_01]: And your mother?\n[SPEAKER_00]: She sold fish.`,
    );
    expect(t.format).toBe('labelled-text');
    expect(t.turns.map((x) => x.speaker)).toEqual([
      'SPEAKER_01',
      'SPEAKER_00',
      'SPEAKER_01',
      'SPEAKER_00',
    ]);
    expect(t.turns[0]!.text).toBe(Q);
  });

  it('WhisperX .srt: cue numbers and timings are not memories, the speaker survives, timing is kept', () => {
    const t = parseTranscript(
      `1\n00:00:00,000 --> 00:00:04,600\n[SPEAKER_01]: ${Q}\n\n2\n00:00:04,600 --> 00:00:21,300\n[SPEAKER_00]: ${A}\n\n3\n00:00:21,300 --> 00:00:24,000\n[SPEAKER_01]: And your mother?\n\n4\n00:00:24,000 --> 00:01:05,500\n[SPEAKER_00]: She sold fish.`,
    );
    expect(t.format).toBe('subtitles');
    expect(t.turns).toHaveLength(4);
    expect(t.turns.map((x) => x.text)).toEqual([Q, A, 'And your mother?', 'She sold fish.']);
    expect(t.turns[1]).toMatchObject({ speaker: 'SPEAKER_00', start: 4.6, end: 21.3 });
    expect(t.turns[3]!.end).toBe(65.5);
    expect(t.turns.map((x) => x.text).join(' ')).not.toMatch(/-->|^\d+$/);
  });

  it('WebVTT, including <v Name> voice tags, MM:SS timings and cue settings', () => {
    const t = parseTranscript(
      `WEBVTT\n\nNOTE made by a machine\n\n00:00.000 --> 00:04.600 align:start\n<v Interviewer>${Q}</v>\n\n00:04.600 --> 00:21.300\n<v Grandma><i>${A}</i></v>\n`,
    );
    expect(t.format).toBe('subtitles');
    expect(t.turns.map((x) => [x.speaker, x.text])).toEqual([
      ['Interviewer', Q],
      ['Grandma', A],
    ]);
  });

  it('SRT with a cue number stuck to the previous cue, and CRLF line ends', () => {
    const t = parseTranscript(
      `1\r\n00:00:00,000 --> 00:00:03,000\r\nA: ${Q}\r\n2\r\n00:00:03,000 --> 00:00:09,000\r\nB: ${A}\r\n`,
    );
    expect(t.turns.map((x) => x.speaker)).toEqual(['A', 'B']);
    expect(t.turns[1]!.text).toBe(A);
  });

  it('JSON with numeric speaker ids', () => {
    const t = parseTranscript({
      segments: [
        { start: 0, end: 4, text: Q, speaker: 0 },
        { start: 4, end: 20, text: A, speaker: 1 },
      ],
    });
    expect(speakersOf(t)).toEqual(['SPEAKER_00', 'SPEAKER_01']);
  });

  it('whisper.cpp JSON: timestamps and millisecond offsets', () => {
    const t = parseTranscript({
      transcription: [
        {
          timestamps: { from: '00:00:00,000', to: '00:00:04,600' },
          offsets: { from: 0, to: 4600 },
          text: ` ${Q}`,
        },
        { offsets: { from: 4600, to: 21300 }, text: ` ${A}` },
      ],
    });
    expect(t.turns.map((x) => x.text)).toEqual([Q, A]);
    expect(t.turns[1]).toMatchObject({ start: 4.6, end: 21.3 });
  });

  it('AssemblyAI-style utterances in milliseconds, and word-only segments', () => {
    const t = parseTranscript({
      utterances: [
        { speaker: 'A', start: 240, end: 4600, text: Q },
        { speaker: 'B', start: 4600, end: 61300, text: A },
      ],
    });
    expect(t.turns[1]).toMatchObject({ start: 4.6, end: 61.3 });
    const w = parseTranscript({
      segments: [
        {
          start: 0,
          end: 3,
          speaker: 'A',
          words: [{ word: 'He' }, { word: 'repaired' }, { word: 'boats.' }],
        },
      ],
    });
    expect(w.turns[0]!.text).toBe('He repaired boats.');
  });

  it('Otter: a "Speaker 1  0:05" header line, then the words', () => {
    const t = parseTranscript(
      `Speaker 1  0:05\n${Q}\n\nSpeaker 2  0:09\n${A}\nHe also had a green truck.\n\nSpeaker 1  0:21\nAnd your mother?\n\nSpeaker 2  0:24\nShe sold fish.`,
    );
    expect(t.format).toBe('header-text');
    expect(t.turns.map((x) => x.speaker)).toEqual([
      'Speaker 1',
      'Speaker 2',
      'Speaker 1',
      'Speaker 2',
    ]);
    expect(t.turns[1]!.text).toBe(`${A} He also had a green truck.`);
    expect(t.turns[0]).toMatchObject({ start: 5, end: 9 });
  });

  it("Zoom's own text export: [Name] 00:00:05 on a line, then the words; and the same on one line", () => {
    const own = parseTranscript(
      `[Anna Lee] 00:00:05\n${Q}\n\n[Grandma Sunja] 00:00:12\n${A}\n\n[Anna Lee] 00:00:40\nAnd your mother?\n\n[Grandma Sunja] 00:00:45\nShe sold fish.`,
    );
    expect(own.format).toBe('header-text');
    expect(own.turns.map((x) => [x.speaker, x.start, x.text])).toEqual([
      ['Anna Lee', 5, Q],
      ['Grandma Sunja', 12, A],
      ['Anna Lee', 40, 'And your mother?'],
      ['Grandma Sunja', 45, 'She sold fish.'],
    ]);
    const oneLine = parseTranscript(
      `[Anna Lee] 00:00:05 ${Q}\n[Grandma Sunja] 00:00:12 ${A}\n[Anna Lee] 00:00:40 And your mother?\n[Grandma Sunja] 00:00:45 She sold fish.`,
    );
    expect(oneLine.turns.map((x) => [x.speaker, x.start, x.text])).toEqual([
      ['Anna Lee', 5, Q],
      ['Grandma Sunja', 12, A],
      ['Anna Lee', 40, 'And your mother?'],
      ['Grandma Sunja', 45, 'She sold fish.'],
    ]);
    // the time is not left in the words, and a sound note in brackets is not a speaker
    expect(oneLine.turns.map((x) => x.text).join(' ')).not.toMatch(/00:00/);
    const music = parseTranscript(`[Music] 00:00:05 la la la\n[Applause] 00:00:12 clap clap\n${A}`);
    expect(speakersOf(music)).not.toContain('Music');
  });

  it('Rev and Teams: Name  0:05 on a line, hours included; numbered voices and participants', () => {
    const rev = parseTranscript(
      `Speaker 1  00:05\n${Q}\n\nSpeaker 2  1:02:03\n${A}\n\nSpeaker 1  1:03:40\nAnd your mother?`,
    );
    expect(rev.turns.map((x) => x.start)).toEqual([5, 3723, 3820]);
    const teams = parseTranscript(
      'Participant 1 00:05\nTell me about your childhood.\nParticipant 2 00:12\nI was born in Busan.\nParticipant 1 00:30\nAnd your father?\nParticipant 2 00:35\nHe repaired boats.',
    );
    expect(speakersOf(teams)).toEqual(['Participant 1', 'Participant 2']);
  });

  it('numbered speakers: [Speaker1] text, Speaker 2: text', () => {
    const a = parseTranscript(
      '[Speaker1] What was your father like?\n[Speaker2] He repaired boats.\n[Speaker1] And your mother?\n[Speaker2] She sold fish at the market.',
    );
    expect(speakersOf(a)).toEqual(['Speaker1', 'Speaker2']);
    const b = parseTranscript(
      'Speaker 1: What was your father like?\nSpeaker 2: He repaired boats.',
    );
    expect(speakersOf(b)).toEqual(['Speaker 1', 'Speaker 2']);
  });

  it('labels with timestamps in any position', () => {
    const t = parseTranscript(
      `[00:05] Interviewer: ${Q}\nGrandma (00:09): ${A}\n00:21 Interviewer: And your mother?\nGrandma [00:24 - 00:40]: She sold fish.`,
    );
    expect(t.turns.map((x) => [x.speaker, x.start])).toEqual([
      ['Interviewer', 5],
      ['Grandma', 9],
      ['Interviewer', 21],
      ['Grandma', 24],
    ]);
  });

  it('timestamped lines with no speakers', () => {
    const t = parseTranscript(
      '[00:05] I was born in a small town.\n[00:12] We lived by the water.\n[00:20] My father repaired boats.\n[00:31] He had big hands.',
    );
    expect(t.format).toBe('timestamped-text');
    expect(t.turns[0]).toMatchObject({ start: 5 });
  });

  it('prose with a colon in it is not a transcript, and neither is a lone "He said:" line', () => {
    expect(
      parseTranscript(
        'The night it rained: we all stayed in.\nAnd in the morning the road was gone.',
      ).format,
    ).toBe('plain-text');
    const t = parseTranscript('Grandma: He said: no.\nInterviewer: And then?\nGrandma: We left.');
    expect(t.turns.map((x) => x.speaker)).toEqual(['Grandma', 'Interviewer', 'Grandma']);
    expect(t.turns[0]!.text).toBe('He said: no.');
  });

  it('a title line above the first label is not testimony', () => {
    const t = parseTranscript(`Interview with Grandma, 2026\n\nInterviewer: ${Q}\nGrandma: ${A}`);
    expect(t.turns.map((x) => x.speaker)).toEqual(['Interviewer', 'Grandma']);
  });
});

describe('cleaning what the recogniser got wrong', () => {
  it('drops non-speech annotations', () => {
    expect(
      stripAnnotations('[Music] hello (laughs) there *sighs* ♪ la la ♪ end [inaudible]')
        .replace(/\s+/g, ' ')
        .trim(),
    ).toBe('hello there end');
    const t = parseTranscript({
      segments: [
        { start: 0, end: 4, text: '[Music]', speaker: 'A' },
        { start: 4, end: 20, text: `${A} (laughs) [inaudible] ♪ la la la ♪`, speaker: 'B' },
      ],
    });
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.text).toBe(A);
    // one per note, not one per segment: [Music], (laughs), [inaudible], ♪ la la la ♪
    expect(warnings(t).annotations_removed).toBe(4);
  });

  it('keeps ordinary parentheses', () => {
    const t = parseTranscript({
      segments: [{ start: 0, end: 4, text: 'My brother (the older one) left.', speaker: 'A' }],
    });
    expect(t.turns[0]!.text).toBe('My brother (the older one) left.');
  });

  it('drops known hallucinations and collapses a segment repeated three or more times', () => {
    const loop = Array.from({ length: 30 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: 'Okay so we left.',
      speaker: 'SPEAKER_00',
    }));
    const t = parseTranscript({
      segments: [
        { start: 0, end: 4, text: Q, speaker: 'SPEAKER_01' },
        ...loop,
        { start: 40, end: 44, text: 'Thanks for watching!', speaker: 'SPEAKER_00' },
      ],
    });
    expect(t.turns).toHaveLength(2);
    expect(t.turns[1]!.text).toBe('Okay so we left.');
    expect(warnings(t).repeats_collapsed).toBe(29);
  });

  it('collapses a sentence looped inside one segment, but not a deliberate repeat', () => {
    const t = parseTranscript({
      segments: [
        {
          start: 0,
          end: 9,
          text: 'We left. ' + 'Thank you. '.repeat(8) + 'Then it rained.',
          speaker: 'A',
        },
      ],
    });
    expect(t.turns[0]!.text).toBe('We left. Thank you. Then it rained.');
    const same = parseTranscript({
      segments: [{ start: 0, end: 4, text: 'No. No. It was not him.', speaker: 'A' }],
    });
    expect(same.turns[0]!.text).toBe('No. No. It was not him.');
  });

  it('removes fillers and joins the pieces of one speaker', () => {
    const t = parseTranscript({
      segments: [
        {
          start: 0,
          end: 4,
          text: 'Um, so I, I grew up there, you know, by the water.',
          speaker: 'A',
        },
        { start: 4, end: 8, text: 'Uh, um, I was born in Tongyeong.', speaker: 'A' },
      ],
    });
    expect(t.turns[0]!.text).toBe('So I grew up there by the water. I was born in Tongyeong.');
  });

  it('words in another script are kept exactly as written, whatever the layout', () => {
    const said = [
      'Мы жили у моря, и отец чинил лодки.',
      '我出生在釜山，我父亲是修船的。',
      'ولدت في بوسان وكان أبي يصلح القوارب.',
      'Γεννήθηκα στη Μπουσάν και ο πατέρας μου έφτιαχνε βάρκες.',
    ];
    for (const line of said) {
      // text: one voice per line, then a labelled file, a subtitle file and JSON
      expect(parseTranscript(line).turns.map((x) => x.text)).toEqual([line]);
      const labelled = parseTranscript(
        `Interviewer: Where were you born?\nGrandma: ${line}\nInterviewer: And then?\nGrandma: ${line}`,
      );
      expect(labelled.turns.filter((x) => x.speaker === 'Grandma').map((x) => x.text)).toEqual([
        line,
        line,
      ]);
      const srt = parseTranscript(
        `1\n00:00:00,000 --> 00:00:04,000\n[Interviewer]: Where were you born?\n\n2\n00:00:04,000 --> 00:00:09,000\n[Grandma]: ${line}\n`,
      );
      expect(srt.turns[1]!.text).toBe(line);
      const json = parseTranscript({
        segments: [{ start: 0, end: 4, text: ` ${line} `, speaker: 'SPEAKER_00' }],
      });
      expect(json.turns[0]!.text).toBe(line);
    }
    // only ASCII punctuation structures a transcript: a full-width colon makes a plain line
    const plain = parseTranscript('Interviewer： Where were you born?\nGrandma： In Busan.');
    expect(plain.format).toBe('plain-text');
    expect(plain.turns.map((x) => x.text)).toEqual([
      'Interviewer： Where were you born?',
      'Grandma： In Busan.',
    ]);
  });
});

describe('who spoke', () => {
  it('a segment with no speaker takes the previous speaker, never colliding with a real one', () => {
    const t = parseTranscript({
      segments: [
        { start: 0, end: 4, text: Q, speaker: 'SPEAKER_01' },
        { start: 4, end: 20, text: A, speaker: 'SPEAKER_00' },
        { start: 20, end: 30, text: 'And he had a green truck.' },
        { start: 30, end: 34, text: 'And your mother?', speaker: 'SPEAKER_01' },
      ],
    });
    expect(t.turns.map((x) => x.speaker)).toEqual(['SPEAKER_01', 'SPEAKER_00', 'SPEAKER_01']);
    expect(t.turns[1]!.text).toBe(`${A} And he had a green truck.`);
    expect(warnings(t).unlabelled_filled).toBe(1);
  });

  it('leading unlabelled segments are their own UNKNOWN voice, not SPEAKER_00', () => {
    const t = parseTranscript({
      segments: [
        { start: 0, end: 2, text: 'Testing, testing one two.' },
        { start: 2, end: 6, text: Q, speaker: 'SPEAKER_01' },
        { start: 6, end: 20, text: A, speaker: 'SPEAKER_00' },
      ],
    });
    expect(t.turns[0]!.speaker).toBe('UNKNOWN');
  });

  // The reader no longer folds anything: whether "Yeah." is an interjection or an answer
  // depends on WHO said it, which only the roles know (see applyRoles in roles-confidence.test.ts).
  it('"Mm-hm" and "Yeah" from the interviewer between two parts of one answer are folded once the roles are known', () => {
    const seg = (text: string, speaker: string, i: number) => ({
      start: i * 10,
      end: i * 10 + 9,
      text,
      speaker,
    });
    for (const backchannel of ['Mm-hm.', 'Yeah.', 'Uh-huh.']) {
      const t = parseTranscript({
        segments: [
          seg(Q, 'Q', 0),
          seg('He repaired boats.', 'A', 1),
          seg(backchannel, 'Q', 2),
          seg('And he had big hands.', 'A', 3),
        ],
      });
      // the reader keeps every turn
      expect(t.turns.map((x) => x.speaker)).toEqual(['Q', 'A', 'Q', 'A']);
      const r = applyRoles(t);
      expect(r.turns.map((x) => x.speaker)).toEqual(['Q', 'A']);
      expect(r.turns.map((x) => x.index)).toEqual([0, 1]);
      expect(r.turns[1]!.text).toBe('He repaired boats. And he had big hands.');
    }
    // a real interjection (not a backchannel) stays a turn
    const kept = applyRoles(
      parseTranscript({
        segments: [
          seg(Q, 'Q', 0),
          seg('He repaired boats.', 'A', 1),
          seg('Wait, which boats?', 'Q', 2),
          seg('The fishing boats.', 'A', 3),
        ],
      }),
    );
    expect(kept.turns).toHaveLength(4);
    const folded = applyRoles(
      parseTranscript({
        segments: [
          seg(Q, 'Q', 0),
          seg('He repaired boats and he had big hands and he did not talk much at all.', 'A', 1),
          seg('Yeah.', 'Q', 2),
          seg('And he took me down to the pier every Sunday morning.', 'A', 3),
        ],
      }),
    );
    expect(folded.warnings.find((w) => w.code === 'backchannels_merged')?.count).toBe(1);
  });

  it('with no speakers, lines that end in "?" are set apart as questions, and the caller is told', () => {
    const t = parseTranscript({
      segments: [
        { start: 0, end: 4, text: 'Where were you born?' },
        { start: 4, end: 20, text: 'In a small town by the sea.' },
        { start: 20, end: 24, text: 'And your father?' },
        { start: 24, end: 40, text: 'He repaired boats.' },
      ],
    });
    expect(t.turns.map((x) => x.speaker)).toEqual([
      QUESTIONS,
      'SPEAKER_00',
      QUESTIONS,
      'SPEAKER_00',
    ]);
    expect(warnings(t)).toMatchObject({ no_speakers: 1, questions_guessed: 2 });
  });

  it('with no speakers, a transcript that is mostly questions is left alone', () => {
    const t = parseTranscript('Why?\nWhy not?\nWho knows?\nI do.');
    expect(t.turns.every((x) => x.speaker === 'SPEAKER_00')).toBe(true);
  });

  it('with no speakers, ASR fragments are gathered into paragraphs, not one giant turn and not one per fragment', () => {
    const segs = Array.from({ length: 40 }, (_, i) => ({
      start: i * 3,
      end: i * 3 + 2.5,
      text: `This is fragment number ${i + 1} of the story I am telling you.`,
    }));
    const t = parseTranscript({ segments: segs });
    expect(t.turns.length).toBeGreaterThan(3);
    expect(t.turns.length).toBeLessThan(40);
    expect(t.turns.every((x) => x.text.length < 900)).toBe(true);
  });
});

describe('word-level JSON is gathered into turns', () => {
  type W = Record<string, string | number>;
  /** one word per item; `unit` 1000 writes the times in milliseconds, as AssemblyAI does */
  const say = (
    text: string,
    speaker: string | number | undefined,
    t0: number,
    o: { key?: 'word' | 'text'; unit?: number } = {},
  ): W[] =>
    text.split(' ').map((word, i) => {
      const start = t0 + i * 0.4;
      const unit = o.unit ?? 1;
      return {
        [o.key ?? 'word']: word,
        start: Math.round(start * unit * 1000) / 1000,
        end: Math.round((start + 0.3) * unit * 1000) / 1000,
        ...(speaker === undefined ? {} : { speaker }),
      };
    });
  const Q = 'What was your father like when you were a small boy then';
  const A = 'He repaired boats and he had big hands and he did not talk much at all.';

  it('WhisperX word_segments on their own: one turn per speaker, in order, with the time of the first word', () => {
    const t = parseTranscript({
      word_segments: [...say(Q, 'SPEAKER_01', 0), ...say(A, 'SPEAKER_00', 6)],
    });
    expect(t.turns.map((x) => x.speaker)).toEqual(['SPEAKER_01', 'SPEAKER_00']);
    expect(t.turns[1]!.text).toBe(A);
    expect(t.turns[1]!.start).toBe(6);
    expect(t.format).toBe('segments-json');
  });

  it('a word WhisperX could not time or attribute (a numeral) joins the words around it', () => {
    const t = parseTranscript({
      word_segments: [
        { word: 'I', start: 0, end: 0.2, speaker: 'SPEAKER_00' },
        { word: 'was', start: 0.3, end: 0.5, speaker: 'SPEAKER_00' },
        { word: 'born', start: 0.6, end: 0.9, speaker: 'SPEAKER_00' },
        { word: 'in', start: 1.0, end: 1.1, speaker: 'SPEAKER_00' },
        { word: '1946' },
        { word: 'in', start: 1.6, end: 1.8, speaker: 'SPEAKER_00' },
        { word: 'Busan.', start: 1.9, end: 2.4, speaker: 'SPEAKER_00' },
      ],
    });
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.text).toBe('I was born in 1946 in Busan.');
    expect(t.turns[0]!.end).toBeCloseTo(2.4);
  });

  it('segments and word_segments together (a normal WhisperX file): the sentences are used, nothing is said twice', () => {
    const t = parseTranscript({
      segments: [
        { start: 0, end: 4, text: Q, speaker: 'SPEAKER_01' },
        { start: 5, end: 11, text: A, speaker: 'SPEAKER_00' },
      ],
      word_segments: [...say(Q, 'SPEAKER_01', 0), ...say(A, 'SPEAKER_00', 5)],
    });
    expect(t.turns).toHaveLength(2);
    expect(t.turns.map((x) => x.text).join(' ')).toBe(`${Q} ${A}`);
  });

  it('with no speakers at all, a pause of a second and a half starts a new turn', () => {
    const raw = parseJson(
      { word_segments: [...say(Q, undefined, 0), ...say(A, undefined, 20)] },
      50_000,
    )!;
    expect(raw.segs).toHaveLength(2);
    expect(raw.segs[0]!.text).toBe(Q);
    expect(raw.segs[1]!.text).toBe(A);
    expect(raw.segs[1]!.start).toBe(20);
  });

  it('AssemblyAI top-level words: milliseconds are read as seconds, speakers A and B', () => {
    const t = parseTranscript({
      words: [
        ...say(Q, 'A', 0, { key: 'text', unit: 1000 }),
        ...say(A, 'B', 30, { key: 'text', unit: 1000 }),
      ],
    });
    expect(t.turns.map((x) => x.speaker)).toEqual(['A', 'B']);
    expect(t.turns[1]!.start).toBe(30);
    expect(t.turns[1]!.text).toBe(A);
  });

  it('Deepgram channels[0].alternatives[0].words, preferring the punctuated spelling', () => {
    const t = parseTranscript({
      results: {
        channels: [
          {
            alternatives: [
              {
                words: [
                  ...say(Q.toLowerCase(), 0, 0).map((w, i) => ({
                    ...w,
                    punctuated_word: i === 0 ? 'What' : w.word,
                  })),
                  ...say(A, 1, 20).map((w) => ({ ...w, punctuated_word: w.word })),
                ],
              },
            ],
          },
        ],
      },
    });
    expect(t.turns.map((x) => x.speaker)).toEqual(['SPEAKER_00', 'SPEAKER_01']);
    expect(t.turns[0]!.text.startsWith('What was')).toBe(true);
    expect(t.turns[1]!.text).toBe(A);
  });

  it('a long unbroken run is cut at a sentence end (the reader), and is whole again after back-to-back turns by one speaker are joined', () => {
    // different sentences: 30 identical ones would be taken for a recogniser stuck in a loop
    const sentences = Array.from(
      { length: 30 },
      (_, i) => `We went down to the harbour on day ${i + 1} before school.`,
    );
    // four seconds of speech, then a short silence: under the pause threshold, so only the length can cut it
    const many = sentences.flatMap((x, i) => say(x, 'SPEAKER_00', i * 5.2));
    const raw = parseJson({ word_segments: many }, 50_000)!;
    expect(raw.segs.length).toBeGreaterThan(2);
    expect(raw.segs.every((x) => x.text.endsWith('.'))).toBe(true);
    expect(raw.segs.map((x) => x.text).join(' ')).toBe(sentences.join(' '));
    expect(
      parseTranscript({ word_segments: many })
        .turns.map((x) => x.text)
        .join(' '),
    ).toBe(sentences.join(' '));
  });

  it('too many words is refused quickly, and a list of non-words is simply unreadable', () => {
    const t0 = performance.now();
    expect(() =>
      parseTranscript({ word_segments: Array.from({ length: 400_000 }, () => ({ word: 'a' })) }),
    ).toThrow(/too many/);
    expect(() => parseTranscript({ word_segments: [{ nope: 1 }, 5, null, 'x'] })).toThrow(
      TranscriptError,
    );
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('size and shape', () => {
  it('splits a turn too long for one model call at sentence boundaries, keeping every word and the timing in order', () => {
    const text = Array.from(
      { length: 200 },
      (_, i) => `On day ${i + 1} we went to the market and my mother sold fish there.`,
    ).join(' ');
    const t = parseTranscript({ segments: [{ start: 100, end: 700, text, speaker: 'A' }] });
    expect(t.turns.length).toBeGreaterThan(3);
    expect(t.turns.every((x) => x.text.length <= MAX_TURN_CHARS)).toBe(true);
    expect(t.turns.map((x) => x.text).join(' ')).toBe(text);
    expect(t.turns[0]!.start).toBe(100);
    for (let i = 1; i < t.turns.length; i++)
      expect(t.turns[i]!.start!).toBeGreaterThanOrEqual(t.turns[i - 1]!.end! - 1e-9);
    expect(t.turns.at(-1)!.end).toBeCloseTo(700, 5);
  });

  it('splits a long turn with no punctuation at spaces, never mid-word', () => {
    const t = parseTranscript({
      segments: [
        {
          start: 0,
          end: 600,
          text: 'and then we went to the market '.repeat(300).trim(),
          speaker: 'A',
        },
      ],
    });
    for (const x of t.turns)
      expect(
        x.text.startsWith('and then') ||
          x.text.startsWith('market') ||
          x.text.startsWith('the') ||
          /^\w/.test(x.text),
      ).toBe(true);
    expect(
      t.turns
        .map((x) => x.text)
        .join(' ')
        .split(' ').length,
    ).toBe(300 * 7 - 0);
  });

  it('refuses too many segments, too many characters, nothing, and no speech, each with its own code', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as TranscriptError).code;
      }
      return 'none';
    };
    expect(
      code(() =>
        parseTranscript({
          segments: Array.from({ length: MAX_SEGMENTS + 1 }, () => ({ text: 'hi' })),
        }),
      ),
    ).toBe('too_many_segments');
    expect(code(() => parseTranscript('x'.repeat(MAX_TRANSCRIPT_CHARS * 2 + 1)))).toBe('too_long');
    expect(
      code(() =>
        parseTranscript({
          segments: Array.from({ length: 300 }, (_, i) => ({
            speaker: i % 2 ? 'A' : 'B',
            text: `word${i} `.repeat(300),
          })),
        }),
      ),
    ).toBe('too_long');
    expect(
      code(() =>
        parseTranscript({ segments: [{ text: 'x'.repeat(MAX_TRANSCRIPT_CHARS * 2 + 5) }] }),
      ),
    ).toBe('too_long');
    expect(code(() => parseTranscript('   \n  '))).toBe('empty');
    expect(code(() => parseTranscript('[Music]\n[Applause]'))).toBe('no_speech');
    expect(code(() => parseTranscript({ nothing: true }))).toBe('unreadable');
    expect(code(() => parseTranscript(42))).toBe('unreadable');
  });

  it('an hour and more of speech-to-text JSON, with a timing for every word, is not "too long"', () => {
    const WORDS =
      'my father repaired boats and he had big hands and he did not talk much at all'.split(' ');
    const segments = Array.from({ length: 700 }, (_, i) => {
      const speaker = i % 2 === 0 ? 'SPEAKER_01' : 'SPEAKER_00';
      const n = speaker === 'SPEAKER_00' ? 28 : 9;
      const start = i * 12;
      const words = Array.from({ length: n }, (_w, k) => ({
        word: WORDS[(i + k) % WORDS.length]!,
        start: start + k * 0.35,
        end: start + k * 0.35 + 0.3,
        score: 0.91,
        speaker,
      }));
      return {
        start,
        end: start + n * 0.35,
        text: words.map((w) => w.word).join(' '),
        speaker,
        words,
      };
    });
    const file = JSON.stringify({
      segments,
      word_segments: segments.flatMap((x) => x.words),
    });
    expect(file.length).toBeGreaterThan(MAX_TRANSCRIPT_CHARS * 4);
    const t0 = Date.now();
    const t = parseTranscript(file);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(t.turns).toHaveLength(700);
    expect(t.chars).toBeLessThan(MAX_TRANSCRIPT_CHARS);
    // the same file as an object is the same transcript
    expect(parseTranscript(JSON.parse(file) as object).turns).toHaveLength(700);
  });

  it('a huge text that only looks like JSON is refused as unreadable, quickly, and a huge plain text is still too long', () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as TranscriptError).code;
      }
      return 'none';
    };
    const t0 = Date.now();
    expect(code(() => parseTranscript(`{"segments": [${'{"text": "oops" '.repeat(120_000)}`))).toBe(
      'unreadable',
    );
    expect(code(() => parseTranscript(`[00:12] ${'a b c: '.repeat(300_000)}`))).toBe('too_long');
    expect(code(() => parseTranscript(`{"x":"${'y'.repeat(MAX_JSON_CHARS)}"}`))).toBe('too_long');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('turn indices are contiguous and no turn is empty', () => {
    const t = parseTranscript(
      `Interviewer: ${Q}\nGrandma: ${A}\nInterviewer: [Music]\nGrandma: ${A}`,
    );
    expect(t.turns.map((x) => x.index)).toEqual(t.turns.map((_, i) => i));
    expect(t.turns.every((x) => x.text.trim() !== '')).toBe(true);
  });
});

describe('fuzz: whatever arrives, it is read or refused cleanly, and quickly', () => {
  // a small seeded generator so a failure is reproducible
  let seed = 20261018;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const bits = [
    'SPEAKER_00',
    'SPEAKER_01',
    '[',
    ']',
    '(',
    ')',
    ':',
    '：',
    '-->',
    '00:00:01,000',
    '00:12',
    '1:02:03',
    '\n',
    '\n\n',
    '\r\n',
    ' ',
    '  ',
    'Speaker 1',
    'Interviewer',
    'Grandma',
    'WEBVTT',
    '1',
    '[Music]',
    '(laughs)',
    '♪',
    '?',
    '.',
    ',',
    'um',
    'I, I',
    'You know',
    'э',
    'ммм',
    'Это предложение.',
    '这是一个句子。',
    'He repaired boats.',
    '<v A>',
    '</v>',
    '{',
    '}',
    '"',
    '​',
    '﻿',
    'NOTE',
    '0',
    '99999999',
  ];

  it('300 random messy texts', () => {
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rnd() * 80);
      const text = Array.from({ length: n }, () => pick(bits)).join(pick(['', ' ', '\n']));
      const t0 = performance.now();
      try {
        const t = parseTranscript(text);
        expect(t.turns.length).toBeGreaterThan(0);
        t.turns.forEach((x, k) => {
          expect(x.index).toBe(k);
          expect(x.text.trim()).not.toBe('');
          expect(x.text.length).toBeLessThanOrEqual(MAX_TURN_CHARS);
          if (x.start !== null) expect(Number.isFinite(x.start)).toBe(true);
          if (x.end !== null) expect(Number.isFinite(x.end)).toBe(true);
        });
        assignRoles(t.turns); // and roles can always be assigned
      } catch (e) {
        if (!(e instanceof TranscriptError))
          throw new Error(
            `seed case ${i} threw ${String(e)} on ${JSON.stringify(text.slice(0, 200))}`,
          );
      }
      expect(performance.now() - t0).toBeLessThan(300);
    }
  });

  it('300 random JSON shapes', () => {
    const vals = (): unknown => {
      const r = rnd();
      if (r < 0.2) return null;
      if (r < 0.35) return Math.floor(rnd() * 100000) / (rnd() < 0.5 ? 1 : 1000);
      if (r < 0.55)
        return pick([
          '',
          'hello there friend',
          'SPEAKER_00',
          '00:01:02',
          '[Music]',
          '?',
          'русский',
        ]);
      if (r < 0.65) return [];
      if (r < 0.75) return pick([true, false, -5, 1e21, NaN]);
      return {
        text: pick(['hi there', 'It was June.', '']),
        speaker: pick([0, 1, 'A', null, '', 7]),
        start: pick([0, 1.5, '00:01', -3, null, 'x', 90000]),
        end: pick([2, '00:02', null, 1e9]),
      };
    };
    for (let i = 0; i < 300; i++) {
      const list = Array.from({ length: Math.floor(rnd() * 12) }, vals);
      const input = pick([
        { segments: list },
        list,
        { utterances: list },
        { transcription: list },
        { chunks: list },
        { segments: list, interviewee: 'A' },
        { results: { utterances: list } },
      ]);
      try {
        const t = parseTranscript(input);
        expect(t.turns.length).toBeGreaterThan(0);
        t.turns.forEach((x) => {
          if (x.start !== null) expect(Number.isFinite(x.start)).toBe(true);
        });
      } catch (e) {
        if (!(e instanceof TranscriptError)) throw new Error(`json case ${i} threw ${String(e)}`);
      }
    }
  });

  it('adversarial strings finish fast', () => {
    const big = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
    for (const text of [
      big('a', 399_000),
      big(', ', 399_000),
      big('I, I, ', 399_000),
      big('SPEAKER_00: hello there friend\n', 399_000),
      ' '.repeat(399_000) + 'x',
      big('[', 399_000),
      big('(a', 399_000),
      big('1\n00:00:01,000 --> 00:00:02,000\nhi\n\n', 399_000),
      big('Speaker 1  0:05\nhi\n', 399_000),
      big('<v A>', 399_000),
      big('\n', 399_000) + 'x',
      big('♪', 399_000) + 'x',
      // fillers and tags the cleaner removes: what is left behind must not be slow to read either
      big('um ', 399_000),
      big('um, ', 399_000),
      big(', you know, ', 399_000),
      big('I mean, ', 399_000),
      big('мм ', 399_000),
      big('nineteen sixty six ', 399_000),
      big('since 1934 ', 399_000),
      big('[00:12] Q: hi\n', 399_000),
    ]) {
      const t0 = performance.now();
      try {
        parseTranscript(text);
      } catch (e) {
        if (!(e instanceof TranscriptError)) throw e;
      }
      expect(performance.now() - t0).toBeLessThan(1500);
    }
  });
});
