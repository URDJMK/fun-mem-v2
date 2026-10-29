import { randomUUID } from 'node:crypto';
import { extractWikilinks, matchKey } from '@funmem/core';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { FIND_SYSTEM } from '../src/graph/find';
import {
  applyGraphPatch,
  entityNoteInputs,
  linkStories,
  paragraphText,
  relinkMemories,
  storiesOf,
  type NoteChoice,
} from '../src/graph/save';
import type { GraphProposal, ProposedEntity } from '../src/graph/types';
import type { IngestResult } from '../src/ingest-pipeline';
import { persistImport } from '../src/ingest-save';
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
    // the same as Tommy Lee: the link is to his note, and what she said of Tom is a paragraph there
    expect(await body(SCHOOL.title)).toContain('[[Tommy Lee|Tom]]');
    expect(await body('Tommy Lee')).toMatch(/^_From “[^”]+”:_ Tom is Sarah’s brother\.$/);
    expect(await body('Busan')).toBe('');
    // her note is new, made with the stories
    expect(await body('Mina Kim')).toBe('She always made seaweed soup.');
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
    // the relationship the story left out told has no story now: it is tied to her note
    expect((await relationships()).map((r) => [r.description, r.story])).toEqual([
      ['Noah Kim’s mother — his mother', 'Noah Kim’s mother'],
      ['Sarah — Noah’s friend from school', 'The new boy at school'],
      ['Tom — Sarah’s brother', 'The new boy at school'],
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
    // Tom went with his story, and the relationship with him
    expect(out.relationships).toEqual([]);
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

  it('a new name never breaks a link', () => {
    const memories = [{ id: 'm1', body: '[[Tom]] met [[Ann]].' }];
    const before: GraphProposal = {
      entities: [NOTED('e1', 'Tom', 'm1'), NOTED('e2', 'Ann', 'm1')],
      relationships: [],
    };
    const after = applyGraphPatch(
      before,
      { rename: { e1: 'Tom | Lee', e2: 'Ann]] x [[y' } },
      new Set(['m1']),
    );
    expect(after.entities.map((e) => e.name)).toEqual(['Tom Lee', 'Ann x y']);
    relinkMemories(memories, before, after);
    expect(memories[0]!.body).toBe('[[Tom Lee|Tom]] met [[Ann x y|Ann]].');
    expect(extractWikilinks(memories[0]!.body).map((l) => [l.target, l.alias])).toEqual([
      ['Tom Lee', 'Tom'],
      ['Ann x y', 'Ann'],
    ]);
  });

  it('a new name another kept entity of another type has is not taken', () => {
    const memories = [{ id: 'm1', body: '[[Tom]] went to [[Busan]].' }];
    const busan: ProposedEntity = { ...NOTED('e2', 'Busan', 'm1'), type: 'place' };
    const before: GraphProposal = {
      entities: [NOTED('e1', 'Tom', 'm1'), busan],
      relationships: [],
    };
    const after = applyGraphPatch(before, { rename: { e1: 'busan' } }, new Set(['m1']));
    expect(after.entities.map((e) => [e.name, e.aliases])).toEqual([
      ['Tom', undefined],
      ['Busan', undefined],
    ]);
    relinkMemories(memories, before, after);
    expect(memories[0]!.body).toBe('[[Tom]] went to [[Busan]].');
  });

  it('a new name another kept entity of the same type has is taken: they are one', () => {
    const before: GraphProposal = {
      entities: [NOTED('e1', 'Tom', 'm1'), NOTED('e2', 'Tommy Lee', 'm1')],
      relationships: [],
    };
    const after = applyGraphPatch(before, { rename: { e1: 'Tommy Lee' } }, new Set(['m1']));
    expect(after.entities.map((e) => e.name)).toEqual(['Tommy Lee', 'Tommy Lee']);
  });

  it('relinkMemories leaves a link a kept entity still answers to when another is renamed', () => {
    const memories = [{ id: 'm1', body: 'She met [[Tom]].' }];
    const before: GraphProposal = {
      entities: [NOTED('e1', 'Tom', 'm1'), NOTED('e2', 'Tom', 'm1')],
      relationships: [],
    };
    const after = applyGraphPatch(before, { rename: { e1: 'Tommy' } }, new Set(['m1']));
    relinkMemories(memories, before, after);
    expect(memories[0]!.body).toBe('She met [[Tom]].');
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

describe('the notes of an import’s people, places and things, as text', () => {
  const said = (text: string) => ({ text, sources: [{ interviewId: null, from: 3, to: 3 }] });

  it('a paragraph is one line, from the interview, that never reads as a source line', () => {
    const text = paragraphText('Sunja on\nBusan', [
      said('She said:\n> go home.'),
      said('Then she  left.'),
    ]);
    expect(text).toBe('_From “Sunja on Busan”:_ She said: > go home. Then she left.');
    expect(text.split('\n')).toHaveLength(1);
  });

  it('one note for refs that ended with the same name and type', () => {
    const one: NoteChoice = { kind: 'make', entityId: null, name: 'Tommy Lee', type: 'person' };
    const p: GraphProposal = {
      entities: [
        { ...NOTED('e1', 'Tommy Lee'), description: [said('Tom came.')] },
        { ...NOTED('e2', 'Tommy Lee'), description: [said('Tommy stayed.'), said('Tom came.')] },
        { ...NOTED('e3', 'Busan'), type: 'place', description: [said('>\n> By the sea.')] },
      ],
      relationships: [],
    };
    const plan = new Map<string, NoteChoice>([
      ['e1', one],
      ['e2', one],
      ['e3', { kind: 'make', entityId: null, name: 'Busan', type: 'place' }],
    ]);
    const out = entityNoteInputs(p, plan, 'i1');
    expect(out.map((x) => [x.refs, x.input.title, x.input.type, x.input.body, x.hint])).toEqual([
      [['e1', 'e2'], 'Tommy Lee', 'person', 'Tom came. Tommy stayed.', 'person'],
      [['e3'], 'Busan', 'place', 'By the sea.', 'place'],
    ]);
    expect(out[0]!.input).toMatchObject({
      entity: false,
      extra: {
        sources: [
          { sentence: 'Tom came.', sources: [{ interviewId: 'i1', from: 3, to: 3 }] },
          { sentence: 'Tommy stayed.', sources: [{ interviewId: 'i1', from: 3, to: 3 }] },
        ],
      },
    });
  });

  it('the stories link to the final titles, again when a save is tried again', () => {
    const memories = [{ body: 'In [[Busan]], [[Mina|her aunt]] met [[Sam]] and [[Sunja]].' }];
    const p: GraphProposal = {
      entities: [
        { ...NOTED('e1', 'Busan'), type: 'place' },
        NOTED('e2', 'Mina'),
        NOTED('e3', 'Sam'),
        { ...NOTED('e4', 'Sunja'), subject: true },
      ],
      relationships: [],
    };
    const plan = new Map<string, NoteChoice>([
      ['e1', { kind: 'make', entityId: null, name: 'Busan', type: 'place' }],
      ['e2', { kind: 'existing', entityId: 'x', noteId: 'n', title: 'Mina Kim' }],
      ['e3', { kind: 'none' }],
      ['e4', { kind: 'none' }],
    ]);
    const linked = new Map<string, string>();
    linkStories(memories, p, plan, new Map([['e1', 'Busan (place)']]), linked);
    expect(memories[0]!.body).toBe(
      'In [[Busan (place)|Busan]], [[Mina Kim|her aunt]] met Sam and [[Sunja]].',
    );
    // the first try's title was taken meanwhile: the second moves the links on
    linkStories(memories, p, plan, new Map([['e1', 'Busan (2)']]), linked);
    expect(memories[0]!.body).toBe(
      'In [[Busan (2)|Busan]], [[Mina Kim|her aunt]] met Sam and [[Sunja]].',
    );
  });
});

describe('saving an import’s notes, links, mentions and relationships', () => {
  const INTERVIEW = 'Sunja on Busan and Minho';
  const story = (id: string, title: string, body: string) => ({
    id,
    title,
    type: 'event',
    occurred: null,
    body,
    notes: [],
    turns: [0],
    startSec: null,
    endSec: null,
    method: 'story',
    speaker: 'A',
    anchor: '',
    tellers: ['Sunja'],
    sources: [],
  });
  const line = (n: number) => [{ interviewId: null, from: n, to: n }];
  const said = (text: string, n: number) => ({ text, sources: line(n) });
  const mention = (story: string, words: string[], at: string, n: number) => ({
    story,
    words,
    line: at,
    sources: line(n),
  });

  async function project(label: string) {
    const owner = await ctx.realSession(`graph-save-notes-${label}-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Sunja ${label} ${RUN}`);
    const note = async (title: string, type: string, body = '') => {
      const res = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
        title,
        type,
        body,
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const entityOf = async (noteId: string) =>
      (
        (await ctx.pool.query(`select id from public.graph_entities where note_id = $1`, [noteId]))
          .rows[0] as { id: string }
      ).id;
    const notes = async () =>
      (
        await ctx.pool.query(
          `select id, title, type::text as type, body, extra from public.notes
            where archive_id = $1 order by title`,
          [archive],
        )
      ).rows as Array<{
        id: string;
        title: string;
        type: string;
        body: string;
        extra: Record<string, unknown>;
      }>;
    const save = (memories: unknown[], graph: GraphProposal) =>
      persistImport(ctx.deps, archive, owner.userId, {
        sourceHash: randomUUID(),
        interviewName: INTERVIEW,
        memories,
        graph,
      } as unknown as IngestResult);
    return { owner, archive, note, entityOf, notes, save };
  }

  it('makes the notes, adds the paragraphs, and points every link at its note', async () => {
    const { owner, archive, note, entityOf, notes, save } = await project('all');
    const subject = (
      await ctx.pool.query(
        `select e.id, n.id as note_id, n.title, n.body from public.graph_entities e
           join public.archives a on a.subject_note_id = e.note_id
           join public.notes n on n.id = e.note_id where a.id = $1`,
        [archive],
      )
    ).rows[0] as { id: string; note_id: string; title: string; body: string };
    // a story already called "Busan": the place's note is "Busan (place)"
    await note('Busan', 'event', 'A story about Busan.');
    const mina = await note('Mina Kim', 'person', 'Mina is Sunja’s aunt.');
    const jun = await note('Jun Park', 'person', 'Jun Park.');
    // in the graph without a note, named by a story already here
    const hyun = (
      await ctx.pool.query(
        `insert into public.graph_entities (archive_id, type, name, match_key, created_by)
         values ($1, 'person', 'Hyun', $2, $3) returning id`,
        [archive, matchKey('Hyun'), owner.userId],
      )
    ).rows[0].id as string;
    await ctx.pool.query(
      `insert into public.graph_mentions (archive_id, entity_id, note_id, words, line)
       values ($1, $2, $3, '{Hyun}', 'Hyun came to stay.')`,
      [archive, hyun, await note('Cousins', 'event', 'Hyun came to stay.')],
    );
    const revisions = async (noteId: string) =>
      (
        await ctx.pool.query(`select count(*)::int as n from public.revisions where note_id = $1`, [
          noteId,
        ])
      ).rows[0].n as number;
    const subjectRevisions = await revisions(subject.note_id);

    const harbour = story(
      'm1',
      'Harbour days',
      'Sunja grew up by the harbour in [[Busan]]. [[Mina Kim|Her aunt]] sold fish there.',
    );
    const gravy = story(
      'm2',
      'The gravy',
      '[[Minho]] made gravy for [[Jun Park|Jun]]. [[Cousin Hyun|Hyun]] ate it all.',
    );
    const existing = (ref: string, name: string, entityId: string, noteId: string) => ({
      ...NOTED(ref, name),
      match: { kind: 'existing' as const, entityId, name },
      note: { kind: 'existing' as const, noteId, title: name },
    });
    const graph: GraphProposal = {
      entities: [
        {
          ...existing('e1', 'Sunja', subject.id, subject.note_id),
          subject: true,
          description: [said('Sunja grew up in Busan.', 1)],
          mentions: [mention('m1', ['Sunja'], 'Sunja grew up by the harbour in Busan.', 1)],
        },
        {
          ...NOTED('e2', 'Minho'),
          description: [said('Minho cooked for the family.', 5)],
          mentions: [mention('m2', ['Minho'], 'Minho made gravy for Jun.', 5)],
        },
        {
          ...NOTED('e3', 'Busan'),
          type: 'place',
          description: [said('Busan is a harbour city.', 1)],
          mentions: [mention('m1', ['Busan'], 'Sunja grew up by the harbour in Busan.', 1)],
        },
        {
          ...existing('e4', 'Mina Kim', await entityOf(mina), mina),
          description: [said('Mina sold fish at the harbour.', 2)],
          mentions: [mention('m1', ['Her aunt'], 'Her aunt sold fish there.', 2)],
        },
        {
          ...existing('e5', 'Jun Park', await entityOf(jun), jun),
          description: [],
          mentions: [mention('m2', ['Jun'], 'Minho made gravy for Jun.', 5)],
        },
        {
          // the same as Hyun, who has no note: the note is his, by his name
          ...NOTED('e6', 'Cousin Hyun'),
          match: { kind: 'existing', entityId: hyun, name: '' },
          description: [said('Hyun was Sunja’s cousin.', 6)],
          mentions: [mention('m2', ['Hyun'], 'Hyun ate it all.', 6)],
        },
      ],
      relationships: [
        {
          ref: 'r1',
          a: 'e2',
          b: 'e1',
          description: 'Minho — Sunja’s brother',
          story: 'm2',
          sources: line(5),
        },
        {
          ref: 'r2',
          a: 'e6',
          b: 'e2',
          description: 'Hyun — Minho’s friend',
          story: null,
          sources: line(6),
        },
      ],
    };

    const out = await save([harbour, gravy], graph);
    // the stories only: the notes of the people, places and things are not in it
    expect(out.saved.map((s) => s.title)).toEqual(['Harbour days', 'The gravy']);

    const all = await notes();
    const byTitle = (t: string) => all.find((n) => n.title === t);
    const minho = byTitle('Minho')!;
    expect(minho).toMatchObject({
      type: 'person',
      body: 'Minho cooked for the family.',
      extra: {
        sources: [{ sentence: 'Minho cooked for the family.', sources: line(5) }],
      },
    });
    const minhoEntity = (
      await ctx.pool.query(`select name, run_id from public.graph_entities where note_id = $1`, [
        minho.id,
      ])
    ).rows;
    expect(minhoEntity).toEqual([{ name: 'Minho', run_id: out.runId }]);

    // the title was taken by a story: the type tells them apart, and the link follows
    const place = byTitle('Busan (place)')!;
    expect(place).toMatchObject({ type: 'place', body: 'Busan is a harbour city.' });
    expect(byTitle('Harbour days')!.body).toBe(
      'Sunja grew up by the harbour in [[Busan (place)|Busan]]. [[Mina Kim|Her aunt]] sold fish there.',
    );
    const resolved = await ctx.pool.query(
      `select l.target, l.resolved_id from public.links l
        where l.source_id = $1 order by l.start_pos`,
      [byTitle('Harbour days')!.id],
    );
    expect(resolved.rows).toEqual([
      { target: 'Busan (place)', resolved_id: place.id },
      { target: 'Mina Kim', resolved_id: mina },
    ]);

    // the protagonist: no paragraph, no new revision
    expect(byTitle(subject.title)!.body).toBe(subject.body);
    expect(await revisions(subject.note_id)).toBe(subjectRevisions);

    // a note already here gets a paragraph, and no second note is made
    expect(byTitle('Mina Kim')!.body).toBe(
      `Mina is Sunja’s aunt.\n\n_From “${INTERVIEW}”:_ Mina sold fish at the harbour.`,
    );
    expect(all.filter((n) => n.title.startsWith('Mina Kim'))).toHaveLength(1);
    // with nothing to add, it is left as it was; the story still links to it
    expect(byTitle('Jun Park')!.body).toBe('Jun Park.');
    expect(await revisions(jun)).toBe(1);
    expect(byTitle('The gravy')!.body).toBe(
      '[[Minho]] made gravy for [[Jun Park|Jun]]. [[Hyun]] ate it all.',
    );

    // in the graph without a note: the note is made for that entity, by its name
    const hyunNote = byTitle('Hyun')!;
    expect(hyunNote.body).toBe('Hyun was Sunja’s cousin.');
    const hyuns = (
      await ctx.pool.query(
        `select id, note_id from public.graph_entities where archive_id = $1 and match_key = 'hyun'`,
        [archive],
      )
    ).rows;
    expect(hyuns).toEqual([{ id: hyun, note_id: hyunNote.id }]);
    expect(all.map((n) => n.title)).not.toContain('Cousin Hyun');

    // each story's mentions, with its words
    const mentions = await ctx.pool.query(
      `select e.name, s.title as story, m.words from public.graph_mentions m
         join public.graph_entities e on e.id = m.entity_id
         join public.notes s on s.id = m.note_id
        where m.run_id = $1 order by s.title, e.name`,
      [out.runId],
    );
    expect(mentions.rows).toEqual([
      { name: 'Busan', story: 'Harbour days', words: ['Busan'] },
      { name: 'Mina Kim', story: 'Harbour days', words: ['Her aunt'] },
      { name: subject.title, story: 'Harbour days', words: ['Sunja'] },
      { name: 'Hyun', story: 'The gravy', words: ['Hyun'] },
      { name: 'Jun Park', story: 'The gravy', words: ['Jun'] },
      { name: 'Minho', story: 'The gravy', words: ['Minho'] },
    ]);
    // a relationship no story tells is tied to its first entity's note
    const told = await ctx.pool.query(
      `select r.description, n.title from public.graph_relationships r
         join public.notes n on n.id = r.note_id
        where r.archive_id = $1 order by r.description`,
      [archive],
    );
    expect(told.rows).toEqual([
      { description: 'Hyun — Minho’s friend', title: 'Hyun' },
      { description: 'Minho — Sunja’s brother', title: 'The gravy' },
    ]);

    // Minho's page shows the story that links to him
    const res = await ctx.api(
      owner.token,
      'GET',
      `/v1/archives/${archive}/notes/${minho.id}/backlinks`,
    );
    expect(res.status).toBe(200);
    const back = (await res.json()) as { occurrences: Array<{ sourceTitle: string }> };
    expect(back.occurrences.map((o) => o.sourceTitle)).toEqual(['The gravy']);
  });

  it('one note for two that ended with the same name; none for one whose note is private', async () => {
    const { archive, note, notes, save } = await project('one');
    // someone else's private note: the importer may not see it, nor link to it
    const other = await ctx.realSession(`graph-save-notes-other-${RUN}@test.local`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'contributor')`,
      [archive, other.userId],
    );
    const res = await ctx.api(other.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: 'Secret Sam',
      type: 'person',
      body: 'Private.',
    });
    const sam = ((await res.json()) as { id: string }).id;
    await ctx.pool.query(
      `insert into public.audiences (archive_id, note_id, kind) values ($1, $2, 'private-to-author')`,
      [archive, sam],
    );
    await note('Unrelated', 'event');
    const memory = story(
      'm1',
      'Old friends',
      '[[Tommy Lee|Tom]] and [[Tommy Lee]] met [[Secret Sam|Sam]].',
    );
    const graph: GraphProposal = {
      entities: [
        { ...NOTED('e1', 'Tommy Lee', 'm1'), aliases: ['Tom'] },
        NOTED('e2', 'Tommy Lee', 'm1'),
        NOTED('e3', 'Secret Sam', 'm1'),
      ],
      relationships: [],
    };
    await save([memory], graph);
    const all = await notes();
    expect(all.filter((n) => n.title.startsWith('Tommy Lee')).map((n) => n.title)).toEqual([
      'Tommy Lee',
    ]);
    expect(all.find((n) => n.title === 'Tommy Lee')!.body).toBe('Tommy Lee came.');
    expect(all.find((n) => n.title === 'Old friends')!.body).toBe(
      '[[Tommy Lee|Tom]] and [[Tommy Lee]] met Sam.',
    );
    expect(all.filter((n) => n.title.startsWith('Secret Sam')).map((n) => n.id)).toEqual([sam]);
    const tommy = await ctx.pool.query(
      `select count(*)::int as n from public.graph_entities where archive_id = $1 and match_key = 'tommy lee'`,
      [archive],
    );
    expect(tommy.rows[0]).toEqual({ n: 1 });
  });
});
