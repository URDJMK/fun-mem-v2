import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ingestTranscript, parseProposals, type ChatModel } from '../src/ingest';
import { assignRoles, parseTranscript, toSeconds } from '../src/transcript';
import { acceptTitle, fallbackTitle } from '../src/ingest-lang';
import { checkGrounding } from '../src/grounding-check';
import { testContext } from './helpers';

/** a letter of a script other than the Latin alphabet */
const OTHER_SCRIPT = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u;

/* ── parsing: pure, no database ──────────────────────────────────────── */

describe('transcript parsing', () => {
  it('reads WhisperX segments JSON and merges back-to-back turns by one speaker', () => {
    const t = parseTranscript({
      language: 'en',
      segments: [
        { start: 0, end: 4.2, text: ' Where was your mother born?', speaker: 'SPEAKER_01' },
        { start: 4.2, end: 9, text: ' She was born in Busan.', speaker: 'SPEAKER_00' },
        { start: 9, end: 14, text: ' In a house by the sea.', speaker: 'SPEAKER_00' },
      ],
    });
    expect(t.format).toBe('segments-json');
    expect(t.turns).toHaveLength(2);
    expect(t.turns[1]).toMatchObject({
      speaker: 'SPEAKER_00',
      start: 4.2,
      end: 14,
      text: 'She was born in Busan. In a house by the sea.',
    });
  });

  it('reads the same JSON as a string, and a bare array', () => {
    const seg = [{ start: 1, end: 2, text: 'Hello', speaker: 'A' }];
    expect(parseTranscript(JSON.stringify({ segments: seg })).turns).toHaveLength(1);
    expect(parseTranscript(JSON.stringify(seg)).turns).toHaveLength(1);
  });

  it('uses one anonymous voice when diarization did not run', () => {
    const t = parseTranscript({ segments: [{ start: 0, end: 1, text: 'I am talking to myself' }] });
    expect(t.turns[0]!.speaker).toBe('SPEAKER_00');
  });

  it('reads labelled text with timestamps, and treats unlabelled lines as continuations', () => {
    const t = parseTranscript(
      [
        '[00:05] Interviewer: How old were you then?',
        '[00:09] Sunja Kim: Seventeen.',
        'I got married that winter.',
        'SPEAKER_00 [01:02 - 01:10]: There is more',
      ].join('\n'),
    );
    expect(t.format).toBe('labelled-text');
    expect(t.turns.map((x) => x.speaker)).toEqual(['Interviewer', 'Sunja Kim', 'SPEAKER_00']);
    expect(t.turns[1]).toMatchObject({ start: 9, text: 'Seventeen. I got married that winter.' });
    expect(t.turns[2]).toMatchObject({ start: 62, end: 70 });
  });

  it('does not mistake one colon in prose for a transcript', () => {
    const t = parseTranscript(
      'I remember that day: it was raining.\nAnd then my father came home.',
    );
    expect(t.format).toBe('plain-text');
    expect(t.turns).toHaveLength(2);
  });

  it('rejects empty and oversized input', () => {
    expect(() => parseTranscript('   ')).toThrow();
    expect(() => parseTranscript('a'.repeat(400_001))).toThrow();
    expect(() => parseTranscript({ segments: [] })).toThrow();
  });

  it('parses timestamps in every spelling', () => {
    expect(toSeconds(12.5)).toBe(12.5);
    expect(toSeconds('01:02')).toBe(62);
    expect(toSeconds('1:02:03')).toBe(3723);
    expect(toSeconds('00:01:02,500')).toBe(62.5);
    expect(toSeconds('nope')).toBeNull();
  });

  it('picks the interviewee by who talked most, unless told otherwise', () => {
    const { turns } = parseTranscript(
      'Interviewer: Where were you born?\nGrandma: I was born in Busan and grew up by the sea, it is a very old story now',
    );
    expect(assignRoles(turns).interviewee).toBe('Grandma');
    expect(assignRoles(turns, 'Interviewer').interviewee).toBe('Interviewer');
    expect(assignRoles(turns, 'Nobody').interviewee).toBe('Grandma');
  });
});

/* ── the model's output ──────────────────────────────────────────────── */

