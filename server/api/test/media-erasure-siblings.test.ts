import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-066 — erasure counts siblings before removing bytes.
 *
 * FM-069 dropped `unique(archive_id, content_hash)` and FM-065 made duplicate
 * rows ORDINARY: two memories may each hold the same photograph. Without a
 * sibling count, deleting one row destroys a photograph the other memory still
 * shows — silently, and with no recovery.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function makeNote(s: RealSession, archive: string, title: string) {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body: '',
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function upload(s: RealSession, archive: string, bytes: Buffer, note?: string) {
  const q = note ? `?note=${note}` : '';
  const r = await ctx.app.request(`/v1/archives/${archive}/media${q}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'image/png' },
    body: new Uint8Array(bytes),
  });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

const del = async (s: RealSession, archive: string, id: string) => {
  const r = await ctx.app.request(`/v1/archives/${archive}/media/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${s.token}` },
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

const readByHash = (s: RealSession, archive: string, hash: string) =>
  ctx.app.request(`/v1/archives/${archive}/media/by-hash/${hash}`, {
    headers: { authorization: `Bearer ${s.token}` },
  });

describe('FM-066 erasure counts siblings', () => {
  it("deleting one memory does not destroy another memory's identical photograph", async () => {
    /**
     * THE LIVE GAP THIS UNIT CLOSES. Both members legitimately hold the same
     * photograph in their own memories — FM-065 makes that ordinary. When one
     * deletes theirs, the other's must still be there.
     */
    const owner = await ctx.realSession(`s1a-${RUN}@test.local`);
    const member = await ctx.realSession(`s1b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `S1 ${RUN}`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role)
       values ($1, $2, 'contributor') on conflict do nothing`,
      [archive, member.userId],
    );

    const bytes = Buffer.from(`ZZSIB${RUN}\n`, 'utf8');
    const noteA = await makeNote(owner, archive, `주인의 기억 ${RUN}`);
    const noteB = await makeNote(member, archive, `손님의 기억 ${RUN}`);
    const a = await upload(owner, archive, bytes, noteA);
    const b = await upload(member, archive, bytes, noteB);
    expect(a.body.id).not.toBe(b.body.id);

    const d = await del(owner, archive, a.body.id!);
    expect(d.status).toBe(200);

    // the OTHER member's photograph must still be readable — bytes and all
    const still = await readByHash(member, archive, b.body.contentHash!);
    expect(still.status, "deleting one row destroyed the other memory's photograph").toBe(200);
    expect(await still.text(), 'the row survived but its bytes were removed').toContain(
      `ZZSIB${RUN}`,
    );
  });

  it('the last reference takes the bytes with it', async () => {
    /**
     * The negative control. Without this, an implementation that NEVER removes
     * bytes passes the test above trivially, and FR-143 erasure becomes a soft
     * delete that leaves the photograph in Storage forever.
     */
    const owner = await ctx.realSession(`s2-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `S2 ${RUN}`);
    const bytes = Buffer.from(`ZZLAST${RUN}\n`, 'utf8');
    const note = await makeNote(owner, archive, `유일한 기억 ${RUN}`);
    const up = await upload(owner, archive, bytes, note);

    expect((await readByHash(owner, archive, up.body.contentHash!)).status).toBe(200);
    const d = await del(owner, archive, up.body.id!);
    expect(d.status).toBe(200);

    /**
     * ASSERTED AGAINST STORAGE, NOT AGAINST THE API.
     *
     * The first version re-uploaded the same bytes and expected a fresh 201.
     * That proves nothing: the media ROW is deleted either way, so a re-upload
     * inserts a new one whether or not the object survived. Verified by
     * mutation -- `lastReference = false` (never remove bytes) PASSED it. The
     * only way to know the bytes are gone is to look at the bucket.
     */
    const key = `${archive}/${up.body.contentHash}/original`;
    const { data } = await ctx.admin.storage
      .from('media')
      .list(`${archive}/${up.body.contentHash}`);
    expect(
      (data ?? []).map((o) => o.name),
      `the object survived the last reference (${key})`,
    ).not.toContain('original');
  });

  it('a delete answers the same whether or not the bytes survive', async () => {
    /**
     * A caller who possesses bytes must not learn from a delete whether another
     * member also holds them. Same family as the R3 dedup oracle.
     */
    const owner = await ctx.realSession(`s3a-${RUN}@test.local`);
    const member = await ctx.realSession(`s3b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `S3 ${RUN}`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role)
       values ($1, $2, 'contributor') on conflict do nothing`,
      [archive, member.userId],
    );

    const bytes = Buffer.from(`ZZSHAPE${RUN}\n`, 'utf8');
    const nA = await makeNote(owner, archive, `모양 A ${RUN}`);
    const nB = await makeNote(member, archive, `모양 B ${RUN}`);
    const a = await upload(owner, archive, bytes, nA);
    const b = await upload(member, archive, bytes, nB);

    const withSibling = await del(owner, archive, a.body.id!); // bytes survive
    const lastRef = await del(member, archive, b.body.id!); // bytes go

    expect(withSibling.status).toBe(200);
    expect(lastRef.status).toBe(200);
    expect(
      Object.keys(withSibling.body).sort(),
      'the two delete branches answer with different shapes',
    ).toEqual(Object.keys(lastRef.body).sort());
    expect(withSibling.body).not.toHaveProperty('bytesRetained');
  });
});
