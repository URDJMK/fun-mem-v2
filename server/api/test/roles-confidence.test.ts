import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QUESTIONS, applyRoles, assignRoles, parseTranscript, type Turn } from '../src/transcript';

/**
 * Who is telling, and how sure we are. HIGH means "save without asking", so it must only be
 * said when the evidence agrees; anything else is confirmed by a person first.
 */

const turn = (index: number, speaker: string, text: string): Turn => ({
  index,
  speaker,
  start: null,
  end: null,
  text,
});
const turns = (...xs: Array<[string, string]>) => xs.map(([s, t], i) => turn(i, s, t));
const rolesOf = (text: string, named?: string | string[]) =>
  applyRoles(parseTranscript(text), named).roles;

describe('the labels say who asks', () => {
  it('an interviewer who prompts with statements and talks more than a terse relative', () => {
    const r = rolesOf(
      [
        'Interviewer: Tell me about your father and what he did for a living when you were growing up near the river.',
        'Grandpa Min: He was a signalman at the little station. Red lamp, green lamp.',
        'Interviewer: Describe the house you lived in and who else was living there with you at that time.',
        'Grandpa Min: Four rooms. My grandmother, my parents, three of us children.',
        'Interviewer: Now talk about the day your father retired from the railway and how the family marked it.',
        'Grandpa Min: We had a small party. He cried. I had never seen that before.',
      ].join('\n'),
    );
    expect(r).toMatchObject({
      interviewees: ['Grandpa Min'],
      confidence: 'high',
      needsConfirmation: false,
    });
    expect(r.reasons).toContain('label_says_interviewer');
  });

  it('labels the turns contradict (the "interviewer" only tells, the other only asks) are not trusted', () => {
    const r = assignRoles(
      turns(
        ['Interviewer', 'I was born in Busan, in a small house by the sea.'],
        ['Granddaughter', 'What was your father like?'],
        ['Interviewer', 'He repaired boats. He had big hands.'],
        ['Granddaughter', 'And your mother? Tell me about her.'],
      ),
    );
    expect(r).toMatchObject({ confidence: 'low', needsConfirmation: true });
    expect(r.reasons).toContain('prompts_like_questions');
  });

  it('"A" means the answerer only next to "Q": AssemblyAI calls its speakers A, B, C', () => {
    const qa = assignRoles(turns(['Q', 'Where were you born?'], ['A', 'In Busan, by the sea.']));
    expect(qa.interviewees).toEqual(['A']);
    expect(qa.reasons).toContain('label_says_interviewer');
    const ab = assignRoles(
      turns(
        ['A', 'Where were you born? Tell me everything.'],
        ['B', 'In Busan, by the sea, in a small house.'],
      ),
    );
    expect(ab.reasons).not.toContain('label_says_interviewer');
  });
});

describe('no labels: who talks, and how', () => {
  it('the one who talks most only prompts (no question marks): never picked silently', () => {
    const r = assignRoles(
      turns(
        [
          'SPEAKER_00',
          'Okay Grandma, today I want to hear about the house by the harbour that Mom always talks about. Tell me about it.',
        ],
        ['SPEAKER_01', 'It was small. Two rooms.'],
        [
          'SPEAKER_00',
          'Mom said your father built the second room himself, after the war, with wood from an old boat. Tell me about that.',
        ],
        ['SPEAKER_01', 'He did. It leaked.'],
      ),
    );
    expect(r).toMatchObject({ confidence: 'low', needsConfirmation: true });
    expect(r.reasons).toContain('prompts_like_questions');
  });

  it('an ordinary interview, the relative talking clearly more and the turns agreeing, is a sure answer', () => {
    const r = assignRoles(
      turns(
        ['SPEAKER_01', 'Where were you born?'],
        [
          'SPEAKER_00',
          'In Busan, in a little house near the harbour. My mother always said the boats were coming in the morning I was born.',
        ],
        ['SPEAKER_01', 'Tell me about your father.'],
        [
          'SPEAKER_00',
          'He repaired boats. He had big hands, and he did not talk much at all, but on Sundays he took me to the pier.',
        ],
      ),
    );
    expect(r).toMatchObject({
      interviewees: ['SPEAKER_00'],
      confidence: 'high',
      needsConfirmation: false,
    });
    expect(r.reasons).toEqual(['clear_majority']);
  });

  it('talking more is not enough when the other speaker does not ask either: medium, confirmed', () => {
    const r = assignRoles(
      turns(
        [
          'SPEAKER_00',
          'We had a farm with forty cows, and every morning my brothers did the milking before school.',
        ],
        ['SPEAKER_01', 'We kept the chickens.'],
        [
          'SPEAKER_00',
          'My father sold the milk in town, and my mother made cheese from what was left.',
        ],
        ['SPEAKER_01', 'I remember the cheese.'],
      ),
    );
    expect(r).toMatchObject({ confidence: 'medium', needsConfirmation: true });
  });
});