describe('model output parsing', () => {
  it('tolerates a code fence and chatter, rejects the rest', () => {
    const ok = parseProposals(
      'Sure!\n```json\n{"memories":[{"turns":[1,2],"title":"t","body":"b"}]}\n```',
    );
    expect(ok).toEqual([{ turns: [1, 2], title: 't', body: 'b' }]);
    expect(parseProposals('no json here')).toBeNull();
    expect(parseProposals('{"memories":"x"}')).toBeNull();
    expect(parseProposals('{"memories":[{"turns":[],"body":"b"}]}')).toEqual([]);
  });
});

/* ── the pipeline, with a fake model ─────────────────────────────────── */

const TRANSCRIPT = [
  'Interviewer: Tell me about your childhood.',
  'Grandma: I was born in Busan. When I was little we lived in a house by the sea.',
  'Interviewer: What was your mother like?',
  'Grandma: My mother was good at boiling noodles. Every summer she boiled noodles for us in the yard.',
].join('\n');

const fakeChat = (
  memories: Array<{ turns: number[]; title: string; body: string }>,
): ChatModel => ({
  id: 'fake',
  complete: async () => JSON.stringify({ memories }),
});

const fake = (reply: string): ChatModel => ({ id: 'fake', complete: async () => reply });

describe('ingest pipeline', () => {
  it("without a model, groups the speaker's own words by the question that prompted them", async () => {
    const r = await ingestTranscript(TRANSCRIPT, {}, { chat: null, titles: [] });
    expect(r.interviewee).toBe('Grandma');
    expect(r.memories).toHaveLength(2);
    expect(r.memories.every((m) => m.method === 'verbatim')).toBe(true);
    expect(r.memories[0]!.body).toContain('I was born in Busan');
    // the interviewer is never testimony: only the labelled question line in the footer
    expect(r.memories.map((m) => m.body.split('\n\n> ')[0]).join(' ')).not.toContain(
      'Tell me about your childhood',
    );
    expect(r.memories[0]!.body).toContain('> Question: “Tell me about your childhood.”');
  });

  it("keeps a model rewrite that is provable from the speaker's words", async () => {
    const chat = fake(
      JSON.stringify({
        memories: [
          {
            turns: [1],
            title: 'A house by the sea in Busan',
            body: 'I was born in Busan. When I was little we lived in a house by the sea.',
          },
          {
            turns: [3],
            title: "My mother's noodles",
            body: 'My mother was good at boiling noodles. Every summer she boiled noodles for us in the yard.',
          },
        ],
      }),
    );
    const r = await ingestTranscript(TRANSCRIPT, {}, { chat, titles: [] });
    expect(r.memories.map((m) => m.method)).toEqual(['ai-grounded', 'ai-grounded']);
    expect(r.memories[0]!.title).toBe('A house by the sea in Busan');
    expect(r.memories[0]!.body).toContain('From the interview transcript');
  });

  it('throws away a rewrite that invents something, and keeps what was said', async () => {
    const chat = fake(
      JSON.stringify({
        memories: [
          {
            turns: [1],
            title: 'Busan',
            body: 'I was born in Busan. My father was a captain and died in a storm.',
          },
          {
            turns: [3],
            title: 'Noodles',
            body: 'My mother was good at boiling noodles. Every summer she boiled noodles for us in the yard.',
          },
        ],
      }),
    );
    const r = await ingestTranscript(TRANSCRIPT, {}, { chat, titles: [] });
    expect(r.memories[0]!.method).toBe('verbatim');
    expect(r.memories[0]!.body).not.toContain('captain');
    expect(r.memories[0]!.body).toContain('a house by the sea');
    expect(r.memories[1]!.method).toBe('ai-grounded');
  });

  it("still returns the speaker's words for turns the model left out, and when the model fails", async () => {
    const partial = fake(
      JSON.stringify({
        memories: [
          {
            turns: [1],
            title: 'Busan',
            body: 'I was born in Busan. When I was little we lived in a house by the sea.',
          },
        ],
      }),
    );
    const r = await ingestTranscript(TRANSCRIPT, {}, { chat: partial, titles: [] });
    expect(r.memories).toHaveLength(2);
    expect(r.memories[1]!.body).toContain('good at boiling noodles');

    const broken: ChatModel = {
      id: 'broken',
      complete: async () => {
        throw new Error('nim http 503');
      },
    };
    const f = await ingestTranscript(TRANSCRIPT, {}, { chat: broken, titles: [] });
    expect(f.stats.failedWindows).toBe(1);
    expect(f.memories).toHaveLength(2);
  });

  it('ignores turn numbers the model made up or took from the interviewer', async () => {
    const chat = fake(
      JSON.stringify({
        memories: [{ turns: [0, 99], title: 'Question', body: 'Tell me about your childhood.' }],
      }),
    );
    const r = await ingestTranscript(TRANSCRIPT, {}, { chat, titles: [] });
    expect(r.memories.map((m) => m.body.split('\n\n> ')[0]).join(' ')).not.toContain(
      'Tell me about your childhood',
    );
    expect(r.memories).toHaveLength(2);
  });

  it('carries timing from the transcript into each memory', async () => {
    const r = await ingestTranscript(
      {
        segments: [
          { start: 0, end: 3, text: 'Where were you born?', speaker: 'Q' },
          {
            start: 3,
            end: 20,
            text: 'I was born in Busan and grew up in a house by the sea, that is how it was.',
            speaker: 'A',
          },
        ],
      },
      { interviewee: 'A' },
      { chat: null, titles: [] },
    );
    expect(r.memories[0]).toMatchObject({ startSec: 3, endSec: 20 });
    expect(r.memories[0]!.body).toContain('0:03–0:20');
  });
});

