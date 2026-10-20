import { describe, expect, it } from 'vitest';
import {
  IngestCancelled,
  SHORT_LINES_PER_NOTE,
  callBudget,
  hashTurns,
  ingestParsed,
  ingestTranscript,
  occurredFor,
  withOpener,
  type IngestProgress,
  type IngestResult,
} from '../src/ingest-pipeline';
import { ModelError, type ChatModel } from '../src/nim';
import { applyRoles, parseTranscript } from '../src/transcript';

/** a letter of a script other than the Latin alphabet */
const OTHER_SCRIPT = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u;
const Q = 'Tell me about your father please.';
const seg = (i: number, speaker: string, text: string) => ({
  start: i * 10,
  end: i * 10 + 9,
  speaker,
  text,
});
const A1 = 'My father repaired boats and he had big hands and he did not talk much at all.';
const A2 = 'My mother sold fish at the market and she came home after sunset every single day.';
const deps = (chat: ChatModel | null, extra: object = {}) => ({ chat, titles: [], ...extra });
const answer = (...memories: Array<{ turns: number[]; title: string; body: string }>) =>
  JSON.stringify({ memories });

/** A model that returns the next scripted reply (a string, or an Error to throw). */
function model(
  replies: Array<string | Error | ((user: string) => string | Error)>,
): ChatModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: 'script',
    calls,
    async complete(_s, user) {
      calls.push(user);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      const v = typeof r === 'function' ? r(user) : r;
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

describe('the date of a memory', () => {
  it('a leading "Yes." or "Well." is not what the speaker led with', () => {
    expect(
      occurredFor(
        'Yes. In nineteen eighty-one I opened a little shop. By nineteen eighty-eight I had moved it to the main street.',
      ),
    ).toBe('1981');
    expect(occurredFor('Yes. 1958. It was a drought. In 1959 we sold the cows.')).toBe('1958');
    expect(
      occurredFor('Well. It was a long time ago. In 1958 and again in 1959 it rained.'),
    ).toBeNull();
  });

  it('one year: that year. Several: the one the speaker led with, else none.', () => {
    expect(occurredFor('We sold the farm in nineteen eighty-four.')).toBe('1984');
    expect(occurredFor('In 1958 there was a drought. We sold the cows in 1959.')).toBe('1958');
    expect(
      occurredFor('My dad had farmed since 1934. I was born in 1946. We sold it in 1984.'),
    ).toBeNull();
    expect(occurredFor('We had forty cows and a red barn.')).toBeNull();
    expect(
      occurredFor(
        'At a church supper in nineteen sixty-six he spilled gravy. We married in June of nineteen sixty-seven.',
      ),
    ).toBe('1966');
  });
});

describe('the identity of an interview is its words', () => {
  const turn = (index: number, speaker: string, text: string) => ({
    index,
    speaker,
    text,
    start: null,
    end: null,
  });
  it('is the same whatever the speakers are called, however the text is cased, spaced or split into turns', () => {
    const a = [
      turn(0, 'SPEAKER_01', 'Where were you born?'),
      turn(1, 'SPEAKER_00', 'In Busan, in 1946.'),
    ];
    const b = [
      turn(0, 'Interviewer', 'where were you BORN?'),
      turn(1, 'Grandma Sunja', 'In  Busan,\n in 1946.'),
    ];
    const c = [
      turn(0, 'A', 'Where were'),
      turn(1, 'B', 'you born? In Busan,'),
      turn(2, 'A', 'in 1946.'),
    ];
    expect(hashTurns(a)).toBe(hashTurns(b));
    expect(hashTurns(a)).toBe(hashTurns(c));
  });
  it('differs when a single word differs, and is the same however its accents were composed', () => {
    const a = [turn(0, 'A', 'In Busan, in 1946.')];
    expect(hashTurns(a)).not.toBe(hashTurns([turn(0, 'A', 'In Busan, in 1947.')]));
    const nfc = [turn(0, 'A', 'José was born in Mérida.')];
    const nfd = [turn(0, 'A', 'José was born in Mérida.'.normalize('NFD'))];
    expect(hashTurns(nfc)).toBe(hashTurns(nfd));
  });
});

describe('windows', () => {
  it('a long interview is split into windows of about the same size, with no tiny trailing one', async () => {
    const A =
      'My father repaired boats and he had big hands and he did not talk much at all, and on Sundays he took me to the pier to watch the ships come in and out of the harbour while the gulls shouted.';
    const t = {
      interviewee: 'A',
      segments: Array.from({ length: 70 }, (_, i) =>
        i % 2 === 0 ? seg(i, 'Q', 'And then what happened?') : seg(i, 'A', `${A} ${'x'.repeat(0)}`),
      ),
    };
    const m = model(['{"memories":[]}']);
    await ingestTranscript(t, {}, deps(m));
    const first = m.calls.filter((c) => c.includes('[1|A]') || c.includes('[1]'));
    const sizes = m.calls.slice(0, 2).map((c) => c.length);
    // 35 answers of ~190 characters is ~6,700: two windows, not 6,000 + 700
    expect(first.length).toBeGreaterThan(0);
    expect(sizes).toHaveLength(2);
    expect(Math.min(...sizes) / Math.max(...sizes)).toBeGreaterThan(0.6);
  });
});

describe('who told it, and where it came from', () => {
  const t = {
    interviewee: 'A',
    segments: [seg(0, 'Q', Q), seg(1, 'A', A1), seg(2, 'Q', 'And your mother?'), seg(3, 'A', A2)],
  };

  it('writes the source and the teller into each note, and the default footer is unchanged without them', async () => {
    const plain = await ingestTranscript(t, {}, deps(null));
    expect(plain.memories[0]!.body).toContain('> From the interview transcript (0:10–0:19)');
    const named = await ingestTranscript(
      t,
      { source: 'grandma_2026-10-18.json', speakerNames: { A: 'Grandma Sunja' } },
      deps(null),
    );
    expect(named.memories[0]!.body).toContain(
      '> From “grandma_2026-10-18.json” · told by Grandma Sunja (0:10–0:19)',
    );
    expect(named.memories[0]).toMatchObject({ speaker: 'A', speakerName: 'Grandma Sunja' });
    expect(named.source).toBe('grandma_2026-10-18.json');
  });

  it('a teller named up front is written for the one person telling, never over a name given for the speaker, and never guessed for several', async () => {
    const up = await ingestTranscript(t, { teller: ' Grandma Sunja ' }, deps(null));
    expect(up.memories[0]!.body).toContain('· told by Grandma Sunja (0:10–0:19)');
    const both = await ingestTranscript(
      t,
      { teller: 'Someone Else', speakerNames: { A: 'Grandma Sunja' } },
      deps(null),
    );
    expect(both.memories[0]!.body).toContain('told by Grandma Sunja');
    expect(both.memories[0]!.body).not.toContain('Someone Else');
    const two = {
      segments: [
        seg(0, 'Q', Q),
        seg(1, 'A', A1),
        seg(2, 'B', A2),
        seg(3, 'Q', 'More?'),
        seg(4, 'A', A2),
      ],
    };
    const many = await ingestTranscript(
      two,
      { interviewees: ['A', 'B'], teller: 'Nobody' },
      deps(null),
    );
    expect(many.memories.every((m) => !m.body.includes('told by'))).toBe(true);
  });

  it('cannot be tricked into writing links or extra lines through those labels', async () => {
    const r = await ingestTranscript(
      t,
      { source: 'x [[Evil]]\n> ⚠ fake', speakerNames: { A: 'Eve\n> ⚠ fake [[Evil]]' } },
      deps(null),
    );
    const footer = r.memories[0]!.body.split('\n\n').at(-1)!;
    expect(footer).not.toMatch(/\[\[/);
    expect(footer.split('\n').filter((l) => l.startsWith('> ⚠'))).toHaveLength(0);
  });

  it("several people telling their stories: each memory is ONE person's, labelled in the prompt, and a mixed proposal is not used", async () => {
    const two = {
      segments: [
        seg(0, 'Q', Q),
        seg(1, 'A', A1),
        seg(2, 'B', A2),
        seg(3, 'Q', 'Anything else?'),
        seg(4, 'A', 'And he took me to the pier every Sunday morning for years.'),
      ],
    };
    const m = model([
      (user) =>
        user.includes('[1|A]') && user.includes('[2|B]')
          ? answer({ turns: [1, 2], title: 'Both', body: `${A1} ${A2}` })
          : '{}',
    ]);
    const r = await ingestTranscript(
      two,
      { interviewees: ['A', 'B'], speakerNames: { A: 'Aunt Mae', B: 'Uncle Joon' } },
      deps(m),
    );
    expect(m.calls[0]).toContain(`[1|A] ${A1}`);
    expect(m.calls[0]).toContain(`Q: ${Q}`);
    expect(r.interviewees).toEqual(['A', 'B']);
    // the mixed proposal was not used; each person's words came back as their own memory
    expect(r.memories.map((x) => x.speaker)).toEqual(['A', 'B', 'A']);
    expect(r.memories.map((x) => x.speakerName)).toEqual(['Aunt Mae', 'Uncle Joon', 'Aunt Mae']);
    expect(r.memories.every((x) => x.method === 'verbatim')).toBe(true);
  });

  it('a single teller sees plain [n] lines with no label', async () => {
    const m = model([answer({ turns: [1], title: 'Boats', body: A1 })]);
    await ingestTranscript(t, {}, deps(m));
    expect(m.calls[0]).toContain(`[1] ${A1}`);
    expect(m.calls[0]).not.toContain('|A]');
  });
});

describe("the interviewer's question", () => {
  it('is the closest real question before the memory, skipping a throwaway line', async () => {
    const r = await ingestTranscript(
      {
        interviewee: 'A',
        segments: [
          seg(0, 'I1', 'Tell me about your father please.'),
          seg(1, 'I2', 'Okay.'),
          seg(2, 'A', A1),
        ],
      },
      {},
      deps(null),
    );
    expect(r.memories[0]!.body).toContain('Question: “Tell me about your father please.”');
  });

  it("is not borrowed from an earlier answer: a memory that follows the teller's own turn has none", async () => {
    // (a remark of 60 characters or less would not split the story at all: see "interruptions")
    const r = await ingestTranscript(
      {
        interviewee: 'A',
        segments: [
          seg(0, 'Q', Q),
          seg(1, 'A', A1),
          seg(2, 'B', 'Right, and that is so true, I remember Grandpa saying the very same thing.'),
          seg(3, 'A', A2),
        ],
      },
      {},
      deps(null),
    );
    expect(r.memories).toHaveLength(2);
    expect(r.memories.at(-1)!.body).not.toContain('Question:');
  });
});

describe('not everything is a memory of its own', () => {
  it('a proposal that is only "Yes." is not a note of its own: it is kept, with its question, in Short answers', async () => {
    const t = {
      interviewee: 'A',
      segments: [
        seg(0, 'Q', 'Did he work hard?'),
        seg(1, 'A', 'Yes.'),
        seg(2, 'Q', Q),
        seg(3, 'A', A1),
      ],
    };
    const m = model([
      answer({ turns: [1], title: 'Yes', body: 'Yes.' }, { turns: [3], title: 'Boats', body: A1 }),
    ]);
    const r = await ingestTranscript(t, {}, deps(m));
    expect(r.memories.map((x) => x.title)).toEqual(['Boats', 'Short answers']);
    expect(r.memories[1]!.body.split('\n\n')[0]).toBe('- Did he work hard? — Yes.');
    expect(r.stats.coverage).toEqual({ covered: 2, total: 2 });
  });

  it('a title that is a web address or an email is not used', async () => {
    const t = { interviewee: 'A', segments: [seg(0, 'Q', Q), seg(1, 'A', A1)] };
    for (const bad of ['Visit www.evil.example now', 'mail me at a@b.co', 'https://x.y/z']) {
      const r = await ingestTranscript(
        t,
        {},
        deps(model([answer({ turns: [1], title: bad, body: A1 })])),
      );
      expect(r.memories[0]!.title).toBe('My father repaired boats and he had big hands');
    }
  });
});

/** a long interview: many windows of teller speech */
const long = (n: number) => ({
  interviewee: 'A',
  segments: Array.from({ length: n * 2 }, (_, i) =>
    i % 2 === 0
      ? seg(i, 'Q', 'And what happened after that?')
      : seg(
          i,
          'A',
          `On day ${(i + 1) / 2} we went down to the water and my father repaired the boats until the sun went down. `
            .repeat(4)
            .trim(),
        ),
  ),
});
const echoAll = (user: string): string => {
  const ids = [...user.matchAll(/^\[(\d+)\] (.+)$/gm)];
  return answer(...ids.map((m) => ({ turns: [Number(m[1])], title: `Day ${m[1]}`, body: m[2]! })));
};

describe('when the AI service fails, the person is told and nothing is lost', () => {
  it("a failed stretch falls back to the speaker's words AND is reported as degraded", async () => {
    const r = await ingestTranscript(
      long(30),
      {},
      deps(model([new ModelError('x', 'rate_limited', true)])),
    );
    expect(r.degraded.windows).toBeGreaterThan(0);
    expect(r.degraded.reasons).toEqual(['rate_limited']);
    expect(r.stats.failedWindows).toBe(r.degraded.windows);
    expect(r.memories.length).toBeGreaterThan(0);
    expect(r.memories.every((x) => x.method === 'verbatim')).toBe(true);
    expect(r.stats.coverage.covered).toBe(r.stats.coverage.total);
  });

  it('nothing degraded when everything ran', async () => {
    const r = await ingestTranscript(long(10), {}, deps(model([echoAll])));
    expect(r.degraded).toEqual({ windows: 0, reasons: [] });
  });

  it('an answer that was cut off is retried as two smaller halves, and those succeed', async () => {
    let first = true;
    const m = model([
      (user) => {
        if (first) {
          first = false;
          return new ModelError('cut', 'truncated', false);
        }
        return echoAll(user);
      },
    ]);
    const r = await ingestTranscript(long(8), {}, deps(m));
    expect(r.degraded.windows).toBe(0);
    expect(r.memories.some((x) => x.method === 'ai-grounded')).toBe(true);
    expect(m.calls.length).toBeGreaterThan(r.stats.windows); // it asked again, in halves
  });

  it('answers that are not JSON twice in a row degrade that window, with the right reason', async () => {
    const r = await ingestTranscript(
      { interviewee: 'A', segments: [seg(0, 'Q', Q), seg(1, 'A', A1)] },
      {},
      deps(model(['not json', 'still not json'])),
    );
    expect(r.degraded.reasons).toEqual(['bad_output']);
    expect(r.memories[0]!.method).toBe('verbatim');
  });

  it('a rejected key stops the asking: later windows are not sent, and the reason is "auth"', async () => {
    const m = model([new ModelError('nope', 'auth', false, 401)]);
    const r = await ingestTranscript(long(40), {}, deps(m));
    expect(r.degraded.reasons).toEqual(['auth']);
    expect(m.calls.length).toBeLessThanOrEqual(3); // only the first batch was in flight
    expect(r.degraded.windows).toBe(r.stats.windows);
    expect(r.stats.coverage.covered).toBe(r.stats.coverage.total);
  });

  it('past the deadline the rest is shown as spoken, reported as a timeout', async () => {
    const m = model([echoAll]);
    const r = await ingestTranscript(long(10), {}, deps(m, { deadlineMs: -1 }));
    expect(m.calls).toHaveLength(0);
    expect(r.degraded.reasons).toEqual(['timeout']);
    expect(r.memories.length).toBeGreaterThan(0);
  });

  it('a rejected rewrite that cannot be asked again is shown as spoken without waiting for more rounds', async () => {
    const t = { interviewee: 'A', segments: [seg(0, 'Q', Q), seg(1, 'A', A1)] };
    const m = model([
      answer({ turns: [1], title: 'Boats', body: `${A1} He later became a captain.` }),
      new ModelError('gone', 'unavailable', false),
    ]);
    const r = await ingestTranscript(t, {}, deps(m));
    expect(r.memories[0]).toMatchObject({ method: 'verbatim' });
    expect(m.calls).toHaveLength(2); // one try, one retry, then it stopped
  });
});

describe('cancel, and progress', () => {
  it('cancelling before it starts, and while it runs, raises IngestCancelled', async () => {
    const early = new AbortController();
    early.abort();
    await expect(
      ingestTranscript(long(5), {}, deps(model([echoAll]), { signal: early.signal })),
    ).rejects.toBeInstanceOf(IngestCancelled);

    const mid = new AbortController();
    const slow: ChatModel = {
      id: 's',
      complete: async (_s, _u, o) => {
        mid.abort();
        if (o?.signal?.aborted) throw new ModelError('cancelled', 'cancelled', false);
        return '{}';
      },
    };
    await expect(
      ingestTranscript(long(30), {}, deps(slow, { signal: mid.signal })),
    ).rejects.toBeInstanceOf(IngestCancelled);
  });

  it('reports progress as windows finish', async () => {
    const seen: IngestProgress[] = [];
    const r = await ingestTranscript(
      long(12),
      {},
      deps(model([echoAll]), { onProgress: (p: IngestProgress) => seen.push(p) }),
    );
    expect(seen.at(0)).toEqual({ stage: 'organizing', done: 0, total: r.stats.windows });
    expect(seen.at(-1)).toEqual({
      stage: 'organizing',
      done: r.stats.windows,
      total: r.stats.windows,
    });
    expect(seen.map((p) => p.done)).toEqual([...seen.map((p) => p.done)].sort((a, b) => a - b));
  });
});

describe('what the result tells the caller', () => {
  it("carries the roles decision and the parser's warnings", async () => {
    const input = {
      segments: [
        { start: 0, end: 4, text: 'Where were you born?' },
        { start: 4, end: 20, text: A1 },
        { start: 20, end: 24, text: '[Music]' },
      ],
    };
    const r = await ingestTranscript(input, {}, deps(null));
    // exactly what the roles module decided, passed through (its rules are its own)
    const decided = applyRoles(parseTranscript(input)).roles;
    expect(r.roles).toEqual({
      source: decided.source,
      confidence: decided.confidence,
      reasons: decided.reasons,
      needsConfirmation: decided.needsConfirmation,
    });
    expect(r.roles.source).toBe('guess');
    expect(r.warnings.map((w) => w.code).sort()).toEqual([
      'annotations_removed',
      'no_speakers',
      'questions_guessed',
    ]);
    expect(r.speakers.map((s) => s.id).sort()).toEqual(['QUESTIONS', 'SPEAKER_00']);
  });

  it('the same words hash the same in any file format, and different words differ', () => {
    const txt = parseTranscript(`[Q]: ${Q}\n[A]: ${A1}`);
    const srt = parseTranscript(
      `1\n00:00:00,000 --> 00:00:04,000\n[Q]: ${Q}\n\n2\n00:00:04,000 --> 00:00:20,000\n[A]: ${A1}\n`,
    );
    const json = parseTranscript({ segments: [seg(0, 'Q', Q), seg(1, 'A', A1)] });
    expect(hashTurns(txt.turns)).toBe(hashTurns(srt.turns));
    expect(hashTurns(txt.turns)).toBe(hashTurns(json.turns));
    expect(
      hashTurns(parseTranscript({ segments: [seg(0, 'Q', Q), seg(1, 'A', A2)] }).turns),
    ).not.toBe(hashTurns(json.turns));
  });
});

/* ── helpers for the tests below ─────────────────────────────────────── */

/** the part of a note the speaker's words are in: everything before the footer */
const prose = (body: string) =>
  body
    .split('\n')
    .filter((l) => !l.startsWith('> '))
    .join('\n')
    .trim();
const allProse = (r: IngestResult) => r.memories.map((m) => prose(m.body)).join('\n');
/** a long interview of distinct sentences (repeated ones would be collapsed when read) */
const wide = (n: number) => ({
  interviewee: 'A',
  segments: Array.from({ length: n * 2 }, (_, i) =>
    i % 2 === 0
      ? seg(i, 'Q', 'And what happened after that?')
      : seg(
          i,
          'A',
          Array.from(
            { length: 8 },
            (_, k) =>
              `On day ${i} part ${k} we went down to the water number ${i * 10 + k} and my father repaired boat ${k}.`,
          ).join(' '),
        ),
  ),
});
/** a model that proposes every teller line as its own memory, word for word */
const eachLine = (user: string): string =>
  answer(
    ...[...user.matchAll(/^\[(\d+)(?:\|[^\]]+)?\] (.+)$/gm)].map((m) => ({
      turns: [Number(m[1])],
      title: 'A memory',
      body: m[2]!,
    })),
  );

describe('nothing the relative said is lost: short answers (A1)', () => {
  const EN = `Interviewer: What was your mother's name?
Grandma: Her name was Sunja Kim.
Interviewer: When were you born?
Grandma: In 1946, in Busan.
Interviewer: And when did your father die?
Grandma: March 1989. Of a stroke.
Interviewer: Did he ever talk about the war?
Grandma: No. Never.
Interviewer: How many brothers did you have?
Grandma: Four brothers, two sisters.
Interviewer: Tell me about the house you grew up in.
Grandma: It was a small house near the harbour, with a blue door, and my mother kept chickens in the yard behind it.`;
  const said = EN.split('\n')
    .filter((l) => l.startsWith('Grandma: '))
    .map((l) => l.slice('Grandma: '.length));

  for (const [label, chat] of [
    ['no AI', () => null],
    ['an AI that proposes every line', () => model([eachLine])],
  ] as const) {
    it(`short factual answers are all kept, and coverage counts every one (${label})`, async () => {
      const r = await ingestTranscript(EN, {}, deps(chat()));
      for (const line of said) expect(allProse(r)).toContain(line);
      expect(r.stats.coverage).toEqual({ covered: 6, total: 6 });
      // the ones with something in them stand alone; "No. Never." waits in Short answers
      const own = r.memories.filter((m) => m.title !== 'Short answers');
      expect(own.map((m) => prose(m.body))).toEqual(said.filter((l) => l !== 'No. Never.'));
      const short = r.memories.at(-1)!;
      expect(short).toMatchObject({
        title: 'Short answers',
        method: 'verbatim',
        type: 'event',
        occurred: null,
        speaker: 'Grandma',
      });
      expect(prose(short.body)).toBe('- Did he ever talk about the war? — No. Never.');
      expect(r.warnings).toContainEqual({ code: 'short_answers', count: 1 });
    });
  }

  it('answers in a script these rules do not read are kept, every one, as they were said', async () => {
    const OTHER = `Interviewer: What was your mother's name?
Grandma: Её звали Ирина.
Interviewer: When were you born?
Grandma: В 1946 году, в Одессе.
Interviewer: Brothers and sisters?
Grandma: Четыре брата, две сестры.
Interviewer: Where is home?
Grandma: Одесса.`;
    for (const chat of [null, model([eachLine])]) {
      const r = await ingestTranscript(OTHER, {}, deps(chat));
      expect(r.stats.coverage).toEqual({ covered: 4, total: 4 });
      expect(r.memories.map((m) => m.title).at(-1)).toBe('Short answers');
      const short = r.memories.at(-1)!;
      expect(prose(short.body)).toBe(
        "- What was your mother's name? — Её звали Ирина.\n- Where is home? — Одесса.",
      );
      expect(short.body).toContain('> From the interview transcript · told by Grandma');
      expect(short.notes).toEqual([
        'Short replies are gathered in this one note, each with the question it answered, so that none is lost.',
      ]);
      expect(allProse(r)).toContain('В 1946 году, в Одессе.');
      expect(allProse(r)).toContain('Четыре брата, две сестры.');
    }
  });

  it('"Every day." to "Do you miss her?" is kept with its question', async () => {
    const r = await ingestTranscript(
      `Interviewer: When did she pass away?
Grandpa Tae: Two thousand and nineteen. In the spring. We buried her by the river.
Interviewer: Do you miss her?
Grandpa Tae: Every day.`,
      {},
      deps(null),
    );
    expect(prose(r.memories.at(-1)!.body)).toBe('- Do you miss her? — Every day.');
    expect(r.stats.coverage).toEqual({ covered: 2, total: 2 });
  });

  it('a relative who talks in short bursts loses nothing, with the AI down or absent', async () => {
    const lines = [
      ['Interviewer', 'Tell me about Grandpa.'],
      ['Grandma', 'He was a quiet man.'],
      ['Interviewer', 'For how long did he work at the mill?'],
      ['Grandma', 'Thirty-one years.'],
      ['Interviewer', 'Not one day missed?'],
      ['Grandma', 'Not one.'],
      ['Interviewer', 'Who was Frank?'],
      ['Grandma', 'Our first boy. He died at six.'],
    ];
    const t = lines.map(([s, x]) => `${s}: ${x}`).join('\n');
    const down = model([new ModelError('x', 'unavailable', false)]);
    for (const chat of [null, down]) {
      const r = await ingestTranscript(t, {}, deps(chat));
      for (const [s, x] of lines) if (s === 'Grandma') expect(allProse(r)).toContain(x);
      expect(r.stats.coverage).toEqual({ covered: 4, total: 4 });
    }
  });

  it('the last sentence of a long answer, cut off on its own, is kept', async () => {
    let body = '';
    for (let i = 1; body.length < 2470; i++) {
      body += `On day number ${i} we worked on the farm from dawn to dusk behind the old barn. `;
    }
    const r = await ingestTranscript(
      `Interviewer: Tell me about your father.\nGrandma: ${body.trim()} He died at 52.`,
      {},
      deps(null),
    );
    expect(allProse(r)).toContain('He died at 52.');
    expect(r.stats.coverage.covered).toBe(r.stats.coverage.total);
  });

  it('one Short answers note per teller, at most 30 replies each, then "Short answers (2)"; it sorts last', async () => {
    const segs = [seg(0, 'Q', 'Tell me about the boat you had as a young man.')];
    segs.push(seg(1, 'A', A1));
    for (let i = 0; i < SHORT_LINES_PER_NOTE + 5; i++) {
      segs.push(seg(2 + i * 2, 'Q', `And what was the answer to question ${i}?`));
      segs.push(seg(3 + i * 2, 'A', `Answer ${i}.`));
    }
    const r = await ingestTranscript({ interviewee: 'A', segments: segs }, {}, deps(null));
    expect(r.memories.map((m) => m.title)).toEqual([
      'My father repaired boats and he had big hands',
      'Short answers',
      'Short answers (2)',
    ]);
    expect(prose(r.memories[1]!.body).split('\n')).toHaveLength(SHORT_LINES_PER_NOTE);
    expect(prose(r.memories[2]!.body).split('\n')).toHaveLength(5);
    expect(prose(r.memories[1]!.body).split('\n')[0]).toBe(
      '- And what was the answer to question 0? — Answer 0.',
    );
    expect(r.warnings).toContainEqual({ code: 'short_answers', count: SHORT_LINES_PER_NOTE + 5 });
    expect(r.stats.coverage).toEqual({
      covered: SHORT_LINES_PER_NOTE + 6,
      total: SHORT_LINES_PER_NOTE + 6,
    });
  });

  it('two people telling: each gets their own Short answers note, in their own words', async () => {
    const r = await ingestTranscript(
      {
        segments: [
          seg(0, 'Q', 'Aunt Mae, did you see the flood yourself?'),
          seg(1, 'Mae', 'Yes, I did.'),
          seg(2, 'Q', 'Uncle Joon, were you there as well?'),
          seg(3, 'Joon', 'No, never.'),
          seg(4, 'Q', Q),
          seg(5, 'Mae', A1),
        ],
      },
      { interviewees: ['Mae', 'Joon'] },
      deps(null),
    );
    const short = r.memories.filter((m) => m.title === 'Short answers');
    expect(short.map((m) => m.speaker)).toEqual(['Mae', 'Joon']);
    expect(prose(short[0]!.body)).toBe('- Aunt Mae, did you see the flood yourself? — Yes, I did.');
    expect(prose(short[1]!.body)).toBe('- Uncle Joon, were you there as well? — No, never.');
  });

  it('a relative\'s own "Mm-hm." to a question is an answer: kept in Short answers with the question', async () => {
    const r = await ingestTranscript(
      `Interviewer: Did you love him?
Grandma: Mm-hm.
Interviewer: Tell me about the day you met him.
Grandma: ${A1}`,
      { interviewees: ['Grandma'] },
      deps(null),
    );
    expect(prose(r.memories.at(-1)!.body)).toBe('- Did you love him? — Mm-hm.');
    expect(r.stats.coverage).toEqual({ covered: 2, total: 2 });
  });

  it('an answer with no question before it is a plain line', async () => {
    const r = await ingestTranscript(
      { interviewee: 'A', segments: [seg(0, 'A', 'Yes, Tom.'), seg(1, 'Q', Q), seg(2, 'A', A1)] },
      {},
      deps(null),
    );
    expect(prose(r.memories.at(-1)!.body)).toBe('- Yes, Tom.');
  });
});

describe('the date is read from what the note keeps (A2)', () => {
  it('a rewrite that dropped the sentence with the year does not carry that year', async () => {
    const said =
      'My father repaired boats in the harbour every day of his life, and my mother sold fish at the market. My brother Tom drowned in 1952.';
    const r = await ingestTranscript(
      {
        interviewee: 'A',
        segments: [seg(0, 'Q', 'What do you remember about your family?'), seg(1, 'A', said)],
      },
      {},
      deps(
        model([
          answer({
            turns: [1],
            title: 'Family',
            body: 'My father repaired boats in the harbour every day of his life, and my mother sold fish at the market.',
          }),
        ]),
      ),
    );
    // whichever way the checker decides, a date on the note is one the note's own words state
    for (const m of r.memories) {
      if (m.occurred) expect(prose(m.body)).toContain(m.occurred.replace('~', '').slice(0, 4));
    }
    expect(allProse(r)).toContain('My brother Tom drowned in 1952.');
  });

  it('a date in an accepted rewrite is its own: spoken years written as digits still count', async () => {
    const said =
      'At a church supper in nineteen sixty-six he spilled gravy all over my dress, and I was so angry.';
    const r = await ingestTranscript(
      {
        interviewee: 'A',
        segments: [seg(0, 'Q', 'How did you meet your husband?'), seg(1, 'A', said)],
      },
      {},
      deps(model([answer({ turns: [1], title: 'The church supper', body: said })])),
    );
    expect(r.memories[0]).toMatchObject({ method: 'ai-grounded', occurred: '1966' });
  });
});

describe('the date is read from the accepted text itself (A2)', () => {
  it('an accepted rewrite is dated by what the NOTE says, in whatever form it writes the year', async () => {
    // (a rewrite that reorders the sentences, or leads with a different year, is refused by the gate
    // since round 3, so the date can only differ in form: spoken years written as digits)
    const said =
      'In nineteen fifty-eight there was a drought and the well went dry. We sold the cows in nineteen fifty-nine to pay the debts.';
    const body =
      'In 1958 there was a drought and the well went dry. We sold the cows in 1959 to pay the debts.';
    const r = await ingestTranscript(
      {
        interviewee: 'A',
        segments: [seg(0, 'Q', 'What happened to the farm?'), seg(1, 'A', said)],
      },
      {},
      deps(model([answer({ turns: [1], title: 'The drought', body })])),
    );
    expect(r.memories[0]).toMatchObject({ method: 'ai-grounded', occurred: '1958' });
    // a rewrite that swaps the two sentences is not accepted: her words, in her order, are kept
    const swapped =
      'We sold the cows in 1959 to pay the debts. In 1958 there was a drought and the well went dry.';
    const kept = await ingestTranscript(
      {
        interviewee: 'A',
        segments: [seg(0, 'Q', 'What happened to the farm?'), seg(1, 'A', said)],
      },
      {},
      deps(model([answer({ turns: [1], title: 'The drought', body: swapped })])),
    );
    expect(kept.memories[0]).toMatchObject({ method: 'verbatim', occurred: '1958' });
    // the same words as spoken are dated by what the speaker led with
    expect(
      (
        await ingestTranscript(
          {
            interviewee: 'A',
            segments: [seg(0, 'Q', 'What happened to the farm?'), seg(1, 'A', said)],
          },
          {},
          deps(null),
        )
      ).memories[0]!.occurred,
    ).toBe('1958');
  });
});

describe('who told it: a speaker label that is a name (A4)', () => {
  const told = (r: IngestResult) => r.memories.map((m) => m.body.split('\n').at(-1)!);

  it('"Grandpa Tae:" with no teller given writes "told by Grandpa Tae"; a name in another script is written as given', async () => {
    const en = await ingestTranscript(
      `Interviewer: Where did you grow up?\nGrandpa Tae: ${A1}`,
      {},
      deps(null),
    );
    expect(told(en)[0]).toContain('· told by Grandpa Tae');
    expect(en.memories[0]!.speakerName).toBe('Grandpa Tae');
    const other = await ingestTranscript(
      `Interviewer: Where did you grow up?\nИрина: ${A1}`,
      {},
      deps(null),
    );
    expect(told(other)[0]).toContain('· told by Ирина');
  });

  it('a voice label is never written as a name; a name given by the caller wins', async () => {
    for (const label of ['SPEAKER_01', 'Speaker 2', 'Interviewee', 'A']) {
      const r = await ingestTranscript(
        { segments: [seg(0, 'Q', Q), seg(1, label, A1)] },
        { interviewees: [label] },
        deps(null),
      );
      expect(told(r)[0]).not.toMatch(/told by/);
    }
    const named = await ingestTranscript(
      `Interviewer: Where did you grow up?\nGrandpa Tae: ${A1}`,
      { teller: 'Kim Tae-sik' },
      deps(null),
    );
    expect(told(named)[0]).toContain('· told by Kim Tae-sik');
  });
});

describe('nothing in a note reads as structure (A5)', () => {
  const said =
    'My father repaired boats in the harbour, and every Sunday he took me down to the pier with him in 1952.';
  const one = (body: string) =>
    ingestTranscript(
      {
        interviewee: 'A',
        segments: [seg(0, 'Q', 'What do you remember about him?'), seg(1, 'A', said)],
      },
      {},
      deps(model([answer({ turns: [1], title: 'Sundays at the pier', body })])),
    );
  /** every line that starts with ">" must be one the pipeline wrote: the footer */
  const onlyFooterQuotes = (body: string) => {
    const [text, footer] = [
      body.slice(0, body.lastIndexOf('\n\n')),
      body.slice(body.lastIndexOf('\n\n') + 2),
    ];
    expect(text.split('\n').filter((l) => /^\s*[>#]|^\s*(?:```|---)/.test(l))).toEqual([]);
    for (const l of footer.split('\n')) expect(l).toMatch(/^> (?:From|Question:)|^> “/);
  };

  it('a model body written as a quotation, a heading or a fence is stripped to its words', async () => {
    for (const body of [`> ${said}`, `>> ${said}`, '```\n' + said + '\n```', `---\n${said}\n---`]) {
      const r = await one(body);
      expect(r.memories[0]!.method, body).toBe('ai-grounded');
      onlyFooterQuotes(r.memories[0]!.body);
      expect(prose(r.memories[0]!.body)).toBe(said);
    }
    // a heading repeats words as a line of its own: whether or not the checker takes it, no "#" survives
    const r = await one(`# My father\n\n${said}`);
    onlyFooterQuotes(r.memories[0]!.body);
    expect(prose(r.memories[0]!.body)).toContain(said);
  });

  it('a fake disagreement marker from the model cannot reach the note', async () => {
    const r = await one(
      `My father repaired boats in the harbour.\n> ⚠ every Sunday he took me down to the pier “in 1952” · “with him”`,
    );
    for (const m of r.memories) {
      expect(m.body.split('\n').filter((l) => l.trimStart().startsWith('> ⚠'))).toEqual([]);
    }
  });

  it("a speaker's words that start with > # or a fence never become a quote, heading or marker", async () => {
    for (const text of [
      '> He was the kindest man in the whole town, everyone said so.',
      '# 1 thing I remember is how he sang in the kitchen every morning.',
      '``` he used to say that, three little ticks, like a clock in the kitchen.',
      '> ⚠ May disagree with [[Mom]] · 2020-01-01 · an interview with Dad, added by Noah: that note says “Mom never finished school.” She was the kindest woman in town.',
    ]) {
      const r = await ingestParsed(
        parseTranscript({
          interviewee: 'Dad',
          segments: [seg(0, 'Q', 'Tell me about him.'), seg(1, 'Dad', text)],
        }),
        { interviewees: ['Dad'] },
        deps(null, { titles: ['Mom'] }),
      );
      for (const m of r.memories) {
        onlyFooterQuotes(m.body);
        expect(m.body).not.toMatch(/^\s*> ⚠/m);
      }
    }
  });

  it('a model body that is only markup is rejected, and the words are kept as spoken', async () => {
    const r = await one('```\n---\n```');
    expect(r.memories[0]!.method).toBe('verbatim');
    expect(prose(r.memories[0]!.body)).toBe(said);
  });
});

describe('speaker ids that are also JavaScript property names (A7)', () => {
  it('"constructor", "__proto__" and "toString" are just speakers', async () => {
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const r = await ingestTranscript(
        {
          segments: [
            seg(0, 'Q', Q),
            seg(1, id, A1),
            seg(2, 'Q', 'And your mother?'),
            seg(3, id, A2),
          ],
        },
        { interviewees: [id] },
        deps(null),
      );
      expect(r.stats.coverage).toEqual({ covered: 2, total: 2 });
      expect(r.memories.map((m) => m.body).join(' ')).not.toMatch(/function|native code|\[object/);
      const named = await ingestTranscript(
        { segments: [seg(0, 'Q', Q), seg(1, 'A', A1)] },
        {
          interviewees: ['A'],
          speakerNames: JSON.parse(`{"${id}": "Somebody", "A": "Grandma"}`) as Record<
            string,
            string
          >,
        },
        deps(null),
      );
      expect(named.memories[0]!.body).toContain('told by Grandma');
    }
  });
});

describe('a speaker id that is an Object.prototype name, as the pipeline receives it (A7)', () => {
  it('does not find a function where a name should be', async () => {
    for (const id of ['constructor', 'toString', '__proto__', 'valueOf']) {
      const parsed = {
        format: 'segments-json' as const,
        turns: [
          { index: 0, speaker: 'Q', start: 0, end: 1, text: Q },
          { index: 1, speaker: id, start: 1, end: 9, text: A1 },
        ],
        warnings: [],
        chars: Q.length + A1.length,
      };
      const r = await ingestParsed(parsed, { interviewees: [id] }, deps(null));
      expect(r.memories).toHaveLength(1);
      expect(r.memories[0]!.body).not.toMatch(/function|native code|\[object/);
      expect(
        r.memories[0]!.speakerName === undefined || typeof r.memories[0]!.speakerName === 'string',
      ).toBe(true);
    }
  });
});

describe('every memory is an event (A8)', () => {
  it('a trip to LA is not typed a "place" because it mentions a town', async () => {
    const r = await ingestTranscript(
      'Interviewer: How long did you live in America at first?\nJung Mi-kyung: Uh, in 1985 I went to LA. At first we lived in Koreatown and I could not speak any English. Home, school and the market were all far away.',
      {},
      deps(null),
    );
    expect(r.memories.map((m) => m.type)).toEqual(['event']);
    const ai = await ingestTranscript(
      {
        interviewee: 'A',
        segments: [
          seg(0, 'Q', Q),
          seg(
            1,
            'A',
            'Our house was next to the market. The school was close too. My mother sold fish at the market.',
          ),
        ],
      },
      {},
      deps(model([eachLine])),
    );
    expect(ai.memories.map((m) => [m.method, m.type])).toEqual([['ai-grounded', 'event']]);
  });
});

describe('words in another script, in an English interview (B1)', () => {
  const MIXED = `Interviewer: Grandma, tell me about your childhood.
Grandma: Я родилась в Одессе. Наш маленький дом стоял прямо у моря.
Interviewer: What was your mother like?
Grandma: Мама каждое утро ходила на рынок продавать рыбу. Она очень много работала.
Interviewer: How did you come to America?
Grandma: We came to Los Angeles in 1975 because my husband found work at a garment factory downtown.
Interviewer: What was the hardest part?
Grandma: The language was the hardest. I could not read the signs at the supermarket for years.`;

  it("every footer and note is English, the words are kept as said, and a title in that script is never the model's", async () => {
    const chat = model([
      (user) =>
        answer(
          ...[...user.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => ({
            turns: [Number(m[1])],
            title: OTHER_SCRIPT.test(m[2]!) ? 'Дом у моря' : 'Coming to Los Angeles',
            body: m[2]!,
          })),
        ),
    ]);
    const r = await ingestTranscript(MIXED, { teller: 'Irina Petrova' }, deps(chat));
    for (const m of r.memories) {
      expect(m.body.split('\n').at(-1)).toContain('told by Irina Petrova');
      expect(m.notes.join(' ')).not.toMatch(OTHER_SCRIPT);
    }
    expect(allProse(r)).toContain('Я родилась в Одессе. Наш маленький дом стоял прямо у моря.');
    // the model's title in that script is not used: the memory is named by its own first words
    expect(r.memories[0]!.title).toBe('Я родилась в Одессе');
    expect(r.memories[2]!.title).toBe('Coming to Los Angeles');
  });
});

describe("the interviewer's question (B3)", () => {
  it("only the principal interviewer's real questions are quoted: not a child's, not a break", async () => {
    const r = await ingestTranscript(
      `Interviewer: Tell me about the time you bought the truck.
Grandpa Min: So in nineteen seventy-eight I saved up for two years and bought a used Hyundai truck, blue, with a cracked windshield.
Interviewer: How did the first month go for you?
Grandpa Min: I drove it to the market every morning at four, and in the first month I made more money than in the whole year before.
Child: Grandpa can I have a cookie?
Grandpa Min: In a minute, Joon. So that truck paid for your mother's school fees, all of it.
Interviewer: I'm so sorry. Do you want to take a break?
Grandpa Min: No, no. I want to say this. Your grandmother packed the boxes every night and I could not have done it without her.`,
      { interviewees: ['Grandpa Min'] },
      deps(null),
    );
    const quoted = r.memories.map((m) => /> Question: “([^”]*)”/.exec(m.body)?.[1] ?? null);
    expect(quoted).toEqual([
      'Tell me about the time you bought the truck.',
      'How did the first month go for you?',
      null,
      null,
    ]);
  });

  it('a hand-typed "Q:" is not part of the quoted question', async () => {
    const r = await ingestTranscript(
      { segments: [seg(0, 'Interviewer', 'Q: How old were you when you left?'), seg(1, 'A', A1)] },
      { interviewees: ['A'] },
      deps(null),
    );
    expect(r.memories[0]!.body).toContain('> Question: “How old were you when you left?”');
  });
});

describe('interruptions do not split a story (B4)', () => {
  it('"It was green!" between two parts of one story is not a boundary; a follow-up question is', async () => {
    const r = await ingestTranscript(
      `Interviewer: Tell me about the time you bought the truck.
Grandpa Min: So in nineteen seventy-eight I saved up for two years and bought a used truck, blue, with a cracked windshield.
Grandma Sunja: It was green!
Grandpa Min: It was blue. Anyway, I drove it to the market every morning at four.
Interviewer: And how much did you make in that first month?
Grandpa Min: More money than in the whole year before, and it paid for the school fees.`,
      { interviewees: ['Grandpa Min'] },
      deps(null),
    );
    expect(r.memories.map((m) => m.turns)).toEqual([[1, 3], [5]]);
    expect(allProse(r)).not.toContain('It was green');
  });
});

describe('degraded counts windows of the interview (B5)', () => {
  it('a window that was halved twice and failed is ONE degraded window, with its reasons', async () => {
    const r = await ingestTranscript(
      long(4),
      {},
      deps(model([new ModelError('cut', 'truncated', false)])),
    );
    expect(r.stats.windows).toBe(1);
    expect(r.degraded).toEqual({ windows: 1, reasons: ['truncated'] });
    expect(r.stats.failedWindows).toBe(1);
  });

  it('seven windows that all fail are seven, not twenty-eight', async () => {
    const r = await ingestTranscript(
      wide(62),
      {},
      deps(model([new ModelError('cut', 'truncated', false)])),
    );
    expect(r.stats.windows).toBeGreaterThanOrEqual(7);
    expect(r.degraded).toEqual({ windows: r.stats.windows, reasons: ['truncated'] });
  });
});

describe('the call budget (B6)', () => {
  it('a model that never answers in JSON cannot make more than the budget of calls', async () => {
    const m = model(['Sure! Here are the memories.']);
    const r = await ingestTranscript(wide(62), {}, deps(m));
    expect(r.stats.windows).toBeGreaterThanOrEqual(7);
    expect(m.calls.length).toBeLessThanOrEqual(callBudget(r.stats.windows));
    expect(r.degraded.reasons).toContain('budget');
    expect(r.degraded.windows).toBe(r.stats.windows);
    expect(r.stats.coverage.covered).toBe(r.stats.coverage.total);
    expect(r.memories.every((x) => x.method === 'verbatim')).toBe(true);
  });

  it('a rewrite that fails the same way twice is not asked a third time', async () => {
    const m = model([
      answer({ turns: [1], title: 'Boats', body: `${A1} He later became a captain.` }),
    ]);
    const r = await ingestTranscript(
      { interviewee: 'A', segments: [seg(0, 'Q', Q), seg(1, 'A', A1)] },
      {},
      deps(m),
    );
    expect(m.calls).toHaveLength(2); // the window, and one retry that came back the same
    expect(r.stats).toMatchObject({ exit: 'round_budget', retried: 1 });
    expect(r.memories[0]).toMatchObject({ method: 'verbatim' });
    expect(r.degraded).toEqual({ windows: 0, reasons: [] });
  });

  it('a gate that keeps rejecting every memory of a long interview stays within the budget', async () => {
    let n = 0;
    const m = model([
      (user) =>
        answer(
          ...[...user.matchAll(/^\[(\d+)\] (.+)$/gm)].map((x) => ({
            turns: [Number(x[1])],
            title: 'Boats',
            body: `${x[2]} Wonderful number ${n++}.`,
          })),
        ),
    ]);
    const r = await ingestTranscript(wide(62), {}, deps(m));
    expect(m.calls.length).toBeLessThanOrEqual(callBudget(r.stats.windows));
    expect(r.stats.coverage.covered).toBe(r.stats.coverage.total);
    expect(allProse(r)).not.toMatch(/Wonderful/);
  });
});

describe('the deadline stops a call already in flight (B7)', () => {
  it('a model that never answers is cut off at the deadline: the rest is shown as spoken', async () => {
    const hang: ChatModel & { calls: number } = {
      id: 'hang',
      calls: 0,
      complete() {
        this.calls++;
        return new Promise<string>(() => {}); // never settles, ignores the signal
      },
    };
    const t0 = Date.now();
    const r = await ingestTranscript(long(10), {}, deps(hang, { deadlineMs: 150 }));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.degraded.reasons).toEqual(['timeout']);
    expect(r.stats.coverage.covered).toBe(r.stats.coverage.total);
    expect(r.memories.every((x) => x.method === 'verbatim')).toBe(true);
  });

  it('the signal a model is given aborts at the deadline', async () => {
    let seen: AbortSignal | undefined;
    const polite: ChatModel = {
      id: 'polite',
      complete: (_s, _u, o) =>
        new Promise<string>((_resolve, reject) => {
          seen = o?.signal;
          o?.signal?.addEventListener('abort', () =>
            reject(new ModelError('cancelled', 'cancelled', false)),
          );
        }),
    };
    const r = await ingestTranscript(long(3), {}, deps(polite, { deadlineMs: 100 }));
    expect(seen?.aborted).toBe(true);
    expect(r.degraded.reasons).toEqual(['timeout']);
  });

  it('cancelling the job while a call is in flight is still a cancellation, not a timeout', async () => {
    const ac = new AbortController();
    const hang: ChatModel = {
      id: 'hang',
      complete: () => {
        setTimeout(() => ac.abort(), 20);
        return new Promise<string>(() => {});
      },
    };
    await expect(
      ingestTranscript(long(3), {}, deps(hang, { signal: ac.signal, deadlineMs: 60_000 })),
    ).rejects.toBeInstanceOf(IngestCancelled);
  });
});

describe('a rejection caused by a link is reported for what it was (B9)', () => {
  it('a word the speaker never said inside [[…]] is named to the model and to the reviewer', async () => {
    const said =
      'My father repaired boats in the harbour every day, and he did not talk much at all.';
    const m = model([
      answer({
        turns: [1],
        title: 'Boats',
        body: 'My father repaired boats in the [[Captain Kim harbour]] every day, and he did not talk much at all.',
      }),
    ]);
    const r = await ingestTranscript(
      { interviewee: 'A', segments: [seg(0, 'Q', Q), seg(1, 'A', said)] },
      {},
      deps(m),
    );
    expect(m.calls[1]).toMatch(/captain/i);
    expect(r.memories[0]!.method).toBe('verbatim');
    expect(r.memories[0]!.notes.join(' ')).toMatch(/not said.*captain/i);
  });
});

describe("the speaker's opening word is theirs", () => {
  const tidyOne = async (
    said: string,
    body: string,
    question = 'Did your father play any music?',
  ) =>
    (
      await ingestTranscript(
        { interviewee: 'A', segments: [seg(0, 'Q', question), seg(1, 'A', said)] },
        {},
        deps(model([answer({ turns: [1], title: 'Music', body })])),
      )
    ).memories[0]!;

  it('a rewrite that dropped "Yes." / "No, no." / "So" gets it back, as it was said', async () => {
    const yes = await tidyOne(
      'Yes. My father played the flute on the boat at night, very softly, so that he would not wake the men.',
      'My father played the flute on the boat at night, very softly, so that he would not wake the men.',
    );
    expect(yes.method).toBe('ai-grounded');
    expect(prose(yes.body)).toBe(
      'Yes. My father played the flute on the boat at night, very softly, so that he would not wake the men.',
    );
    const nono = await tidyOne(
      'No, no. I want to say this. He told me the day before that I was the best thing in his life.',
      'I want to say this. He told me the day before that I was the best thing in his life.',
      'Do you want to take a break?',
    );
    expect(prose(nono.body)).toMatch(/^No, no\. I want to say this\./);
    const so = await tidyOne(
      'So in nineteen seventy-eight I saved up for two years and bought a used truck, blue, with a cracked windshield.',
      'In nineteen seventy-eight I saved up for two years and bought a used truck, blue, with a cracked windshield.',
      'Tell me about the time you bought the truck.',
    );
    expect(prose(so.body)).toMatch(/^So in nineteen seventy-eight I saved up/);
    const andSo = await tidyOne(
      'And so my father sent me to live with my aunt in the city, which I did not want at all.',
      'So my father sent me to live with my aunt in the city, which I did not want at all.',
      'Where did you go after that?',
    );
    expect(prose(andSo.body)).toMatch(/^And so my father sent me/);
  });

  it('is never put in front of a sentence it did not answer', async () => {
    const m = await tidyOne(
      'Yes. My father played the flute at night. He mended nets on holidays, every single one of them.',
      'He mended nets on holidays, every single one of them. My father played the flute at night.',
    );
    // never "Yes. He mended nets…"; and the answer is not lost either: her words, in her order
    expect(prose(m.body)).not.toMatch(/Yes\.? He mended/);
    expect(prose(m.body)).toMatch(/^Yes\. My father played the flute at night\./);
  });

  it('a rewrite that opens on a quotation mark does not fail the import (it used to throw)', async () => {
    const said =
      'Yes. "Come here," she said, and she gave me the bread she had baked that morning.';
    const m = await tidyOne(
      said,
      '"Come here," she said, and she gave me the bread she had baked that morning.',
      'Did your mother bake?',
    );
    // the opener cannot be joined to a quotation mark: the rewrite is judged as written, and the
    // answer it lost ("Yes.") sends it back, so the speaker's words are what the note keeps
    expect(prose(m.body)).toBe(said);
    expect(withOpener('"Come here," she said.', said, said)).toBe('"Come here," she said.');
  });
});

describe('a request is a prompt, not an interjection', () => {
  it('"Thank you. Please state your name." between two answers ends the first', async () => {
    const r = await ingestTranscript(
      `Interviewer: Do you understand and agree to be recorded for the family archive today?
Grandpa Min: Yes, I understand. I agree to all of it.
Interviewer: Thank you. Please state your name.
Grandpa Min: My name is Kim Min-ho, and I was born in Haman.`,
      { interviewees: ['Grandpa Min'] },
      deps(null),
    );
    expect(r.memories.map((m) => m.turns)).toEqual([[1], [3]]);
  });
});

describe('one memory is one topic, not a whole window', () => {
  it('a model that puts a whole window in one note is asked to split it, then the words are shown in ordinary pieces', async () => {
    const huge = model([
      (user) => {
        const ls = [...user.matchAll(/^\[(\d+)\] (.+)$/gm)];
        return answer({
          turns: ls.map((x) => Number(x[1])),
          title: 'Everything she told me',
          body: ls.map((x) => x[2]).join(' '),
        });
      },
    ]);
    const r = await ingestTranscript(wide(8), {}, deps(huge));
    expect(r.stats.windows).toBe(1);
    expect(huge.calls).toHaveLength(2); // the window, and one request to split it
    expect(r.memories.length).toBeGreaterThan(3);
    expect(Math.max(...r.memories.map((m) => prose(m.body).length))).toBeLessThan(3500);
    expect(r.memories[0]!.notes[0]).toMatch(/too much into one note/);
    expect(r.stats.coverage.covered).toBe(r.stats.coverage.total);
    expect(huge.calls[1]).toMatch(/split them into separate memories/);
  });
});

describe('a reply whose body contains three backticks is still read', () => {
  it('is not mistaken for a fenced answer (it used to be "not JSON", and the window was lost)', async () => {
    const said =
      'He used to say that, three little ticks, like a clock in the kitchen, every single night.';
    const m = model([answer({ turns: [1], title: 'The clock', body: '```\n' + said + '\n```' })]);
    const r = await ingestTranscript(
      { interviewee: 'A', segments: [seg(0, 'Q', Q), seg(1, 'A', said)] },
      {},
      deps(m),
    );
    expect(m.calls).toHaveLength(1);
    expect(r.degraded).toEqual({ windows: 0, reasons: [] });
    expect(r.memories[0]).toMatchObject({ method: 'ai-grounded', title: 'The clock' });
  });
});

describe('a link reads as the reader sees it', () => {
  it("[[Title|words]] is judged by its words: the target's name is not reported as invented", async () => {
    const said =
      'My father repaired boats in the harbour every day, and he did not talk much at all.';
    const m = model([
      answer({
        turns: [1],
        title: 'Boats',
        body: 'My father repaired boats in the [[Busan Harbour|harbour]] every day, and he talked a lot.',
      }),
    ]);
    const r = await ingestTranscript(
      { interviewee: 'A', segments: [seg(0, 'Q', Q), seg(1, 'A', said)] },
      {},
      deps(m),
    );
    expect(r.memories[0]!.method).toBe('verbatim');
    expect(r.memories[0]!.notes.join(' ')).not.toMatch(/busan/i);
    expect(m.calls[1]).toMatch(/REJECTED/);
    expect(m.calls[1]).not.toMatch(/not said[^\n]*busan/i);
    expect(m.calls[1]).toMatch(/^- Negation: /m);
  });
});

describe('the result (A6)', () => {
  it('identifies the transcript by the words that arrived, and every memory says its language', async () => {
    const t = {
      interviewee: 'A',
      segments: [seg(0, 'Q', Q), seg(1, 'A', A1), seg(2, 'Q', 'Okay?'), seg(3, 'A', 'Yes.')],
    };
    const r = await ingestTranscript(t, {}, deps(null));
    expect(r.sourceHash).toBe(hashTurns(parseTranscript(t).turns));
  });
});

describe('a short reply the AI folds into a story is not lost (round 2, G2-1)', () => {
  const STORY = 'He made us bow to him every morning before we were allowed to eat our rice.';
  for (const [q, reply, more, story] of [
    ['Did he ever hit you?', 'Yes.', 'Tell me more about him.', STORY],
    ['Did he ever hit you?', 'No.', 'Tell me more about him.', STORY],
    // a reply in a script these rules do not read is kept the same way, as it was said
    ['Did he ever hit you?', 'Да.', 'Tell me more about him.', STORY],
  ] as const) {
    it(`"${reply}" grouped with the next story and dropped from the body goes to Short answers with its own question`, async () => {
      const m = model([answer({ turns: [1, 3], title: 'Bowing every morning', body: story })]);
      const r = await ingestTranscript(
        {
          segments: [
            seg(0, 'Noah', q),
            seg(1, 'Grandma', reply),
            seg(2, 'Noah', more),
            seg(3, 'Grandma', story),
          ],
        },
        { interviewees: ['Grandma'] },
        deps(m),
      );
      const [note, short] = r.memories;
      expect(note).toMatchObject({ method: 'ai-grounded', turns: [3] });
      // the story's footer quotes ITS question, not the one the short reply answered
      expect(note!.body).toContain(more);
      expect(note!.body).not.toContain(q);
      expect(prose(short!.body)).toBe(`- ${q} — ${reply}`);
      expect(r.stats.coverage).toEqual({ covered: 2, total: 2 });
    });
  }

  it('a reply the body DOES keep stays in the memory', async () => {
    const m = model([answer({ turns: [1, 3], title: 'Bowing', body: `Yes. ${STORY}` })]);
    const r = await ingestTranscript(
      {
        segments: [
          seg(0, 'Noah', 'Did he ever hit you?'),
          seg(1, 'Grandma', 'Yes.'),
          seg(2, 'Noah', 'Tell me more.'),
          seg(3, 'Grandma', STORY),
        ],
      },
      { interviewees: ['Grandma'] },
      deps(m),
    );
    expect(r.memories.map((x) => x.turns)).toEqual([[1, 3]]);
  });

  it('a "No." in the story does not stand in for the answer "No." that was dropped', async () => {
    const story = 'There was no money for shoes, so we walked to school barefoot every day.';
    const m = model([answer({ turns: [1, 3], title: 'Barefoot', body: story })]);
    const r = await ingestTranscript(
      {
        segments: [
          seg(0, 'Noah', 'Did you have shoes?'),
          seg(1, 'Grandma', 'No.'),
          seg(2, 'Noah', 'How did you get to school?'),
          seg(3, 'Grandma', story),
        ],
      },
      { interviewees: ['Grandma'] },
      deps(m),
    );
    expect(prose(r.memories.at(-1)!.body)).toBe('- Did you have shoes? — No.');
  });

  it('the same through the split asked for when a note is too big', async () => {
    const story = (k: number) =>
      [0, 1, 2, 3, 4]
        .map(
          (j) =>
            `In part ${k} sentence ${j} my father took me to the harbour number ${k * 10 + j} and we watched the boats come in with the fish.`,
        )
        .join(' ');
    const segs = [];
    for (let k = 0; k < 8; k++) {
      segs.push(
        seg(2 * k, 'Noah', k === 3 ? 'Did he ever hit you?' : `What happened next, part ${k}?`),
      );
      segs.push(seg(2 * k + 1, 'Grandma', k === 3 ? 'No.' : story(k)));
    }
    const m = model([
      (user) => {
        const ls = [...user.matchAll(/^\[(\d+)\] (.+)$/gm)].map((x) => ({
          id: Number(x[1]),
          text: x[2]!,
        }));
        if (m.calls.length === 1)
          return answer({
            turns: ls.map((l) => l.id),
            title: 'All',
            body: ls.map((l) => l.text).join(' '),
          });
        const out = [];
        for (let i = 0; i < ls.length; i += 2) {
          const g = ls.slice(i, i + 2);
          out.push({
            turns: g.map((l) => l.id),
            title: 'Harbour days',
            body: g
              .filter((l) => l.text !== 'No.')
              .map((l) => l.text)
              .join(' '),
          });
        }
        return answer(...out);
      },
    ]);
    const r = await ingestTranscript({ segments: segs }, { interviewees: ['Grandma'] }, deps(m));
    expect(prose(r.memories.at(-1)!.body)).toBe('- Did he ever hit you? — No.');
    expect(r.stats).toMatchObject({ exit: 'converged', coverage: { covered: 8, total: 8 } });
  });

  it('a model unit shown as spoken still keeps each short reply beside its own question', async () => {
    // the model groups the reply with a story and invents a word, every time: shown as spoken
    const m = model([answer({ turns: [1, 3], title: 'x', body: `${STORY} He was a captain.` })]);
    const r = await ingestTranscript(
      {
        segments: [
          seg(0, 'Noah', 'Did he ever hit you?'),
          seg(1, 'Grandma', 'Yes.'),
          seg(2, 'Noah', 'Tell me more about him.'),
          seg(3, 'Grandma', STORY),
        ],
      },
      { interviewees: ['Grandma'] },
      deps(m),
    );
    expect(r.memories.map((x) => [x.method, x.turns])).toEqual([
      ['verbatim', [3]],
      ['verbatim', [1]],
    ]);
    expect(prose(r.memories[1]!.body)).toBe('- Did he ever hit you? — Yes.');
  });
});

describe('a reply is paired with what it answered, never an earlier question (round 2, G2-2)', () => {
  const run = (rows: Array<[string, string]>) =>
    ingestTranscript(
      { segments: rows.map(([who, text], i) => seg(i, who, text)) },
      { interviewees: ['Grandma'] },
      deps(null),
    );
  const shortLines = (r: IngestResult) => prose(r.memories.at(-1)!.body).split('\n');

  it("someone else's question in between: the reply answered THEM", async () => {
    const r = await run([
      ['Noah', 'Where were you born?'],
      ['Grandma', 'I was born in Busan, near the fish market by the harbour.'],
      ['Noah', 'Did your father ever hit you?'],
      ['Mina', 'Grandma, do you want some water?'],
      ['Grandma', 'No.'],
      ['Noah', 'Was your father strict?'],
      ['Mina', 'Did he ever hit you?'],
      ['Grandma', 'No.'],
    ]);
    expect(shortLines(r)).toEqual([
      '- Grandma, do you want some water? — No.',
      '- Did he ever hit you? — No.',
    ]);
  });

  it("a memory's footer quotes only the principal interviewer's question, however short", async () => {
    const r = await run([
      ['Noah', 'Tell me about the day you left the village.'],
      [
        'Grandma',
        'It was early in the morning, still dark, and my mother was standing at the gate.',
      ],
      ['Noah', 'When?'],
      ['Grandma', 'In the spring of nineteen fifty-three, when I was twelve years old.'],
      ['Noah', 'And work?'],
      ['Mina', 'Grandma, tell us about the factory!'],
      ['Grandma', 'I started at a textile factory in Daegu when I was eighteen years old.'],
    ]);
    expect(r.memories.map((m) => /> Question: “([^”]*)”/.exec(m.body)?.[1] ?? null)).toEqual([
      'Tell me about the day you left the village.',
      'When?',
      null, // Mina asked last: the factory answer is not quoted under Noah's "And work?"
    ]);
  });

  it('a question followed by more words in the same turn is quoted up to the question', async () => {
    const r = await run([
      [
        'Noah',
        'What was it like in winter? In winter the snow came up to the windows and we stayed in.',
      ],
      ['Grandma', 'My mother kept the fire going all night and we slept close to the stove.'],
    ]);
    expect(r.memories[0]!.body).toContain('> Question: “What was it like in winter?”\n');
  });

  it('a stray mark left by a removed filler is not quoted', async () => {
    const r = await ingestTranscript(
      'Interviewer: Tell me about the station.\nGrandma: It was early and it was dark.\nInterviewer: Mm-hm. And then?\nGrandma: And then I walked to the station alone, and I did not look back.',
      { interviewees: ['Grandma'] },
      deps(null),
    );
    expect(r.memories.at(-1)!.body).toContain('> Question: “And then?”');
  });
});

describe('a question without a "?" still ends a story (round 2, G2-3)', () => {
  it('an interview whose questions have no "?" gives one memory per answer', async () => {
    const r = await ingestTranscript(
      {
        segments: [
          seg(0, 'Mina', 'Grandma where were you born'),
          seg(
            1,
            'Grandma',
            'I was born on Yeongdo in Busan. Our little house stood right by the sea.',
          ),
          seg(2, 'Mina', 'What was your father like'),
          seg(3, 'Grandma', 'My father repaired boats and he did not talk much at all.'),
          seg(4, 'Mina', 'Did he ever hit you'),
          seg(5, 'Grandma', 'No.'),
          seg(6, 'Mina', 'Did you go to school'),
          seg(7, 'Grandma', 'Because of the war I only went to school until the fifth grade.'),
        ],
      },
      { interviewees: ['Grandma'] },
      deps(null),
    );
    expect(r.memories.map((m) => m.turns)).toEqual([[1], [3], [7], [5]]);
    expect(prose(r.memories.at(-1)!.body)).toBe('- Did he ever hit you — No.');
    expect(r.memories[2]!.body).toContain('> Question: “Did you go to school”');
  });

  it('an English prompt without "?" ends a story; a listener\'s "Wow." does not', async () => {
    const en = await ingestTranscript(
      {
        segments: [
          seg(0, 'Noah', 'Tell me about the house'),
          seg(1, 'Grandma', 'We lived in a shack made of scrap boards near the harbour.'),
          seg(2, 'Noah', 'And your father, the kind of man he was'),
          seg(3, 'Grandma', 'He repaired boats and he did not talk much at all.'),
          seg(4, 'Noah', 'Wow.'),
          seg(5, 'Grandma', 'He also sang in the kitchen every morning before dawn.'),
        ],
      },
      { interviewees: ['Grandma'] },
      deps(null),
    );
    // (the folding may already have joined "Wow." into the answer: what matters is one story)
    expect(en.memories.map((m) => prose(m.body))).toEqual([
      'We lived in a shack made of scrap boards near the harbour.',
      expect.stringMatching(/^He repaired boats[\s\S]*He also sang in the kitchen/),
    ]);
  });
});

describe("an interviewer's closing statement and its one-word reply (round 2, G2-8)", () => {
  it('"Alright." to "I am going to stop the recording now." is a short answer, not the end of a story', async () => {
    const r = await ingestTranscript(
      [
        'Noah: Before we begin, do you consent to this recording being kept in our family archive?',
        'Sunja: Yes, I do. I consent to the recording.',
        'Noah: What did you do for fun?',
        'Sunja: We swam in the river every summer, and in winter my brothers and I slid down the hill on rice sacks.',
        'Noah: Okay, I am going to stop the recording now.',
        'Sunja: Alright.',
      ].join('\n'),
      { interviewees: ['Sunja'] },
      deps(null),
    );
    expect(r.memories.map((m) => prose(m.body))).toEqual([
      'Yes, I do. I consent to the recording.',
      'We swam in the river every summer, and in winter my brothers and I slid down the hill on rice sacks.',
      '- Okay, I am going to stop the recording now. — Alright.',
    ]);
  });
});

describe('a restored opener is never misplaced or doubled (round 2, G2-6)', () => {
  const one = (
    said: string,
    body: string,
    question = 'Did you ever go back to the north after the war?',
  ) =>
    ingestTranscript(
      { segments: [seg(0, 'Noah', question), seg(1, 'Grandma', said)] },
      { interviewees: ['Grandma'] },
      deps(model([answer({ turns: [1], title: 'x', body })])),
    );

  it('a reordered rewrite does not get "No." in front of the wrong sentence, and does not lose it', async () => {
    const said = 'No. I never saw my village again. I went to Seoul in 1960 instead.';
    const r = await one(said, 'I went to Seoul in 1960 instead. I never saw my village again.');
    // neither "No. I went to Seoul…" (misplaced) nor the rewrite without its "No." (lost)
    expect(r.memories).toHaveLength(1);
    expect(prose(r.memories[0]!.body)).toBe(said);
    expect(r.memories[0]!.method).toBe('verbatim');
  });

  it('the repair never doubles a word, and never puts an opener before another sentence', () => {
    const said = 'No. He was a gentle man and he never raised his voice.';
    const moved = 'He was a gentle man and he never raised his voice. No.';
    // "No." moved to the end: left as the model wrote it, for the checker to judge (not "No. … No.")
    expect(withOpener(moved, said, said)).toBe(moved);
    const reordered = 'I went to Seoul in 1960 instead. I never saw my village again.';
    const turn = 'No. I never saw my village again. I went to Seoul in 1960 instead.';
    expect(withOpener(reordered, turn, turn)).toBe(reordered);
    expect(
      withOpener('I never saw my village again. I went to Seoul in 1960 instead.', turn, turn),
    ).toBe(turn);
  });

  it('still restores the opener when the rewrite starts with the very sentence that followed it', async () => {
    const r = await one(
      'No. I never saw my village again, not once in all those years.',
      'I never saw my village again, not once in all those years.',
    );
    expect(r.memories[0]).toMatchObject({ method: 'ai-grounded' });
    expect(prose(r.memories[0]!.body)).toBe(
      'No. I never saw my village again, not once in all those years.',
    );
  });
});

describe('a swallowed reply does not cost the story its AI polish (round 3, G2-B7)', () => {
  const STORY =
    'He made us bow to him every morning, and he beat us with a stick if we were late. My mother never said a word about it.';
  const grouped = (story: string) =>
    model([
      (user) =>
        answer({
          turns: [...user.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1])),
          title: '',
          body: story,
        }),
    ]);
  for (const reply of [
    'Nine.',
    'Busan.',
    'Every day.',
    'Sometimes.',
    'Twice.',
    'My brother.',
    'Never.',
    'About ten.',
    // replies in a script these rules do not read: kept the same way, as they were said
    'Да.',
    'Иногда.',
  ]) {
    it(`"${reply}" goes beside its own question, and the story is polished with no retry`, async () => {
      const [q, more, story] = ['Did he ever hit you?', 'Tell me more about him.', STORY];
      const m = grouped(story);
      const r = await ingestTranscript(
        `Noah: ${q}\nGrandma: ${reply}\nNoah: ${more}\nGrandma: ${story}`,
        { interviewees: ['Grandma'] },
        deps(m),
      );
      expect(r.memories[0]).toMatchObject({ method: 'ai-grounded', turns: [3] });
      expect(r.stats.retried).toBe(0);
      expect(m.calls).toHaveLength(1);
      expect(prose(r.memories.at(-1)!.body)).toBe(`- ${q} — ${reply}`);
    });
  }

  it('a reply that stands alone ("In 1946.") becomes its own note, beside its own question', async () => {
    const r = await ingestTranscript(
      `Noah: When did he start?\nGrandma: In 1946.\nNoah: Tell me more about him.\nGrandma: ${STORY}`,
      { interviewees: ['Grandma'] },
      deps(grouped(STORY)),
    );
    expect(r.memories.map((x) => [x.method, x.turns])).toEqual([
      ['verbatim', [1]],
      ['ai-grounded', [3]],
    ]);
    expect(r.memories[0]!.body).toContain('> Question: “When did he start?”');
    expect(r.stats.retried).toBe(0);
  });
});
