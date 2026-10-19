import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestTranscript, type IngestResult } from '../src/ingest-pipeline';
import { ModelError, type ChatModel, type ModelErrorKind } from '../src/nim';
import { applyRoles, parseTranscript, type Turn } from '../src/transcript';

/**
 * Behaviour, end to end, without a database: realistic transcripts and a property test.
 *
 * THE PROPERTY. Whatever the transcript and whatever the model does (answers that are not
 * JSON, wrong or repeated turn numbers, nothing at all, everything merged into one memory,
 * invented sentences, errors, cut-off answers), every turn of a person telling their story
 * that holds a letter or a digit ends up in EXACTLY ONE memory, with all of its words, and
 * the reported coverage says so. The pipeline's self-repair for a missed turn must never
 * have been needed.
 */

/* ── seeded randomness: the same run every time ──────────────────────── */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rand = ReturnType<typeof rng>;
const pick = <T>(r: Rand, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/* ── words ───────────────────────────────────────────────────────────── */

const FILLER = new Set([
  'um',
  'uh',
  'uhm',
  'er',
  'erm',
  'hmm',
  'mhm',
  'mm',
  '어',
  '음',
  '으음',
  '흠',
]);
const wordsOf = (s: string): string[] =>
  (
    s
      .normalize('NFC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((w) => !FILLER.has(w));
/** the lines of a note the speaker's words are in (the footer is the pipeline's) */
const proseOf = (body: string): string =>
  body
    .split('\n')
    .filter((l) => !l.startsWith('> '))
    .join('\n');

/* ── random transcripts ──────────────────────────────────────────────── */

const LONG_EN = [
  'My father repaired boats in the harbour and he did not talk much at all',
  'On Sundays the whole village walked to the little church by the water',
  'We hid in a cave for three weeks and my mother told me not to make a sound',
  'The teacher had a bamboo stick but she never used it on any of us',
  'I sent half of my pay home every month and kept the rest in a tin',
  'He could not cook at all but he washed every dish for fifty years',
];
const LONG_KO = [
  '아버지는 항구에서 배를 고치셨고 말씀이 별로 없으셨어요',
  '일요일마다 온 동네 사람들이 바닷가 작은 교회까지 걸어갔어요',
  '어머니는 새벽마다 시장에 나가서 생선을 파셨어요',
  '우리는 산으로 도망가서 삼 주 동안 동굴에 숨어 있었어요',
];
const SHORT = [
  'Yes.',
  'No.',
  'Every day.',
  'Busan.',
  'Two.',
  'Very much.',
  'Thirty-eight.',
  'Sometimes.',
  'No. Never.',
  'Mm-hm, yes.',
  '네.',
  '부산.',
  '매일.',
  '김순자예요.',
  '그럼. 많이.',
  'In 1946.',
  '1952.',
  '> Fine.',
];
const QUESTIONS = [
  'Where were you born?',
  'What did your father do?',
  'Did you love him?',
  'And then what happened?',
  '어디서 태어나셨어요?',
  '아버지는 무슨 일을 하셨어요?',
  'Tell me about the war.',
];
const REMARKS = ['Oh wow.', 'I see.', 'That is lovely.', 'Right.'];

interface Generated {
  segments: Array<{ start: number; end: number; speaker: string; text: string }>;
  tellers: string[];
}

function randomTranscript(r: Rand, n: number): Generated {
  const tellers = r() < 0.7 ? ['Grandma'] : r() < 0.5 ? ['Mae', 'Joon'] : ['Mae', 'Joon', 'Ok'];
  const others = r() < 0.8 ? ['Interviewer'] : ['Interviewer', 'Child'];
  const segments: Generated['segments'] = [];
  const turns = 3 + Math.floor(r() * 22);
  let clock = 0;
  for (let i = 0; i < turns; i++) {
    let speaker: string;
    let text: string;
    if (r() < 0.45) {
      speaker = pick(r, others);
      text = r() < 0.75 ? pick(r, QUESTIONS) : pick(r, REMARKS);
    } else {
      speaker = pick(r, tellers);
      if (r() < 0.45) {
        text = pick(r, SHORT);
      } else {
        // a unique word in every long turn, so one turn's words never pass as another's
        const bank = r() < 0.7 ? LONG_EN : LONG_KO;
        const k = 1 + Math.floor(r() * 3);
        text = Array.from({ length: k }, () => `${pick(r, bank)} place${n}x${i}.`).join(' ');
      }
    }
    const dur = 2 + Math.floor(r() * 20);
    segments.push({ start: clock, end: clock + dur, speaker, text });
    clock += dur + 1;
  }
  return { segments, tellers };
}

/* ── misbehaving models ──────────────────────────────────────────────── */

const lines = (user: string) =>
  [...user.matchAll(/^\[(\d+)(?:\|[^\]]+)?\] (.*)$/gm)].map((m) => ({
    id: Number(m[1]),
    text: m[2]!,
  }));
const J = (memories: Array<{ turns: number[]; title: string; body: string }>) =>
  JSON.stringify({ memories });

const BEHAVIOURS = [
  'honest',
  'invalid',
  'truncatedJson',
  'empty',
  'mergeAll',
  'wrongTurns',
  'dupTurns',
  'bogusTurns',
  'invent',
  'shortOnly',
  'foldShort',
  'swallowShort',
  'throws',
  'cutOff',
  'chaos',
] as const;
type Behaviour = (typeof BEHAVIOURS)[number];

function misbehaving(kind: Behaviour, r: Rand): ChatModel {
  const reply = (user: string): string => {
    const ls = lines(user);
    switch (kind) {
      case 'honest':
        return J(ls.map((l) => ({ turns: [l.id], title: 'A memory', body: l.text })));
      case 'invalid':
        return 'Sure! Here are the memories I found.';
      case 'truncatedJson':
        return J(ls.map((l) => ({ turns: [l.id], title: 'T', body: l.text }))).slice(0, 40);
      case 'empty':
        return '{"memories":[]}';
      case 'mergeAll':
        return ls.length === 0
          ? '{"memories":[]}'
          : J([
              {
                turns: ls.map((l) => l.id),
                title: 'Everything',
                body: ls.map((l) => l.text).join(' '),
              },
            ]);
      case 'wrongTurns':
        return J(ls.map((l) => ({ turns: [l.id + 1], title: 'Shifted', body: l.text })));
      case 'dupTurns':
        return J(ls.map((l) => ({ turns: [ls[0]!.id, l.id], title: 'Dup', body: l.text })));
      case 'bogusTurns':
        return J(ls.map((l, i) => ({ turns: [900 + i, -3, 1.5], title: 'Bogus', body: l.text })));
      case 'invent':
        return J(
          ls.map((l) => ({
            turns: [l.id],
            title: 'Invented',
            body: `${l.text} He later became the captain of the whole fleet.`,
          })),
        );
      case 'shortOnly':
        return J(
          ls
            .filter((l) => l.text.length < 20)
            .map((l) => ({ turns: [l.id], title: 'Short', body: l.text })),
        );
      // a short reply grouped with the story after it (or before it), its words left out of the
      // body but its turn number claimed: the class the round-1 check missed by counting numbers
      case 'foldShort': {
        const out: Array<{ turns: number[]; title: string; body: string }> = [];
        for (let i = 0; i < ls.length; i++) {
          const l = ls[i]!;
          const next = ls[i + 1];
          if (l.text.length < 20 && next !== undefined && next.text.length >= 20) {
            out.push({ turns: [l.id, next.id], title: 'Folded', body: next.text });
            i++;
          } else out.push({ turns: [l.id], title: 'A memory', body: l.text });
        }
        return J(out);
      }
      // every line in one memory, the short ones left out of the body
      case 'swallowShort':
        return ls.length === 0
          ? '{"memories":[]}'
          : J([
              {
                turns: ls.map((l) => l.id),
                title: 'Everything',
                body:
                  ls
                    .filter((l) => l.text.length >= 20)
                    .map((l) => l.text)
                    .join(' ') || ls[0]!.text,
              },
            ]);
      case 'throws':
      case 'cutOff':
      case 'chaos':
        return '';
    }
  };
  return {
    id: kind,
    async complete(_s, user) {
      if (kind === 'throws') {
        const k = pick(r, [
          'rate_limited',
          'unavailable',
          'bad_request',
          'timeout',
        ] as ModelErrorKind[]);
        throw new ModelError('failed', k, k !== 'bad_request');
      }
      if (kind === 'cutOff') throw new ModelError('cut', 'truncated', false);
      if (kind === 'chaos') {
        const b = pick(
          r,
          BEHAVIOURS.filter((x) => x !== 'chaos' && x !== 'throws' && x !== 'cutOff'),
        );
        if (r() < 0.15) throw new ModelError('flaky', 'unavailable', true);
        return misbehaving(b, r).complete(_s, user);
      }
      return reply(user);
    },
  };
}

/* ── the property ────────────────────────────────────────────────────── */

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

function checkNothingLost(turns: Turn[], tellers: string[], r: IngestResult, label: string) {
  for (const t of turns) {
    if (!tellers.includes(t.speaker) || wordsOf(t.text).length === 0) continue;
    const homes = r.memories.filter((m) => m.turns.includes(t.index));
    expect(
      homes,
      `${label}: turn ${t.index} "${t.text}" is in ${homes.length} memories`,
    ).toHaveLength(1);
    const kept = new Set(wordsOf(proseOf(homes[0]!.body)));
    const missing = wordsOf(t.text).filter((w) => !kept.has(w));
    expect(missing, `${label}: turn ${t.index} "${t.text}" lost words`).toEqual([]);
  }
  expect(r.stats.coverage.covered, label).toBe(r.stats.coverage.total);
  // a turn in two memories, or in none: either is a bug, and the totals would hide neither
  const all = r.memories.flatMap((m) => m.turns);
  expect(new Set(all).size, `${label}: a turn is in two memories`).toBe(all.length);
}

describe('property: whatever the model does, every teller turn is in exactly one memory, whole (A1)', () => {
  it('holds for 300 random transcripts and misbehaving models', async () => {
    const r = rng(20261018);
    for (let n = 0; n < 300; n++) {
      const g = randomTranscript(r, n);
      const kind = BEHAVIOURS[n % BEHAVIOURS.length]!;
      const chat = n % 17 === 0 ? null : misbehaving(kind, r);
      const label = `#${n} ${chat ? kind : 'no-ai'}`;
      let result: IngestResult;
      try {
        result = await ingestTranscript(
          { segments: g.segments },
          { interviewees: g.tellers },
          {
            chat,
            titles: [],
          },
        );
      } catch (e) {
        // a transcript the parser refuses (no speech at all) is the one allowed outcome besides a result
        expect(String(e), label).toMatch(/no speech/);
        continue;
      }
      // the turns as the pipeline numbered them (a listener's "mm-hm" folded away first)
      const { turns } = applyRoles(parseTranscript({ segments: g.segments }), g.tellers);
      checkNothingLost(turns, result.interviewees, result, label);
      for (const m of result.memories) {
        expect(m.title.trim(), `${label}: an empty title`).not.toBe('');
        expect(
          m.body.split('\n').some((l) => /^\s*>\s*⚠/.test(l)),
          label,
        ).toBe(false);
      }
    }
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('ingest_coverage_healed'))).toEqual(
      [],
    );
  });
});

