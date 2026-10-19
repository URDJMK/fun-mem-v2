import { describe, expect, it } from 'vitest';
import { parseTranscript, prepareText } from '../src/transcript';
import {
  parseHeaderText,
  parseLabelled,
  parseSubtitles,
  splitRunOnLabels,
} from '../src/transcript-formats';

/**
 * Round 2 of the format readers. Every input here is one a reviewer showed going wrong: the
 * interviewer's question inside the relative's answer at high confidence, words lost without
 * a warning, labels the readers could not read. The readers are tested directly where the
 * point is the reader, and through parseTranscript where the point is the words.
 */

const turnsOf = (input: string) => parseTranscript(input).turns.map((t) => [t.speaker, t.text]);
const linesOf = (input: string) => splitRunOnLabels(prepareText(input)).split('\n');
const speakersOf = (input: string) => [
  ...new Set(parseTranscript(input).turns.map((t) => t.speaker)),
];

describe('P1-1 a paste that lost its line breaks is cut at every label of its speakers', () => {
  const pairs = (a: string, b: string, qa: Array<[string, string]>) =>
    qa.map(([q, ans]) => `${a}: ${q} ${b}: ${ans}`).join(' ');

  it('a short sentence, a sound note, an abbreviation or "Yes." just before a label is never swallowed into it', () => {
    for (const before of [
      'We were poor. Very poor.',
      'In Busan. [laughs]',
      'On Main St.',
      'His name was Robert Allen Jr.',
      'I was the oldest. Yes.',
    ]) {
      const t = turnsOf(
        `Interviewer: Where were you born? Grandma: ${before} Interviewer: What did your father do? Grandma: He repaired boats. Interviewer: And your mother? Grandma: She sold fish.`,
      );
      expect(t).toEqual([
        ['Interviewer', 'Where were you born?'],
        ['Grandma', expect.not.stringContaining('Interviewer')],
        ['Interviewer', 'What did your father do?'],
        ['Grandma', 'He repaired boats.'],
        ['Interviewer', 'And your mother?'],
        ['Grandma', 'She sold fish.'],
      ]);
    }
  });

  it('Korean speech-to-text with no "?" before the label', () => {
    expect(
      turnsOf(
        '면접관: 어디서 태어나셨어요 할머니: 부산에서요. 면접관: 아버지는요? 할머니: 배를 고치셨어요. 면접관: 어머니는요? 할머니: 생선을 파셨어요.',
      ),
    ).toEqual([
      ['면접관', '어디서 태어나셨어요'],
      ['할머니', '부산에서요.'],
      ['면접관', '아버지는요?'],
      ['할머니', '배를 고치셨어요.'],
      ['면접관', '어머니는요?'],
      ['할머니', '생선을 파셨어요.'],
    ]);
  });

  it('titled and two-word names stay whole; a family name shared by two speakers is no label of its own', () => {
    expect(
      speakersOf(
        pairs('Ms. Lee', 'Dr. J. Park', [
          ['Where were you born?', 'In Busan.'],
          ['And then?', 'Seoul.'],
        ]),
      ),
    ).toEqual(['Ms. Lee', 'Dr. J. Park']);
    expect(
      speakersOf(
        pairs('Noah Kim', 'Sunja Kim', [
          ['Where were you born?', 'In Busan.'],
          ['And then?', 'Seoul.'],
        ]),
      ),
    ).toEqual(['Noah Kim', 'Sunja Kim']);
    expect(
      speakersOf(
        pairs('Voice 3', 'Grandma', [
          ['Where were you born?', 'In Busan.'],
          ['And then?', 'Seoul.'],
        ]),
      ),
    ).toEqual(['Voice 3', 'Grandma']);
  });

  it('a relative who answers only once is still her own turn: after a question, or after a Korean question with no "?"', () => {
    expect(
      linesOf(
        'Interviewer: Where were you born? Grandma: In Busan. We were poor. Interviewer: Thank you.',
      ),
    ).toEqual([
      'Interviewer: Where were you born?',
      'Grandma: In Busan. We were poor.',
      'Interviewer: Thank you.',
    ]);
    expect(linesOf('Q: 그때 집은 어땠어요 José: 방이 두 칸이었어요. Q: 고맙습니다.')).toEqual([
      'Q: 그때 집은 어땠어요',
      'José: 방이 두 칸이었어요.',
      'Q: 고맙습니다.',
    ]);
    // a one-word Korean name stays one word: "어땠어요" is the end of the question
    expect(linesOf('Q: 그때 집은 어땠어요 외할머니: 방이 두 칸이었어요. Q: 고맙습니다.')[1]).toBe(
      '외할머니: 방이 두 칸이었어요.',
    );
  });

  it('a time before a label goes with it, but the time at the end of a sound note stays with the note', () => {
    expect(
      linesOf('Noah: Where? [00:12] Grandma: Busan. Noah: When? [00:20] Grandma: 1946.'),
    ).toEqual(['Noah: Where?', '[00:12] Grandma: Busan.', 'Noah: When?', '[00:20] Grandma: 1946.']);
    expect(
      linesOf('Noah: Where? [inaudible 00:12:33] Grandma: Busan. Noah: When? Grandma: 1946.')[1],
    ).toBe('Grandma: Busan.');
  });

  it('a colon in a sentence never cuts it: prose, and a label-looking word used once', () => {
    const prose =
      'He said: go. She said: stay. We stayed until the morning. Then the road was gone.';
    expect(splitRunOnLabels(prose)).toBe(prose);
    const once =
      'Interviewer: Where did you live? Grandma: In Busan. Busan: that was home for us. Interviewer: And then? Grandma: We moved.';
    expect(linesOf(once)[1]).toBe('Grandma: In Busan. Busan: that was home for us.');
    // one turn per line already, and a label-looking word used once: nothing to cut
    const lines =
      'Interviewer: Where?\nGrandma: In Busan. Busan: that was home.\nInterviewer: Really?\nGrandma: Yes.';
    expect(splitRunOnLabels(lines)).toBe(lines);
  });

  it('500 realistic run-on pastes: no interviewer words inside the relative turns', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pick = <X>(a: readonly X[]): X => a[Math.floor(rnd() * a.length)]!;
    const answers = [
      'In Busan.',
      'We were poor. Very poor.',
      'Yes.',
      'He fixed boats on Main St.',
      'His name was Kim Jr.',
      'Four. All older.',
      '[laughs] It was hard.',
      'No.',
      'I think so. Maybe.',
    ];
    const questions = [
      'Where were you born?',
      'What did your father do?',
      'And your mother?',
      'Tell me more.',
      'Really?',
      'When was that?',
    ];
    let leaks = 0;
    for (let n = 0; n < 500; n++) {
      const [a, b] = pick([
        ['Interviewer', 'Grandma'],
        ['Noah', 'Sunja Kim'],
        ['Ms. Lee', 'Dr. Park'],
        ['Q', 'Grandpa Joe'],
      ] as const);
      const k = 2 + Math.floor(rnd() * 5);
      const paste = Array.from(
        { length: k },
        () => `${a}: ${pick(questions)} ${b}: ${pick(answers)} ${pick(answers)}`,
      ).join(' ');
      const tellers = parseTranscript(paste).turns.filter((t) => t.speaker === b);
      if (
        tellers.some((t) => questions.some((q) => t.text.includes(q)) || t.text.includes(`${a}:`))
      )
        leaks++;
    }
    expect(leaks).toBe(0);
  });
});

