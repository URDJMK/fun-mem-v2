import { describe, expect, it } from 'vitest';
import { applyRoles, assignRoles, parseTranscript, type Turn } from '../src/transcript';
import { leadKind } from '../src/roles';

/**
 * Round 3: what sits ABOVE the first speaker label, and header lines. A greeting, an e-mail
 * header or "Date of birth: March 3, 1946" was filed as the relative's own memory at HIGH
 * confidence (dated and titled with it); a header naming one interviewee silently left a second
 * relative out; and a pasted file of 40,000 one-line "speakers" blocked the server for 84 s.
 */

const turns = (...xs: Array<[string, string]>): Turn[] =>
  xs.map(([speaker, text], index) => ({ index, speaker, text, start: null, end: null }));
const read = (input: unknown, named?: string[]) => applyRoles(parseTranscript(input), named);
const told = (r: ReturnType<typeof read>) =>
  r.turns
    .filter((t) => r.roles.interviewees.includes(t.speaker))
    .map((t) => t.text)
    .join(' ');

const BODY = [
  'Noah: Where were you born, and what was your father like?',
  'Grandma: I was born in Busan in 1946. My father repaired boats and he had big hands, and he did not talk much at all.',
  'Noah: And your mother?',
  'Grandma: My mother sold fish at the market. She came home after sunset every single day, and she never complained.',
  'Noah: Did you go to school?',
  'Grandma: Only until fifth grade, but my teacher said I had the most beautiful handwriting in the whole class.',
];

describe('lines above the first label that are not hers are never filed as her memory', () => {
  it.each([
    'Hello Grandma, thank you so much for sitting down with me today.',
    'Okay, testing, one two three, can you hear me alright.',
    'Good morning everyone, welcome to the family history project.',
    'Today is March 1st, 2024, and I am here with my grandmother Sunja Kim in her home in Busan.',
    "Okay, let's start.",
    'So, Grandma, thank you for doing this.',
    'family history project grandma spring',
    'Interview date: March 1, 2024',
    'Date of birth: March 3, 1946',
    'Speaker 1 = Noah Kim, Speaker 2 = Sunja Kim',
    'On Mon, May 4, 2026 at 9:12 AM Noah Kim <noah@example.com> wrote:',
    '45m 12s',
    'Where were you born',
  ])('%s', (lead) => {
    const r = read([lead, ...BODY].join('\n'));
    expect(r.roles.interviewees).toEqual(['Grandma']);
    expect(told(r)).not.toContain(lead.slice(0, 16));
    // nothing of hers is doubted: a sure answer, no question to the family
    expect(r.roles.confidence).toBe('high');
  });

  it('Korean: a greeting to her stays the interviewer’s', () => {
    const r = read(
      [
        '안녕하세요 할머니, 오늘 시간 내주셔서 정말 감사합니다.',
        '노아: 어디서 태어나셨어요?',
        '할머니: 저는 1946년에 부산에서 태어났어요. 아버지는 배를 고치셨고 손이 아주 크셨어요.',
        '노아: 어머니는요?',
        '할머니: 어머니는 시장에서 생선을 파셨어요. 힘들다고 한 번도 말씀하신 적이 없어요.',
      ].join('\n'),
    );
    expect(told(r)).not.toContain('안녕하세요');
  });

  it('a WhisperX first segment with no speaker that introduces the session', () => {
    const seg = (i: number, sp: string | null, text: string) => ({
      start: i * 5,
      end: i * 5 + 4,
      text,
      ...(sp ? { speaker: sp } : {}),
    });
    const r = read({
      segments: [
        seg(0, null, 'Today is March first and I am here with my grandmother.'),
        seg(1, 'SPEAKER_01', 'Where were you born?'),
        seg(
          2,
          'SPEAKER_00',
          'In Busan, in a little house near the harbour, and my father repaired boats there.',
        ),
        seg(3, 'SPEAKER_01', 'And your mother?'),
        seg(4, 'SPEAKER_00', 'She sold fish at the market every morning before the sun was up.'),
      ],
    });
    expect(told(r)).not.toContain('Today is March first');
  });
});

