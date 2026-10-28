import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { GRAPH_SYSTEM } from '../src/graph/step';
import type { GraphProposal } from '../src/graph/types';
import type { ChatModel } from '../src/nim';
import { PLAN_SYSTEM } from '../src/stories/plan';
import { WRITE_SYSTEM } from '../src/stories/write';
import { testContext } from './helpers';

/**
 * "Find people, places and things" (graph design 4.4): the graph built from stories already
 * saved, an interview's from its transcript and a hand-written one from its own sentences,
 * reviewed and saved as a run of its own, and undone as one.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(() => ctx.close());

let building = false;
const answer = (result: unknown) => JSON.stringify({ result });
const chat: ChatModel = {
  id: 'scripted-graph-build',
  complete: async (system, user) => {
    if (system.startsWith(PLAN_SYSTEM)) {
      return answer({
        stories: [{ title: 'Summers in Busan', lines: ['L1-L2'], tellers: ['Noah'] }],
      });
    }
    if (system.startsWith(WRITE_SYSTEM)) {
      return answer({
        title: 'Summers in Busan',
        occurred: null,
        sentences: [
          { text: 'Two summers Noah went back to Busan.', cites: ['L2'], paragraph: true },
          { text: 'His uncle Jae-won let him hold the wheel.', cites: ['L2'] },
        ],
      });
    }
    if (system.startsWith(GRAPH_SYSTEM)) {
      // the import found nothing; the button, asked again later, does
      if (!building) return answer({ entities: [], relationships: [] });
      if (user.includes('The new boy')) {
        return answer({
          entities: [
            {
              ref: 'e1',
              name: 'Sarah',
              type: 'person',
              match: 'new',
              mentions: [
                {
                  story: 'S1',
                  words: ['Sarah'],
                  line: 'Sarah met Noah on his first day.',
                  cites: ['L1'],
                },
              ],
            },
            {
              ref: 'e2',
              name: 'Tom',
              type: 'person',
              match: 'new',
              mentions: [
                {
                  story: 'S1',
                  words: ['her brother Tom'],
                  line: 'Tom is Sarah’s brother.',
                  cites: ['L2'],
                },
              ],
            },
          ],
          relationships: [
            { a: 'e2', b: 'e1', description: 'Tom — Sarah’s brother', story: 'S1', cites: ['L2'] },
          ],
        });
      }
      return answer({
        entities: [
          {
            ref: 'e1',
            name: 'Busan',
            type: 'place',
            match: 'new',
            mentions: [
              {
                story: 'S1',
                words: ['Busan'],
                line: 'Where Noah spent two summers.',
                cites: ['L2'],
              },
            ],
          },
        ],
        relationships: [],
      });
    }
    const n = (user.match(/^\d+\. /gm) ?? []).length;
    return answer({
      rulings: Array.from({ length: n }, (_, i) => ({ sentence: i, verdict: 'supported' })),
    });
  },
};

describe('finding the graph in stories already saved', () => {
  it('proposes from both kinds of story, saves as its own run, finds nothing twice, and undoes', async () => {
    const s = await ctx.realSession(`graph-build-${RUN}@test.local`);
    const app = createApp({ ...ctx.deps, importMode: 'stories', chat });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const made = await call('POST', '/v1/provision', {
      subjectName: `Noah Kim ${RUN}`,
      jurisdiction: 'US',
    });
    const { archiveId: archive } = (await made.json()) as { archiveId: string };
    // a story written by hand
    const handRes = await call('POST', `/v1/archives/${archive}/notes`, {
      title: 'The new boy',
      type: 'event',
      body: 'Noah met Sarah on his first day. She brought her brother Tom along.',
    });
    const hand = (await handRes.json()) as { id: string };
    // a story from an interview, saved before the graph found anything in it
    const imported = await call('POST', `/v1/archives/${archive}/ingest`, {
      teller: 'Noah',
      interviewees: ['Noah'],
      save: true,
      transcript:
        'Interviewer: And summers?\nNoah: Two summers we went back to Busan, and my uncle Jae-won let me hold the wheel.',
    });
    expect(imported.status).toBe(200);
    const story = ((await imported.json()) as { saved: Array<{ id: string }> }).saved[0]!.id;

    building = true;
    const built = await call('POST', `/v1/archives/${archive}/graph/build`, {});
    expect(built.status).toBe(200);
    const out = (await built.json()) as {
      jobId: string;
      status: string;
      memories: unknown[];
      graph: GraphProposal;
    };
    expect(out.status).toBe('previewed');
    expect(out.memories).toEqual([]);
    expect(out.graph.entities.map((e) => e.name).sort()).toEqual(['Busan', 'Sarah', 'Tom']);
    const sarah = out.graph.entities.find((e) => e.name === 'Sarah')!;
    expect(sarah.mentions).toEqual([
      expect.objectContaining({ story: hand.id, sources: [{ noteId: hand.id, sentence: 0 }] }),
    ]);
    const busan = out.graph.entities.find((e) => e.name === 'Busan')!;
    expect(busan.mentions[0]!.story).toBe(story);
    expect(busan.mentions[0]!.sources[0]).toMatchObject({ from: 2, to: 2 });

    const saved = await call('POST', `/v1/archives/${archive}/ingest/${out.jobId}/save`, {});
    expect(saved.status).toBe(200);
    const { runId } = (await saved.json()) as { runId: string };
    const run = await ctx.pool.query(
      `select kind, note_count from public.ingest_runs where id = $1`,
      [runId],
    );
    expect(run.rows[0]).toEqual({ kind: 'graph', note_count: 0 });
    const names = async () =>
      (
        await ctx.pool.query(
          `select e.name from public.graph_entities e
            where e.archive_id = $1 and exists (select 1 from public.graph_mentions m where m.entity_id = e.id)
            order by e.name`,
          [archive],
        )
      ).rows.map((r: { name: string }) => r.name);
    expect(await names()).toEqual(['Busan', 'Sarah', 'Tom']);

    // asked again: everything it finds is in the graph already
    const again = (await (
      await call('POST', `/v1/archives/${archive}/graph/build`, {})
    ).json()) as {
      graph: GraphProposal;
    };
    expect(again.graph.entities).toEqual([]);

    expect((await call('POST', `/v1/archives/${archive}/ingest-runs/${runId}/undo`)).status).toBe(
      200,
    );
    expect(await names()).toEqual([]);
    // the stories are untouched
    const left = await ctx.pool.query(
      `select count(*)::int as n from public.notes where id = any($1)`,
      [[hand.id, story]],
    );
    expect(left.rows[0].n).toBe(2);
  });

  it('is refused to a viewer', async () => {
    const owner = await ctx.realSession(`graph-build-owner-${RUN}@test.local`);
    const viewer = await ctx.realSession(`graph-build-viewer-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Viewer ${RUN}`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'viewer')`,
      [archive, viewer.userId],
    );
    const res = await ctx.api(viewer.token, 'POST', `/v1/archives/${archive}/graph/build`, {});
    expect(res.status).toBe(403);
  });
});