describe('more than one may be telling', () => {
  it('two relatives and an interviewer: both are tellers, and a person confirms', () => {
    const r = rolesOf(
      [
        "Interviewer: Let's talk about the flood. Aunt Mae, what do you remember?",
        'Aunt Mae: It was nineteen fifty-nine, in September. The river came up in the night and we carried the pigs up to the church.',
        'Uncle Joon: No no, it was sixty. I remember because I had just started at the mill.',
        'Aunt Mae: You were still at school, Joon. The teacher sent everybody home early.',
        'Interviewer: Uncle Joon, tell me more about your father.',
        'Uncle Joon: He was a stubborn man. But kind. He gave away half of every harvest to the widows in the village.',
      ].join('\n'),
    );
    expect([...r.interviewees].sort()).toEqual(['Aunt Mae', 'Uncle Joon']);
    expect(r).toMatchObject({ confidence: 'medium', needsConfirmation: true });
  });

  it('three unlabelled voices, a second one telling at length: others_may_tell, low', () => {
    const r = assignRoles(
      turns(
        ['SPEAKER_02', 'How did you two meet?'],
        [
          'SPEAKER_00',
          'We met at a church supper in nineteen sixty-six. He spilled soup on my good dress and was so embarrassed.'.repeat(
            2,
          ),
        ],
        [
          'SPEAKER_01',
          'It was chicken soup. I remember because I had made it myself that morning for the supper.',
        ],
        ['SPEAKER_02', 'And then?'],
        [
          'SPEAKER_00',
          'We got married in June of nineteen sixty-seven, at the same church, and the same people came.'.repeat(
            2,
          ),
        ],
        [
          'SPEAKER_01',
          'And somebody made the same chicken soup as a joke, and everybody laughed for a long time.',
        ],
      ),
    );
    expect(r.interviewees).toEqual(['SPEAKER_00']);
    expect(r).toMatchObject({ confidence: 'low', needsConfirmation: true });
    expect(r.reasons).toContain('others_may_tell');
  });
});

describe('named by the sender', () => {
  const t = turns(['Interviewer', 'Where were you born?'], ['Grandma', 'In Busan, by the sea.']);

  it('found as written, in any case, or by its number', () => {
    expect(assignRoles(t, 'grandma')).toMatchObject({
      interviewees: ['Grandma'],
      source: 'sender',
      confidence: 'high',
    });
    expect(
      assignRoles(turns(['SPEAKER_01', 'Where?'], ['SPEAKER_00', 'Busan.']), '0').interviewees,
    ).toEqual(['SPEAKER_00']);
  });

  it('not found: a guess a person confirms; half found: the same', () => {
    const none = assignRoles(t, 'Grandpa');
    expect(none).toMatchObject({ source: 'guess', confidence: 'low', needsConfirmation: true });
    expect(none.reasons).toContain('named_speaker_not_found');
    const half = assignRoles(t, ['Grandma', 'Grandpa']);
    expect(half).toMatchObject({
      interviewees: ['Grandma'],
      source: 'sender',
      confidence: 'low',
      needsConfirmation: true,
    });
  });
});

describe('never throws, whatever the turns', () => {
  it('only guessed questions, or no turns at all: nobody is picked, and a person must look', () => {
    for (const ts of [turns([QUESTIONS, 'Where were you born?'], [QUESTIONS, 'Why?']), []]) {
      const r = assignRoles(ts);
      expect(r).toMatchObject({
        interviewees: [],
        interviewee: '',
        confidence: 'low',
        needsConfirmation: true,
      });
    }
  });

  it('a speaker called QUESTIONS in the file is renamed, so the file is read and roles are assigned', () => {
    const t = parseTranscript({
      segments: [
        { text: 'Where were you born?', speaker: 'QUESTIONS' },
        { text: 'Busan, by the sea.', speaker: 'QUESTIONS' },
      ],
    });
    expect(() => applyRoles(t)).not.toThrow();
    expect(applyRoles(t).roles.interviewees.length).toBeGreaterThan(0);
  });
});

