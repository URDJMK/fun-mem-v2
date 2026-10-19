import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-039 — revision provenance (FR-060/FR-061) + payload hygiene (hardening PRD v2, D4).
 *
 * `public.revisions` is the product's provenance substrate, and it could not say
 * WHY a row exists: `rewriteReferrers`' machine rewrite of a referring note and
 * an author editing their own words landed as identical attributed rows. Not
 * backfillable — `revisions_no_mutate` blocks UPDATE — so the columns had to
 * land before more history accrued.
 *
 * Real Postgres, real GoTrue ES256 sessions, real app.request.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

interface NoteResponse {
  id: string;
  title: string;
  body: string;
}

async function createNote(
  s: RealSession,
  archive: string,
  title: string,
  body: string,
): Promise<NoteResponse> {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body,
  });
  if (res.status !== 201) throw new Error(`create '${title}' failed: ${res.status}`);
  return (await res.json()) as NoteResponse;
}

/** Revision rows straight from the DB — the API is not the oracle for provenance. */
async function revisionsOf(noteId: string) {
  const r = await ctx.pool.query<{ reason: string; change_id: string | null; seq: string }>(
    `select reason, change_id, seq from public.revisions
      where note_id = $1 order by seq asc`,
    [noteId],
  );
  return r.rows;
}