const EN = [
  { start: 0, end: 4, speaker: 'Q', text: 'What was your father like?' },
  {
    start: 4,
    end: 30,
    speaker: 'A',
    text: 'Um, my father repaired boats. He had big hands and he did not talk much, but every Sunday he took me down to the pier with him.',
  },
  { start: 30, end: 33, speaker: 'Q', text: 'And your mother?' },
  {
    start: 33,
    end: 60,
    speaker: 'A',
    text: 'My mother sold fish at the market. She left at four in the morning and came home after sunset, and she always bought me a piece of taffy.',
  },
];

describe('language: the notes are English, and a title is never a translation', () => {
  it('writes an English interview with an English footer and English notes', async () => {
    const r = await ingestTranscript({ segments: EN }, {}, { chat: null, titles: [] });
    expect(r.memories).toHaveLength(2);
    for (const m of r.memories) {
      expect(m.body).toContain('From the interview transcript');
      expect(m.body).not.toMatch(OTHER_SCRIPT);
      expect(m.notes.join(' ')).not.toMatch(OTHER_SCRIPT);
    }
  });

  it('keeps an English model title, but never one in another script', async () => {
    const good = fakeChat([
      {
        turns: [1],
        title: "My father's boat yard",
        body: 'My father repaired boats. He had big hands and he did not talk much, but every Sunday he took me down to the pier with him.',
      },
      {
        turns: [3],
        title: 'Мамин рынок',
        body: 'My mother sold fish at the market. She left at four in the morning and came home after sunset, and she always bought me a piece of taffy.',
      },
    ]);
    const r = await ingestTranscript({ segments: EN }, {}, { chat: good, titles: [] });
    expect(r.memories[0]!.method).toBe('ai-grounded');
    // a title may be NEW words (the body may not)
    expect(r.memories[0]!.title).toBe("My father's boat yard");
    // a title in another script is not used; the fallback is the speaker's own words
    expect(r.memories[1]!.title).toBe('My mother sold fish at the market');
  });

  it('still rejects an invented fact in English, and shows what was said', async () => {
    const bad = fakeChat([
      {
        turns: [1],
        title: 'Boats',
        body: 'My father repaired boats. He later became a captain and died in a storm.',
      },
    ]);
    const r = await ingestTranscript({ segments: EN }, {}, { chat: bad, titles: [] });
    expect(r.memories[0]!.method).toBe('verbatim');
    expect(r.memories[0]!.body).not.toContain('captain');
    expect(r.memories[0]!.notes[0]).toMatch(/not said/);
  });

  it('does not treat a capitalised sentence start as an invented word', () => {
    const src = 'He took me to the pier every Sunday.';
    expect(checkGrounding(src, 'Every Sunday he took me to the pier.').ungrounded).toEqual([]);
  });

  it('takes the interviewee the sender named, over the talkative-speaker guess', async () => {
    const r = await ingestTranscript(
      { interviewee: 'Q', segments: EN },
      {},
      { chat: null, titles: [] },
    );
    expect(r.interviewee).toBe('Q');
  });
});

