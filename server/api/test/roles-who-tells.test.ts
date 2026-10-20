import { describe, expect, it } from 'vitest';
import { applyRoles, assignRoles, parseTranscript, type Turn } from '../src/transcript';

/**
 * Round 2: every word a relative said ends up in a turn that goes to the pipeline as the
 * TELLER's, or the system ASKS. Each case below was once saved at HIGH confidence with words
 * missing, or with the interviewer as "the relative".
 */

const turns = (...xs: Array<[string, string]>): Turn[] =>
  xs.map(([speaker, text], index) => ({ index, speaker, text, start: null, end: null }));
const read = (input: unknown, named?: string[]) => applyRoles(parseTranscript(input), named);
/** the teller's words as the pipeline will see them */
const told = (r: ReturnType<typeof read>) =>
  r.turns
    .filter((t) => r.roles.interviewees.includes(t.speaker))
    .map((t) => t.text)
    .join(' ');
/** what the person sees: either her words are hers, or the import asks first */
const keptOrAsked = (r: ReturnType<typeof read>, words: string) =>
  r.roles.needsConfirmation || told(r).includes(words);

describe('one odd label among the teller’s turns (e2e K11)', () => {
  const story = (odd: string) =>
    [
      'Noah: Where were you born, and what was your father like?',
      'Grandma: I was born in Busan in 1946. My father repaired boats and he had big hands, and he did not talk much at all.',
      'Noah: And your mother?',
      'Grandma: My mother sold fish at the market. She came home after sunset every single day, and she never complained.',
      'Noah: Tell me about school.',
      `${odd}: I only finished fifth grade, but my teacher said I had the most beautiful handwriting in the class.`,
      'Noah: And work?',
      'Grandma: At eighteen I started at a textile factory in Daegu and I gave my whole pay to my mother.',
      'Noah: Did you enjoy it?',
      'Grandma: Not at all, but we needed the money, so I never said a word about it to anyone.',
    ].join('\n');

  it.each(['grandma', 'GRANDMA', 'Grandma.', '(Grandma)'])(
    '«%s:» is the same speaker: her answer is hers, nothing asked',
    (odd) => {
      const r = read(story(odd));
      expect(r.roles.interviewees).toEqual(['Grandma']);
      expect(told(r)).toContain('I only finished fifth grade');
    },
  );

  it.each(['Granny', 'Sunja', 'Grandam', 'Granma', 'Grandma Sunja', 'Grandma 2'])(
    '«%s:» may be her or someone else: never silently an interviewer, the import asks',
    (odd) => {
      const r = read(story(odd));
      expect(keptOrAsked(r, 'I only finished fifth grade')).toBe(true);
      expect(r.roles.needsConfirmation).toBe(true);
      expect(r.roles.reasons).toContain('others_may_tell');
    },
  );

  it('spellings that differ only in case or punctuation are folded, and the caller is told', () => {
    const r = parseTranscript(
      'Noah: Where were you born?\nGrandma: In Busan.\nNoah: And then?\nGrandma.: We moved to Daegu.\nNoah: Why?\nGrandma: For work.',
    );
    expect(new Set(r.turns.map((t) => t.speaker))).toEqual(new Set(['Noah', 'Grandma']));
    expect(r.warnings).toContainEqual({ code: 'labels_merged', count: 1 });
    // two people whose names differ by one letter are never folded
    const two = parseTranscript(
      'Noah: Hi.\nGrandma: Hello there.\nGrandpa: Hello, Noah.\nNoah: Ready?\nGrandma: Yes.\nGrandpa: Yes.',
    );
    expect(new Set(two.turns.map((t) => t.speaker))).toEqual(
      new Set(['Noah', 'Grandma', 'Grandpa']),
    );
  });
});