/* ── realistic transcripts (from the behaviour review) ───────────────── */

const ONEWORD_EN = `Interviewer: Grandpa, where were you born?
Grandpa Tae: Busan.
Interviewer: And what year was that?
Grandpa Tae: Thirty-eight.
Interviewer: Nineteen thirty-eight. Did you go to school?
Grandpa Tae: Two years.
Interviewer: Why only two years?
Grandpa Tae: Work.
Interviewer: What kind of work did you do as a boy?
Grandpa Tae: Fish.
Interviewer: Did your father ever hit you?
Grandpa Tae: Sometimes.
Interviewer: Were you afraid of him?
Grandpa Tae: Yes.
Interviewer: Did you love him?
Grandpa Tae: Yes. Very much.
Interviewer: Tell me about your wedding day.
Grandpa Tae: It rained. Everyone said it was good luck. Your grandmother cried the whole day.
Interviewer: Was she sad?
Grandpa Tae: No. Happy. She said so.
Interviewer: When did she pass away?
Grandpa Tae: Two thousand and nineteen. In the spring.
Interviewer: Do you miss her?
Grandpa Tae: Every day.`;

const ONEWORD_KO = `면접자: 할아버지, 어디서 태어나셨어요?
김태식: 부산.
면접자: 몇 년도에요?
김태식: 서른여덟.
면접자: 학교는 다니셨어요?
김태식: 이 년.
면접자: 왜 이 년만 다니셨어요?
김태식: 일해야 했지.
면접자: 아버지가 때리셨어요?
김태식: 가끔.
면접자: 아버지를 사랑하셨어요?
김태식: 그럼. 많이.
면접자: 결혼식 날은 어땠어요?
김태식: 비가 왔어. 다들 복 받는다고 했지. 네 할머니가 하루 종일 울었어.
면접자: 할머니가 보고 싶으세요?
김태식: 매일.`;

