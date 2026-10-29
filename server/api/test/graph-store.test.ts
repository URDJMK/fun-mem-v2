import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureGraph, entityLookup, entityVisibleSql, knownFor } from '../src/graph/store';
import { testContext } from './helpers';

/**
 * Where the graph's entities come from before any import proposes one (graph design 3.3, 3.5):
 * hand-written person, place and object notes, the protagonist, and the backfill of a project
 * made before the graph existed. And who may see an entity.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(() => ctx.close());

const entities = async (archiveId: string) =>
  (
    await ctx.pool.query(
      `select e.name, e.type::text as type, e.note_id, n.title as note
         from public.graph_entities e left join public.notes n on n.id = e.note_id
        where e.archive_id = $1 order by e.name`,
      [archiveId],
    )
  ).rows as Array<{ name: string; type: string; note_id: string | null; note: string | null }>;

const note = async (token: string, archiveId: string, body: object) => {
  const res = await ctx.api(token, 'POST', `/v1/archives/${archiveId}/notes`, body);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
};

describe('entities of hand-written notes', () => {
  it('a person, place or object note is about an entity; a story is not', async () => {
    const s = await ctx.realSession(`graph-notes-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `The Marsh family ${RUN}`);
    await ctx.pool.query(`update public.archives set kind = 'family' where id = $1`, [archive]);
    const walter = await note(s.token, archive, { title: 'Walter Marsh', type: 'person' });
    await note(s.token, archive, { title: 'Dayton', type: 'place' });
    await note(s.token, archive, { title: 'The sewing machine', type: 'object' });
    await note(s.token, archive, { title: 'The flood of 1959', type: 'event' });
    const got = await entities(archive);
    expect(got.map((e) => [e.name, e.type])).toEqual(
      expect.arrayContaining([
        ['Walter Marsh', 'person'],
        ['Dayton', 'place'],
        ['The sewing machine', 'thing'],
      ]),
    );
    expect(got.find((e) => e.name === 'The flood of 1959')).toBeUndefined();
    expect(got.find((e) => e.name === 'Walter Marsh')!.note_id).toBe(walter.id);
  });

  it('a second note with the same name key stays a note on its own, and saves', async () => {
    const s = await ctx.realSession(`graph-same-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Han ${RUN}`);
    await note(s.token, archive, { title: 'Mrs. Han', type: 'person' });
    await note(s.token, archive, { title: 'Mrs Han', type: 'person' });
    const hans = (await entities(archive)).filter((e) => /han$/i.test(e.name));
    expect(hans).toHaveLength(1);
    expect(hans[0]!.note).toBe('Mrs. Han');
  });
});

describe('which note an entity has', () => {
  it('the lookup and the known entities say which note each has', async () => {
    const s = await ctx.realSession(`graph-has-note-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Walt Marsh ${RUN}`);
    const walt = await note(s.token, archive, { title: 'Grandpa Walt', type: 'person' });
    const found = await entityLookup(ctx.pool, archive, s.userId).find('grandpa walt');
    expect(found[0]!.note).toEqual({ noteId: walt.id, title: 'Grandpa Walt' });
    const known = await knownFor(ctx.pool, archive, s.userId, []);
    const subject = known.find((k) => k.subject);
    expect(subject?.note?.noteId).toBeTruthy();
  });

  it('an entity whose note the member cannot see has none', async () => {
    const owner = await ctx.realSession(`graph-hidden-note-owner-${RUN}@test.local`);
    const member = await ctx.realSession(`graph-hidden-note-member-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Hidden ${RUN}`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'contributor')`,
      [archive, member.userId],
    );
    const aunt = await note(owner.token, archive, { title: 'Aunt Mabel', type: 'person' });
    await ctx.pool.query(
      `insert into public.audiences (archive_id, note_id, kind) values ($1, $2, 'private-to-author')`,
      [archive, aunt.id],
    );
    const story = await note(owner.token, archive, {
      title: 'A visit',
      type: 'event',
      body: 'Mabel visited.',
    });
    const e = await ctx.pool.query(`select id from public.graph_entities where note_id = $1`, [
      aunt.id,
    ]);
    await ctx.pool.query(
      `insert into public.graph_mentions (archive_id, entity_id, note_id, words, line)
       values ($1, $2, $3, '{Mabel}', 'Mabel visited.')`,
      [archive, e.rows[0].id, story.id],
    );
    const seen = await entityLookup(ctx.pool, archive, member.userId).find('Aunt Mabel');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.note).toBeNull();
    const mine = await entityLookup(ctx.pool, archive, owner.userId).find('Aunt Mabel');
    expect(mine[0]!.note).toEqual({ noteId: aunt.id, title: 'Aunt Mabel' });
  });
});

describe('who may see an entity', () => {
  it('one known only from a private story is seen by its author alone', async () => {
    const owner = await ctx.realSession(`graph-vis-owner-${RUN}@test.local`);
    const member = await ctx.realSession(`graph-vis-member-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Vis ${RUN}`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'contributor')`,
      [archive, member.userId],
    );
    const story = await note(owner.token, archive, {
      title: 'A private story',
      type: 'event',
      body: 'Sarah came by.',
    });
    await ctx.pool.query(
      `insert into public.audiences (archive_id, note_id, kind) values ($1, $2, 'private-to-author')`,
      [archive, story.id],
    );
    const e = await ctx.pool.query(
      `insert into public.graph_entities (archive_id, type, name, match_key, created_by)
       values ($1, 'person', 'Sarah', 'sarah', $2) returning id`,
      [archive, owner.userId],
    );
    await ctx.pool.query(
      `insert into public.graph_mentions (archive_id, entity_id, note_id, words, line)
       values ($1, $2, $3, '{Sarah}', 'Sarah came by.')`,
      [archive, e.rows[0].id, story.id],
    );
    const seen = async (userId: string) =>
      (
        await ctx.pool.query(
          `select e.name from public.graph_entities e
            where e.archive_id = $1 and ${entityVisibleSql('e', '$2')} order by e.name`,
          [archive, userId],
        )
      ).rows.map((r: { name: string }) => r.name);
    expect(await seen(owner.userId)).toContain('Sarah');
    expect(await seen(member.userId)).not.toContain('Sarah');
    // the protagonist is seen by every member
    expect(await seen(member.userId)).toContain(`Vis ${RUN}`);
  });
});

describe('the protagonist', () => {
  it('is a person note and an entity from the moment a personal project is made', async () => {
    const s = await ctx.realSession(`graph-subject-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Noah Kim ${RUN}`);
    const row = await ctx.pool.query(
      `select n.title, n.type::text as type, e.id as entity
         from public.archives a join public.notes n on n.id = a.subject_note_id
         left join public.graph_entities e on e.note_id = n.id
        where a.id = $1`,
      [archive],
    );
    expect(row.rows[0]).toMatchObject({ title: `Noah Kim ${RUN}`, type: 'person' });
    expect(row.rows[0].entity).toBeTruthy();
  });

  it('a family project has none', async () => {
    const s = await ctx.realSession(`graph-family-${RUN}@test.local`);
    const res = await ctx.api(s.token, 'POST', '/v1/provision', {
      subjectName: `The Kims ${RUN}`,
      jurisdiction: 'US',
      kind: 'family',
    });
    const { archiveId } = (await res.json()) as { archiveId: string };
    const a = await ctx.pool.query(`select subject_note_id from public.archives where id = $1`, [
      archiveId,
    ]);
    expect(a.rows[0].subject_note_id).toBeNull();
    expect(await entities(archiveId)).toEqual([]);
  });

  it('keeps the names the family uses as the entity’s aliases', async () => {
    const s = await ctx.realSession(`graph-aliases-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Sunja Kim ${RUN}`);
    const put = (aliases: string[]) =>
      ctx.api(s.token, 'PUT', `/v1/archives/${archive}/profile`, { aliases });
    expect((await put(['Grandma Sunja', 'Halmeoni'])).status).toBe(200);
    expect((await put(['Halmeoni', 'Sunja'])).status).toBe(200);
    const aliases = await ctx.pool.query(
      `select g.alias from public.graph_aliases g
         join public.graph_entities e on e.id = g.entity_id
         join public.archives a on a.subject_note_id = e.note_id
        where a.id = $1 order by g.alias`,
      [archive],
    );
    expect(aliases.rows.map((r: { alias: string }) => r.alias)).toEqual(['Halmeoni', 'Sunja']);
  });
});

describe('ensureGraph: a project made before the graph', () => {
  it('turns its notes and links into entities and mentions, once', async () => {
    const s = await ctx.realSession(`graph-backfill-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Nell ${RUN}`);
    const subject = (
      await ctx.pool.query(`select subject_note_id from public.archives where id = $1`, [archive])
    ).rows[0].subject_note_id as string;
    await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/profile`, {
      aliases: ['Grandma Nell'],
    });
    await note(s.token, archive, { title: 'Walter', type: 'person' });
    await note(s.token, archive, { title: 'Dayton', type: 'place' });
    const story = await note(s.token, archive, {
      title: 'The drive to town',
      type: 'event',
      body: 'Every Saturday [[Walter|Dad]] drove us to [[Dayton]] in the truck.',
    });
    // as it was before the graph: no entities, no protagonist link, never backfilled
    await ctx.pool.query(`delete from public.graph_entities where archive_id = $1`, [archive]);
    await ctx.pool.query(
      `update public.archives set subject_note_id = null, graph_backfilled_at = null where id = $1`,
      [archive],
    );

    await ensureGraph(ctx.deps, archive);
    const got = await entities(archive);
    expect(got.map((e) => [e.name, e.type])).toEqual([
      ['Dayton', 'place'],
      [`Nell ${RUN}`, 'person'],
      ['Walter', 'person'],
    ]);
    // the protagonist's own note was adopted, not made twice
    expect(got.find((e) => e.name === `Nell ${RUN}`)!.note_id).toBe(subject);
    const mentions = await ctx.pool.query(
      `select e.name, m.words, m.line from public.graph_mentions m
         join public.graph_entities e on e.id = m.entity_id
        where m.note_id = $1 order by e.name`,
      [story.id],
    );
    expect(mentions.rows).toEqual([
      { name: 'Dayton', words: ['Dayton'], line: expect.stringContaining('drove us to Dayton') },
      { name: 'Walter', words: ['Dad'], line: expect.stringContaining('Every Saturday Dad drove') },
    ]);
    const aliases = await ctx.pool.query(
      `select g.alias from public.graph_aliases g where g.archive_id = $1`,
      [archive],
    );
    expect(aliases.rows).toEqual([{ alias: 'Grandma Nell' }]);

    const counts = async () =>
      (
        await ctx.pool.query(
          `select (select count(*) from public.graph_entities where archive_id = $1)::int as e,
                  (select count(*) from public.graph_mentions where archive_id = $1)::int as m`,
          [archive],
        )
      ).rows[0];
    const before = await counts();
    await ensureGraph(ctx.deps, archive);
    expect(await counts()).toEqual(before);
  });
});