describe('a long statement under the interviewer’s id (diarization, e2e K1b)', () => {
  const seg = (i: number, sp: string, text: string) => ({
    start: i * 10,
    end: i * 10 + 9,
    speaker: sp,
    text,
  });
  const pad =
    ' Those were the years when everything we ate we grew ourselves, and everything we wore my mother sewed by hand.';

  it('asks, instead of filing her winter story as a question', () => {
    const r = read({
      segments: [
        seg(0, 'SPEAKER_01', 'Where did you grow up?'),
        seg(1, 'SPEAKER_00', `I grew up in a village near Jeonju.${pad}`),
        seg(2, 'SPEAKER_01', 'What was it like in winter?'),
        seg(
          3,
          'SPEAKER_01',
          'In winter the snow came up to the windows and we dug tunnels to the well every morning before school.',
        ),
        seg(4, 'SPEAKER_01', 'And your mother?'),
        seg(5, 'SPEAKER_00', `My mother kept bees in the back garden.${pad}`),
        seg(6, 'SPEAKER_01', 'Did you help her?'),
        seg(7, 'SPEAKER_00', `Yes, I carried the jars, and I was stung nearly every week.${pad}`),
      ],
    });
    expect(r.roles).toMatchObject({ interviewees: ['SPEAKER_00'], needsConfirmation: true });
    expect(r.roles.reasons).toContain('others_may_tell');
  });

  it('an interviewer who opens a question with a long remark is still just the interviewer', () => {
    const r = assignRoles(
      turns(
        [
          'SPEAKER_01',
          'I remember when I was little we used to visit you every summer and I loved the garden. What was the house like?',
        ],
        [
          'SPEAKER_00',
          'Small, two rooms and one stove for eight people, and my mother grew peppers in the little garden behind it. In the summer we slept outside on the flat roof because it was too hot inside, and my father told us stories about the sea until we fell asleep.',
        ],
        [
          'SPEAKER_01',
          'Mom always says you were the one who kept everybody fed during the war years. How did you manage?',
        ],
        [
          'SPEAKER_00',
          'We grew what we could and we traded the rest, and nobody in our street went hungry, not once, not even in winter. My mother kept a jar of rice under the floor for the neighbours, and she never told my father how much of it she gave away.',
        ],
      ),
    );
    expect(r).toMatchObject({ interviewees: ['SPEAKER_00'], confidence: 'high' });
  });
});

describe('a second relative who only answers briefly (no role labels)', () => {
  it('asks, so "Nineteen sixty." and "In Busan." are not silently the interviewer’s', () => {
    const r = read(
      [
        'Noah: Where were you born?',
        'Grandma: In Busan, in a little house by the harbour, in nineteen forty-six, the spring after the war ended.',
        'Noah: When did you two meet?',
        'Grandpa: Nineteen sixty.',
        'Grandma: At church, on a Sunday, and I thought he was far too loud for a church.',
        'Noah: Where?',
        'Grandpa: In Busan.',
        'Noah: And your mother?',
        'Grandma: She sold fish at the market every morning, before the sun was up, and she never once complained.',
      ].join('\n'),
    );
    expect(r.roles.needsConfirmation).toBe(true);
    expect(r.roles.reasons).toContain('others_may_tell');
  });

  it('a third person’s passing remark after her story asks nothing', () => {
    const r = assignRoles(
      turns(
        ['Noah', 'Where were you born?'],
        [
          'Grandma',
          'In Busan, in a little house by the harbour, in nineteen forty-six, the spring after the war ended.',
        ],
        ['Aunt June', 'Tea?'],
        ['Noah', 'And your father?'],
        [
          'Grandma',
          'He repaired boats down at the harbour and he did not talk much at all, not even at dinner.',
        ],
      ),
    );
    expect(r).toMatchObject({ interviewees: ['Grandma'], confidence: 'high' });
  });
});

describe('a header naming who is who (parser #2)', () => {
  const body: Array<[string, string]> = [
    ['Noah', 'Where were you born?'],
    ['Sunja', 'In Busan.'],
    ['Noah', 'When?'],
    ['Sunja', 'In 1946, in the spring.'],
    ['Noah', 'What did your father do?'],
    ['Sunja', 'He fixed boats.'],
  ];

  it('"Interviewee: Sunja Kim" never makes "Interviewee" the teller; it names Sunja', () => {
    const r = assignRoles(
      turns(['Interviewee', 'Sunja Kim'], ['Interviewer', 'Noah Kim Date: March 1, 2024'], ...body),
    );
    expect(r).toMatchObject({ interviewees: ['Sunja'], confidence: 'high' });
    expect(r.reasons).toContain('label_says_interviewer');
  });

  it('a header naming nobody who speaks decides nothing', () => {
    const r = assignRoles(turns(['Interviewee', 'Grandma Rose'], ...body));
    expect(r.interviewees).not.toContain('Interviewee');
  });

  it('end to end, the oral-history sample keeps every answer of hers', () => {
    const r = read(
      `Interviewee: Sunja Kim\nInterviewer: Noah Kim\nDate: March 1, 2024\n\n${body.map(([s, t]) => `${s}: ${t}`).join('\n')}`,
    );
    expect(r.roles.interviewees).toEqual(['Sunja']);
    for (const [s, t] of body) if (s === 'Sunja') expect(told(r)).toContain(t);
  });
});