describe('P1-2 label shapes the readers could not read', () => {
  it('Zoom and Otter header lines with "Family, Given"', () => {
    const zoom = parseHeaderText(
      '[Interviewer] 00:00:00\n어디서 태어나셨어요\n\n[Kim, Sunja] 00:00:05\n부산에서 태어났어요.\n\n[Interviewer] 00:00:20\n아버지는요\n\n[Kim, Sunja] 00:00:25\n배를 고치셨어요.',
    )!;
    expect(zoom.segs.map((s) => [s.speaker, s.text])).toEqual([
      ['Interviewer', '어디서 태어나셨어요'],
      ['Kim, Sunja', '부산에서 태어났어요.'],
      ['Interviewer', '아버지는요'],
      ['Kim, Sunja', '배를 고치셨어요.'],
    ]);
    const otter = parseHeaderText(
      'Noah Kim 0:00\nWhere were you born?\nKim, Sunja 0:05\nIn Busan.\nNoah Kim 0:20\nAnd your mother?\nKim, Sunja 0:25\nShe sold fish.',
    )!;
    expect(otter.segs.map((s) => s.speaker)).toEqual([
      'Noah Kim',
      'Kim, Sunja',
      'Noah Kim',
      'Kim, Sunja',
    ]);
  });

  it('a subtitle cue holding two named speakers is cut, in Korean and English', () => {
    const srt = (a: string, b: string) =>
      [1, 2, 3]
        .map(
          (i) =>
            `${i}\n00:00:${i}0,000 --> 00:00:${i}9,000\n[${a}]: 질문 ${i} [${b}]: 대답 ${i}.\n`,
        )
        .join('\n');
    for (const [a, b] of [
      ['Interviewer', '할머니'],
      ['Host', 'Grandma'],
      ['Dr. J. Park', 'Sunja Kim'],
    ]) {
      expect(parseSubtitles(srt(a!, b!))!.segs.map((s) => [s.speaker, s.text])).toEqual([
        [a, '질문 1'],
        [b, '대답 1.'],
        [a, '질문 2'],
        [b, '대답 2.'],
        [a, '질문 3'],
        [b, '대답 3.'],
      ]);
    }
  });

  it('a name in brackets with its own note, and a three-line file of bracketed names', () => {
    expect(
      speakersOf(
        "[Q] What happened then?\n[Zoë (Noah's grandma)] We had nothing.\n[Q] And school?\n[Zoë (Noah's grandma)] Fifth grade.",
      ),
    ).toEqual(['Q', "Zoë (Noah's grandma)"]);
    expect(
      turnsOf(
        "[Noah] 00:00:05 Where?\n[Zoë (Noah's grandma)] 00:00:12 In Busan.\n[Noah] 00:00:40 And then?\n[Zoë (Noah's grandma)] 00:00:45 Seoul.",
      )[1],
    ).toEqual(["Zoë (Noah's grandma)", 'In Busan.']);
    expect(
      turnsOf(
        '[Noah] Where were you born?\n[Grandma] In Busan, by the harbour.\n[Noah] And your father?',
      ),
    ).toEqual([
      ['Noah', 'Where were you born?'],
      ['Grandma', 'In Busan, by the harbour.'],
      ['Noah', 'And your father?'],
    ]);
  });
});