describe('applyRoles: interjections folded only once the roles are sure', () => {
  const interview = (answer: string, after = 'Interviewer: Tell me more about him.') =>
    parseTranscript(
      `Interviewer: Mom said you were born in Tongyeong, by the sea, in a house near the harbour.\nGrandma: ${answer}\n${after}\n` +
        'Grandma: He repaired boats, and on Sundays he took me to the pier to watch the ships come in.',
    );

  it("the interviewer's mm-hm inside one answer is folded, and the answer becomes one turn", () => {
    const t = parseTranscript(
      'Interviewer: Tell me about your father.\nGrandma: He repaired boats.\nInterviewer: Mm-hm.\nGrandma: And on Sundays he took me to the pier.',
    );
    const r = applyRoles(t);
    expect(r.turns.map((x) => [x.index, x.speaker, x.text])).toEqual([
      [0, 'Interviewer', 'Tell me about your father.'],
      [1, 'Grandma', 'He repaired boats. And on Sundays he took me to the pier.'],
    ]);
    expect(r.warnings).toContainEqual({ code: 'backchannels_merged', count: 1 });
    // the reader itself never drops it
    expect(t.turns).toHaveLength(4);
  });

  it("the teller's mm-hm after a question is an answer and stays", () => {
    const t = parseTranscript(
      'Interviewer: So you were born in Tongyeong?\nGrandma: Mm-hm.\nInterviewer: And your father repaired boats there?\nGrandma: He did, every day, until the war came and we had to leave.',
    );
    expect(applyRoles(t).turns.map((x) => x.text)).toContain('Mm-hm.');
  });

  it('a word of agreement from the teller always stays; a mere listening sound after a statement goes', () => {
    expect(applyRoles(interview('Yes.')).turns.map((x) => x.text)).toContain('Yes.');
    expect(applyRoles(interview('Right.')).turns.map((x) => x.text)).toContain('Right.');
    // after "Mom said you were born in Tongyeong…", "Mm-hm." / "Uh-huh." is her yes, like "Yes."
    expect(applyRoles(interview('Mm-hm.')).turns.map((x) => x.text)).toContain('Mm-hm.');
    expect(applyRoles(interview('Uh-huh.')).turns.map((x) => x.text)).toContain('Uh-huh.');
    const listening = applyRoles(interview('Oh.'));
    expect(listening.turns.map((x) => x.text)).not.toContain('Oh.');
    expect(listening.turns.map((x) => x.index)).toEqual(listening.turns.map((_, i) => i));
  });

  it('a reticent relative named by the sender keeps every one-word answer', () => {
    const t = parseTranscript(
      [
        'Interviewer: Grandma, Mom always told me you were born in Tongyeong, by the sea, in a house near the harbour. Is that right?',
        'Grandma: Yes.',
        'Interviewer: And your father, he was the one who repaired the fishing boats down at the pier. Did you go with him?',
        'Grandma: Sometimes.',
        'Interviewer: Mom said you had to walk all the way to Busan with your little brother on your back. Is that true?',
        'Grandma: Right.',
      ].join('\n'),
    );
    const r = applyRoles(t, 'Grandma');
    expect(r.turns.filter((x) => x.speaker === 'Grandma').map((x) => x.text)).toEqual([
      'Yes.',
      'Sometimes.',
      'Right.',
    ]);
  });

  it('a guess that still needs a person folds nothing (with the wrong roles it would delete the answers)', () => {
    const t = parseTranscript({
      segments: [
        {
          start: 0,
          end: 12,
          speaker: 'SPEAKER_01',
          text: 'Grandma, Mom always told me you were born in Tongyeong, by the sea, in a house near the harbour. Is that right?',
        },
        { start: 12, end: 13, speaker: 'SPEAKER_00', text: 'Yes.' },
        {
          start: 13,
          end: 25,
          speaker: 'SPEAKER_01',
          text: 'And Mom said you had to leave during the war and walk all the way to Busan. Is that true?',
        },
        { start: 25, end: 26, speaker: 'SPEAKER_00', text: 'Yeah.' },
        { start: 26, end: 30, speaker: 'SPEAKER_01', text: 'Were you scared?' },
        {
          start: 30,
          end: 40,
          speaker: 'SPEAKER_00',
          text: 'Of course I was scared, I was nine years old.',
        },
      ],
    });
    const r = applyRoles(t);
    expect(r.roles.needsConfirmation).toBe(true);
    expect(r.turns).toHaveLength(6);
    expect(r.warnings.map((w) => w.code)).not.toContain('backchannels_merged');
  });
});