describe('role labels and questions written without "?" (parser #3, e2e E10)', () => {
  it('Narrator tells and Interviewer asks', () => {
    const r = read(
      [
        'Interviewer: Where is your hometown',
        'Narrator: Busan. I was born in a small house by the sea.',
        'Interviewer: When were you born',
        'Narrator: In the spring of 1946.',
        'Interviewer: And your father',
        'Narrator: He repaired boats.',
      ].join('\n'),
    );
    expect(r.roles).toMatchObject({ interviewees: ['Narrator'], confidence: 'high' });
  });

  it('a normal interview transcribed without "?" is a sure answer, not a question to the family', () => {
    const r = read({
      segments: [
        ['SPEAKER_01', 'Grandma where were you born'],
        ['SPEAKER_00', 'In Busan, in Yeongdo. There was a little house right by the sea.'],
        ['SPEAKER_01', 'Tell me about your father'],
        [
          'SPEAKER_00',
          'He repaired boats and he did not talk much at all. But he was always kind to me.',
        ],
        ['SPEAKER_01', 'What was the house like'],
        ['SPEAKER_00', 'Two rooms for six of us. In winter we made do with one stove.'],
        ['SPEAKER_01', 'Did you go to school'],
        ['SPEAKER_00', 'Until the fifth grade. After that I helped out at the market.'],
      ].map(([speaker, text], i) => ({ start: i * 10, end: i * 10 + 9, speaker, text })),
    });
    expect(r.roles).toMatchObject({
      interviewees: ['SPEAKER_00'],
      confidence: 'high',
      needsConfirmation: false,
    });
  });
});

describe('a lone speaker labelled as the asker is never a sure teller (parser #4)', () => {
  it('everything under "Interviewer" (the relative’s label was not read): ask', () => {
    const r = assignRoles(
      turns(
        [
          'Interviewer',
          'Where were you born I was born in Busan. It was a small house by the sea.',
        ],
        ['Interviewer', 'My father repaired boats. He did not talk much at all.'],
      ),
    );
    expect(r).toMatchObject({ confidence: 'low', needsConfirmation: true });
    expect(r.reasons).toEqual(
      expect.arrayContaining(['monologue', 'label_says_interviewer', 'labels_unclear']),
    );
  });

  it('the same with "Q" and with "Host 2"', () => {
    for (const label of ['Q', 'Host 2', 'Moderator']) {
      const r = assignRoles(
        turns([label, 'We moved to Daegu in 1952 and my uncle found us a room.']),
      );
      expect(r.needsConfirmation).toBe(true);
    }
  });
});

describe('words before the first label, and answers with no speaker (e2e E2, parser #6)', () => {
  const STORY = [
    'Interviewer: Where were you born, and what was your father like?',
    'Grandma: I was born in Busan in 1946. My father repaired boats and he had big hands.',
    'Interviewer: And your mother?',
    'Grandma: My mother sold fish at the market. She came home after sunset every single day.',
    'Interviewer: Tell me about school.',
    'Grandma: I only finished fifth grade, but my teacher said I had beautiful handwriting.',
  ];
  const lead =
    'and that is why we never went back to the village after the flood, not even for the funerals.';

  it('a tape that starts mid-answer: those words are hers, chosen or guessed, and the caller is told', () => {
    for (const named of [undefined, ['Grandma']]) {
      const r = read([lead, ...STORY].join('\n'), named);
      expect(told(r)).toContain('we never went back to the village after the flood');
      expect(r.warnings).toContainEqual({ code: 'unlabelled_to_teller', count: 1 });
    }
  });

  it('a lead that is a question, or talk about the recording, is not hers', () => {
    for (const first of ['Where were you born', 'Okay, the recorder is on now, we can start.']) {
      const r = read([first, ...STORY.slice(1)].join('\n'));
      expect(told(r)).not.toContain(first.slice(0, 12));
    }
  });

  it('an answer the diarizer left with no speaker goes to her, and the guess asks first', () => {
    const qa: Array<[string, string]> = [
      [
        'Where were you born?',
        'In Busan, in a little house by the harbour, in nineteen forty-six.',
      ],
      [
        'What did your father do?',
        'He repaired boats down at the harbour and he hardly talked at dinner.',
      ],
      ['And your mother?', 'She sold fish at the market every morning, before the sun was up.'],
      [
        'Did you go to school?',
        'Until the fifth grade, and then I had to work in the market with her.',
      ],
    ];
    const segments: Array<Record<string, unknown>> = [];
    let t = 0;
    for (const [q, a] of qa) {
      segments.push({ start: t, end: t + 2, text: q, speaker: 'SPEAKER_01' });
      segments.push({ start: t + 2.1, end: t + 7, text: a, speaker: 'SPEAKER_00' });
      t += 8;
    }
    segments.splice(
      4,
      0,
      { start: 40, end: 41, text: 'Did you have brothers?', speaker: 'SPEAKER_01' },
      { start: 41.2, end: 42, text: 'Four. All older than me.' },
    );
    const guessed = read({ segments });
    expect(told(guessed)).toContain('Four. All older than me.');
    expect(guessed.roles.needsConfirmation).toBe(true);
    expect(guessed.turns.find((x) => x.text.includes('Did you have brothers'))!.text).not.toContain(
      'Four',
    );
    const chosen = read({ segments }, ['SPEAKER_00']);
    expect(told(chosen)).toContain('Four. All older than me.');
    expect(chosen.warnings).toContainEqual({ code: 'unlabelled_to_teller', count: 1 });
  });

  it('a passage with no speaker inside her own story still continues her story', () => {
    const p = parseTranscript({
      segments: [
        { start: 0, end: 4, text: 'What was your father like?', speaker: 'SPEAKER_01' },
        { start: 4, end: 20, text: 'He repaired boats. He had big hands.', speaker: 'SPEAKER_00' },
        { start: 20, end: 30, text: 'And he had a green truck.' },
        { start: 30, end: 34, text: 'And your mother?', speaker: 'SPEAKER_01' },
      ],
    });
    expect(p.turns.map((x) => x.speaker)).toEqual(['SPEAKER_01', 'SPEAKER_00', 'SPEAKER_01']);
  });
});

