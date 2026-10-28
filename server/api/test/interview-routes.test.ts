import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { ChatModel } from '../src/nim';
import { testContext } from './helpers';

/** The live interview's two routes, as a person reaches them: the coach and the Deepgram token. */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(() => ctx.close());

const coach: ChatModel = {
  id: 'fake',
  complete: async () => '{"move":"follow_up","question":"What did the coop look like?"}',
};
const app = createApp({ ...ctx.deps, interviewChat: coach, transcriptionKey: 'not-a-real-key' });
const call = (token: string, path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
const ask = {
  narrator: 'Nell',
  interviewer: 'Theo',
  topics: [],
  minutes: 3,
  transcript: [
    { who: 'Theo', text: 'Tell me about the farm.' },
    { who: 'Nell Marsh', text: 'My father built the chicken coop.' },
  ],
  threads: [],
  asked: [],
};

describe('the coach route', () => {
  it('one suggestion at a time: a second too soon is told when to come back', async () => {
    const s = await ctx.realSession(`coach-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Coach ${RUN}`);
    const first = await call(s.token, `/v1/archives/${archive}/interview/suggest`, ask);
    expect(first.status).toBe(200);
    const second = await call(s.token, `/v1/archives/${archive}/interview/suggest`, ask);
    expect(second.status).toBe(429);
    const wait = Number(second.headers.get('retry-after'));
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(3);
    expect(await second.json()).toMatchObject({ code: 'busy', retryAfter: wait });
  });
});

describe('the transcription token route', () => {
  it('gives one person at most ten tokens a minute', async () => {
    const s = await ctx.realSession(`token-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Token ${RUN}`);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await call(s.token, `/v1/archives/${archive}/transcription-token`)).status);
    }
    // the first ten reach Deepgram (which refuses a key that is not real); the eleventh does not
    expect(statuses.slice(0, 10).every((x) => x !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