describe('P1-3 words before the first label are kept unless they say they are a header', () => {
  it('speech before the first label is kept, counted, and belongs to nobody yet', () => {
    for (const lead of [
      '그래서 우리 아버지가 그날 밤 늦게 오셨는데\n어머니가 많이 우셨어요',
      'My father came home late that night and my mother was crying\nShe said the soldiers had taken the boat',
    ]) {
      const raw = parseLabelled(
        `${lead}\n면담자: 그게 몇 년도였어요?\n할머니: 1950년이었지.\n면담자: 그다음에는요?\n할머니: 피난을 갔지.`,
      )!;
      expect(raw.segs.slice(0, 2).map((s) => [s.speaker, s.text])).toEqual(
        lead.split('\n').map((l) => [null, l]),
      );
      expect(raw.notices).toEqual({ unlabelledStart: 2 });
    }
    const midstart = parseLabelled(
      'and that is why we never went back to the village after the flood, not even for the funerals.\nInterviewer: Where were you born?\nGrandma: Near Andong.\nInterviewer: And then?\nGrandma: Seoul.',
    )!;
    expect(midstart.segs[0]).toMatchObject({
      speaker: null,
      text: expect.stringMatching(/never went back to the village/),
    });
  });

  it('titles, header fields and dates are left out, and counted (Korean fields too)', () => {
    const en = parseLabelled(
      'Interview with Grandma\nRecorded March 1, 2024, at her house in Daejeon\n\nThis is the transcript of a conversation we had over two afternoons.\nTranscribed by Noah\n\nInterviewer: Where were you born?\nGrandma: In Busan.\nInterviewer: And then?\nGrandma: We moved.',
    )!;
    expect(en.notices).toEqual({ unlabelledStart: 1, linesDropped: 3 });
    expect(en.segs[0]!.text).toMatch(/^This is the transcript/);
    const ko = parseLabelled(
      '제목: 할머니 구술\n일시: 2024년 3월 1일\n장소: 대전 할머니 댁\n\n면담자: 어디서 태어나셨어요\n구술자: 부산에서 태어났어요.\n면담자: 아버지는요\n구술자: 배를 고치셨어요.',
    )!;
    expect(ko.segs.map((s) => s.speaker)).toEqual(['면담자', '구술자', '면담자', '구술자']);
    expect(ko.notices).toEqual({ linesDropped: 3 });
    expect(
      parseLabelled(
        "Grandma Sunja's Story\n\nInterviewer: Where?\nGrandma: Busan.\nInterviewer: Then?\nGrandma: Seoul.",
      )!.notices,
    ).toEqual({ linesDropped: 1 });
    // below the first turn nothing is a header: a line there is somebody's, and is kept
    const mid = parseLabelled(
      'Interviewer: Where were you born?\nGrandma: In Busan.\n\nDate: March 4, 2024\n\nInterviewer: And your father?\nGrandma: He fixed boats.',
    )!;
    expect(mid.segs.map((s) => s.text).join(' ')).toMatch(/March 4/);
    expect(mid.notices).toBeUndefined();
  });

  it('an oral-history header block names people; it is nobody’s words, and it names the interviewee', () => {
    const raw = parseLabelled(
      'Interviewee: Sunja Kim\nInterviewer: Noah Kim\nDate: March 1, 2024\n\nNoah: Where were you born?\nSunja: In Busan.\nNoah: When?\nSunja: In 1946.',
    )!;
    expect(raw.segs.map((s) => s.speaker)).toEqual(['Noah', 'Sunja', 'Noah', 'Sunja']);
    // a hint for the roles, not the sender's word (`interviewee` is the JSON's own key)
    expect(raw.intervieweeHint).toBe('Sunja');
    expect(raw.interviewee).toBeUndefined();
    expect(raw.notices).toEqual({ linesDropped: 3 });
    // a role used as the speaker label throughout is a speaker, not a header
    expect(
      parseLabelled(
        'Interviewer: Okay\nGrandma: Yes.\nInterviewer: Where were you born?\nGrandma: Busan.',
      )!.segs[0]!.speaker,
    ).toBe('Interviewer');
  });

  it('a transcriber’s note and the lines before the first header line are counted, never silently gone', () => {
    const raw = parseHeaderText(
      prepareText(
        'My father fixed boats\nSpeaker 1  0:05\nWhere?\nSpeaker 2  0:09\nIn Busan.\nNote: the tape ran out\nSpeaker 1  0:21\nAnd then?\nTranscribed by https://otter.ai',
      ),
    )!;
    expect(raw.segs[0]).toMatchObject({ speaker: null, text: 'My father fixed boats' });
    expect(raw.notices).toEqual({ unlabelledStart: 1, linesDropped: 2 });
    expect(raw.segs.map((s) => s.text).join(' ')).not.toMatch(/otter|tape ran out/);
  });
});

describe('P1-4 subtitles keep every word', () => {
  it('a blank line inside a cue, words on the timing line, and cue numbers never in the words', () => {
    const blank = parseSubtitles(
      '1\n00:00:01,000 --> 00:00:04,000\n[SPEAKER_01]: Where were you born?\n\n2\n00:00:05,000 --> 00:00:12,000\n[SPEAKER_00]: In Busan, by the harbour.\n\nMy father fixed boats there for forty years.\n\n3\n00:00:13,000 --> 00:00:15,000\n[SPEAKER_01]: And your mother?\n',
    )!;
    expect(blank.segs.map((s) => s.text)).toEqual([
      'Where were you born?',
      'In Busan, by the harbour. My father fixed boats there for forty years.',
      'And your mother?',
    ]);
    const onTiming = parseSubtitles(
      '1\n00:00:01,000 --> 00:00:04,000 [SPEAKER_01]: Where were you born?\n\n2\n00:00:05,000 --> 00:00:12,000 align:start position:10% [SPEAKER_00]: In Busan.\n\n3\n00:00:13,000 --> 00:00:15,000 [SPEAKER_01]: And then?\n',
    )!;
    expect(onTiming.segs.map((s) => [s.speaker, s.text])).toEqual([
      ['SPEAKER_01', 'Where were you born?'],
      ['SPEAKER_00', 'In Busan.'],
      ['SPEAKER_01', 'And then?'],
    ]);
    // a cue number on its own, with a blank line before its timing
    expect(
      parseSubtitles(
        '1\n\n00:00:01,000 --> 00:00:04,000\nHello there.\n\n2\n\n00:00:05,000 --> 00:00:08,000\nGood morning.\n',
      )!.segs.map((s) => s.text),
    ).toEqual(['Hello there.', 'Good morning.']);
  });

  it('a WebVTT comment block and the header are not words; text before the first cue is counted', () => {
    const vtt = parseSubtitles(
      'WEBVTT\nKind: captions\n\nNOTE made by a machine\nsecond line of the note\n\n00:01.000 --> 00:04.000\nHello.\n\n00:04.000 --> 00:06.000\nHi.\n',
    )!;
    expect(vtt.segs.map((s) => s.text)).toEqual(['Hello.', 'Hi.']);
    expect(vtt.notices).toBeUndefined();
    const titled = parseSubtitles(
      'Interview with Grandma\n\n1\n00:00:01,000 --> 00:00:04,000\nHello.\n\n2\n00:00:05,000 --> 00:00:08,000\nHi.\n',
    )!;
    expect(titled.notices).toEqual({ linesDropped: 1 });
  });
});

