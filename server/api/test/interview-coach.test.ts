import { describe, expect, it, vi } from 'vitest';
import {
  coachPrompt,
  midSentence,
  CoachError,
  readCoachRequest,
  readSuggestion,
  suggest,
  type CoachRequest,
} from '../src/interview-coach';
import { ModelError, type ChatModel } from '../src/nim';

const base = {
  narrator: 'Nell',
  interviewer: 'Theo',
  topics: ['Childhood', 'Family'],
  minutes: 7,
  transcript: [
    { who: 'Theo', text: 'Tell me about your childhood.' },
    {
      who: 'Nell',
      text: 'In Duluth. My father built the chicken coop the summer before I was born.',
    },
  ],
  threads: [],
  asked: ['Tell me about your childhood.'],
};

const answering = (reply: string): ChatModel => ({
  id: 'fake',
  complete: async () => reply,
});

describe('readCoachRequest', () => {
  it('keeps what the model needs and refuses a request with no narrator', () => {
    const r = readCoachRequest(base) as CoachRequest;
    expect(r.narrator).toBe('Nell');
    expect(r.transcript).toHaveLength(2);
    expect(r.want).toBeNull();
    expect(readCoachRequest({ ...base, narrator: ' ' })).toEqual({ error: 'narrator is required' });
    expect(readCoachRequest('nope')).toEqual({ error: 'expected an object' });
  });

  it('sends only the most recent words when the interview is long', () => {
    const long = Array.from({ length: 120 }, (_, i) => ({
      who: 'Nell',
      text: `${i} ${'word '.repeat(30)}`,
    }));
    const r = readCoachRequest({ ...base, transcript: long }) as CoachRequest;
    const chars = r.transcript.reduce((n, t) => n + t.text.length, 0);
    expect(chars).toBeLessThanOrEqual(6000);
    expect(r.transcript.at(-1)!.text.startsWith('119 ')).toBe(true);
  });

  it('takes a chosen move, but never "wait" as one', () => {
    expect((readCoachRequest({ ...base, want: 'change_topic' }) as CoachRequest).want).toBe(
      'change_topic',
    );
    expect((readCoachRequest({ ...base, want: 'wait' }) as CoachRequest).want).toBeNull();
    expect((readCoachRequest({ ...base, want: 'shout' }) as CoachRequest).want).toBeNull();
  });
});

describe('readSuggestion', () => {
  it('reads a well-formed suggestion, even with words around the JSON', () => {
    const s = readSuggestion(
      'Sure! {"move":"follow_up","kind":"detail","question":"Describe the chicken coop your father built.","reason":"She mentioned it and moved on","threads":["the streetcar"],"topic":null}',
    );
    expect(s).toEqual({
      move: 'follow_up',
      kind: 'detail',
      question: 'Describe the chicken coop your father built.',
      reason: 'She mentioned it and moved on',
      threads: ['the streetcar'],
      topic: null,
    });
  });

  it('keeps only the first of two questions, when it stands on its own', () => {
    expect(
      readSuggestion(
        '{"move":"follow_up","question":"What did the coop look like? Who helped him build it?"}',
      )!.question,
    ).toBe('What did the coop look like?');
    // too short to stand alone: refused
    expect(readSuggestion('{"move":"follow_up","question":"Who built it? And when?"}')).toBeNull();
  });

  it('reads a move however it is spelled', () => {
    expect(readSuggestion('{"move":"Follow up","question":"Describe the coop."}')!.move).toBe(
      'follow_up',
    );
    expect(readSuggestion('{"move":"change-topic","question":"Tell me about work."}')!.move).toBe(
      'change_topic',
    );
  });

  it('refuses an unknown move or no question', () => {
    expect(readSuggestion('{"move":"interrogate","question":"Why?"}')).toBeNull();
    expect(readSuggestion('{"move":"follow_up","question":""}')).toBeNull();
    expect(readSuggestion('no json here')).toBeNull();
  });

  it('keeps a topic only for a change of topic', () => {
    expect(
      readSuggestion('{"move":"follow_up","question":"Describe it.","topic":"Work"}')!.topic,
    ).toBeNull();
    expect(
      readSuggestion(
        '{"move":"change_topic","question":"Tell me about your work.","topic":"Work"}',
      )!.topic,
    ).toBe('Work');
  });
});

