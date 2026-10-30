import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * Changing the graph by hand (graph design 5.4): rename, retype, merge, remove an entity or one
 * relationship. Every change is recorded; viewers may only read; strangers see nothing.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(() => ctx.close());

let n = 0;
async function setup() {
  const owner = await ctx.realSession(`graph-edit-${RUN}-${n++}@test.local`);
  const archive = await ctx.provisionArchive(owner, `Edit ${RUN} ${n}`);
  const api = (method: string, path: string, body?: unknown, who: RealSession = owner) =>
    ctx.api(who.token, method, `/v1/archives/${archive}${path}`, body);
  const story = async (title: string) => {
    const res = await api('POST', '/notes', { title, type: 'event', body: `${title}.` });
    return ((await res.json()) as { id: string }).id;
  };
  const entity = async (name: string, type = 'person') =>
    (
      await ctx.pool.query(
        `insert into public.graph_entities (archive_id, type, name, match_key, created_by)
         values ($1, $2, $3, lower(regexp_replace($3, '[^[:alnum:]]+', ' ', 'g')), $4) returning id`,
        [archive, type, name, owner.userId],
      )
    ).rows[0].id as string;
  const mention = (entityId: string, noteId: string, words: string[]) =>
    ctx.pool.query(
      `insert into public.graph_mentions (archive_id, entity_id, note_id, words, line)
       values ($1, $2, $3, $4, $5)`,
      [archive, entityId, noteId, words, `${words[0]} is in it.`],
    );
  const told = async (a: string, b: string, noteId: string, description: string) =>
    (
      await ctx.pool.query(
        `insert into public.graph_relationships (archive_id, a_id, b_id, description, note_id, created_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [archive, a, b, description, noteId, owner.userId],
      )
    ).rows[0].id as string;
  const row = async (id: string) =>
    (
      await ctx.pool.query(
        `select e.name, e.type::text as type, e.note_id,
                coalesce((select array_agg(g.alias order by g.alias) from public.graph_aliases g
                           where g.entity_id = e.id), '{}') as aliases
           from public.graph_entities e where e.id = $1`,
        [id],
      )
    ).rows[0] as
      { name: string; type: string; note_id: string | null; aliases: string[] } | undefined;
  const changes = async () =>
    (
      await ctx.pool.query(
        `select kind from public.graph_changes where archive_id = $1 order by created_at`,
        [archive],
      )
    ).rows.map((r: { kind: string }) => r.kind);
  return { owner, archive, api, story, entity, mention, told, row, changes };
}

describe('rename and retype', () => {
  it('keeps the old name as an alias, and refuses a name another entity has', async () => {
    const { api, story, entity, mention, row, changes } = await setup();
    const s = await story('The kitchen');
    const mother = await entity('Noah’s mother');
    const mina = await entity('Mina Kim');
    await mention(mother, s, ['his mother']);
    await mention(mina, s, ['Mina']);
    const res = await api('PATCH', `/entities/${mother}`, { name: 'Mina Park' });
    expect(res.status).toBe(200);
    expect(await row(mother)).toMatchObject({ name: 'Mina Park', aliases: ['Noah’s mother'] });
    const taken = await api('PATCH', `/entities/${mother}`, { name: 'mina kim' });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: 'taken', entityId: mina });
    // back to an alias it already has: no longer an alias, now its name
    expect((await api('PATCH', `/entities/${mother}`, { name: 'Noah’s mother' })).status).toBe(200);
    expect(await row(mother)).toMatchObject({ name: 'Noah’s mother', aliases: ['Mina Park'] });
    expect((await api('PATCH', `/entities/${mother}`, { type: 'place' })).status).toBe(200);
    expect((await row(mother))!.type).toBe('place');
    expect((await api('PATCH', `/entities/${mother}`, { type: 'animal' })).status).toBe(400);
    expect((await api('PATCH', `/entities/${mother}`, { name: '  ' })).status).toBe(400);
    expect(await changes()).toEqual(['rename', 'rename', 'type']);
  });
});

describe('merge', () => {
  it('moves mentions, relationships and names into the one kept, and removes the other', async () => {
    const { api, story, entity, mention, told, row, changes, archive } = await setup();
    const school = await story('School');
    const summer = await story('Summer');
    const sarah = await entity('Sarah Lee');
    const sally = await entity('Sally');
    const tom = await entity('Tom');
    await mention(sarah, school, ['Sarah']);
    await mention(sally, school, ['Sally']);
    await mention(sally, summer, ['Sally']);
    await told(sally, sarah, school, 'Sally — Sarah’s nickname');
    await told(tom, sally, school, 'Tom — Sally’s brother');
    await told(tom, sarah, school, 'Tom — Sarah’s brother');
    await told(tom, sally, summer, 'Tom — took Sally to the lake');
    const res = await api('POST', `/entities/${sarah}/merge`, { from: sally });
    expect(res.status).toBe(200);
    expect(await row(sally)).toBeUndefined();
    expect((await row(sarah))!.aliases).toEqual(['Sally']);
    const mentions = await ctx.pool.query(
      `select n.title, m.words from public.graph_mentions m join public.notes n on n.id = m.note_id
        where m.entity_id = $1 order by n.title`,
      [sarah],
    );
    expect(mentions.rows).toEqual([
      { title: 'School', words: ['Sarah', 'Sally'] },
      { title: 'Summer', words: ['Sally'] },
    ]);
    const rels = await ctx.pool.query(
      `select description from public.graph_relationships where archive_id = $1 order by description`,
      [archive],
    );
    // the self-relationship goes; Tom and Sarah keep one per story
    expect(rels.rows.map((r: { description: string }) => r.description)).toEqual([
      'Tom — Sarah’s brother',
      'Tom — took Sally to the lake',
    ]);
    expect(await changes()).toEqual(['merge']);
    expect((await api('POST', `/entities/${sarah}/merge`, { from: sarah })).status).toBe(400);
  });

  it('keeps the note of the one merged away when the kept one has none', async () => {
    const { api, row, mention, story } = await setup();
    const res = await api('POST', '/notes', { title: 'Grandpa Walt', type: 'person' });
    const note = ((await res.json()) as { id: string }).id;
    const walt = (
      await ctx.pool.query(`select id from public.graph_entities where note_id = $1`, [note])
    ).rows[0].id as string;
    const walter = (
      await ctx.pool.query(
        `insert into public.graph_entities (archive_id, type, name, match_key, created_by)
         select archive_id, 'person', 'Walter Marsh', 'walter marsh', created_by
           from public.graph_entities where id = $1 returning id`,
        [walt],
      )
    ).rows[0].id as string;
    await mention(walter, await story('The barn'), ['Walter Marsh']);
    expect((await api('POST', `/entities/${walter}/merge`, { from: walt })).status).toBe(200);
    expect(await row(walter)).toMatchObject({ note_id: note, aliases: ['Grandpa Walt'] });
  });
});

describe('remove', () => {
  it('an entity goes with its mentions and relationships; the stories stay', async () => {
    const { api, story, entity, mention, told, row, changes, archive } = await setup();
    const s = await story('Fishing');
    const boat = await entity('The boat', 'thing');
    const tom = await entity('Tom');
    await mention(boat, s, ['the boat']);
    await told(tom, boat, s, 'Tom — owned the boat');
    expect((await api('DELETE', `/entities/${boat}`)).status).toBe(200);
    expect(await row(boat)).toBeUndefined();
    const left = await ctx.pool.query(
      `select (select count(*) from public.graph_relationships where archive_id = $1)::int as r,
              (select count(*) from public.notes where id = $2)::int as n`,
      [archive, s],
    );
    expect(left.rows[0]).toEqual({ r: 0, n: 1 });
    expect(await changes()).toEqual(['remove']);
  });

  it('one relationship goes on its own', async () => {
    const { api, story, entity, told, changes, archive } = await setup();
    const s = await story('Fishing');
    const rel = await told(
      await entity('Tom'),
      await entity('Jae-won'),
      s,
      'Tom — Jae-won’s friend',
    );
    expect((await api('DELETE', `/relationships/${rel}`)).status).toBe(200);
    const left = await ctx.pool.query(
      `select count(*)::int as n from public.graph_relationships where archive_id = $1`,
      [archive],
    );
    expect(left.rows[0].n).toBe(0);
    expect(await changes()).toEqual(['remove-relationship']);
  });

  it('the protagonist cannot be removed, nor merged away', async () => {
    const { api, archive, entity, mention, story } = await setup();
    const subject = (
      await ctx.pool.query(
        `select e.id from public.graph_entities e join public.archives a on a.subject_note_id = e.note_id
          where a.id = $1`,
        [archive],
      )
    ).rows[0].id as string;
    expect((await api('DELETE', `/entities/${subject}`)).status).toBe(409);
    const other = await entity('Someone');
    await mention(other, await story('Someone came'), ['Someone']);
    expect((await api('POST', `/entities/${other}/merge`, { from: subject })).status).toBe(409);
  });
});

describe('who may change it', () => {
  it('a viewer may not; a stranger sees nothing', async () => {
    const { api, entity } = await setup();
    const x = await entity('Mina');
    const viewer = await ctx.realSession(`graph-edit-viewer-${RUN}@test.local`);
    const stranger = await ctx.realSession(`graph-edit-stranger-${RUN}@test.local`);
    const archive = (
      await ctx.pool.query(`select archive_id from public.graph_entities where id = $1`, [x])
    ).rows[0].archive_id as string;
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'viewer')`,
      [archive, viewer.userId],
    );
    // Mina is in no story: only the owner-side checks would show her; a viewer cannot change her
    expect((await api('PATCH', `/entities/${x}`, { name: 'M' }, viewer)).status).toBe(403);
    expect((await api('DELETE', `/entities/${x}`, undefined, stranger)).status).toBe(404);
  });
});