describe('P1-5 a long answer of short lines is read in linear time', () => {
  it('400,000 and 800,000 characters of continuation lines', () => {
    for (const n of [400_000, 790_000]) {
      const text = `Noah: Where were you born?\nGrandma: I was born\n${'in a little house by the harbour\n'.repeat(Math.ceil(n / 33)).slice(0, n)}`;
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        parseLabelled(prepareText(text));
        best = Math.min(best, performance.now() - t0);
      }
      expect(best).toBeLessThan(250);
    }
  });
});

describe('P1-6 Teams VTT with unpadded times', () => {
  it('"0:0:5.120" is a cue time, and the voices are read', () => {
    const t = parseSubtitles(
      'WEBVTT\n\n0:0:0.0 --> 0:0:5.120\n<v Noah Kim>Where were you born?</v>\n\n0:0:5.120 --> 0:0:9.400\n<v Sunja Kim>In Busan.</v>\n\n0:0:9.400 --> 0:0:12.0\n<v Noah Kim>And your father?</v>\n',
    )!;
    expect(t.segs.map((s) => [s.speaker, s.start, s.end, s.text])).toEqual([
      ['Noah Kim', 0, 5.12, 'Where were you born?'],
      ['Sunja Kim', 5.12, 9.4, 'In Busan.'],
      ['Noah Kim', 9.4, 12, 'And your father?'],
    ]);
  });
});

describe('P1-7 label styles people type', () => {
  const expected = [
    ['Noah', 'Where were you born?'],
    ['Grandma', 'In Busan, by the harbour.'],
    ['Noah', 'And your father?'],
    ['Grandma', 'He fixed boats.'],
  ];
  it.each([
    [
      'markdown bold',
      '**Noah:** Where were you born?\n**Grandma:** In Busan, by the harbour.\n**Noah**: And your father?\n**Grandma**: He fixed boats.',
    ],
    [
      'a list',
      '- Noah: Where were you born?\n- Grandma: In Busan, by the harbour.\n- Noah: And your father?\n- Grandma: He fixed boats.',
    ],
    [
      'a chat log',
      '<Noah> Where were you born?\n<Grandma> In Busan, by the harbour.\n<Noah> And your father?\n<Grandma> He fixed boats.',
    ],
    [
      '"said:"',
      'Noah said: Where were you born?\nGrandma said: In Busan, by the harbour.\nNoah said: And your father?\nGrandma said: He fixed boats.',
    ],
    [
      'a dash',
      'Noah - Where were you born?\nGrandma - In Busan, by the harbour.\nNoah — And your father?\nGrandma — He fixed boats.',
    ],
  ])('%s', (_style, text) => {
    expect(parseLabelled(text)!.segs.map((s) => [s.speaker, s.text])).toEqual(expected);
  });

  it('used once, a dash or "said:" is part of a sentence', () => {
    expect(
      parseLabelled(
        'Interviewer: Where did you live?\nGrandma: In Busan.\nBusan - that is where my father worked.\nInterviewer: And then?\nGrandma: We moved.',
      )!.segs.map((s) => s.speaker),
    ).toEqual(['Interviewer', 'Grandma', 'Interviewer', 'Grandma']);
    expect(
      parseLabelled(
        'Interviewer: What did she say?\nMom: One thing.\nGrandma said: eat first, talk later.\nInterviewer: Did you?\nMom: Never.',
      )!.segs.map((s) => s.speaker),
    ).not.toContain('Grandma');
  });

  it('a label typed in another case is the same speaker, not part of the question above it', () => {
    const raw = parseLabelled(
      'Interviewer: Did you have brothers?\ngrandma: Four.\nInterviewer: Older or younger?\nGRANDMA: All older.\nInterviewer: And your father?\nGrandma: He fixed boats.\nInterviewer: Thank you.\nGrandma: Thank you.',
    )!;
    expect(raw.segs.map((s) => [s.speaker, s.text])).toEqual([
      ['Interviewer', 'Did you have brothers?'],
      ['Grandma', 'Four.'],
      ['Interviewer', 'Older or younger?'],
      ['Grandma', 'All older.'],
      ['Interviewer', 'And your father?'],
      ['Grandma', 'He fixed boats.'],
      ['Interviewer', 'Thank you.'],
      ['Grandma', 'Thank you.'],
    ]);
  });
});

describe('the new patterns are linear on 400,000 characters', () => {
  const N = 400_000;
  const big = (s: string) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  it.each([
    ['colons after long words', big('abcdefghijklmnopqrstuvwxyz: ')],
    ['colons after many short words', big('a b c d e: ')],
    ['brackets and colons', big('[a b c]: ')],
    ['bracketed ids without colons', big('[SPEAKER_00] x ')],
    ['notes in brackets before colons', big('x (a b c): ')],
    ['times before labels', big('[00:12] Noah: x ')],
    ['header fields', big('Date: March 1, 2024\n')],
    ['date lines', big('2024년 3월 1일 녹음\n')],
    ['bold labels', big('**Noah:** x\n')],
    ['dash labels', big('Noah - x\n')],
    ['chat labels', big('<Noah> x\n')],
    [
      'cue lines with settings',
      `1\n00:00:01,000 --> 00:00:02,000 ${big('align:start ')}\n\n2\n00:00:02,000 --> 00:00:03,000\nhi\n`,
    ],
    [
      'one cue, many labels',
      `1\n00:00:01,000 --> 00:00:02,000\n${big('[Host]: a [Grandma]: b ')}\n\n2\n00:00:02,000 --> 00:00:03,000\nhi\n`,
    ],
  ])('%s', (_name, text) => {
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      try {
        parseTranscript(text);
      } catch {
        /* refusing is fine; hanging is not */
      }
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(1000);
  });
});