describe('her "Mm-hm." to a statement is her yes; a fold never makes her contradict herself (parser #10)', () => {
  it('"So you were born in Busan, in 1946." / "Mm-hm." stays', () => {
    const r = read(
      [
        'Interviewer: So you were born in Busan, in 1946.',
        'Grandma: Mm-hm.',
        'Interviewer: And your father repaired boats there.',
        'Grandma: He did that for forty years, every day, even on Sundays in the rain.',
      ].join('\n'),
    );
    expect(r.turns.filter((t) => t.speaker === 'Grandma').map((t) => t.text)).toContain('Mm-hm.');
  });

  it('the interviewer’s "Right?" before her "No, …" is not folded away', () => {
    const r = read(
      [
        'Interviewer: Tell me about your father.',
        'Grandma: My father fixed boats in Busan for forty years, until the war came.',
        'Interviewer: Right?',
        'Grandma: No, no, that was my uncle. My father was a teacher at the girls’ school.',
        'Interviewer: And your mother?',
        'Grandma: She sold fish at the market every single morning before the sun came up.',
      ].join('\n'),
    );
    expect(r.turns.map((t) => t.text)).toContain('Right?');
  });
});

describe('round 3: a normal interview is a sure answer in more registers', () => {
  it('a quiet interviewer who mostly says "Mm-hm." does not make the guess ask', () => {
    const lines: string[] = [];
    const story = [
      'I was born in Busan in a little house near the harbour, and my mother always said the boats were coming in.',
      'My father repaired boats. He had big hands and he did not talk much at all, but on Sundays he took me to the pier.',
      'She sold fish at the market. She left before dawn and came home after sunset every single day.',
      'We lived in a shack made of scrap boards and the wind came through the walls in winter.',
    ];
    lines.push('Noah: Where were you born?');
    for (const [i, s] of story.entries()) {
      lines.push(`Grandma: ${s}`);
      lines.push(`Noah: ${['Mm-hm.', 'I see.', 'Mm.', 'Wow.'][i]}`);
    }
    lines.push('Grandma: That is all I remember of that house.');
    const r = applyRoles(parseTranscript(lines.join('\n')));
    expect(r.roles).toMatchObject({ interviewees: ['Grandma'], confidence: 'high' });
  });

  it('short questions written without "?" in plain speech are a sure answer', () => {
    const qa: Array<[string, string]> = [
      ['where were you born', 'In Busan, in a little house near the harbour. It was small.'],
      [
        'when did you get married',
        'At twenty, through a matchmaker. Everyone did it that way then.',
      ],
      [
        'what work did you do',
        'I worked at a factory spinning thread. My hands were always cracked.',
      ],
      ['and your mom', 'She sold fish at the market. She left at dawn and came home at night.'],
    ];
    const r = applyRoles(
      parseTranscript(qa.flatMap(([q, a]) => [`Noah: ${q}`, `Grandma: ${a}`]).join('\n')),
    );
    expect(r.roles).toMatchObject({ interviewees: ['Grandma'], confidence: 'high' });
  });
});
