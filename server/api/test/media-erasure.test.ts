import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';
import { MEDIA_BUCKET, listAllUnderPrefix, residueOf, mediaPrefix } from '../src/media';

/**
 * FM-040 — erasure completeness on the media delete path (FR-143, FR-004).
 *
 * The PRD proposed "list the prefix and remove it" at size S. The pre-task sweep
 * proved that does not work: `.list()` is a one-level directory listing, `derived`
 * comes back as an `id:null` placeholder, `remove()` silently no-ops on it and
 * reports `error:null` — so the obvious implementation reproduces the exact
 * FR-143 violation this task exists to close, and reports success doing it.
 *
 * Real Supabase Storage, real Postgres, real sessions.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
const B = () => ctx.admin.storage.from(MEDIA_BUCKET);

afterAll(async () => {
  await ctx.close();
});

async function upload(s: RealSession, archive: string, body: string) {
  // raw bytes, not JSON — ctx.api serializes, so this goes straight to app.request
  const res = await ctx.app.request(`/v1/archives/${archive}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/octet-stream' },
    body,
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`upload failed: ${res.status}`);
  return (await res.json()) as { id: string; contentHash: string };
}

async function del(s: RealSession, archive: string, mediaId: string) {
  return ctx.api(s.token, 'DELETE', `/v1/archives/${archive}/media/${mediaId}`);
}

describe('FM-040 media erasure completeness', () => {
  it('a derived object two levels under a media prefix is erased with its source', async () => {
    const s = await ctx.realSession(`fm040a-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Media A ${RUN}`);

    const bytes = `fm040 payload ${RUN}`;
    const media = await upload(s, archive, bytes);
    const prefix = mediaPrefix(archive, media.contentHash);

    // Phase-2 shaped derivatives: one at depth 1, one at depth 2. A hand-rolled
    // recursion that descends a single level leaves the second behind.
    await B().upload(`${prefix}derived/thumb.webp`, new Blob([new Uint8Array([9, 9])]), {
      contentType: 'image/webp',
    });
    await B().upload(
      `${prefix}derived/whisperx/transcript.json`,
      new Blob([new TextEncoder().encode('{"t":"x"}')]),
      { contentType: 'application/json' },
    );

    const before = await listAllUnderPrefix(ctx.admin, MEDIA_BUCKET, prefix);
    expect(before.length).toBe(3); // the fixture's own precondition

    const res = await del(s, archive, media.id);
    expect(res.status).toBe(200);

    // assert the PREFIX IS EMPTY, not that two named paths 404 — residue at any
    // other depth must fail this too
    const after = await listAllUnderPrefix(ctx.admin, MEDIA_BUCKET, prefix);
    expect(after).toEqual([]);
  });

  it('a media row stored under the pre-FM-040 flat key is still erased', async () => {
    const s = await ctx.realSession(`fm040b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Media B ${RUN}`);

    // the exact pre-cutover shape: all 152 objects on the stack look like this
    const hash = `deadbeef${RUN}${'0'.repeat(48 - 8 - RUN.length)}`;
    const flatKey = `${archive}/${hash}`;
    await B().upload(flatKey, new Blob([new Uint8Array([4, 2])]), {
      contentType: 'application/octet-stream',
    });
    const row = await ctx.pool.query<{ id: string }>(
      `insert into public.media (archive_id, content_hash, mime, bytes, created_by)
       values ($1, $2, 'application/octet-stream', 2, $3) returning id`,
      [archive, hash, s.userId],
    );
    const mediaId = row.rows[0]!.id;

    // MIXED row: also a new-shape derivative, so the prefix listing is NON-empty.
    // A fallback gated on `leaves.length === 0` leaves the flat original behind.
    await B().upload(
      `${mediaPrefix(archive, hash)}derived/thumb.webp`,
      new Blob([new Uint8Array([7])]),
      {
        contentType: 'image/webp',
      },
    );

    const res = await del(s, archive, mediaId);
    expect(res.status).toBe(200);

    const dl = await B().download(flatKey);
    expect(dl.error, 'the legacy flat original must be gone').toBeTruthy();
    expect(await listAllUnderPrefix(ctx.admin, MEDIA_BUCKET, mediaPrefix(archive, hash))).toEqual(
      [],
    );
  });

  it('residue is reported per key, not inferred from a null error', () => {
    // pure unit over the exported helper: remove() cannot distinguish "missing"
    // from "removed", so `error == null` is not evidence of erasure
    expect(residueOf(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
    expect(residueOf(['a'], ['a'])).toEqual([]);
    expect(residueOf(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});