describe('a numbered speaker among its family of labels (found by P2 after P1 finished)', () => {
  it('"Grandma 2:" used once beside "Grandma:" is a speaker of its own, not part of the interviewer', () => {
    const text = [
      'Interviewer: Where were you born?',
      'Grandma: In Busan.',
      'Interviewer: And your father?',
      'Grandma: He repaired boats.',
      'Interviewer: Who is with you today?',
      'Grandma 2: I am her sister, I came from Daegu this morning.',
      'Interviewer: Thank you both.',
      'Grandma: Of course.',
    ].join('\n');
    const turns = parseTranscript(text).turns;
    const sister = turns.find((t) => t.text.includes('her sister'));
    expect(sister?.speaker).toBe('Grandma 2');
    // and her words are in nobody else's turn
    expect(turns.filter((t) => t.text.includes('her sister'))).toHaveLength(1);
    expect(
      turns.find((t) => t.speaker === 'Interviewer' && t.text.includes('sister')),
    ).toBeUndefined();
  });

  it('a sentence that merely contains a colon is still prose ("Rule 1: never lie.")', () => {
    const text = [
      'Interviewer: What did your father teach you?',
      'Grandma: He had one rule. Rule 1: never lie.',
      'Interviewer: And the second?',
      'Grandma: Rule 2: never borrow.',
      'Interviewer: Thank you.',
      'Grandma: Of course.',
    ].join('\n');
    const turns = parseTranscript(text).turns;
    expect(new Set(turns.map((t) => t.speaker))).toEqual(new Set(['Interviewer', 'Grandma']));
  });
});

/*
 * Round 3. Reviewers re-tested the committed readers: header detection had spread below the
 * first turn and dropped the relative's lines; a colon in her sentence made a speaker of the
 * word before it; a list in her answer became speakers; a cue of digits was lost. Each input
 * below is one of theirs.
 */
const said = (input: string) =>
  parseTranscript(input)
    .turns.map((t) => t.text)
    .join('\n')
    .toLowerCase();
const codesOf = (input: string) => parseTranscript(input).warnings.map((w) => w.code);

describe('round 3 · P1-A1 below the first turn every line is somebody’s, and is kept', () => {
  const otter = (answer: string) =>
    `Noah  0:00\nHow was it?\n\nGrandma  0:04\n${answer}\n\nNoah  0:20\nReally?\n\nGrandma  0:22\nYes, really.`;
  it.each([
    [
      'a continuation line that starts with a date',
      'Noah: When were you born?\nGrandma: I was told it was a cold day.\nMarch 3rd, 1946, in a little house by the harbour\nNoah: And your father?\nGrandma: He fixed boats.',
      'March 3rd, 1946, in a little house',
    ],
    [
      'an Otter answer that starts with a date',
      'Noah  0:00\nWhen were you born?\n\nGrandma  0:04\nMarch 3rd, 1946, in Busan\n\nNoah  0:10\nAnd your father?\n\nGrandma  0:13\nHe fixed boats near the harbour.',
      'March 3rd, 1946, in Busan',
    ],
    [
      'a Korean Otter answer that starts with a date',
      '참석자 1 00:00\n언제 태어나셨어요\n\n참석자 2 00:04\n1946년 3월에 태어났어요\n\n참석자 1 00:10\n아버지는 뭐 하셨어요\n\n참석자 2 00:13\n배를 고치셨어요',
      '1946년 3월에 태어났어요',
    ],
    [
      'a Korean continuation line that starts with a date',
      '면담자: 전쟁 때 어떠셨어요?\n할머니: 아주 무서웠지.\n1950년 6월 25일 새벽에 갑자기 포 소리가 났어요\n면담자: 그다음에는요?\n할머니: 피난을 갔지.',
      '1950년 6월 25일 새벽에',
    ],
    [
      'a Korean continuation line with a year and a season',
      '면담자: 언제 태어나셨어요?\n할머니: 부산에서 태어났지.\n1946년 봄에 태어났고 그때는 정말 가난했어요\n면담자: 아버지는요?\n할머니: 배를 고치셨지.',
      '1946년 봄에 태어났고',
    ],
    [
      'a header key in her sentence',
      'Noah: What was school like?\nGrandma: Time: that is what we never had. We worked from sunrise.\nNoah: And church?\nGrandma: Place: the old hall by the river, every Sunday.',
      'the old hall by the river',
    ],
    [
      '"Date:" opening a line of her answer',
      'Noah: Do you remember the day?\nGrandma: I do.\nDate: I remember the date because it was my birthday, March 3rd.\nNoah: Yes?\nGrandma: We had cake.',
      'i remember the date because it was my birthday',
    ],
    [
      '"Title:" on a line of her answer',
      'Noah: What did the sign say?\nGrandma: It said\nTitle: Chief Engineer of the Eastern Railway\nNoah: Wow.\nGrandma: Yes it did.',
      'chief engineer of the eastern railway',
    ],
    [
      'a web address in her answer',
      'Noah: Where can people read about it?\nGrandma: There is a website\nhttps://example.org/busan-history that has it\nNoah: Great.\nGrandma: Yes.',
      'busan-history',
    ],
    [
      '"Language:" opening a line of her answer',
      'Noah: What did you speak at home?\nGrandma: We spoke Korean.\nLanguage: it was forbidden at school, so we whispered.\nNoah: Hm.\nGrandma: Yes.',
      'it was forbidden at school',
    ],
    [
      'a Korean header key in her answer',
      '면담자: 학교는 어땠어요?\n할머니: 힘들었지.\n시간: 그게 제일 부족했어요 우리는 늘 일했으니까.\n면담자: 그렇군요.\n할머니: 네.',
      '그게 제일 부족했어요',
    ],
    [
      'an Otter paragraph that starts "Interviewed by"',
      otter('Interviewed by the newspaper in 1962, I was so nervous that I forgot my own name.'),
      'interviewed by the newspaper in 1962',
    ],
    [
      'an Otter paragraph that starts "Recorded"',
      otter('Recorded songs on a tape for my sister every Christmas.'),
      'recorded songs on a tape',
    ],
    [
      'an Otter paragraph that starts "Copyright"',
      otter('Copyright laws were different then, he patented it anyway.'),
      'copyright laws were different',
    ],
    [
      'an Otter paragraph that starts "Transcribed by"',
      otter('Transcribed by hand every letter that came from the front, he did.'),
      'transcribed by hand every letter',
    ],
    [
      'an Otter paragraph that starts "www"',
      otter('www dot something my grandson showed me, I never understood it.'),
      'www dot something',
    ],
  ])('%s', (_name, input, words) => {
    expect(said(input)).toContain(words.toLowerCase());
    expect(codesOf(input)).not.toContain('lines_dropped');
  });

  it('a line above the first label that is speech, not a header, is kept', () => {
    for (const [input, words] of [
      [
        'I will tell you the story\nNoah: Please do.\nGrandma: It began in Busan.\nNoah: And then?\nGrandma: We moved.',
        'I will tell you the story',
      ],
      [
        '그때 이야기를 해 드릴게요\n면담자: 네 말씀하세요.\n할머니: 부산에서 시작됐어요.\n면담자: 그다음에는요?\n할머니: 이사를 갔죠.',
        '그때 이야기를 해 드릴게요',
      ],
      [
        'Hi Grandma\n\nNoah: Hi, ready?\nGrandma: Yes.\nNoah: Where were you born?\nGrandma: Busan.',
        'Hi Grandma',
      ],
    ]) {
      const raw = parseLabelled(prepareText(input!))!;
      expect(raw.segs[0]).toMatchObject({ speaker: null, text: words });
      expect(raw.notices).toEqual({ unlabelledStart: 1 });
    }
  });

  it('a speaker whose label is a header key keeps every line: "Subject:", "Translator:"', () => {
    const subject =
      'Interviewer: Where were you born?\nSubject: In Busan, in a little house by the harbour.\nInterviewer: And your father?\nSubject: He repaired boats for forty years.\nInterviewer: Your mother?\nSubject: She sold fish at the market.';
    expect(turnsOf(subject).filter(([s]) => s === 'Subject')).toHaveLength(3);
    expect(codesOf(subject)).not.toContain('lines_dropped');
    const translator = [
      'Noah: Where were you born?',
      'Translator: She asks where you were born.',
      'Grandma: 부산에서 태어났어요.',
      'Translator: She says she was born in Busan, in a little house near the harbour.',
      'Noah: What did your father do?',
      'Translator: He asks what your father did for a living.',
      'Grandma: 배를 고치셨어요.',
      'Translator: She says he repaired boats for forty years and did not talk much.',
    ].join('\n');
    expect(turnsOf(translator).filter(([s]) => s === 'Translator')).toHaveLength(4);
    expect(codesOf(translator)).not.toContain('lines_dropped');
  });
});

