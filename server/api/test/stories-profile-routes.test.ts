import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { ChatModel } from '../src/nim';
import { PLAN_SYSTEM } from '../src/stories/plan';
import { WRITE_SYSTEM } from '../src/stories/write';
import { testContext } from './helpers';

/**
 * The protagonist's profile through the API (PRD D13, D14, 7.5): entered when the project is made,
 * changed in Settings, kept on their person note, and read by every step that writes a story.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(() => ctx.close());

const call = (
  app: ReturnType<typeof createApp>,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) =>
  app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const provision = async (app: ReturnType<typeof createApp>, token: string, body: object) => {
  const res = await call(app, token, 'POST', '/v1/provision', { jurisdiction: 'US', ...body });
  return { status: res.status, body: (await res.json()) as { archiveId: string; error?: string } };
};

describe('the profile', () => {
  it('is entered with a personal project and kept on the protagonist’s person note', async () => {
    const s = await ctx.realSession(`profile-${RUN}@test.local`);
    const app = createApp(ctx.deps);
    const made = await provision(app, s.token, {
      subjectName: `Sunja Kim ${RUN}`,
      profile: { born: 'about 1946', aliases: 'Grandma Sunja, Sunja' },
    });
    expect(made.status).toBe(201);
    const got = await call(app, s.token, 'GET', `/v1/archives/${made.body.archiveId}/profile`);
    expect(await got.json()).toMatchObject({
      name: `Sunja Kim ${RUN}`,
      born: '~1946',
      died: null,
      aliases: ['Grandma Sunja', 'Sunja'],
    });
    const note = await ctx.pool.query(
      `select n.type::text as type, n.extra->'profile' as profile
         from public.archives a join public.notes n on n.id = a.subject_note_id
        where a.id = $1`,
      [made.body.archiveId],
    );
    expect(note.rows[0]).toMatchObject({ type: 'person', profile: { born: '~1946' } });
  });

  it('refuses a date it cannot read, and makes no project', async () => {
    const s = await ctx.realSession(`profile-bad-${RUN}@test.local`);
    const app = createApp(ctx.deps);
    const made = await provision(app, s.token, {
      subjectName: `Bad date ${RUN}`,
      profile: { born: 'the spring of 46' },
    });
    expect(made.status).toBe(400);
    expect(made.body.error).toMatch(/born/);
    const left = await ctx.pool.query('select 1 from public.archives where subject_name = $1', [
      `Bad date ${RUN}`,
    ]);
    expect(left.rowCount).toBe(0);
  });

  it('is changed in Settings by those who may write, and read by every member', async () => {
    const owner = await ctx.realSession(`profile-owner-${RUN}@test.local`);
    const stranger = await ctx.realSession(`profile-stranger-${RUN}@test.local`);
    const app = createApp(ctx.deps);
    // made without a profile: the person note is there, with nothing entered yet
    const archive = await ctx.provisionArchive(owner, `Nell ${RUN}`);
    const before = await call(app, owner.token, 'GET', `/v1/archives/${archive}/profile`);
    expect(await before.json()).toMatchObject({
      name: `Nell ${RUN}`,
      born: null,
      noteId: expect.any(String),
    });

    const put = await call(app, owner.token, 'PUT', `/v1/archives/${archive}/profile`, {
      born: '1931-05-02',
      died: '2019',
      aliases: ['Grandma Nell'],
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ born: '1931-05-02', died: '2019' });
    // the project points at it
    const linked = await ctx.pool.query(
      `select n.title from public.archives a join public.notes n on n.id = a.subject_note_id
        where a.id = $1`,
      [archive],
    );
    expect(linked.rows).toEqual([{ title: `Nell ${RUN}` }]);
    const bad = await call(app, owner.token, 'PUT', `/v1/archives/${archive}/profile`, {
      died: 'yesterday',
    });
    expect(bad.status).toBe(400);
    expect((await call(app, stranger.token, 'GET', `/v1/archives/${archive}/profile`)).status).toBe(
      404,
    );
  });

  it('a family narrator’s profile is kept on their own person note', async () => {
    const s = await ctx.realSession(`profile-family-${RUN}@test.local`);
    const app = createApp(ctx.deps);
    const made = await provision(app, s.token, {
      subjectName: `The Marsh family ${RUN}`,
      kind: 'family',
    });
    const archive = made.body.archiveId;
    const note = await call(app, s.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: `Walter Marsh ${RUN}`,
      type: 'person',
      body: 'Part of the family.',
    });
    const { id } = (await note.json()) as { id: string };
    const put = await call(app, s.token, 'PUT', `/v1/archives/${archive}/people/${id}/profile`, {
      born: '1938',
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ name: `Walter Marsh ${RUN}`, born: '1938' });
    // the family project itself has no single protagonist
    expect((await call(app, s.token, 'GET', `/v1/archives/${archive}/profile`)).status).toBe(404);
  });

  it('goes with every step that writes a story, and turns an age into a year', async () => {
    const s = await ctx.realSession(`profile-story-${RUN}@test.local`);
    const seen: string[] = [];
    const chat: ChatModel = {
      id: 'scripted-profile',
      complete: async (system, user) => {
        seen.push(user);
        if (system.startsWith(PLAN_SYSTEM)) {
          return JSON.stringify({
            result: {
              stories: [{ title: 'The tin of savings', lines: ['L1-L4'], tellers: ['Sunja'] }],
            },
          });
        }
        if (system.startsWith(WRITE_SYSTEM)) {
          return JSON.stringify({
            result: {
              title: 'The tin of savings',
              occurred: null,
              age: { years: 18, cites: ['L2'] },
              sentences: [
                {
                  text: 'At eighteen Sunja started work at a textile factory.',
                  cites: ['L2'],
                  paragraph: true,
                },
                { text: 'Her mother kept a little of her pay in a tin.', cites: ['L4'] },
              ],
            },
          });
        }
        return JSON.stringify({
          result: { rulings: [0, 1].map((i) => ({ sentence: i, verdict: 'supported' })) },
        });
      },
    };
    const app = createApp({ ...ctx.deps, importMode: 'stories', chat });
    const made = await provision(app, s.token, {
      subjectName: `Sunja ${RUN}`,
      profile: { born: '~1946', aliases: ['Sunja'] },
    });
    const archive = made.body.archiveId;
    const preview = await call(app, s.token, 'POST', `/v1/archives/${archive}/ingest`, {
      teller: 'Sunja',
      interviewees: ['Sunja'],
      transcript: [
        'Interviewer: What happened after you left school?',
        `Sunja: At eighteen I started at a textile factory, ${RUN}.`,
        'Interviewer: And your pay?',
        'Sunja: My mother put a little aside for me in a tin.',
      ].join('\n'),
    });
    const out = (await preview.json()) as {
      jobId: string;
      memories: Array<{ occurred: string | null; dateBasis?: string }>;
    };
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const user of seen)
      expect(user).toContain(
        `Who this is about:\n- Sunja ${RUN} (called "Sunja"). Born about 1946.`,
      );
    expect(out.memories[0]).toMatchObject({
      occurred: '~1964',
      dateBasis: `Sunja ${RUN} was 18; born about 1946`,
    });
    const saved = await call(
      app,
      s.token,
      'POST',
      `/v1/archives/${archive}/ingest/${out.jobId}/save`,
      {},
    );
    expect(saved.status).toBe(200);
    const note = await ctx.pool.query(
      `select occurred, extra->>'dateBasis' as basis from public.notes
        where archive_id = $1 and type = 'event'`,
      [archive],
    );
    expect(note.rows[0]).toEqual({
      occurred: '~1964',
      basis: `Sunja ${RUN} was 18; born about 1946`,
    });
  });
});