describe('FM-039 revision provenance', () => {
  it('a rename cascade shares one change_id across every rewritten revision', async () => {
    const s = await ctx.realSession(`prov1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Prov1 ${RUN}`);

    const target = await createNote(s, archive, `Grandmother ${RUN}`, 'She kept bees.');
    // THREE referrers, so a per-row uuid cannot masquerade as a shared one
    const refs = [];
    for (const n of [1, 2, 3]) {
      refs.push(
        await createNote(s, archive, `Story ${n} ${RUN}`, `We visited [[Grandmother ${RUN}]].`),
      );
    }

    const renamed = await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${target.id}`, {
      title: `Halmoni ${RUN}`,
      body: target.body,
    });
    expect(renamed.status).toBe(200);

    // every referrer got a cascade revision, and it carries the SAME change_id
    // as the rename's own revision — not merely a non-null one
    const targetRevs = await revisionsOf(target.id);
    const renameChangeId = targetRevs[targetRevs.length - 1]!.change_id;
    expect(renameChangeId).toBeTruthy();

    const cascadeIds = new Set<string | null>([renameChangeId]);
    for (const r of refs) {
      const revs = await revisionsOf(r.id);
      expect(revs.length).toBe(2); // create + cascade
      cascadeIds.add(revs[1]!.change_id);
    }
    expect(cascadeIds.size).toBe(1);

    // UPPER half of the grouping guarantee: a DIFFERENT action must get a
    // DIFFERENT id. Without this, a per-archive constant satisfies the test
    // above while destroying the thing change_id exists to express.
    expect(targetRevs[0]!.change_id).not.toBe(renameChangeId);
    const refCreateIds = new Set<string | null>();
    for (const r of refs) refCreateIds.add((await revisionsOf(r.id))[0]!.change_id);
    expect(refCreateIds.has(renameChangeId)).toBe(false);
    expect(refCreateIds.size).toBe(refs.length); // three separate creates, three ids

    // S3: changeId must also be correct THROUGH THE API — this is the field
    // Phase-2 change-set undo reads, and it had no API-level assertion.
    const listed = await ctx.api(
      s.token,
      'GET',
      `/v1/archives/${archive}/notes/${refs[0]!.id}/revisions`,
    );
    const rows = (await listed.json()) as Array<{ changeId: string; reason: string }>;
    expect(rows[0]!.changeId).toBe(renameChangeId); // newest first = the cascade
    expect(rows[0]!.reason).toBe('rename-cascade');
  });

  it('each write path records its own revision reason', async () => {
    const s = await ctx.realSession(`prov2-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Prov2 ${RUN}`);

    const target = await createNote(s, archive, `Beekeeper ${RUN}`, 'Original body.');
    const referrer = await createNote(s, archive, `Ref ${RUN}`, `See [[Beekeeper ${RUN}]].`);

    // edit
    await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${target.id}`, {
      title: `Beekeeper ${RUN}`,
      body: 'Edited body.',
    });
    // rename -> cascade on the referrer
    await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${target.id}`, {
      title: `Apiarist ${RUN}`,
      body: 'Edited body.',
    });
    // restore
    const revs = await ctx.api(
      s.token,
      'GET',
      `/v1/archives/${archive}/notes/${target.id}/revisions`,
    );
    const list = (await revs.json()) as Array<{ id: string }>;
    const restored = await ctx.api(
      s.token,
      'POST',
      `/v1/archives/${archive}/notes/${target.id}/restore`,
      { revisionId: list[list.length - 1]!.id },
    );
    expect(restored.status).toBe(200);

    const targetRows = await revisionsOf(target.id);
    const targetReasons = targetRows.map((r) => r.reason);
    expect(targetReasons[0]).toBe('create');
    expect(targetReasons[1]).toBe('edit');
    // index 2 is the RENAME's own revision. A person renaming their own note is
    // an edit; labelling it 'rename-cascade' would mislabel them as a machine —
    // the exact confusion this column exists to prevent, in the other direction.
    expect(targetReasons[2]).toBe('edit');
    expect(targetReasons[3]).toBe('restore');

    const referrerRows = await revisionsOf(referrer.id);
    const referrerReasons = referrerRows.map((r) => r.reason);
    expect(referrerReasons[0]).toBe('create');
    // the confusion the column exists to prevent: a machine rewrite of someone
    // else's note must NOT read as that person editing their own words
    expect(referrerReasons[1]).toBe('rename-cascade');
    // the FIFTH provenance path: restore re-triggers the cascade. It was
    // executed but unasserted — so deleting the whole block left the suite green.
    expect(referrerReasons[2]).toBe('rename-cascade');
    expect(referrerRows[2]!.change_id).toBe(targetRows[3]!.change_id);
    expect(referrerRows[2]!.change_id).not.toBe(referrerRows[1]!.change_id);
  });
});

describe('FM-039 payload hygiene', () => {
  it('listing revisions never returns a body', async () => {
    const s = await ctx.realSession(`prov3-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Prov3 ${RUN}`);
    const MARKER = `BODYZZ${RUN}`; // exists nowhere else in the DB

    const note = await createNote(s, archive, `Long note ${RUN}`, `first ${MARKER}`);
    await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${note.id}`, {
      title: `Long note ${RUN}`,
      body: `second ${MARKER}`,
    });

    const res = await ctx.api(s.token, 'GET', `/v1/archives/${archive}/notes/${note.id}/revisions`);
    expect(res.status).toBe(200);
    // assert against the RAW serialized response: renaming the JSON field would
    // not hide the payload, and a key-absence check would miss that
    const raw = await res.text();
    expect(raw).not.toContain(MARKER);
    expect(JSON.parse(raw)).toHaveLength(2);
  });

  it('a single revision body is unreachable by a co-member on a private note', async () => {
    const author = await ctx.realSession(`prov4a-${RUN}@test.local`);
    const other = await ctx.realSession(`prov4b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(author, `Prov4 ${RUN}`);
    const MARKER = `SECRETZZ${RUN}`;

    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role)
       values ($1, $2, 'contributor') on conflict do nothing`,
      [archive, other.userId],
    );

    const note = await createNote(author, archive, `Private ${RUN}`, `hidden ${MARKER}`);
    await ctx.pool.query(
      `insert into public.audiences (archive_id, note_id, kind)
       values ($1, $2, 'private-to-author')
       on conflict (note_id) do update set kind = excluded.kind`,
      [archive, note.id],
    );

    const rev = await ctx.pool.query<{ id: string }>(
      `select id from public.revisions where note_id = $1 order by seq desc limit 1`,
      [note.id],
    );
    const revisionId = rev.rows[0]!.id;
    const path = `/v1/archives/${archive}/notes/${note.id}/revisions/${revisionId}`;

    // positive control: the author CAN read it, so a 404 below cannot be caused
    // by the endpoint simply not existing
    const mine = await ctx.api(author.token, 'GET', path);
    expect(mine.status).toBe(200);
    expect(await mine.text()).toContain(MARKER);

    const theirs = await ctx.api(other.token, 'GET', path);
    expect(theirs.status).toBe(404); // 404, never 403 — a 403 confirms existence
    expect(await theirs.text()).not.toContain(MARKER);
  });
});