describe('round 3 · P1-F2 in a file whose labels start its lines, a colon in a sentence is no speaker', () => {
  const ko = [
    '질문자: 어디서 태어나셨어요?',
    '할머니: 저는 1946년에 부산에서 태어났어요. 아버지는 배를 고치셨어요.',
    '질문자: 어머니는요?',
    '할머니: 어머니는 시장에서 생선을 파셨어요. 힘들다고 한 번도 안 하셨어요.',
    '질문자: 더 말씀해 주세요.',
  ];
  it.each([
    '어머니는 시장에서 생선을 파셨어요: 힘들다고 한 번도 안 하셨어요. 한 마디도요.',
    '그때 우리 집은 부산에서: 아주 작았어요. 방이 하나뿐이었어요.',
    '제 이름은 순자예요. 나이: 여든이고요. 고향은 부산이에요.',
    '우리는 여섯 식구였어요. 아버지 이름은 철수: 배를 고치셨고, 어머니는 영희: 생선을 파셨어요.',
    '그날은 비가 왔어요. 아침: 일찍 일어났고, 저녁: 늦게 잤어요. 정말 힘든 하루였어요.',
    '학교는 5학년까지 다녔어요. 이유는 간단해요: 돈이 없었어요. 그래도 선생님이 잘해 주셨어요.',
    '아이는 넷이에요. 큰애: 선생님, 둘째: 엔지니어, 막내: 의사가 됐어요.',
  ])('Korean: %s', (answer) => {
    const t = turnsOf([...ko, `할머니: ${answer}`].join('\n'));
    expect(new Set(t.map(([s]) => s))).toEqual(new Set(['질문자', '할머니']));
    expect(t[t.length - 1]).toEqual(['할머니', answer]);
  });

  const en = [
    'Noah: Where were you born?',
    'Grandma: I was born in Busan in 1946. My father repaired boats and he had big hands.',
    'Noah: And your mother?',
    'Grandma: My mother sold fish at the market. She never complained about it once.',
    'Noah: Tell me more.',
  ];
  it.each([
    'Why did we leave? Hunger: that was the whole reason, nothing else at all.',
    'What did we eat? Rice: every day, rice and kimchi and a little fish.',
    'Do you know what she said? Never: that was her answer to everything in life.',
    'I had four children. Mina: the eldest, Jae: the second, Tae: the third, Okja: the baby.',
    'It was in the summer. Monday: we left. Tuesday: we arrived. Wednesday: we slept all day.',
    'We were poor. Father: Tae. Mother: Okja. We all lived in one room by the harbour.',
  ])('English: %s', (answer) => {
    const t = turnsOf([...en, `Grandma: ${answer}`].join('\n'));
    expect(new Set(t.map(([s]) => s))).toEqual(new Set(['Noah', 'Grandma']));
    expect(t[t.length - 1]).toEqual(['Grandma', answer]);
  });

  it('a paste that lost its line breaks still cuts at a name used once after a question', () => {
    expect(
      turnsOf(
        'Noah: Where were you born? Grandma: In Busan. Noah: And your father? Grandma: He fixed boats. Noah: Anyone else? Aunt Mi: I was there too.',
      ).map(([s]) => s),
    ).toEqual(['Noah', 'Grandma', 'Noah', 'Grandma', 'Noah', 'Aunt Mi']);
  });
});