describe('a tape that starts mid-answer: her words, kept, and the import asks', () => {
  it.each([
    'and that is why we never went back to the village after the flood, not even for the funerals.',
    '...and that is how we ended up in Daegu.',
    'because my father had no work there after the war, and my mother was sick.',
    'which was the hardest winter we ever had, my mother said.',
  ])('%s', (lead) => {
    const guessed = read([lead, ...BODY].join('\n'));
    // (a turn starts with a capital, so compare without case)
    const start = lead.replace(/^\.+/, '').slice(0, 16).toLowerCase();
    expect(told(guessed).toLowerCase()).toContain(start);
    expect(guessed.roles).toMatchObject({ confidence: 'medium', needsConfirmation: true });
    expect(guessed.roles.reasons).toContain('unlabelled_to_teller');
    expect(guessed.warnings).toContainEqual({ code: 'unlabelled_to_teller', count: 1 });
    // once the person confirms her, the words are in her memory and nothing more is asked
    const chosen = read([lead, ...BODY].join('\n'), ['Grandma']);
    expect(told(chosen).toLowerCase()).toContain(start);
    expect(chosen.roles.needsConfirmation).toBe(false);
  });

  it('Korean: a lead that starts with 그래서 is hers; in an Interviewer-only file too', () => {
    const ko = read(
      [
        '그래서 우리 아버지가 그날 밤 늦게 오셨는데 어머니가 많이 우셨어요.',
        '노아: 그게 몇 년도였어요?',
        '할머니: 1950년이었지. 전쟁이 막 시작됐을 때야.',
        '노아: 그때 어디 사셨어요?',
        '할머니: 부산에 살았어요. 바닷가 작은 집에서.',
      ].join('\n'),
    );
    expect(told(ko)).toContain('그래서 우리 아버지가');
    expect(ko.roles.needsConfirmation).toBe(true);
    const qOnly = read(
      [
        'and so my father sent me to live with my aunt in the city, which I did not want at all',
        'Interviewer: How old were you?',
        'I was eleven or twelve, I am not sure.',
        'Interviewer: Did you like it there?',
        'No. I cried every night for a month.',
      ].join('\n'),
    );
    expect(told(qOnly).toLowerCase()).toContain('my father sent me to live with my aunt');
    expect(qOnly.roles.needsConfirmation).toBe(true);
    expect(qOnly.warnings.map((w) => w.code)).toContain('unlabelled_start');
  });

  it('the classifier: intros, headers and questions are not hers; a sentence cut short may be', () => {
    expect(leadKind('Hello Grandma, thank you for sitting down with me today.', 'Grandma')).toBe(
      'not',
    );
    expect(leadKind('Grandma Sunja’s story', 'Sunja')).toBe('not');
    expect(leadKind('where were you born', 'Grandma')).toBe('not');
    expect(leadKind('and then we walked all the way to Busan with my brother.', 'Grandma')).toBe(
      'cut',
    );
    expect(
      leadKind('My father came home late that night and my mother was crying', 'Grandma'),
    ).toBe('unclear');
  });

  it('a capitalised lead that may be hers is not filed under her, and the import asks', () => {
    const r = read(
      ['My father came home late that night and my mother was crying', ...BODY].join('\n'),
    );
    expect(told(r)).not.toContain('My father came home late');
    expect(r.roles.needsConfirmation).toBe(true);
  });
});