const honest: ChatModel = misbehaving('honest', rng(1));

describe('a grandparent who answers in a word or two (A1)', () => {
  for (const chat of [null, honest]) {
    it(`English, ${chat ? 'with' : 'without'} AI: every answer is kept, in order, after its question`, async () => {
      const r = await ingestTranscript(
        ONEWORD_EN,
        { interviewees: ['Grandpa Tae'] },
        { chat, titles: [] },
      );
      checkNothingLost(
        applyRoles(parseTranscript(ONEWORD_EN), ['Grandpa Tae']).turns,
        ['Grandpa Tae'],
        r,
        'en',
      );
      const short = r.memories.at(-1)!;
      expect(short.title).toBe('Short answers');
      expect(proseOf(short.body).trim().split('\n').slice(0, 3)).toEqual([
        '- Grandpa, where were you born? — Busan.',
        '- And what year was that? — Thirty-eight.',
        '- Nineteen thirty-eight. Did you go to school? — Two years.',
      ]);
      expect(proseOf(short.body)).toContain('- Do you miss her? — Every day.');
      // a name in the label, no teller given: the footer says who told it
      expect(short.body.split('\n').at(-1)).toContain('told by Grandpa Tae');
      // the title starts at the first sentence that says something ("It rained." is two words)
      const wedding = r.memories.find((m) => m.body.includes('It rained.'))!;
      if (!chat) expect(wedding.title).toBe('Everyone said it was good luck');
    });

    it(`Korean, ${chat ? 'with' : 'without'} AI: the same, in Korean`, async () => {
      const r = await ingestTranscript(
        ONEWORD_KO,
        { interviewees: ['김태식'] },
        { chat, titles: [] },
      );
      checkNothingLost(
        applyRoles(parseTranscript(ONEWORD_KO), ['김태식']).turns,
        ['김태식'],
        r,
        'ko',
      );
      const short = r.memories.at(-1)!;
      expect(short.title).toBe('짧은 답변');
      expect(short.language).toBe('ko');
      expect(proseOf(short.body)).toContain('- 할머니가 보고 싶으세요? — 매일.');
      expect(short.body.split('\n').at(-1)).toContain('김태식님 말씀');
    });
  }
});