describe('round 3 · P1-A6/A7/A9 a list, a cue of digits, a question on two lines', () => {
  it('a bulleted "- Name: …" list inside her answer is her words, not three speakers', () => {
    const t = turnsOf(
      [
        'Noah: Who were your brothers and sisters?',
        'Grandma: There were five of us in that little house near the harbour.',
        '- Jae: the eldest, who became a fisherman and never married',
        '- Min: the quiet one who loved books and went to Seoul',
        '- Sun: that is me, the third one in the middle',
        'Noah: And the youngest?',
        'Grandma: Ho, he was the baby of the family and we all spoiled him.',
      ].join('\n'),
    );
    expect(new Set(t.map(([s]) => s))).toEqual(new Set(['Noah', 'Grandma']));
    expect(t[1]![1]).toMatch(/Jae: the eldest[\s\S]*Min: the quiet one[\s\S]*Sun: that is me/);
    // a list of speakers is still read: the same bulleted names again and again
    expect(
      speakersOf(
        '- Noah: Where were you born?\n- Grandma: In Busan.\n- Noah: And then?\n- Grandma: Seoul.',
      ),
    ).toEqual(['Noah', 'Grandma']);
  });

  it('a cue whose whole text is a number is kept; a number right before a timing is its index', () => {
    const vtt = parseSubtitles(
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nWhen were you born?\n\n00:00:03.500 --> 00:00:05.000\n1946\n\n00:00:05.500 --> 00:00:08.000\nAnd your father?\n\n00:00:08.500 --> 00:00:12.000\nHe fixed boats.\n',
    )!;
    expect(vtt.segs.map((s) => s.text)).toEqual([
      'When were you born?',
      '1946',
      'And your father?',
      'He fixed boats.',
    ]);
    const srt = parseSubtitles(
      '1\n00:00:01,000 --> 00:00:03,000\nHow many brothers?\n\n2\n00:00:03,500 --> 00:00:05,000\n4\n\n3\n00:00:05,500 --> 00:00:08,000\nAnd sisters?\n\n4\n00:00:08,500 --> 00:00:12,000\n2\n',
    )!;
    expect(srt.segs.map((s) => s.text)).toEqual(['How many brothers?', '4', 'And sisters?', '2']);
  });

  it('in an Interviewer-only file a question that goes on to a second line stays a question', () => {
    const t = turnsOf(
      "Interviewer: Let's talk about your childhood.\nWhere were you born, and what was it like there?\nIn Busan, in a little house near the harbour.\nInterviewer: And your father?\nHe repaired boats.",
    );
    expect(t[0]).toEqual([
      'Interviewer',
      "Let's talk about your childhood. Where were you born, and what was it like there?",
    ]);
    expect(t[1]![1]).toMatch(/^In Busan/);
    // and a Korean request on the second line
    const ko = turnsOf(
      '면담자: 어린 시절 이야기를 해 볼게요.\n고향이 어디인지 말씀해 주세요.\n부산이에요. 항구 근처였어요.\n면담자: 아버지는요?\n배를 고치셨어요.',
    );
    expect(ko[0]![1]).toMatch(/말씀해 주세요/);
    expect(ko[1]![1]).toMatch(/^부산이에요/);
  });
});

describe('round 3 · P1-A8 a run-on paste whose labels were not read is never one voice at HIGH', () => {
  it('lower-case labels that take turns are read', () => {
    expect(
      turnsOf(
        'noah: where were you born grandma: in busan noah: and your father grandma: he repaired boats noah: and your mother grandma: she sold fish',
      ).map(([s]) => s),
    ).toEqual(['noah', 'grandma', 'noah', 'grandma', 'noah', 'grandma']);
  });

  it('a one-word name ending in a number, and a family name with a small word in it', () => {
    expect(
      speakersOf(
        'Mom2: Where were you born? P1: In Busan. Mom2: And your father? P1: He repaired boats. Mom2: Mother? P1: She sold fish.',
      ),
    ).toEqual(['Mom2', 'P1']);
    const t = turnsOf(
      'Noah: Where were you born? Mary Ann de Souza: In Busan. Noah: And your father? Mary Ann de Souza: He repaired boats. Noah: Mother? Mary Ann de Souza: She sold fish.',
    );
    expect(new Set(t.map(([s]) => s))).toEqual(new Set(['Noah', 'Mary Ann de Souza']));
    expect(t[0]).toEqual(['Noah', 'Where were you born?']);
  });

  it('a name right after a label is the first word of that turn ("Grandma: Mina: the baker.")', () => {
    const t = turnsOf(
      'Noah: Who lived nearby? Grandma: Mina: the baker. Jae: the fisherman. Mina: she gave us bread. Noah: Others? Grandma: Mr. Baek: the tailor. Noah: Thanks. Grandma: Welcome.',
    );
    expect(new Set(t.map(([s]) => s))).toEqual(new Set(['Noah', 'Grandma']));
    expect(t[1]).toEqual([
      'Grandma',
      'Mina: the baker. Jae: the fisherman. Mina: she gave us bread.',
    ]);
  });

  it('the same word before a colon three times in one voice asks; prose with colons does not', () => {
    expect(
      codesOf(
        'noah: where were you born grandma in busan noah: and your father grandma he repaired boats noah: and your mother',
      ),
    ).toContain('labels_unclear');
    expect(
      codesOf(
        'My mother was strict. She said: eat first. Then he said: no. She said: why not. He said: because.',
      ),
    ).not.toContain('labels_unclear');
    expect(
      codesOf(
        'My mother had one rule: never waste rice. And a second rule: be kind to the neighbours.',
      ),
    ).not.toContain('labels_unclear');
    // "my rule: … another rule: …" in lower case is no pair of speakers taking turns
    expect(
      speakersOf('one rule: be kind. another rule: be brave. one rule: eat. another rule: sleep.'),
    ).toHaveLength(1);
  });
});

