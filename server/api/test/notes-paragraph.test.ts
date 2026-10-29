import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { appendParagraph, createNotesBatch, inTransaction, MAX_NOTE_CHARS } from '../src/notes';
import { testContext } from './helpers';

/**
 * What an import writes into notes (entity design 5.1, 5.2): a note it makes may leave its
 * entity to the import, and a note that already exists gets a paragraph at its end as a new
 * revision.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(() => ctx.close());

let n = 0;
async function setup() {
  const owner = await ctx.realSession(`notes-paragraph-${RUN}-${n++}@test.local`);
  const archive = await ctx.provisionArchive(owner, `Paragraph ${RUN} ${n}`);
  const note = async (title: string, body: string, type = 'person') => {
    const res = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
      title,
      type,
      body,
    });
    return ((await res.json()) as { id: string }).id;
  };
  const add = (
    noteId: string,
    text: string,
    over: Partial<Parameters<typeof appendParagraph>[1]> = {},
  ) => {
    const o = {
      archiveId: archive,
      noteId,
      userId: owner.userId,
      text,
      sources: [{ sentence: 0, interviewId: randomUUID() }],
      runId: randomUUID(),
      changeId: randomUUID(),
      ...over,
    };
    return inTransaction(ctx.deps, archive, async (client) => ({
      changeId: o.changeId,
      runId: o.runId,
      done: await appendParagraph(client, o),
    }));
  };
  /** a member of the project who is not its owner */
  const member = async () => {
    const m = await ctx.realSession(`notes-paragraph-${RUN}-${n++}@test.local`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'contributor')`,
      [archive, m.userId],
    );
    return m;
  };
  const read = async (noteId: string) =>
    (
      await ctx.pool.query(
        `select n.body, n.extra,
                (select count(*)::int from public.revisions r where r.note_id = n.id) as revisions
           from public.notes n where n.id = $1`,
        [noteId],
      )
    ).rows[0] as { body: string; extra: Record<string, unknown>; revisions: number };
  return { owner, archive, note, add, read, member };
}

const entitiesOf = async (archive: string, noteId: string) =>
  (
    await ctx.pool.query(
      `select id from public.graph_entities where archive_id = $1 and note_id = $2`,
      [archive, noteId],
    )
  ).rowCount;

describe('a note the import makes', () => {
  it('has no entity made for it when the import says it will tie it itself', async () => {
    const { owner, archive } = await setup();
    const { notes } = await createNotesBatch(
      ctx.deps,
      archive,
      owner.userId,
      [{ title: 'Busan (place)', type: 'place', body: '', entity: false }],
      'import',
    );
    expect(await entitiesOf(archive, notes[0]!.id)).toBe(0);
    const byName = await ctx.pool.query(
      `select 1 from public.graph_entities where archive_id = $1 and name like 'Busan%'`,
      [archive],
    );
    expect(byName.rowCount).toBe(0);
  });

  it('still gets its entity when the import does not say', async () => {
    const { owner, archive } = await setup();
    const { notes } = await createNotesBatch(
      ctx.deps,
      archive,
      owner.userId,
      [{ title: 'Busan', type: 'place', body: '' }],
      'import',
    );
    expect(await entitiesOf(archive, notes[0]!.id)).toBe(1);
  });
});

describe('a paragraph added to a note', () => {
  const PARAGRAPH = "_From “Noah's birthdays”:_ She made soup.";

  it('goes at the end of the body, and nothing before it changes', async () => {
    const { note, add, read } = await setup();
    const id = await note('Mina Kim', 'Noah’s mother.\n');
    expect((await add(id, PARAGRAPH)).done).toBe(true);
    expect((await read(id)).body).toBe(`Noah’s mother.\n\n${PARAGRAPH}`);
  });

  it('is the whole body of a note that has none yet', async () => {
    const { note, add, read } = await setup();
    const id = await note('Mina Kim', '');
    await add(id, PARAGRAPH);
    expect((await read(id)).body).toBe(PARAGRAPH);
  });

  it('is a new revision with the reason import and the change id given', async () => {
    const { note, add, read } = await setup();
    const id = await note('Mina Kim', 'Noah’s mother.');
    const before = (await read(id)).revisions;
    const { changeId } = await add(id, PARAGRAPH);
    expect((await read(id)).revisions).toBe(before + 1);
    const rev = (
      await ctx.pool.query(
        `select reason::text as reason, body from public.revisions
          where note_id = $1 order by seq desc limit 1`,
        [id],
      )
    ).rows[0] as { reason: string; body: string };
    expect(rev.reason).toBe('import');
    expect(rev.body).toBe(`Noah’s mother.\n\n${PARAGRAPH}`);
    const changes = await ctx.pool.query(
      `select 1 from public.revisions where note_id = $1 and change_id = $2`,
      [id, changeId],
    );
    expect(changes.rowCount).toBe(1);
  });

  it('records its sources with the run, after those of earlier runs, and keeps the rest of extra', async () => {
    const { note, add, read } = await setup();
    const id = await note('Mina Kim', 'Noah’s mother.');
    await ctx.pool.query(
      `update public.notes set extra = '{"sources":[{"sentence":0}]}'::jsonb where id = $1`,
      [id],
    );
    const first = await add(id, PARAGRAPH, { sources: [{ sentence: 1 }] });
    const second = await add(id, 'Another.', { sources: [{ sentence: 2 }] });
    expect((await read(id)).extra).toEqual({
      sources: [{ sentence: 0 }],
      paragraphs: [
        { runId: first.runId, sources: [{ sentence: 1 }] },
        { runId: second.runId, sources: [{ sentence: 2 }] },
      ],
    });
  });

  it('is the whole body of a note whose body is only blank space', async () => {
    const { note, add, read } = await setup();
    const id = await note('Mina Kim', 'Noah’s mother.');
    await ctx.pool.query(`update public.notes set body = $1 where id = $2`, ['  \n', id]);
    await add(id, PARAGRAPH);
    expect((await read(id)).body).toBe(PARAGRAPH);
  });

  it('is found by search: its words are in the note’s chunks', async () => {
    const { note, add } = await setup();
    const id = await note('Mina Kim', 'Noah’s mother.');
    await add(id, PARAGRAPH);
    const chunks = await ctx.pool.query(
      `select content from public.chunks where note_id = $1 order by chunk_index`,
      [id],
    );
    const text = chunks.rows.map((r: { content: string }) => r.content).join('\n');
    expect(text).toContain('She made soup.');
    expect(text).toContain('Noah’s mother.');
  });

  it('twice from one run and one change makes two revisions and two entries', async () => {
    const { owner, archive, note, read } = await setup();
    const id = await note('Mina Kim', 'Noah’s mother.');
    const before = (await read(id)).revisions;
    const runId = randomUUID();
    const changeId = randomUUID();
    const done = await inTransaction(ctx.deps, archive, async (client) => {
      const o = { archiveId: archive, noteId: id, userId: owner.userId, runId, changeId };
      return [
        await appendParagraph(client, { ...o, text: 'First.', sources: [{ sentence: 1 }] }),
        await appendParagraph(client, { ...o, text: 'Second.', sources: [{ sentence: 2 }] }),
      ];
    });
    expect(done).toEqual([true, true]);
    const after = await read(id);
    expect(after.body).toBe('Noah’s mother.\n\nFirst.\n\nSecond.');
    expect(after.revisions).toBe(before + 2);
    expect(after.extra.paragraphs).toEqual([
      { runId, sources: [{ sentence: 1 }] },
      { runId, sources: [{ sentence: 2 }] },
    ]);
    const shared = await ctx.pool.query(
      `select 1 from public.revisions where note_id = $1 and change_id = $2`,
      [id, changeId],
    );
    expect(shared.rowCount).toBe(2);
  });

  it('puts the links it has in the note’s links', async () => {
    const { note, add } = await setup();
    const minho = await note('Minho', 'Noah’s brother.');
    const id = await note('Mina Kim', 'Noah’s mother.');
    await add(id, "_From “Noah's birthdays”:_ She cooked for [[Minho]].");
    const links = await ctx.pool.query(
      `select target, resolved_id from public.links where source_id = $1`,
      [id],
    );
    expect(links.rows).toEqual([{ target: 'Minho', resolved_id: minho }]);
  });

  it('changes nothing, and says so, when it would make the note too long', async () => {
    const { note, add, read } = await setup();
    const id = await note('Mina Kim', 'Noah’s mother.');
    const body = 'x'.repeat(MAX_NOTE_CHARS - 5);
    await ctx.pool.query(`update public.notes set body = $1 where id = $2`, [body, id]);
    const before = await read(id);
    expect((await add(id, PARAGRAPH)).done).toBe(false);
    expect(await read(id)).toEqual(before);
    expect(before.body).toBe(body);
  });

  it('changes nothing for a paragraph with no words', async () => {
    const { note, add, read } = await setup();
    const id = await note('Mina Kim', 'Noah’s mother.');
    const before = await read(id);
    expect((await add(id, ' \n ')).done).toBe(false);
    expect((await add(id, '')).done).toBe(false);
    expect(await read(id)).toEqual(before);
  });

  it('is refused for a note that is not in the project, which stays as it was', async () => {
    const { note, add, read } = await setup();
    const other = await setup();
    const id = await note('Mina Kim', 'Noah’s mother.');
    const before = await read(id);
    expect((await other.add(id, PARAGRAPH)).done).toBe(false);
    expect((await add(randomUUID(), PARAGRAPH)).done).toBe(false);
    expect(await read(id)).toEqual(before);
  });

  it('is refused for a note private to another member, which stays as it was', async () => {
    const { archive, note, add, read, member } = await setup();
    const other = await member();
    const id = await note('Secret', 'Mine alone.');
    await ctx.pool.query(
      `insert into public.audiences (archive_id, note_id, kind) values ($1, $2, 'private-to-author')`,
      [archive, id],
    );
    const before = await read(id);
    expect((await add(id, PARAGRAPH, { userId: other.userId })).done).toBe(false);
    expect(await read(id)).toEqual(before);
    // its author still can
    expect((await add(id, PARAGRAPH)).done).toBe(true);
    expect((await read(id)).body).toBe(`Mine alone.\n\n${PARAGRAPH}`);
  });
});
