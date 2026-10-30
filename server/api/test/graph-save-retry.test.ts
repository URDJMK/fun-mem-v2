import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { persistImport } from '../src/ingest-save';
import type { IngestResult } from '../src/ingest';
import { notePlan, saveGraph } from '../src/graph/save';
import type { GraphProposal } from '../src/graph/types';
import { inTransaction } from '../src/notes';
import * as notesModule from '../src/notes';
import { testContext } from './helpers';

const ctx = testContext();
afterAll(() => ctx.close());

async function project() {
  const owner = await ctx.realSession(`graph-retry-${randomUUID()}@test.local`);
  const archive = await ctx.provisionArchive(owner, 'Retry regression');
  const note = async (title: string, type = 'event') => {
    const res = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
      title,
      type,
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const graph: GraphProposal = {
    entities: [
      {
        ref: 'e1',
        name: 'Busan',
        type: 'place',
        match: { kind: 'new' },
        note: { kind: 'new' },
        mentions: [],
      },
    ],
    relationships: [],
  };
  const result = {
    sourceHash: randomUUID(),
    interviewName: 'A visit',
    memories: [
      {
        id: 'm1',
        title: 'The harbour',
        type: 'event',
        method: 'story',
        body: 'We visited [[Busan]].\n\n> ⚠ May disagree with [[Busan]] · an earlier account',
        occurred: null,
        tellers: [],
        sources: [],
      },
    ],
    graph,
  } as unknown as IngestResult;
  return { owner, archive, note, graph, result };
}

describe('saving entity notes after a stale plan or a rolled-back transaction', () => {
  it('retries the whole save, replans titles, and preserves a marker while relinking prose', async () => {
    const { owner, archive, note, result } = await project();
    await note('Busan');
    const batch = notesModule.createNotesBatch;
    let replanned = false;
    const spy = vi
      .spyOn(notesModule, 'createNotesBatch')
      .mockImplementationOnce(async (deps, archiveId, userId, inputs, reason, hooks) => {
        try {
          return await batch(deps, archiveId, userId, inputs, reason, {
            ...hooks,
            after: async (...args) => {
              await hooks?.after?.(...args);
              throw Object.assign(new Error('title changed during save'), {
                code: '23505',
                constraint: 'notes_archive_title_ci',
              });
            },
          });
        } catch (error) {
          await note('Busan (place)');
          replanned = true;
          throw error;
        }
      });
    try {
      const out = await persistImport(ctx.deps, archive, owner.userId, result);
      expect(replanned).toBe(true);
      expect(out.saved).toHaveLength(1);
      const notes = await ctx.pool.query(
        `select title, body from public.notes where archive_id = $1 and title like 'Busan%' order by title`,
        [archive],
      );
      expect(notes.rows.map((r: { title: string }) => r.title)).toEqual([
        'Busan',
        'Busan (2)',
        'Busan (place)',
      ]);
      const saved = await ctx.pool.query(`select body from public.notes where id = $1`, [
        out.saved[0]!.id,
      ]);
      expect(saved.rows[0].body).toBe(
        'We visited [[Busan (2)|Busan]].\n\n> ⚠ May disagree with [[Busan]] · an earlier account',
      );
      const links = await ctx.pool.query(
        `select n.title from public.links l join public.notes n on n.id = l.resolved_id where l.source_id = $1 order by n.title`,
        [out.saved[0]!.id],
      );
      expect(links.rows).toEqual([{ title: 'Busan' }, { title: 'Busan (2)' }]);
    } finally {
      spy.mockRestore();
    }
  });

  it('two refs for an existing entity without a note attach the same new note once', async () => {
    const { owner, archive, graph, result } = await project();
    const entity = await ctx.pool.query(
      `insert into public.graph_entities (archive_id, type, name, match_key, created_by) values ($1, 'place', 'Busan', 'busan', $2) returning id`,
      [archive, owner.userId],
    );
    graph.entities.push({ ...graph.entities[0]!, ref: 'e2' });
    const out = await persistImport(ctx.deps, archive, owner.userId, result);
    expect(out.saved).toHaveLength(1);
    const attached = await ctx.pool.query(
      `select n.title from public.graph_entities e join public.notes n on n.id = e.note_id where e.id = $1`,
      [entity.rows[0].id],
    );
    expect(attached.rows).toEqual([{ title: 'Busan' }]);
  });

  it('refuses an insert conflict that would leave the newly created note unattached', async () => {
    const { owner, archive, graph } = await project();
    await expect(
      inTransaction(ctx.deps, archive, async (client, changeId) => {
        const plan = await notePlan(client, archive, owner.userId, graph);
        // A writer that skips the archive lock can attach a note after planning.
        const existing = await client.query(
          `insert into public.notes (archive_id, type, title, body, created_by) values ($1, 'place', 'Busan', '', $2) returning id`,
          [archive, owner.userId],
        );
        await client.query(
          `insert into public.graph_entities (archive_id, type, name, match_key, note_id, created_by) values ($1, 'place', 'Busan', 'busan', $2, $3)`,
          [archive, existing.rows[0].id, owner.userId],
        );
        const made = await client.query(
          `insert into public.notes (archive_id, type, title, body, created_by) values ($1, 'place', 'Other Busan', '', $2) returning id`,
          [archive, owner.userId],
        );
        const run = await client.query(
          `insert into public.ingest_runs (archive_id, created_by, change_id, note_count, active) values ($1, $2, $3, 0, false) returning id`,
          [archive, owner.userId, changeId],
        );
        await saveGraph(client, {
          archiveId: archive,
          userId: owner.userId,
          runId: run.rows[0].id,
          proposal: graph,
          storyNote: new Map(),
          interviewId: null,
          notes: {
            plan,
            made: new Map([['e1', made.rows[0].id]]),
            interviewName: 'A visit',
            changeId,
          },
        });
      }),
    ).rejects.toThrow('already has a note');
    const orphan = await ctx.pool.query(
      `select id from public.notes where archive_id = $1 and title = 'Other Busan'`,
      [archive],
    );
    expect(orphan.rows).toEqual([]);
  });
});