describe('round 3 · P1-F1 what is above the first turn and says it is a header is left out, and counted', () => {
  const body = [
    'Noah: Where did Grandpa work?',
    'Grandma: He worked at the shipyard in Ulsan for thirty-one years.',
    'Noah: Did he like it?',
    'Grandma: He did not like it, but he never said so.',
  ];
  const quoted = body.map((l) => `> ${l}`);
  it.each([
    ['a quoted attribution', ['> On Mon, May 4, 2026 at 9:12 AM Noah Kim wrote:', ...quoted], 1],
    [
      'a Gmail attribution',
      ['On Mon, May 4, 2026 at 9:12 AM Noah Kim <noah@example.com> wrote:', '', ...quoted],
      1,
    ],
    [
      'an Apple Mail attribution',
      ['On May 4, 2026, at 9:12 AM, Noah Kim <noah@example.com> wrote:', '', ...quoted],
      1,
    ],
    [
      'a Korean Gmail attribution',
      ['2026년 5월 4일 (월) 오전 9:12, Noah Kim <noah@example.com>님이 작성:', '', ...quoted],
      1,
    ],
    [
      'an Outlook header',
      [
        'From: Noah Kim',
        'Sent: Monday, May 4, 2026 9:12 AM',
        'To: Grandma',
        'Subject: Interview notes',
        '',
        ...body,
      ],
      4,
    ],
    [
      'an original message',
      ['-----Original Message-----', 'From: Noah Kim', 'Date: May 4, 2026', '', ...body],
      3,
    ],
    ['a tape and a part', ['Tape 2, side A', 'Part 2', ...body], 2],
  ])('%s', (_name, lines, count) => {
    const p = parseTranscript(lines.join('\n'));
    expect(p.turns.map((t) => t.speaker)).toEqual(['Noah', 'Grandma', 'Noah', 'Grandma']);
    expect(p.warnings).toContainEqual({ code: 'lines_dropped', count });
  });

  const otter = [
    'Noah Kim  0:02',
    'Where were you born?',
    '',
    'Sunja Kim  0:09',
    'I was born in Busan in 1946.',
    '',
    'Noah Kim  0:16',
    'What was your mother like?',
    '',
    'Sunja Kim  0:23',
    'My mother sold fish at the market.',
  ];
  it('an Otter export header: the title above its date, the summary keywords and the speakers', () => {
    const p = parseTranscript(
      [
        "Grandma Sunja's story",
        'Tue, 5/12 9:15AM • 45:30',
        '',
        'SUMMARY KEYWORDS',
        'family, busan, boats, mother, school, handwriting',
        '',
        'SPEAKERS',
        'Noah Kim, Sunja Kim',
        '',
        ...otter,
      ].join('\n'),
    );
    expect(p.turns.map((t) => t.speaker)).toEqual([
      'Noah Kim',
      'Sunja Kim',
      'Noah Kim',
      'Sunja Kim',
    ]);
    expect(p.warnings).toEqual([{ code: 'lines_dropped', count: 6 }]);
  });

  it('a Teams header: title, date and duration', () => {
    const p = parseTranscript(
      ['Interview with Grandma', 'May 3, 2026, 3:21PM', '45m 12s', '', ...otter].join('\n'),
    );
    expect(p.turns[0]!.speaker).toBe('Noah Kim');
    expect(p.warnings).toEqual([{ code: 'lines_dropped', count: 3 }]);
  });

  it('"Speaker 1 = Noah Kim, Speaker 2 = Sunja Kim" names the voices', () => {
    const turns = [
      'Speaker 1: Where were you born?',
      'Speaker 2: I was born in Busan in 1946.',
      'Speaker 1: What was your mother like?',
      'Speaker 2: My mother sold fish.',
    ];
    for (const lines of [
      ['Speaker 1 = Noah Kim, Speaker 2 = Sunja Kim', '', ...turns],
      [
        'Speaker 1 = Noah Kim, Speaker 2 = Sunja Kim',
        '',
        ...turns.map((l, i) => `[00:00:0${i}] ${l}`),
      ],
    ]) {
      const p = parseTranscript(lines.join('\n'));
      expect(p.turns.map((t) => t.speaker)).toEqual([
        'Noah Kim',
        'Sunja Kim',
        'Noah Kim',
        'Sunja Kim',
      ]);
      expect(p.warnings).toContainEqual({ code: 'lines_dropped', count: 1 });
    }
  });
});

describe('round 3 · the new patterns are linear on 400,000 characters', () => {
  const N = 400_000;
  const big = (s: string) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const turns = '\nNoah: Where?\nGrandma: Busan.\nNoah: When?\nGrandma: 1946.';
  let distinct = '';
  for (let i = 0; distinct.length < N; i++) distinct += `w${i}: x `;
  it.each([
    ['a lead of date and time lines', big('Tue, 5/12 9:15AM • 45:30\n') + turns],
    ['a lead of tape and part lines', big('Tape 2, side A\n') + turns],
    ['one long attribution-like line', `On ${'x '.repeat(N / 2)} wrote:${turns}`],
    ['one long Korean attribution-like line', `${'가 '.repeat(N / 2)}님이 작성:${turns}`],
    ['one long mapping-like line', big('Speaker 1 = Noah Kim, ') + turns],
    [
      'header keys used as labels',
      big('Subject: In Busan, in a little house.\nInterviewer: Then?\n'),
    ],
    ['lower-case labels taking turns', big('noah: where grandma: busan ')],
    ['lower-case words before colons, one after another', big('a b c d e: ')],
    ['a different word before every colon', distinct.slice(0, N)],
    ['bulleted names', big('- Jae: the eldest\n') + turns],
    ['labels right after labels', big('Noah: Grandma: Mina: x ')],
  ])('%s', (_name, text) => {
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      try {
        parseTranscript(text);
      } catch {
        /* refusing is fine; hanging is not */
      }
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(1000);
  });
});
