import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { FIND_SYSTEM } from '../src/graph/find';
import { applyGraphPatch, relinkMemories, storiesOf } from '../src/graph/save';
import type { GraphProposal, ProposedEntity } from '../src/graph/types';
import type { ChatModel } from '../src/nim';
import { JUDGE_SYSTEM } from '../src/stories/judge';
import { PLAN_SYSTEM } from '../src/stories/plan';
import { WRITE_SYSTEM } from '../src/stories/write';
import { testContext, type RealSession } from './helpers';

/**
 * The graph an import proposes, saved with its stories as the reviewer chose, and undone with
 * them (graph design 5.1–5.3). A scripted model plays every step: it finds the people, places and
 * things first, and the writer marks the names its sentences use (entity design 3).
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
      // "his mother" is only a way to call her: the writer marks it; names are found by code
      names: [{ e: 'e4', words: 'his mother' }],
    },
    { text: 'They went to Busan.', cites: ['L4'] },
  ],
};

const said = (text: string, cite: string) => ({ text, cites: [cite] });
/** what the find step answers: the person the project is about by the id it was shown */
function foundFor(noahId: string) {
  const entity = (
    ref: string,
    name: string,
    type: string,
    ways: string[],
    description = [] as unknown[],
  ) => ({
    ref,
    name,
    type,
    match: 'new',
    ways,
    description,
  });
  return {
    entities: [
      { ...entity('e1', 'Noah Kim', 'person', []), match: noahId },
      entity(
        'e2',
        'Sarah',
        'person',
        ['his friend Sarah'],
        [said('Sarah sat next to Noah on the first day.', 'L2')],
      ),
      entity('e3', 'Tom', 'person', ['her brother Tom'], [said('Tom is Sarah’s brother.', 'L2')]),
      entity(
        'e4',
        'Noah Kim’s mother',
        'person',
        ['his mother'],
        [said('She always made seaweed soup.', 'L4')],
      ),
      entity('e5', 'Korea', 'place', []),
      entity('e6', 'Busan', 'place', [], [said('Noah went to Busan.', 'L4')]),
    ],
    relationships: [
      { a: 'e2', b: 'e1', description: 'Sarah — Noah’s friend from school', cites: ['L2'] },
      { a: 'e3', b: 'e2', description: 'Tom — Sarah’s brother', cites: ['L2'] },
      { a: 'e4', b: 'e1', description: 'Noah Kim’s mother — his mother', cites: ['L4'] },
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
    if (system.startsWith(FIND_SYSTEM)) {
      const noah = /Noah Kim[^\n]*\(person, id ([0-9a-f-]{36})\)/.exec(user)?.[1] ?? 'new';
      return answer(foundFor(noah));
    }
    const n = (user.match(/^\d+\. /gm) ?? []).length;
    return answer({
      rulings: Array.from({ length: n }, (_, i) => ({ sentence: i, verdict: 'supported' })),
    });
  },
};

/** a judge that finds every sentence made up: no story is kept, but who is in it is still found */
const doubter: ChatModel = {
  id: 'scripted-graph-save-doubter',
  complete: async (system, user, opts) => {
    if (!system.startsWith(JUDGE_SYSTEM)) return chat.complete(system, user, opts);
    const n = (user.match(/^\d+\. /gm) ?? []).length;
    const rulings = Array.from({ length: n }, (_, i) => ({
      sentence: i,
      verdict: 'made_up',
      reason: 'not said',
    }));
    return JSON.stringify({ result: { rulings } });
  },
};

interface Preview {
  jobId: string;
  memories: Array<{ id: string; title: string }>;
  interviewId: string;
  graph: GraphProposal;
}

async function setup(label: string, model: ChatModel = chat) {
  const s = await ctx.realSession(`graph-save-${label}-${RUN}@test.local`);
  const app = createApp({ ...ctx.deps, importMode: 'stories', chat: model });
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
  const body = async (title: string) =>
    (
      (
        await ctx.pool.query(`select body from public.notes where archive_id = $1 and title = $2`, [
          archive,
          title,
        ])
      ).rows[0] as { body: string }
    ).body;
  return { s, app, call, archive, preview, entities, relationships, body };
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
    const { call, archive, preview, entities, relationships, body } = await setup('save');
    // someone the project already knows, whom the AI did not connect
    await call('POST', `/v1/archives/${archive}/notes`, { title: 'Tommy Lee', type: 'person' });
    const p = await preview();
    const tommy = (await entities()).find((e) => e.name === 'Tommy Lee')!;
    const busan = p.graph.entities.find((e) => e.name === 'Busan')!;
    expect(busan.note).toMatchObject({ kind: 'existing', title: 'Busan' });
    expect(busan.description).toHaveLength(1);
    const res = await call('POST', `/v1/archives/${archive}/ingest/${p.jobId}/save`, {
      graph: {
        leave: [refOf(p.graph, 'Korea')],
        rename: { [refOf(p.graph, 'Noah Kim’s mother')]: 'Mina Kim' },
        same: { [refOf(p.graph, 'Tom')]: tommy.id },
        leaveParagraph: [busan.ref],
      },
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { runId: string; graph: GraphProposal };
    // the paragraph for Busan's note is left out; Busan, and the link to it, stay
    expect(saved.graph.entities.find((e) => e.name === 'Busan')!.description).toEqual([]);
    // the story's links follow: a name left out is plain words, a renamed one its new name
    expect(await body(SOUP.title)).toContain(
      'Every birthday [[Mina Kim|his mother]] made seaweed soup, the way they did in Korea.',
    );
    expect(await body(SOUP.title)).toContain('They went to [[Busan]].');
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
    // a mention's line is the story's sentence that names her
    expect(got.find((e) => e.name === 'Sarah')!.description).toContain(
      'Noah met his friend Sarah on his first day.',
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

  it('a story left out takes its mentions with it; who it names stays', async () => {
    const { call, archive, preview, entities, relationships } = await setup('skip');
    const p = await preview();
    const res = await call('POST', `/v1/archives/${archive}/ingest/${p.jobId}/save`, {
      memories: [{ index: 1, skip: true }],
    });
    expect(res.status).toBe(200);
    // they come from the transcript, not from the story
    const got = await entities();
    expect(got.map((e) => e.name)).toEqual(
      expect.arrayContaining(['Sarah', 'Noah Kim’s mother', 'Korea']),
    );
    const mentions = await ctx.pool.query(
      `select count(*)::int as n from public.graph_mentions m
         join public.graph_entities e on e.id = m.entity_id
        where e.archive_id = $1 and e.name in ('Noah Kim’s mother', 'Korea')`,
      [archive],
    );
    expect(mentions.rows[0]).toEqual({ n: 0 });
    // the relationship the story left out told has no story now: it waits for its note
    expect((await relationships()).map((r) => r.story)).toEqual([
      'The new boy at school',
      'The new boy at school',
    ]);
  });

  it('an import that kept no stories is refused, never saved as the graph alone', async () => {
    const { call, archive, preview, entities } = await setup('none', doubter);
    const p = await preview();
    expect(p.memories).toEqual([]);
    expect(p.graph.entities.map((e) => e.name)).toContain('Sarah');
    const before = await entities();
    const res = await call('POST', `/v1/archives/${archive}/ingest/${p.jobId}/save`, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'cannot_save', reason: 'nothing_selected' });
    expect(await entities()).toEqual(before);
    const runs = await ctx.pool.query(
      `select count(*)::int as n from public.ingest_runs where archive_id = $1`,
      [archive],
    );
    expect(runs.rows[0]).toEqual({ n: 0 });
  });

  it('a choice it cannot read is refused', async () => {
    const { call, archive, preview } = await setup('shape');
    const p = await preview();
    const res = await call('POST', `/v1/archives/${archive}/ingest/${p.jobId}/save`, {
      graph: { leaveParagraph: 'e6' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'bad_request' });
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

describe('a relationship no story tells', () => {
  const mention = (story: string) => ({ story, words: ['x'], line: 'x.', sources: [] });
  it('stays when both its ends do, and names no story', () => {
    const p: GraphProposal = {
      entities: [
        {
          ref: 'e1',
          name: 'Minho',
          type: 'person',
          match: { kind: 'new' },
          mentions: [mention('m1')],
        },
        {
          ref: 'e2',
          name: 'Busan',
          type: 'place',
          match: { kind: 'new' },
          mentions: [mention('m1')],
        },
      ],
      relationships: [
        {
          ref: 'r1',
          a: 'e1',
          b: 'e2',
          description: 'Minho — lived in Busan',
          story: null,
          sources: [],
        },
      ],
    };
    const kept = applyGraphPatch(p, {}, new Set(['m1']));
    expect(kept.relationships.map((r) => [r.ref, r.story])).toEqual([['r1', null]]);
    expect(storiesOf(kept)).toEqual(['m1']);
  });
});

/** an entity as an import proposes it: with the note it gets */
const NOTED = (ref: string, name: string, story?: string): ProposedEntity => ({
  ref,
  name,
  type: 'person',
  match: { kind: 'new' },
  mentions: story ? [{ story, words: [name], line: `${name}.`, sources: [] }] : [],
  ways: [],
  description: [{ text: `${name} came.`, sources: [] }],
  note: { kind: 'new' },
});

describe('the reviewer’s choices on an import’s people, places and things', () => {
  it('a note stays when its only story is left out; the button’s entities do not', () => {
    const p: GraphProposal = {
      entities: [NOTED('e1', 'Minho', 'm2'), { ...NOTED('e2', 'Tom', 'm2'), note: undefined }],
      relationships: [{ ref: 'r1', a: 'e1', b: 'e2', description: 'x', story: 'm2', sources: [] }],
    };
    const out = applyGraphPatch(p, {}, new Set(['m1']));
    expect(out.entities.map((e) => [e.name, e.mentions.length])).toEqual([['Minho', 0]]);
  });

  it('leaving out a paragraph keeps the entity and its links', () => {
    const e = {
      ...NOTED('e1', 'Mina', 'm1'),
      note: { kind: 'existing' as const, noteId: 'n', title: 'Mina' },
    };
    const out = applyGraphPatch(
      { entities: [e], relationships: [] },
      { leaveParagraph: ['e1'] },
      new Set(['m1']),
    );
    expect(out.entities[0]!.description).toEqual([]);
    expect(out.entities[0]!.mentions).toHaveLength(1);
  });

  it('a new note’s text is not a paragraph: leaving one out keeps it', () => {
    const out = applyGraphPatch(
      { entities: [NOTED('e1', 'Mina', 'm1')], relationships: [] },
      { leaveParagraph: ['e1'] },
      new Set(['m1']),
    );
    expect(out.entities[0]!.description).toEqual([{ text: 'Mina came.', sources: [] }]);
  });

  it('the same as one already here: its note is looked up again at save', () => {
    const tom = '00000000-0000-4000-8000-000000000001';
    const e = {
      ...NOTED('e1', 'Tom', 'm1'),
      note: { kind: 'existing' as const, noteId: 'n', title: 'Tom' },
    };
    const button = { ...NOTED('e2', 'Sarah', 'm1'), note: undefined };
    const out = applyGraphPatch(
      { entities: [e, button], relationships: [] },
      { same: { e1: tom, e2: tom } },
      new Set(['m1']),
    );
    expect(out.entities.map((x) => [x.match, x.note])).toEqual([
      [{ kind: 'existing', entityId: tom, name: '' }, { kind: 'new' }],
      [{ kind: 'existing', entityId: tom, name: '' }, undefined],
    ]);
  });

  it('leaving out a paragraph for one the same as one already here drops it', () => {
    const tom = '00000000-0000-4000-8000-000000000001';
    const out = applyGraphPatch(
      { entities: [NOTED('e1', 'Tom', 'm1'), NOTED('e2', 'Sarah', 'm1')], relationships: [] },
      { same: { e1: tom, e2: 'not an id' }, leaveParagraph: ['e1', 'e2'] },
      new Set(['m1']),
    );
    expect(out.entities.map((e) => [e.name, e.note, e.description])).toEqual([
      ['Tom', { kind: 'new' }, []],
      // not the same as anyone: its text is a new note's, not a paragraph
      ['Sarah', { kind: 'new' }, [{ text: 'Sarah came.', sources: [] }]],
    ]);
  });

  it('a relationship from a story left out is tied to a note instead', () => {
    const p: GraphProposal = {
      entities: [NOTED('e1', 'Minho'), NOTED('e2', 'Busan')],
      relationships: [{ ref: 'r1', a: 'e1', b: 'e2', description: 'x', story: 'm2', sources: [] }],
    };
    expect(applyGraphPatch(p, {}, new Set(['m1'])).relationships[0]!.story).toBeNull();
  });

  it('a relationship the button found in a story left out goes, as before', () => {
    const old = (ref: string, name: string) => ({ ...NOTED(ref, name, 'm1'), note: undefined });
    const p: GraphProposal = {
      entities: [old('e1', 'Minho'), old('e2', 'Busan')],
      relationships: [{ ref: 'r1', a: 'e1', b: 'e2', description: 'x', story: 'm2', sources: [] }],
    };
    expect(applyGraphPatch(p, {}, new Set(['m1'])).relationships).toEqual([]);
  });

  it('relinkMemories unlinks what was left out and follows renames', () => {
    const memories = [{ id: 'm1', body: "[[Noah Kim's mother|His mother]] met [[Tom]]." }];
    const before: GraphProposal = {
      entities: [NOTED('e1', "Noah Kim's mother", 'm1'), NOTED('e2', 'Tom', 'm1')],
      relationships: [],
    };
    const after = applyGraphPatch(
      before,
      { leave: ['e2'], rename: { e1: 'Mina Kim' } },
      new Set(['m1']),
    );
    relinkMemories(memories, before, after);
    expect(memories[0]!.body).toBe('[[Mina Kim|His mother]] met Tom.');
  });

  it('relinkMemories keeps a link one kept entity still answers to', () => {
    const memories = [{ id: 'm1', body: 'She met [[Tom]] and [[Busan|the city]].' }];
    const before: GraphProposal = {
      entities: [NOTED('e1', 'Tom', 'm1'), NOTED('e2', 'Tom', 'm1'), NOTED('e3', 'Busan', 'm1')],
      relationships: [],
    };
    relinkMemories(memories, before, applyGraphPatch(before, { leave: ['e2'] }, new Set(['m1'])));
    expect(memories[0]!.body).toBe('She met [[Tom]] and [[Busan|the city]].');
  });
});
