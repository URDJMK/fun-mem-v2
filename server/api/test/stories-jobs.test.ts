import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { ChatModel } from '../src/nim';
import { PLAN_SYSTEM } from '../src/stories/plan';
import { WRITE_SYSTEM } from '../src/stories/write';
import { testContext } from './helpers';

/**
 * Imports in stories mode, end to end through the API and the database: the interview keeps its
 * transcript, the stories are reviewed and saved with their metadata, and undo takes it all back.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(() => ctx.close());

const TRANSCRIPT = [
  'Interviewer: Hello, can you hear me?',
  'Sunja: Yes, I can hear you.',
  'Interviewer: Where were you born?',
  `Sunja: I was born in Busan, near the harbour, in nineteen forty-six. My father repaired boats ${RUN}.`,
  'Interviewer: When did you meet your husband?',
  'Sunja: I met Minho in nineteen sixty-six, at a church supper. He spilled gravy all over his shirt.',
].join('\n');

const sentence = (text: string, cites: string[], paragraph = false) => ({ text, cites, paragraph });
const scripted: ChatModel = {
  id: 'scripted-stories',
  complete: async (system, user) => {
    if (system.startsWith(PLAN_SYSTEM)) {
      return JSON.stringify({
        result: {
          interviewName: 'Sunja on Busan and Minho',
          stories: [
            { title: 'The harbour', period: 'childhood', lines: ['L3-L4'], tellers: ['Sunja'] },
            {
              title: 'Gravy at the church supper',
              period: 'marriage',
              lines: ['L5-L6'],
              tellers: ['Sunja'],
            },
          ],
        },
      });
    }
    if (system.startsWith(WRITE_SYSTEM)) {
      return JSON.stringify({
        result: user.includes('Working title: Gravy')
          ? {
              title: 'Gravy at the church supper',
              occurred: '1966',
              sentences: [
                sentence('Sunja met Minho at a church supper in 1966.', ['L6'], true),
                sentence('He spilled gravy all over his shirt.', ['L6']),
              ],
            }
          : {
              title: 'The harbour',
              occurred: '1946',
              sentences: [
                sentence('Sunja was born in Busan, near the harbour, in 1946.', ['L4'], true),
                sentence('Her father repaired boats.', ['L4']),
              ],
            },
      });
    }
    const n = (user.match(/^\d+\. /gm) ?? []).length;
    return JSON.stringify({
      result: {
        rulings: Array.from({ length: n }, (_, i) => ({ sentence: i, verdict: 'supported' })),
      },
    });
  },
};

const appWith = (chat: ChatModel | null) => createApp({ ...ctx.deps, importMode: 'stories', chat });
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

describe('importing in stories mode', () => {
  it('previews stories, saves them with their metadata, and keeps the interview', async () => {
    const s = await ctx.realSession(`stories-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Stories ${RUN}`);
    const app = appWith(scripted);

    const preview = await call(app, s.token, 'POST', `/v1/archives/${archive}/ingest`, {
      transcript: TRANSCRIPT,
      teller: 'Sunja',
      interviewees: ['Sunja'],
    });
    expect(preview.status).toBe(200);
    const out = (await preview.json()) as {
      jobId: string;
      status: string;
      interviewId: string;
      memories: Array<{ title: string; method: string; sources: unknown[] }>;
    };
    expect(out.status).toBe('previewed');
    expect(out.memories.map((m) => [m.title, m.method])).toEqual([
      ['The harbour', 'story'],
      ['Gravy at the church supper', 'story'],
    ]);
    expect(out.interviewId).toMatch(/^[0-9a-f-]{36}$/);

    // the interview is kept, waiting, under the name the plan gave it
    const listed = await call(app, s.token, 'GET', `/v1/archives/${archive}/interviews`);
    expect(await listed.json()).toMatchObject([
      {
        id: out.interviewId,
        name: 'Sunja on Busan and Minho',
        status: 'pending',
        stories: 0,
        mine: true,
      },
    ]);

    const saved = await call(
      app,
      s.token,
      'POST',
      `/v1/archives/${archive}/ingest/${out.jobId}/save`,
      {},
    );
    expect(saved.status).toBe(200);
    const done = (await saved.json()) as {
      status: string;
      runId: string;
      saved: Array<{ id: string }>;
    };
    expect(done.status).toBe('saved');

    // every story carries its metadata (PRD 7.3)
    const notes = await ctx.pool.query(
      `select n.title, n.occurred, n.recorded, n.contributors, n.extra,
              (select v.reason::text from public.revisions v where v.note_id = n.id order by v.seq limit 1) as reason
         from public.notes n where n.archive_id = $1 order by n.created_at, n.title`,
      [archive],
    );
    const harbour = notes.rows.find((r) => r.title === 'The harbour')!;
    expect(harbour.occurred).toBe('1946');
    expect(harbour.recorded).not.toBeNull();
    expect(harbour.contributors).toEqual(['Sunja']);
    expect(harbour.reason).toBe('import');
    expect(harbour.extra).toMatchObject({
      interviewId: out.interviewId,
      writtenBy: { workflow: 'stories-1', writer: 'scripted-stories' },
    });
    expect(harbour.extra.sources[0]).toMatchObject({
      sentence: 'Sunja was born in Busan, near the harbour, in 1946.',
      from: 4,
      to: 4,
    });
    // greetings are in no note
    expect(notes.rows.some((r) => /hear you/.test(JSON.stringify(r)))).toBe(false);

    // the interview's stories are written, and the run points at it
    const after = await call(app, s.token, 'GET', `/v1/archives/${archive}/interviews`);
    expect(await after.json()).toMatchObject([
      { id: out.interviewId, status: 'written', stories: 2 },
    ]);
    const run = await ctx.pool.query('select interview_id from public.ingest_runs where id = $1', [
      done.runId,
    ]);
    expect(run.rows[0].interview_id).toBe(out.interviewId);

    // the transcript can be read back
    const one = await call(
      app,
      s.token,
      'GET',
      `/v1/archives/${archive}/interviews/${out.interviewId}`,
    );
    const detail = (await one.json()) as {
      transcript: string;
      turns: Array<{ speaker: string; text: string }>;
    };
    expect(detail.transcript).toBe(TRANSCRIPT);
    expect(detail.turns[1]).toMatchObject({ speaker: 'Sunja', text: 'Yes, I can hear you.' });

    // undo takes the stories and the interview's words back
    const undo = await call(
      app,
      s.token,
      'POST',
      `/v1/archives/${archive}/ingest-runs/${done.runId}/undo`,
      {},
    );
    expect(undo.status).toBe(200);
    const gone = await ctx.pool.query('select 1 from public.interviews where id = $1', [
      out.interviewId,
    ]);
    expect(gone.rowCount).toBe(0);
  });

  it('with no AI, the interview waits with its transcript; bringing it in again finds it', async () => {
    const s = await ctx.realSession(`stories-wait-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Stories wait ${RUN}`);
    const app = appWith(null);
    const first = await call(app, s.token, 'POST', `/v1/archives/${archive}/ingest`, {
      transcript: TRANSCRIPT,
      teller: 'Sunja',
      source: 'Sunja, first visit',
    });
    const a = (await first.json()) as {
      status: string;
      pending: { reason: string };
      memories: unknown[];
      interviewId: string;
    };
    expect(a).toMatchObject({ status: 'previewed', pending: { reason: 'no_model' }, memories: [] });
    const again = await call(app, s.token, 'POST', `/v1/archives/${archive}/ingest`, {
      transcript: TRANSCRIPT,
      teller: 'Sunja',
      source: 'Sunja, first visit',
    });
    expect(((await again.json()) as { interviewId: string }).interviewId).toBe(a.interviewId);
    const listed = await call(app, s.token, 'GET', `/v1/archives/${archive}/interviews`);
    expect(await listed.json()).toMatchObject([{ name: 'Sunja, first visit', status: 'pending' }]);
  });

  it('an interview is only for the project’s members', async () => {
    const owner = await ctx.realSession(`stories-own-${RUN}@test.local`);
    const other = await ctx.realSession(`stories-other-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Stories private ${RUN}`);
    const app = appWith(null);
    const made = await call(app, owner.token, 'POST', `/v1/archives/${archive}/ingest`, {
      transcript: TRANSCRIPT,
      teller: 'Sunja',
    });
    const { interviewId } = (await made.json()) as { interviewId: string };
    expect((await call(app, other.token, 'GET', `/v1/archives/${archive}/interviews`)).status).toBe(
      404,
    );
    expect(
      (await call(app, other.token, 'GET', `/v1/archives/${archive}/interviews/${interviewId}`))
        .status,
    ).toBe(404);
  });
});
