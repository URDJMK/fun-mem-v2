import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext } from './helpers';

/**
 * What a note write accepts. Round-3 review D7 (no size cap: one PUT of 20,000 links held the
 * archive's write lock for 73 s) and D10 (malformed requests answered 500, `occurred: 5` was
 * stored, a NUL typed into a note failed the save).
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(async () => {
  await ctx.close();
});

async function setup(label: string) {
  const owner = await ctx.realSession(`ni-${label}-${RUN}@test.local`);
  const archive = await ctx.provisionArchive(owner, `NI ${label} ${RUN}`);
  const call = (method: string, path: string, body?: unknown) =>
    ctx.api(owner.token, method, `/v1/archives/${archive}${path}`, body);
  const raw = (method: string, path: string, text: string) =>
    ctx.app.request(`/v1/archives/${archive}${path}`, {
      method,
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: text,
    });
  const made = (await (
    await call('POST', '/notes', { title: `Kitchen ${RUN}`, type: 'place', body: 'Sundays.' })
  ).json()) as { id: string };
  const bodyOf = async () =>
    (await ctx.pool.query(`select body, occurred from public.notes where id = $1`, [made.id]))
      .rows[0] as { body: string; occurred: string | null };
  return { archive, call, raw, note: made.id, bodyOf, owner };
}

describe('D7 a note has a size: at most 200,000 characters and 1,000 links', () => {
  it('a note over either cap is refused before it waits for the archive, and nothing is written', async () => {
    const { call, note, bodyOf } = await setup('caps');
    const links = Array.from({ length: 1001 }, (_, i) => `[[t${i}]]`).join(' ');
    const many = await call('PUT', `/notes/${note}`, { body: links });
    expect(many.status).toBe(400);
    expect(await many.json()).toMatchObject({ code: 'too_many_links' });
    const long = await call('POST', '/notes', {
      title: `Long ${RUN}`,
      type: 'event',
      body: 'x'.repeat(200_001),
    });
    expect(long.status).toBe(413);
    expect(await long.json()).toMatchObject({ code: 'too_long' });
    expect((await bodyOf()).body).toBe('Sundays.');
  });

  it('a request larger than the route takes is refused as too large', async () => {
    const { raw, note } = await setup('request');
    const r = await raw(
      'PUT',
      `/notes/${note}`,
      JSON.stringify({ body: 'y'.repeat(3 * 1024 * 1024) }),
    );
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ code: 'too_large' });
  });

  it('a note of 1,000 links saves in seconds, and another member is not held behind it', async () => {
    const { archive, call, note } = await setup('fast');
    const other = (await (
      await call('POST', '/notes', { title: `Other ${RUN}`, type: 'event', body: 'before' })
    ).json()) as { id: string };
    const links = Array.from({ length: 1000 }, (_, i) => `[[target ${i}]]`).join(' ');
    const t0 = Date.now();
    const big = call('PUT', `/notes/${note}`, { body: `My own words.\n\n${links}` });
    await new Promise((r) => setTimeout(r, 50));
    const small = await call('PUT', `/notes/${other.id}`, { body: 'after' });
    const smallMs = Date.now() - t0;
    expect((await big).status).toBe(200);
    const bigMs = Date.now() - t0;
    expect(small.status).toBe(200);
    expect(bigMs).toBeLessThan(5000);
    expect(smallMs).toBeLessThan(5000);
    const n = await ctx.pool.query(
      `select count(*)::int as n from public.links where source_id = $1`,
      [note],
    );
    expect(n.rows[0]).toEqual({ n: 1000 });
    void archive;
  });
});

describe('D10 a malformed note request is a 400 with a code, never a 500', () => {
  it('a title or body that is not text, or a request that is not an object, is refused', async () => {
    const { call, raw, note } = await setup('shape');
    for (const body of [
      { title: 123, type: 'event', body: 'x' },
      { title: {}, type: 'event', body: 'x' },
      { title: 'Fine title', type: 'event', body: 42 },
    ]) {
      const r = await call('POST', '/notes', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json()).toMatchObject({ code: 'bad_request' });
    }
    expect((await call('PUT', `/notes/${note}`, { title: 7 })).status).toBe(400);
    for (const text of ['null', '[]', '"a string"', '{"title": "unfinished']) {
      const r = await raw('POST', '/notes', text);
      expect(r.status, text).toBe(400);
      expect(await r.json()).toMatchObject({ code: 'bad_request' });
    }
    // an edit that is not JSON is refused, not answered 200 as if nothing had changed
    const broken = await raw('PUT', `/notes/${note}`, '{"body": "half an edi');
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ code: 'bad_request' });
  });

  it('a NUL or another control character typed into a note is taken out, and the note saves', async () => {
    const { call, note, bodyOf } = await setup('controls');
    const put = await call('PUT', `/notes/${note}`, {
      body: 'She said\u0000 hello\u0007 to me.\tThen left.',
    });
    expect(put.status).toBe(200);
    expect((await bodyOf()).body).toBe('She said hello to me.\tThen left.');
    const post = await call('POST', '/notes', {
      title: `Controls\u0001 ${RUN}`,
      type: 'event',
      body: 'a\u0000b',
    });
    expect(post.status).toBe(201);
  });

  it('a date must look like a date, or be empty', async () => {
    const { call, note, bodyOf } = await setup('dates');
    for (const occurred of [5, {}, 'sometime', true]) {
      const r = await call('PUT', `/notes/${note}`, { occurred });
      expect(r.status, JSON.stringify(occurred)).toBe(400);
      expect(await r.json()).toMatchObject({ code: 'date' });
    }
    expect((await call('PUT', `/notes/${note}`, { occurred: '1987-03' })).status).toBe(200);
    expect((await bodyOf()).occurred).toBe('1987-03');
    expect((await call('PUT', `/notes/${note}`, { occurred: null })).status).toBe(200);
    expect((await bodyOf()).occurred).toBeNull();
    // a date stored before this rule may be sent back as it is: the note can still be saved
    await ctx.pool.query(`update public.notes set occurred = '1963~' where id = $1`, [note]);
    const same = await call('PUT', `/notes/${note}`, {
      occurred: '1963~',
      body: 'Sundays, still.',
    });
    expect(same.status).toBe(200);
    expect(await bodyOf()).toEqual({ body: 'Sundays, still.', occurred: '1963~' });
    expect((await call('PUT', `/notes/${note}`, { occurred: '1964~' })).status).toBe(400);
  });
});
