import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { GRAPH_SYSTEM } from '../src/graph/step';
import type { GraphProposal } from '../src/graph/types';
import type { ChatModel } from '../src/nim';
import { PLAN_SYSTEM } from '../src/stories/plan';
import { WRITE_SYSTEM } from '../src/stories/write';
import { testContext, type RealSession } from './helpers';

/**
 * The graph an import proposes, saved with its stories as the reviewer chose, and undone with
 * them (graph design 5.1–5.3). A scripted model plays every step.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(() => ctx.close());

const TRANSCRIPT = [
  'Interviewer: Who did you meet at school?',
  'Noah: My friend Sarah sat next to me on the first day. She brought her brother Tom to meet me.',
  'Interviewer: And your birthdays?',
  'Noah: My mother always made seaweed soup, the way they did in Korea, and we went to Busan.',
].join('\n');

const SCHOOL = {
  title: 'The new boy at school',
  occurred: null,
  sentences: [
    { text: 'Noah met his friend Sarah on his first day.', cites: ['L2'], paragraph: true },
    { text: 'Sarah brought her brother Tom to meet him.', cites: ['L2'] },
  ],
};
const SOUP = {
  title: 'Seaweed soup on his birthday',
  occurred: null,
  sentences: [
    {
      text: 'Every birthday his mother made seaweed soup, the way they did in Korea.',
      cites: ['L4'],
      paragraph: true,
    },
    { text: 'They went to Busan.', cites: ['L4'] },
  ],
};

const m = (story: string, words: string[], line: string, cites: string[]) => ({
  story,
  words,
  line,
  cites,
});
function graphFor(noahId: string) {
  return {
    entities: [
      {
        ref: 'e1',
        name: 'Noah Kim',
        type: 'person',
        match: noahId,
        mentions: [
          m('S1', ['Noah'], 'Noah was new at school.', ['L2']),
          m('S2', ['his mother'], 'His mother made him seaweed soup.', ['L4']),
        ],
      },
      {
        ref: 'e2',
        name: 'Sarah',
        type: 'person',
        match: 'new',
        mentions: [m('S1', ['Sarah'], 'Sarah sat next to Noah on the first day.', ['L2'])],
      },
      {
        ref: 'e3',
        name: 'Tom',
        type: 'person',
        match: 'new',
        mentions: [m('S1', ['her brother Tom'], 'Tom is Sarah’s brother.', ['L2'])],
      },
      {
        ref: 'e4',
        name: 'Noah Kim’s mother',
        type: 'person',
        match: 'new',
        mentions: [m('S2', ['his mother'], 'She made seaweed soup every birthday.', ['L4'])],
      },
      {
        ref: 'e5',
        name: 'Korea',
        type: 'place',
        match: 'new',
        mentions: [m('S2', ['Korea'], 'Where the soup is made that way.', ['L4'])],
      },
      {
        ref: 'e6',
        name: 'Busan',
        type: 'place',
        match: 'new',
        mentions: [m('S2', ['Busan'], 'Where they went.', ['L4'])],
      },
    ],
    relationships: [
      {
        a: 'e2',
        b: 'e1',
        description: 'Sarah — Noah’s friend from school',
        story: 'S1',
        cites: ['L2'],
      },
      { a: 'e3', b: 'e2', description: 'Tom — Sarah’s brother', story: 'S1', cites: ['L2'] },
      {
        a: 'e4',
        b: 'e1',
        description: 'Noah Kim’s mother — his mother',
        story: 'S2',
        cites: ['L4'],
      },
    ],
  };
}

const chat: ChatModel = {
  id: 'scripted-graph-save',
  complete: async (system, user) => {
    const answer = (result: unknown) => JSON.stringify({ result });
    if (system.startsWith(PLAN_SYSTEM)) {
      return answer({
        stories: [
          { title: SCHOOL.title, lines: ['L1-L2'], tellers: ['Noah'] },
          { title: SOUP.title, lines: ['L3-L4'], tellers: ['Noah'] },
        ],
      });
    }
    if (system.startsWith(WRITE_SYSTEM)) return answer(user.includes(SCHOOL.title) ? SCHOOL : SOUP);
    if (system.startsWith(GRAPH_SYSTEM)) {
      const noah = /Noah Kim[^\n]*\(person, id ([0-9a-f-]{36})\)/.exec(user)?.[1] ?? 'new';
      return answer(graphFor(noah));
    }
    const n = (user.match(/^\d+\. /gm) ?? []).length;
    return answer({
      rulings: Array.from({ length: n }, (_, i) => ({ sentence: i, verdict: 'supported' })),
    });
  },
};

interface Preview {
  jobId: string;
  memories: Array<{ id: string; title: string }>;
  interviewId: string;
  graph: GraphProposal;
}

async function setup(label: string) {
  const s = await ctx.realSession(`graph-save-${label}-${RUN}@test.local`);
  const app = createApp({ ...ctx.deps, importMode: 'stories', chat });
  const call = (method: string, path: string, body?: unknown, who: RealSession = s) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${who.token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const made = await call('POST', '/v1/provision', {
    subjectName: `Noah Kim ${label} ${RUN}`,
    jurisdiction: 'US',
    profile: { aliases: ['Noah Kim', 'Noah'] },
  });
  const { archiveId: archive } = (await made.json()) as { archiveId: string };
  // a place the project already has
  await call('POST', `/v1/archives/${archive}/notes`, { title: 'Busan', type: 'place' });
  const preview = async () => {
    const res = await call('POST', `/v1/archives/${archive}/ingest`, {
      teller: 'Noah',
      interviewees: ['Noah'],
      transcript: TRANSCRIPT,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Preview;
  };
  const entities = async () =>
    (
      await ctx.pool.query(
        `select e.id, e.name, e.type::text as type, e.run_id, e.description,
                coalesce((select array_agg(g.alias order by g.alias) from public.graph_aliases g
                           where g.entity_id = e.id), '{}') as aliases
           from public.graph_entities e where e.archive_id = $1 order by e.name`,
        [archive],
      )
    ).rows as Array<{
      id: string;
      name: string;
      type: string;
      run_id: string | null;
      description: string;
      aliases: string[];
    }>;
  const relationships = async () =>
    (
      await ctx.pool.query(
        `select a.name as a, b.name as b, r.description, n.title as story
           from public.graph_relationships r
           join public.graph_entities a on a.id = r.a_id
           join public.graph_entities b on b.id = r.b_id
           join public.notes n on n.id = r.note_id
          where r.archive_id = $1 order by r.description`,
        [archive],
      )
    ).rows as Array<{ a: string; b: string; description: string; story: string }>;
  return { s, app, call, archive, preview, entities, relationships };
}

const refOf = (g: GraphProposal, name: string) => g.entities.find((e) => e.name === name)!.ref;

describe('an import’s graph', () => {
  it('is proposed with its stories, matched to what the project has', async () => {
    const { preview } = await setup('preview');
    const p = await preview();
    expect(p.memories.map((x) => x.id)).toEqual(['m1', 'm2']);
    const match = (name: string) => p.graph.entities.find((e) => e.name === name)!.match.kind;
    expect(match('Noah Kim')).toBe('existing');
    expect(match('Busan')).toBe('existing');
    expect(match('Sarah')).toBe('new');
    expect(p.graph.relationships).toHaveLength(3);
  });

  it('is saved as the reviewer chose: left out, renamed, the same as one already here', async () => {
    const { call, archive, preview, entities, relationships } = await setup('save');
    // someone the project already knows, whom the AI did not connect
    await call('POST', `/v1/archives/${archive}/notes`, { title: 'Tommy Lee', type: 'person' });
    const p = await preview();
    const tommy = (await entities()).find((e) => e.name === 'Tommy Lee')!;
    const res = await call('POST', `/v1/archives/${archive}/ingest/${p.jobId}/save`, {
      graph: {
        leave: [refOf(p.graph, 'Korea')],
        rename: { [refOf(p.graph, 'Noah Kim’s mother')]: 'Mina Kim' },
        same: { [refOf(p.graph, 'Tom')]: tommy.id },
      },
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { runId: string };
    const got = await entities();
    expect(got.map((e) => e.name)).toEqual(
      expect.arrayContaining(['Busan', 'Mina Kim', `Noah Kim save ${RUN}`, 'Sarah', 'Tommy Lee']),
    );
    expect(got.map((e) => e.name)).not.toContain('Korea');
    expect(got.map((e) => e.name)).not.toContain('Tom');
    expect(got.find((e) => e.name === 'Mina Kim')).toMatchObject({
      run_id: saved.runId,
      aliases: ['Noah Kim’s mother'],
    });
    expect(got.find((e) => e.name === 'Tommy Lee')!.aliases).toEqual(['Tom']);
    expect(got.find((e) => e.name === 'Sarah')!.description).toContain(
      'Sarah sat next to Noah on the first day.',
    );
    expect(await relationships()).toEqual([
      {
        a: 'Mina Kim',
        b: `Noah Kim save ${RUN}`,
        description: 'Noah Kim’s mother — his mother',
        story: 'Seaweed soup on his birthday',
      },
      {
        a: 'Sarah',
        b: `Noah Kim save ${RUN}`,
        description: 'Sarah — Noah’s friend from school',
        story: 'The new boy at school',
      },
      {
        a: 'Tommy Lee',
        b: 'Sarah',
        description: 'Tom — Sarah’s brother',
        story: 'The new boy at school',
      },
    ]);
    const mention = await ctx.pool.query(
      `select m.words, m.sources from public.graph_mentions m
         join public.graph_entities e on e.id = m.entity_id
        where e.archive_id = $1 and e.name = 'Sarah'`,
      [archive],
    );
    expect(mention.rows).toEqual([
      { words: ['Sarah'], sources: [{ interviewId: p.interviewId, from: 2, to: 2 }] },
    ]);
  });

  it('a story left out takes with it what came only from it', async () => {
    const { call, archive, preview, entities, relationships } = await setup('skip');
    const p = await preview();
    const res = await call('POST', `/v1/archives/${archive}/ingest/${p.jobId}/save`, {
      memories: [{ index: 1, skip: true }],
    });
    expect(res.status).toBe(200);
    const names = (await entities()).map((e) => e.name);
    expect(names).toContain('Sarah');
    expect(names).not.toContain('Noah Kim’s mother');
    expect(names).not.toContain('Korea');
    expect((await relationships()).map((r) => r.story)).toEqual([
      'The new boy at school',
      'The new boy at school',
    ]);
  });

  it('a new name made since the preview is joined, not made twice', async () => {
    const { call, archive, preview, entities } = await setup('since');
    const p = await preview();
    await call('POST', `/v1/archives/${archive}/notes`, { title: 'Sarah', type: 'person' });
    expect((await call('POST', `/v1/archives/${archive}/ingest/${p.jobId}/save`, {})).status).toBe(
      200,
    );
    expect((await entities()).filter((e) => e.name === 'Sarah')).toHaveLength(1);
  });

  it('undo takes it back, but keeps an entity someone has worked on since', async () => {
    const { call, archive, preview, entities, relationships } = await setup('undo');
    const p = await preview();
    const saved = (await (
      await call('POST', `/v1/archives/${archive}/ingest/${p.jobId}/save`, {})
    ).json()) as { runId: string };
    const before = await entities();
    const mother = before.find((e) => e.name === 'Noah Kim’s mother')!;
    // renamed by hand since the import
    await ctx.pool.query(
      `insert into public.graph_changes (archive_id, entity_id, kind, before, after, created_by)
       values ($1, $2, 'rename', '{}', '{}', $3)`,
      [archive, mother.id, before[0]!.id],
    );
    const res = await call('POST', `/v1/archives/${archive}/ingest-runs/${saved.runId}/undo`);
    expect(res.status).toBe(200);
    const names = (await entities()).map((e) => e.name);
    expect(names).not.toContain('Sarah');
    expect(names).not.toContain('Tom');
    expect(names).not.toContain('Korea');
    expect(names).toContain('Noah Kim’s mother');
    expect(names).toContain('Busan');
    expect(names).toContain(`Noah Kim undo ${RUN}`);
    expect(await relationships()).toEqual([]);
  });
});
