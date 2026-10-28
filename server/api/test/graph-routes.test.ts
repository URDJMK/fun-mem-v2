import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * Reading the graph (graph design 6.4): the whole graph for Home, entities for People, places &
 * things, one entity with its stories, relationships and neighbours, and the mentions a story's
 * page underlines. A member never sees what comes only from a story they cannot read.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(() => ctx.close());

let owner: RealSession;
let member: RealSession;
let archive: string;
type Who = 'noah' | 'sarah' | 'tom' | 'busan' | 'mina' | 'jun';
const id = {} as Record<Who, string>;
const story = {} as Record<'school' | 'busan' | 'mina' | 'secret', string>;

interface View {
  nodes: Array<{ id: string; name: string; type: string; stories: number; subject: boolean }>;
  told: Array<{ a: string; b: string; lines: Array<{ description: string; storyTitle: string }> }>;
  together: Array<{ a: string; b: string; stories: number }>;
  more: number;
}

const get = async <T>(s: RealSession, path: string): Promise<{ status: number; body: T }> => {
  const res = await ctx.api(s.token, 'GET', `/v1/archives/${archive}${path}`);
  return { status: res.status, body: (await res.json()) as T };
};
const pair = (a: Who, b: Who) => [id[a], id[b]].sort().join(':');
const pairsOf = (lines: Array<{ a: string; b: string }>) =>
  lines.map((l) => [l.a, l.b].sort().join(':')).sort();