describe('text in a script the question cues cannot read is never a sure answer', () => {
  // The cues read English. In another script nothing in the text "asks", so a single unlabelled
  // voice could be an interviewer and a relative the file did not tell apart: the person is asked.
  const lines: Record<string, string[]> = {
    Cyrillic: [
      'Где вы родились',
      'Я родился в Пусане, в маленьком доме у моря.',
      'А ваш отец',
      'Он чинил лодки и мало говорил.',
    ],
    Han: [
      '你在哪里出生？',
      '我出生在釜山，在海边的一座小房子里。',
      '你父亲呢？',
      '他是修船的，他的手很大。',
    ],
    Arabic: ['أين ولدت؟', 'ولدت في بوسان في بيت صغير قرب البحر.', 'وأبوك؟', 'كان يصلح القوارب.'],
    Greek: [
      'Πού γεννηθήκατε;',
      'Γεννήθηκα στη Μπουσάν, σε ένα μικρό σπίτι δίπλα στη θάλασσα.',
      'Και ο πατέρας σας;',
      'Έφτιαχνε βάρκες και μιλούσε λίγο.',
    ],
  };

  it.each(Object.keys(lines))('%s: one voice with no labels asks, and says why', (script) => {
    const r = rolesOf(lines[script]!.join('\n'));
    expect(r).toMatchObject({ confidence: 'medium', needsConfirmation: true });
    expect(r.reasons).toEqual(['monologue', 'script_not_read']);
  });

  it.each(Object.keys(lines))(
    '%s: every word is still kept, and the voice is still a teller',
    (script) => {
      const r = applyRoles(parseTranscript(lines[script]!.join('\n')));
      expect(r.turns.map((t) => t.text)).toEqual(lines[script]);
      expect(r.roles.interviewees).toHaveLength(1);
    },
  );

  it('English stays a sure monologue, and a few words in another script do not change that', () => {
    expect(
      rolesOf('I was born in Busan.\nMy father repaired boats.\nWe had one stove for six people.'),
    ).toMatchObject({ confidence: 'high', needsConfirmation: false, reasons: ['monologue'] });
    const named = rolesOf(
      'My mother was called 金顺子 and she sold fish at the market.\nShe never complained, not once.\nWe lived near the harbour.',
    );
    expect(named).toMatchObject({ confidence: 'high', needsConfirmation: false });
    expect(named.reasons).toEqual(['monologue']);
  });

  it('an English role label still says who asks, whatever script the words are in', () => {
    const r = rolesOf(
      [
        'Interviewer: Где вы родились?',
        'Grandma: Я родился в Пусане, в маленьком доме у моря.',
        'Interviewer: А ваш отец?',
        'Grandma: Он чинил лодки и мало говорил.',
      ].join('\n'),
    );
    expect(r).toMatchObject({ interviewees: ['Grandma'], confidence: 'high' });
    expect(r.reasons).toContain('label_says_interviewer');
  });

  it('two voices that are only names, with questions the cues cannot see, are asked about', () => {
    const r = rolesOf(
      [
        'Анна: Где вы родились',
        'Мария: Я родилась в Пусане, в маленьком доме у моря, где отец чинил лодки.',
        'Анна: А ваша мать',
        'Мария: Она продавала рыбу на рынке каждое утро до рассвета.',
      ].join('\n'),
    );
    expect(r.needsConfirmation).toBe(true);
  });
});

describe('the demo samples are sure answers: the import is not interrupted', () => {
  for (const f of [
    'samples/grandma-sunja-en.txt',
    'samples/grandma-sunja-en.json',
    'sample-whisperx.json',
  ]) {
    it(f, () => {
      const raw = readFileSync(new URL(`../../../docs/ingest/${f}`, import.meta.url), 'utf8');
      const r = applyRoles(parseTranscript(raw)).roles;
      expect(r).toMatchObject({ confidence: 'high', needsConfirmation: false });
      expect(r.interviewees).toHaveLength(1);
    });
  }
});