describe('titles, from realistic answers (A3)', () => {
  it('no "Yes. …" titles, no sentence breaks, no dangling words', async () => {
    const t = `Interviewer: Did your father play any music?
Grandma Sunja: Yes. My father played the flute on the boat at night, very softly, so that he would not wake the men.
Interviewer: Did you ever learn it?
Grandma Sunja: No. I tried once but my fingers were too small and he laughed at me kindly.
Interviewer: How do you feel when you think of her?
Grandma Sunja: I miss her. I miss her every single day and I do not know what to do with myself.
Interviewer: And your children?
Grandma Sunja: Three. Two boys and a girl. The girl, Mina, was born in nineteen seventy.`;
    const r = await ingestTranscript(t, {}, { chat: null, titles: [] });
    expect(r.memories.map((m) => m.title)).toEqual([
      'My father played the flute on the boat at night, very softly',
      'I tried once but my fingers were too small',
      'I miss her',
      'Two boys and a girl',
    ]);
  });

  it('an invented title from the model is replaced by the speaker’s own words', async () => {
    const said =
      'My father repaired boats in the harbour, and every Sunday he took me down to the pier with him.';
    for (const title of [
      "Dad's years in prison",
      'Born in Seoul in 1950',
      "Father's secret second family",
    ]) {
      const chat: ChatModel = {
        id: 'titles',
        complete: async () => J([{ turns: [1], title, body: said }]),
      };
      const r = await ingestTranscript(
        {
          segments: [
            { start: 0, end: 2, speaker: 'Q', text: 'Tell me about him.' },
            { start: 2, end: 9, speaker: 'A', text: said },
          ],
        },
        { interviewees: ['A'] },
        { chat, titles: [] },
      );
      expect(r.memories[0]!.method).toBe('ai-grounded');
      expect(r.memories[0]!.title).toBe('My father repaired boats in the harbour');
    }
  });
});

describe('an interview about an illness (B3)', () => {
  it('"Do you want to take a break?" is not quoted as the question a memory answers', async () => {
    const t = `Interviewer: Can you tell me about when your husband got sick?
Grandma Sunja: It was the spring of two thousand and sixteen. He started losing weight and he said it was nothing.
Interviewer: I'm so sorry. Do you want to take a break?
Grandma Sunja: No, no. I want to say this. He told me the day before, he said, "Sunja, you were the best thing."`;
    const r = await ingestTranscript(t, {}, { chat: null, titles: [] });
    expect(r.memories.map((m) => /> Question: “([^”]*)”/.exec(m.body)?.[1] ?? null)).toEqual([
      'Can you tell me about when your husband got sick?',
      null,
    ]);
  });
});