describe('suggest', () => {
  it('says when there is no model', async () => {
    await expect(suggest(null, readCoachRequest(base) as CoachRequest)).rejects.toMatchObject({
      code: 'not_configured',
    });
  });

  it('turns an unreadable or failed answer into a CoachError the app can fall back from', async () => {
    const req = readCoachRequest(base) as CoachRequest;
    await expect(
      suggest(answering('I think you should ask about the coop.'), req),
    ).rejects.toBeInstanceOf(CoachError);
    const failing: ChatModel = { id: 'x', complete: async () => Promise.reject(new Error('503')) };
    await expect(suggest(failing, req)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('waits, without asking the model, when the narrator stopped mid-sentence', async () => {
    let called = false;
    const model: ChatModel = {
      id: 'x',
      complete: async () => {
        called = true;
        return '{"move":"follow_up","question":"What did she say?"}';
      },
    };
    const req = readCoachRequest({
      ...base,
      transcript: [
        { who: 'Theo', text: 'Tell me about your mother.' },
        {
          who: 'Nell',
          text: 'And one winter she took me out on the ice and she said to me, she said',
        },
      ],
    }) as CoachRequest;
    expect(midSentence(req)).toBe(true);
    expect((await suggest(model, req)).move).toBe('wait');
    expect(called).toBe(false);
    // a finished sentence, or the interviewer's own words last, goes to the model as usual
    expect(midSentence(readCoachRequest(base) as CoachRequest)).toBe(false);
  });

  it('asks once more when the first answer cannot be used', async () => {
    let calls = 0;
    const model: ChatModel = {
      id: 'x',
      complete: async () =>
        ++calls === 1 ? 'not json' : '{"move":"follow_up","question":"Describe the coop."}',
    };
    expect((await suggest(model, readCoachRequest(base) as CoachRequest)).question).toBe(
      'Describe the coop.',
    );
    expect(calls).toBe(2);
  });

  it('holds the model to the move the interviewer chose, and never passes another off as it', async () => {
    const req = readCoachRequest({ ...base, want: 'close' }) as CoachRequest;
    expect(coachPrompt(req)).toContain('the move must be "close"');
    // a follow-up is not a closing question: relabelled, it would be read out as one
    await expect(
      suggest(answering('{"move":"follow_up","question":"Describe the coop."}'), req),
    ).rejects.toMatchObject({ code: 'unreadable' });
    // asked again, an answer that keeps to the chosen move is the one used
    let calls = 0;
    const second: ChatModel = {
      id: 'x',
      complete: async () =>
        ++calls === 1
          ? '{"move":"wait","question":"Give her a moment."}'
          : '{"move":"close","kind":"reflect","question":"What would you want your family to remember?"}',
    };
    const s = await suggest(second, req);
    expect(s).toMatchObject({ move: 'close', kind: 'reflect' });
    expect(calls).toBe(2);
  });

  it('tries once more when the model failed quickly, as NVIDIA sometimes does', async () => {
    let calls = 0;
    const model: ChatModel = {
      id: 'x',
      complete: async () => {
        if (++calls === 1) throw new ModelError('upstream 500', 'unavailable', true, 500);
        return '{"move":"follow_up","question":"Describe the coop."}';
      },
    };
    expect((await suggest(model, readCoachRequest(base) as CoachRequest)).question).toBe(
      'Describe the coop.',
    );
    expect(calls).toBe(2);
  });

  it('does not try again what will not change, and logs why without a word of the interview', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' '));
    });
    let calls = 0;
    const refused: ChatModel = {
      id: 'x',
      complete: async () => {
        calls++;
        throw new ModelError('Authorization failed', 'auth', false, 403);
      },
    };
    try {
      await expect(suggest(refused, readCoachRequest(base) as CoachRequest)).rejects.toMatchObject({
        code: 'unavailable',
      });
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(1);
    expect(logged.join('\n')).toContain('auth 403');
    expect(logged.join('\n')).not.toContain('coop');
  });

  it('knows the narrator by the name the transcript gives them, however they are called', async () => {
    // the app calls her "Nell"; her voice is labelled with her full name
    const req = readCoachRequest({
      ...base,
      transcript: [
        { who: 'Theo', text: 'Tell me about your mother.' },
        { who: 'Nell Marsh', text: 'And one winter she took me out on the ice and she said' },
      ],
    }) as CoachRequest;
    expect(midSentence(req)).toBe(true);
    // the interviewer's own unfinished words are not the narrator's
    const theirs = readCoachRequest({
      ...base,
      transcript: [{ who: 'Theo', text: 'And then you went to' }],
    }) as CoachRequest;
    expect(midSentence(theirs)).toBe(false);
  });
});
