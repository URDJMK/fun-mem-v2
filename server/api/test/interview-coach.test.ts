import { describe, expect, it } from 'vitest';
import {
  coachPrompt,
  midSentence,
  CoachError,
  readCoachRequest,
  readSuggestion,
  suggest,
  type CoachRequest,
} from '../src/interview-coach';
import type { ChatModel } from '../src/nim';

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

  it('holds the model to the move the interviewer chose', async () => {
    const req = readCoachRequest({ ...base, want: 'close' }) as CoachRequest;
    const s = await suggest(answering('{"move":"follow_up","question":"Describe the coop."}'), req);
    expect(s.move).toBe('close');
    expect(coachPrompt(req)).toContain('the move must be "close"');
  });
});