beforeAll(async () => {
  owner = await ctx.realSession(`graph-routes-owner-${RUN}@test.local`);
  member = await ctx.realSession(`graph-routes-member-${RUN}@test.local`);
  archive = await ctx.provisionArchive(owner, `Noah Kim ${RUN}`);
  await ctx.pool.query(
    `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'viewer')`,
    [archive, member.userId],
  );
  id.noah = (
    await ctx.pool.query(
      `select e.id from public.graph_entities e
         join public.archives a on a.subject_note_id = e.note_id where a.id = $1`,
      [archive],
    )
  ).rows[0].id;
  const write = async (title: string, body: string) => {
    const res = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
      title,
      type: 'event',
      body,
    });
    const { id: noteId } = (await res.json()) as { id: string };
    await ctx.pool.query(`update public.notes set contributors = $2 where id = $1`, [
      noteId,
      [`Noah Kim ${RUN}`],
    ]);
    return noteId;
  };
  story.school = await write(
    'The new boy at school',
    'Noah met Sarah, who brought her brother Tom.',
  );
  story.busan = await write('Summers in Busan', 'Noah and Sarah spent summers in Busan.');
  story.mina = await write('A letter from Mina', 'Noah got a letter from Mina.');
  story.secret = await write('A private one', 'Noah told Sarah about Jun.');
  await ctx.pool.query(
    `insert into public.audiences (archive_id, note_id, kind) values ($1, $2, 'private-to-author')`,
    [archive, story.secret],
  );
  const entity = async (name: string, type = 'person') =>
    (
      await ctx.pool.query(
        `insert into public.graph_entities (archive_id, type, name, match_key, created_by)
         values ($1, $2, $3, lower($3), $4) returning id`,
        [archive, type, name, owner.userId],
      )
    ).rows[0].id as string;
  id.sarah = await entity('Sarah Lee');
  id.tom = await entity('Tom Lee');
  id.busan = await entity('Busan', 'place');
  id.mina = await entity('Mina');
  id.jun = await entity('Jun');
  await ctx.pool.query(
    `insert into public.graph_aliases (archive_id, entity_id, alias, match_key)
     values ($1, $2, 'Sarah', 'sarah')`,
    [archive, id.sarah],
  );
  const mention = (who: Who, at: keyof typeof story, words: string[], line: string) =>
    ctx.pool.query(
      `insert into public.graph_mentions (archive_id, entity_id, note_id, words, line)
       values ($1, $2, $3, $4, $5)`,
      [archive, id[who], story[at], words, line],
    );
  await mention('noah', 'school', ['Noah'], 'Noah was new at school.');
  await mention('sarah', 'school', ['Sarah'], 'Sarah sat next to Noah.');
  await mention('tom', 'school', ['her brother Tom'], 'Tom is Sarah’s brother.');
  await mention('noah', 'busan', ['Noah'], 'Noah spent summers in Busan.');
  await mention('sarah', 'busan', ['Sarah'], 'Sarah came along.');
  await mention('busan', 'busan', ['Busan'], 'Where they spent summers.');
  await mention('noah', 'mina', ['Noah'], 'Noah got a letter.');
  await mention('mina', 'mina', ['Mina'], 'Mina wrote to Noah.');
  await mention('sarah', 'secret', ['Sarah'], 'Sarah heard about Jun.');
  await mention('jun', 'secret', ['Jun'], 'Jun was a secret.');
  const told = (a: Who, b: Who, at: keyof typeof story, description: string) =>
    ctx.pool.query(
      `insert into public.graph_relationships (archive_id, a_id, b_id, description, note_id, created_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [archive, id[a], id[b], description, story[at], owner.userId],
    );
  await told('sarah', 'noah', 'school', 'Sarah Lee — Noah’s friend from school');
  await told('tom', 'sarah', 'school', 'Tom Lee — Sarah’s brother');
  await told('jun', 'sarah', 'secret', 'Jun — Sarah’s cousin');
});

describe('GET /graph', () => {
  it('draws told relationships, and same-story lines without the protagonist or the tellers', async () => {
    const { status, body } = await get<View>(member, '/graph');
    expect(status).toBe(200);
    const names = body.nodes.map((n) => n.name);
    expect(names).toEqual(
      expect.arrayContaining([`Noah Kim ${RUN}`, 'Sarah Lee', 'Tom Lee', 'Busan', 'Mina']),
    );
    expect(names).not.toContain('Jun');
    const noah = body.nodes.find((n) => n.id === id.noah)!;
    expect(noah).toMatchObject({ subject: true, stories: 3 });
    expect(body.nodes.find((n) => n.id === id.sarah)!.stories).toBe(2);
    // the bridge: Tom joins through Sarah, never straight to Noah
    expect(pairsOf(body.told)).toEqual([pair('noah', 'sarah'), pair('sarah', 'tom')].sort());
    expect(body.told.find((t) => [t.a, t.b].includes(id.tom))!.lines).toEqual([
      expect.objectContaining({
        description: 'Tom Lee — Sarah’s brother',
        storyTitle: 'The new boy at school',
      }),
    ]);
    // faint lines: shared stories, leaving out Noah, and pairs already joined by a told line
    expect(body.together).toEqual([{ a: expect.any(String), b: expect.any(String), stories: 1 }]);
    expect(pairsOf(body.together)).toEqual([pair('busan', 'sarah')]);
    // Mina is a node of her own: no line at all
    const touching = [...body.told, ...body.together].filter((l) => [l.a, l.b].includes(id.mina));
    expect(touching).toEqual([]);
    expect(body.more).toBe(0);
  });

  it('shows the private story’s author what it says', async () => {
    const { body } = await get<View>(owner, '/graph');
    expect(body.nodes.map((n) => n.name)).toContain('Jun');
    expect(pairsOf(body.told)).toContain(pair('jun', 'sarah'));
  });

  it('keeps the most-mentioned within the limit, and says how many more there are', async () => {
    const { body } = await get<View>(member, '/graph?limit=2');
    expect(body.nodes.map((n) => n.id)).toEqual([id.noah, id.sarah]);
    expect(body.more).toBe(3);
    expect(pairsOf(body.told)).toEqual([pair('noah', 'sarah')]);
  });
});

describe('GET /entities and /entities/:id', () => {
  it('lists the entities a member can see, with aliases and story counts', async () => {
    const { body } = await get<
      Array<{ id: string; name: string; type: string; aliases: string[]; stories: number }>
    >(member, '/entities');
    expect(body.find((e) => e.id === id.sarah)).toMatchObject({
      name: 'Sarah Lee',
      type: 'person',
      aliases: ['Sarah'],
      stories: 2,
    });
    expect(body.find((e) => e.id === id.busan)).toMatchObject({ type: 'place', stories: 1 });
    expect(body.map((e) => e.name)).not.toContain('Jun');
  });

  it('opens one, by its id or its note’s, with its stories, relationships and neighbours', async () => {
    const { status, body } = await get<{
      name: string;
      subject: boolean;
      profile: { born: string | null } | null;
      mentions: Array<{ storyTitle: string; line: string; words: string[] }>;
      relationships: Array<{ description: string; other: { name: string } }>;
      graph: View;
    }>(member, `/entities/${id.sarah}`);
    expect(status).toBe(200);
    expect(body.mentions.map((m) => m.storyTitle).sort()).toEqual([
      'Summers in Busan',
      'The new boy at school',
    ]);
    expect(body.relationships.map((r) => r.other.name).sort()).toEqual([
      `Noah Kim ${RUN}`,
      'Tom Lee',
    ]);
    expect(body.graph.nodes.map((n) => n.name).sort()).toEqual(
      ['Busan', `Noah Kim ${RUN}`, 'Sarah Lee', 'Tom Lee'].sort(),
    );
    const subjectNote = (
      await ctx.pool.query(`select subject_note_id from public.archives where id = $1`, [archive])
    ).rows[0].subject_note_id as string;
    const noah = await get<{ name: string; subject: boolean; profile: object | null }>(
      member,
      `/entities/${subjectNote}`,
    );
    expect(noah.body).toMatchObject({ name: `Noah Kim ${RUN}`, subject: true });
    expect(noah.body.profile).toMatchObject({ born: null, aliases: [] });
    expect((await get(member, `/entities/${id.jun}`)).status).toBe(404);
  });
});

describe('a story’s mentions', () => {
  it('come with the note, for the entities the reader can see', async () => {
    const { body } = await get<{ mentions: Array<{ entityId: string; words: string[] }> }>(
      member,
      `/notes/${story.school}`,
    );
    expect(body.mentions).toEqual(
      expect.arrayContaining([
        { entityId: id.sarah, words: ['Sarah'] },
        { entityId: id.tom, words: ['her brother Tom'] },
      ]),
    );
  });
});

describe('strangers', () => {
  it('get 404 everywhere', async () => {
    const stranger = await ctx.realSession(`graph-routes-stranger-${RUN}@test.local`);
    for (const path of ['/graph', '/entities', `/entities/${id.sarah}`]) {
      expect((await get(stranger, path)).status).toBe(404);
    }
  });
});