describe('header lines are a hint, never a speaker who decides or a second teller', () => {
  const body: Array<[string, string]> = [
    ['Noah', 'Where were you born?'],
    [
      'Sunja',
      'In Busan, in a little house near the harbour. My mother always said the boats came in that morning.',
    ],
    ['Noah', 'Tell me about your father.'],
    ['Sunja', 'He repaired boats. He had big hands and he did not talk much at all.'],
    ['Noah', 'And your mother?'],
    ['Sunja', 'She sold fish at the market. She left before dawn and came home after sunset.'],
  ];

  it.each([
    'Consent: yes, recorded with permission',
    'Participants: Noah Kim (interviewer), Sunja Kim (interviewee)',
    'Summary: Sunja talks about her childhood in Busan',
    'Setting: kitchen table',
  ])('%s: a sure answer, and not her words', (line) => {
    const r = read([line, ...body.map(([s, t]) => `${s}: ${t}`)].join('\n'));
    expect(r.roles).toMatchObject({ interviewees: ['Sunja'], confidence: 'high' });
    expect(told(r)).not.toContain(line.split(':')[1]!.trim().slice(0, 12));
  });

  it('"Participants: … (interviewer), … (interviewee)" names who is who', () => {
    const r = assignRoles(
      turns(['Participants', 'Sunja Kim (narrator), Noah Kim (interviewer)'], ...body),
    );
    expect(r.interviewees).toEqual(['Sunja']);
    expect(r.reasons).toContain('label_says_interviewer');
  });

  it('a header naming one interviewee does not silence a second relative who tells at length', () => {
    const r = read(
      [
        'Interviewee: Sunja Kim',
        'Interviewer: Noah Kim',
        'Date: March 1, 2024',
        '',
        'Noah: Where did you two meet?',
        'Sunja: At a church supper in Daegu. He spilled gravy all over his shirt and I laughed at him in front of everyone.',
        'Minho: I was so nervous that I could not hold the bowl. She laughed and I went red, and that was the day my whole life changed.',
        'Noah: When was the wedding?',
        'Sunja: In June, in a small ceremony, because we had no money for anything bigger than that.',
        'Minho: My brother lent me his suit and I returned it the next day with a stain on the sleeve, which he never forgave me for.',
      ].join('\n'),
    );
    expect(r.roles.interviewees).toEqual(['Sunja']);
    expect(r.roles).toMatchObject({ needsConfirmation: true });
    expect(r.roles.reasons).toContain('others_may_tell');
  });

  it('a header that names her, with nobody else telling, is a sure answer', () => {
    const r = read(
      `Interviewee: Sunja Kim\nInterviewer: Noah Kim\n\n${body.map(([s, t]) => `${s}: ${t}`).join('\n')}`,
    );
    expect(r.roles).toMatchObject({ interviewees: ['Sunja'], confidence: 'high' });
  });
});

describe('roles stay linear on a hostile file', () => {
  it('14,000 one-line role-labelled "speakers", then 25,000 more: a moment, not 84 seconds', () => {
    const words = ['Host', 'Moderator', 'Interviewer', 'Q', 'Question', 'Narrator', 'Respondent'];
    const ts: Array<[string, string]> = [];
    for (let i = 0; i < 14_000; i++) ts.push([`${words[i % words.length]} ${i % 1000}`, 'hi']);
    for (let i = 0; i < 25_000; i++) ts.push([`Z${i}`, 'ok']);
    const t0 = performance.now();
    assignRoles(turns(...ts));
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('what a choice leaves out leaves a trace', () => {
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
    ].join('\n');

  it('the person picks one teller: the odd voice left out is counted, never quoted', () => {
    const r = read(story('Halmoni'), ['Grandma']);
    expect(r.warnings).toContainEqual({ code: 'speaker_left_out', count: 1 });
    expect(read(story('Grandma'), ['Grandma']).warnings.map((w) => w.code)).not.toContain(
      'speaker_left_out',
    );
  });

  it('words with no speaker that all went to the teller are not listed as another voice', () => {
    const r = read(
      [
        'and that is why we never went back to the village after the flood, not even for the funerals.',
        ...BODY,
      ].join('\n'),
    );
    expect(r.roles.speakers.map((s) => s.id)).toEqual(['Noah', 'Grandma']);
  });
});