describe('the verify-and-retry loop', () => {
  const good =
    'My father repaired boats. He had big hands and he did not talk much, but every Sunday he took me down to the pier with him.';
  const bad = `${good} He later became a captain and died in a storm.`;

  it("retries a rejected rewrite with the checker's verdict, and keeps the fixed one", async () => {
    const prompts: string[] = [];
    let call = 0;
    const chat: ChatModel = {
      id: 'loop',
      complete: async (_s, user) => {
        prompts.push(user);
        call++;
        const body = call === 1 ? bad : good;
        return JSON.stringify({ memories: [{ turns: [1], title: 'Boats', body }] });
      },
    };
    const r = await ingestTranscript({ segments: EN }, {}, { chat, titles: [] });
    expect(r.stats).toMatchObject({ exit: 'converged', retried: 1 });
    expect(r.memories[0]!.method).toBe('ai-grounded');
    expect(r.memories[0]!.body).not.toContain('captain');
    // the second prompt names the exact unsupported words
    expect(prompts[1]).toMatch(/REJECTED/);
    expect(prompts[1]).toMatch(/captain/);
  });

  it("stops at the round budget and shows the speaker's own words, never the model's", async () => {
    let calls = 0;
    const chat: ChatModel = {
      id: 'stubborn',
      complete: async () => {
        calls++;
        return JSON.stringify({ memories: [{ turns: [1], title: 'Boats', body: bad }] });
      },
    };
    const r = await ingestTranscript({ segments: EN }, {}, { chat, titles: [] });
    expect(r.stats.exit).toBe('round_budget');
    expect(calls).toBeLessThanOrEqual(1 + 2 + 3); // bounded: one window + at most MAX_ROUNDS-1 retries per unit
    expect(r.memories[0]!.method).toBe('verbatim');
    expect(r.memories.map((m) => m.body).join(' ')).not.toContain('captain');
    // the reviewer is told why, naming the word
    expect(r.memories[0]!.notes.join(' ')).toContain('captain');
  });

  it('reports coverage, and adds speech the model skipped as spoken', async () => {
    const chat: ChatModel = { id: 'skip', complete: async () => JSON.stringify({ memories: [] }) };
    const r = await ingestTranscript({ segments: EN }, {}, { chat, titles: [] });
    expect(r.stats.coverage).toEqual({ covered: 2, total: 2 });
    expect(r.stats.exit).toBe('converged');
    expect(r.memories).toHaveLength(2);
  });
});

describe('what the reader of a note gets', () => {
  const SPOKEN = [
    { start: 0, end: 5, speaker: 'Q', text: 'How did you meet your husband?' },
    {
      start: 5,
      end: 50,
      speaker: 'A',
      text: 'Um, so at a church supper in nineteen sixty-six, he, uh, spilled gravy on my sleeve, and I, I said it was only a sleeve. We got married in June of nineteen sixty-seven, you know, in the spring.',
    },
  ];

  it('removes fillers and stammers in code, before the model ever sees the text', async () => {
    const seen: string[] = [];
    const chat: ChatModel = {
      id: 'spy',
      complete: async (_s, user) => (seen.push(user), JSON.stringify({ memories: [] })),
    };
    const r = await ingestTranscript(
      { interviewee: 'A', segments: SPOKEN },
      {},
      { chat, titles: [] },
    );
    expect(seen.join(' ')).not.toMatch(/\bum\b|\buh\b|I, I|you know/i);
    const body = r.memories[0]!.body.split('\n\n> ')[0]!;
    expect(body).not.toMatch(/\bum\b|\buh\b|I, I|you know/i);
    expect(body).toContain('spilled gravy on my sleeve');
  });

  it('reads spoken years into the date', async () => {
    const r = await ingestTranscript(
      { interviewee: 'A', segments: SPOKEN },
      {},
      { chat: null, titles: [] },
    );
    expect(r.memories[0]!.occurred).toBe('1966');
  });

  it("quotes the interviewer's question above the source line, outside the body", async () => {
    const r = await ingestTranscript(
      { interviewee: 'A', segments: SPOKEN },
      {},
      { chat: null, titles: [] },
    );
    const [body, footer] = r.memories[0]!.body.split('\n\n> ') as [string, string];
    expect(body).not.toContain('How did you meet');
    expect(footer).toContain('Question: “How did you meet your husband?”');
    expect(footer).toContain('From the interview transcript (0:05–0:50)');
  });
});

