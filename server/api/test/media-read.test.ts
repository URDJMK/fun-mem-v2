import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-055 — media was write-only: POST and DELETE existed, nothing could read a
 * blob back. An uploaded original was unreachable by anyone, which blocks §17
 * acceptance criterion 2 outright.
 *
 * The route PROXIES the bytes rather than handing out a signed URL: FR-081 wants
 * the access check before retrieval, and a signed URL is retrieval without one.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function upload(
  s: RealSession,
  archive: string,
  bytes: Buffer,
  mime: string,
): Promise<{ id: string; contentHash: string }> {
  const r = await ctx.app.request(`/v1/archives/${archive}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': mime },
    body: new Uint8Array(bytes),
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`upload: ${r.status}`);
  return (await r.json()) as { id: string; contentHash: string };
}

const read = (s: RealSession, archive: string, mediaId: string) =>
  ctx.app.request(`/v1/archives/${archive}/media/${mediaId}`, {
    headers: { authorization: `Bearer ${s.token}` },
  });

describe('FM-055 media read path', () => {
  it('a member can read an uploaded original back', async () => {
    const s = await ctx.realSession(`md1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `MD1 ${RUN}`);
    const bytes = Buffer.from(`an original ${RUN}\n`, 'utf8');
    const up = await upload(s, archive, bytes, 'image/png');

    const res = await read(s, archive, up.id);
    expect(res.status, 'the original is unreadable').toBe(200);
    // the BYTES, not metadata about them
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(bytes), 'the response body is not the original bytes').toBe(true);
    expect(createHash('sha256').update(got).digest('hex')).toBe(up.contentHash);
    // the stored mime is what makes a browser render it rather than download it
    expect(res.headers.get('content-type'), 'the stored mime was dropped').toContain('image/png');
  });

  it('a non-member gets a uniform 404 and no bytes', async () => {
    const owner = await ctx.realSession(`md2a-${RUN}@test.local`);
    const stranger = await ctx.realSession(`md2b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `MD2 ${RUN}`);
    const secret = Buffer.from(`ZZSECRET${RUN} private original\n`, 'utf8');
    const up = await upload(owner, archive, secret, 'text/plain');

    // POSITIVE CONTROL FIRST. With no route at all every request 404s, so a
    // bare "stranger gets 404" assertion is satisfied by the very bug this
    // task fixes. Prove the object is readable by someone before proving it is
    // not readable by this someone.
    const byOwner = await read(owner, archive, up.id);
    expect(byOwner.status, 'the owner cannot read it either — no route exists').toBe(200);

    const res = await read(stranger, archive, up.id);
    // 404, never 403 — a 403 confirms the object exists
    expect(res.status, 'a stranger could read another archive original').toBe(404);
    const body = await res.text();
    expect(body, 'bytes leaked to a non-member').not.toContain(`ZZSECRET${RUN}`);
    // and nothing about where it lives
    expect(body).not.toContain(up.contentHash);
    expect(body.toLowerCase()).not.toMatch(/storage|supabase|signed|token/);
  });

  it('a media id from another archive is not readable through this archive', async () => {
    const s = await ctx.realSession(`md3-${RUN}@test.local`);
    const a = await ctx.provisionArchive(s, `MD3a ${RUN}`);
    const b = await ctx.provisionArchive(s, `MD3b ${RUN}`);
    const up = await upload(s, a, Buffer.from(`in archive a ${RUN}\n`), 'text/plain');

    // positive control, same reason as above
    expect((await read(s, a, up.id)).status, 'no route exists to test scoping against').toBe(200);

    // the SAME member, but the id belongs to a different archive: looking the
    // row up by id alone would make this a cross-archive existence oracle
    const res = await read(s, b, up.id);
    expect(res.status, 'a media id was readable through the wrong archive').toBe(404);

    // and an id that exists nowhere answers identically
    const missing = await read(s, b, randomUUID());
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(await res.text());
  });
});