describe('short questions', () => {
  it('keeps a short question: "Your mother?" and "And then?" (round 2: any length)', async () => {
    const mother = await ingestTranscript(
      {
        interviewee: 'A',
        segments: [
          { start: 0, end: 2, speaker: 'Q', text: 'Your mother?' },
          {
            start: 2,
            end: 30,
            speaker: 'A',
            text: 'My mother sold fish at the market. She left at four in the morning and came home after sunset.',
          },
        ],
      },
      {},
      { chat: null, titles: [] },
    );
    expect(mother.memories[0]!.body).toContain('> Question: “Your mother?”');
    const en = await ingestTranscript(
      {
        interviewee: 'A',
        segments: [
          { start: 0, end: 2, speaker: 'Q', text: 'And then?' },
          {
            start: 2,
            end: 30,
            speaker: 'A',
            text: 'My mother sold fish at the market and came home after sunset every day.',
          },
        ],
      },
      {},
      { chat: null, titles: [] },
    );
    expect(en.memories[0]!.body).toContain('> Question: “And then?”');
  });
});

describe('titles', () => {
  it('accepts a phrase in the Latin alphabet, rejects another script, links and long ones', () => {
    expect(acceptTitle("My father's boat yard.")).toBe("My father's boat yard");
    expect(acceptTitle('Лодки моего отца')).toBeNull();
    expect(acceptTitle('See [[Mom]]')).toBe('See Mom');
    expect(acceptTitle('x'.repeat(61))).toBeNull();
    expect(acceptTitle('')).toBeNull();
  });

  it('falls back to the opening words without fillers, cut at a word boundary', () => {
    expect(
      fallbackTitle('Um, I was born in 1941 in a small fishing town on the south coast of Korea.'),
    ).toBe('I was born in 1941 in a small fishing town');
    expect(fallbackTitle('so, well, my father repaired boats. He had big hands.')).toBe(
      'My father repaired boats',
    );
  });

  it('a long English sentence is cut where a clause ends, never on a word that needs a follower', () => {
    const t = (s: string) => fallbackTitle(s);
    expect(
      t('We lived in a shack made of scrap boards and the wind came through the walls in winter.'),
    ).toBe('We lived in a shack made of scrap boards');
    expect(
      t('I only finished fifth grade but my teacher said I had the most beautiful handwriting.'),
    ).toBe('I only finished fifth grade');
    expect(
      t(
        'We moved to Scranton in 1958 because my uncle had found work at the mill and the pay was better.',
      ),
    ).toBe('We moved to Scranton in 1958');
    // no clause break in reach: the word-boundary cut still never ends on "is how"
    expect(
      t('Honestly the thing I remember most about that summer is how hot it was in the kitchen.'),
    ).not.toMatch(/\b(?:is|how|the|and|about)$/i);
    // a sentence that already fits is left whole
    expect(t('The wedding was in the spring and everybody came.')).toBe(
      'The wedding was in the spring and everybody came',
    );
  });
});

/* ── the route: membership, and that it writes nothing ───────────────── */

const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(async () => {
  await ctx.close();
});

describe('POST /ingest', () => {
  it('proposes memories for a member, 404s a stranger, and writes no note', async () => {
    const owner = await ctx.realSession(`ing-${RUN}@test.local`);
    const stranger = await ctx.realSession(`ings-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Ingest ${RUN}`);

    const res = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest`, {
      transcript: TRANSCRIPT,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memories: unknown[]; interviewee: string };
    expect(body.memories).toHaveLength(2);
    expect(body.interviewee).toBe('Grandma');

    const notes = (await (
      await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/notes`)
    ).json()) as unknown[];
    expect(notes).toHaveLength(0);

    const foreign = await ctx.api(stranger.token, 'POST', `/v1/archives/${archive}/ingest`, {
      transcript: TRANSCRIPT,
    });
    expect(foreign.status).toBe(404);

    const bad = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/ingest`, {
      transcript: '',
    });
    expect(bad.status).toBe(400);
  });
});
