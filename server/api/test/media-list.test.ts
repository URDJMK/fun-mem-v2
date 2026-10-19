import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-070 — the LIST route, and the reason it exists.
 *
 * Media was enumerable only at the instant of upload: `POST` handed back one id
 * and nothing could ever ask "what photographs does this memory hold". So a
 * photograph was invisible on the next visit unless its 64-character content
 * hash had been typed into a body by hand. That, not the storage backend, is
 * why photographs did not appear in the app.
 *
 * Every test here carries a POSITIVE CONTROL before its negative assertion.
 * With a broken route every request 404s and every list is empty, so a bare
 * "the stranger sees nothing" would pass against the very bug being fixed.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function makeNote(s: RealSession, archive: string, title: string): Promise<string> {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body: '',
  });
  if (res.status !== 201) throw new Error(`create note: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function upload(
  s: RealSession,
  archive: string,
  marker: string,
  noteId?: string,
  filename?: string,
): Promise<{ id: string; contentHash: string }> {
  const q = noteId ? `?note=${noteId}` : '';
  const res = await ctx.app.request(`/v1/archives/${archive}/media${q}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${s.token}`,
      'content-type': 'image/png',
      ...(filename ? { 'x-filename': encodeURIComponent(filename) } : {}),
    },
    // marker keeps the bytes distinct, so dedup never silently merges fixtures
    body: new Uint8Array(Buffer.from(`png-${marker}\n`, 'utf8')),
  });
  if (res.status !== 201) throw new Error(`upload: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; contentHash: string };
}

interface ListPage {
  items: Array<{ id: string; noteId: string; filename: string | null; contentHash: string }>;
  nextCursor: string | null;
}

async function list(s: RealSession, archive: string, query = ''): Promise<Response> {
  return ctx.app.request(`/v1/archives/${archive}/media${query}`, {
    headers: { authorization: `Bearer ${s.token}` },
  });
}

async function restrict(archive: string, noteId: string) {
  await ctx.pool.query(
    `insert into public.audiences (archive_id, note_id, kind)
     values ($1, $2, 'private-to-author')
     on conflict (note_id) do update set kind = excluded.kind`,
    [archive, noteId],
  );
}

async function addMember(archive: string, userId: string) {
  await ctx.pool.query(
    `insert into public.memberships (archive_id, user_id, role)
     values ($1, $2, 'contributor') on conflict do nothing`,
    [archive, userId],
  );
}

describe('FM-070 media list', () => {
  it('lists what a memory holds, and scopes to the memory asked for', async () => {
    const s = await ctx.realSession(`ml1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `ML1 ${RUN}`);
    const a = await makeNote(s, archive, `봄 ${RUN}`);
    const b = await makeNote(s, archive, `가을 ${RUN}`);

    const onA1 = await upload(s, archive, `a1-${RUN}`, a, '봄 사진.png');
    const onA2 = await upload(s, archive, `a2-${RUN}`, a);
    const onB = await upload(s, archive, `b1-${RUN}`, b);

    const scoped = (await (await list(s, archive, `?note=${a}`)).json()) as ListPage;
    expect(
      scoped.items.map((i) => i.id).sort(),
      'the memory did not list exactly its own photographs',
    ).toEqual([onA1.id, onA2.id].sort());
    // the SCOPE is the assertion: the other memory's photograph must not appear
    expect(
      scoped.items.some((i) => i.id === onB.id),
      'the scope leaks another memory',
    ).toBe(false);
    expect(scoped.items.every((i) => i.noteId === a)).toBe(true);

    // the filename survives the round trip, percent-decoded and in Korean
    expect(scoped.items.find((i) => i.id === onA1.id)?.filename).toBe('봄 사진.png');
    // and an upload that sent no name says so rather than inventing one
    expect(scoped.items.find((i) => i.id === onA2.id)?.filename).toBeNull();

    // unscoped enumerates the whole archive
    const all = (await (await list(s, archive)).json()) as ListPage;
    expect(all.items.map((i) => i.id).sort(), 'the archive listing is not the union').toEqual(
      [onA1.id, onA2.id, onB.id].sort(),
    );
  });

  it('a memory the caller may not see answers 404, never an empty list', async () => {
    const owner = await ctx.realSession(`ml2a-${RUN}@test.local`);
    const other = await ctx.realSession(`ml2b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ML2 ${RUN}`);
    await addMember(archive, other.userId);

    const secret = await makeNote(owner, archive, `비밀 ${RUN}`);
    const up = await upload(owner, archive, `s-${RUN}`, secret);
    await restrict(archive, secret);

    // POSITIVE CONTROL: the route works, and the owner can see the row
    const byOwner = (await (await list(owner, archive, `?note=${secret}`)).json()) as ListPage;
    expect(
      byOwner.items.map((i) => i.id),
      'the owner cannot list their own photograph',
    ).toEqual([up.id]);

    // An empty 200 would ITSELF be the disclosure: it distinguishes "this
    // memory exists and holds nothing" from "this memory is not yours".
    const denied = await list(other, archive, `?note=${secret}`);
    expect(denied.status, 'a private memory answered something other than 404').toBe(404);

    // and it does not leak through the unscoped listing either
    const unscoped = (await (await list(other, archive)).json()) as ListPage;
    expect(
      unscoped.items.some((i) => i.id === up.id),
      'the archive listing leaks a private memory’s photograph',
    ).toBe(false);
  });

  it('pages by keyset, and a malformed cursor is refused rather than restarted', async () => {
    const s = await ctx.realSession(`ml3-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `ML3 ${RUN}`);
    const note = await makeNote(s, archive, `묶음 ${RUN}`);

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await upload(s, archive, `p${i}-${RUN}`, note)).id);

    const first = (await (await list(s, archive, `?note=${note}&limit=2`)).json()) as ListPage;
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor, 'a full page did not offer a cursor').not.toBeNull();

    const second = (await (
      await list(s, archive, `?note=${note}&limit=2&cursor=${first.nextCursor!}`)
    ).json()) as ListPage;
    const third = (await (
      await list(s, archive, `?note=${note}&limit=2&cursor=${second.nextCursor!}`)
    ).json()) as ListPage;

    const walked = [...first.items, ...second.items, ...third.items].map((i) => i.id);
    // NO OVERLAP AND NO SKIP — the two ways a paginator silently lies
    expect(new Set(walked).size, 'a page repeated a row').toBe(walked.length);
    expect(walked.sort(), 'the walk did not cover every row').toEqual([...ids].sort());
    expect(third.nextCursor, 'the last page still claimed more').toBeNull();

    // A bad cursor must not quietly mean "from the beginning": a paging client
    // would then loop on page one forever instead of failing loudly.
    const bad = await list(s, archive, `?note=${note}&cursor=not-a-cursor`);
    expect(bad.status, 'a malformed cursor silently restarted the walk').toBe(400);
  });

  it('download carries the real filename, encoded so a header cannot be split', async () => {
    const s = await ctx.realSession(`ml4-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `ML4 ${RUN}`);
    const note = await makeNote(s, archive, `내려받기 ${RUN}`);
    const up = await upload(s, archive, `dl-${RUN}`, note, '빨랫줄 1987년 봄.png');

    const inline = await ctx.app.request(`/v1/archives/${archive}/media/${up.id}`, {
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(inline.headers.get('content-disposition')).toMatch(/^inline;/);

    const dl = await ctx.app.request(`/v1/archives/${archive}/media/${up.id}?download=1`, {
      headers: { authorization: `Bearer ${s.token}` },
    });
    const cd = dl.headers.get('content-disposition') ?? '';
    expect(cd, 'the flag did not force an attachment').toMatch(/^attachment;/);
    // the quoted ASCII fallback is the HASH, which cannot contain a quote
    expect(cd).toContain(`filename="${up.contentHash}"`);
    const star = /filename\*=UTF-8''([^;]+)/.exec(cd);
    expect(star, 'the filename* parameter is missing').not.toBeNull();
    expect(decodeURIComponent(star![1]!)).toBe('빨랫줄 1987년 봄.png');
  });

  it('a filename carrying CRLF cannot split the response header', async () => {
    const s = await ctx.realSession(`ml5-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `ML5 ${RUN}`);
    const note = await makeNote(s, archive, `주입 ${RUN}`);

    // `x-filename` is percent-DECODED on the way in, so this is the shape a
    // hostile client actually sends: legal on the request, a response splitter
    // if it ever reaches a response header raw.
    const hostile = 'ok.png\r\nx-injected: yes\r\n\r\n<script>';
    const up = await upload(s, archive, `inj-${RUN}`, note, hostile);

    const dl = await ctx.app.request(`/v1/archives/${archive}/media/${up.id}?download=1`, {
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('x-injected'), 'the filename injected a header').toBeNull();

    const cd = dl.headers.get('content-disposition') ?? '';
    expect(cd).not.toContain('\r');
    expect(cd).not.toContain('\n');
    // encoded, not stripped: the name still round-trips exactly
    const star = /filename\*=UTF-8''([^;]+)/.exec(cd);
    expect(decodeURIComponent(star![1]!)).toBe(hostile);
  });

  it("the ext-value's own delimiters are encoded, not left literal", async () => {
    const s = await ctx.realSession(`ml6-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `ML6 ${RUN}`);
    const note = await makeNote(s, archive, `구분자 ${RUN}`);

    /**
     * This is the case that separates a correct RFC 5987 encoder from
     * `encodeURIComponent`, which leaves `! ' ( ) *` literal. `'` and `*` are
     * the DELIMITERS of the ext-value grammar itself — a literal one inside the
     * value makes a parser end the parameter early and read a different
     * filename than the one that was stored.
     */
    const tricky = "1987's *photo* (2).png";
    const up = await upload(s, archive, `tk-${RUN}`, note, tricky);

    const dl = await ctx.app.request(`/v1/archives/${archive}/media/${up.id}?download=1`, {
      headers: { authorization: `Bearer ${s.token}` },
    });
    const cd = dl.headers.get('content-disposition') ?? '';
    const value = /filename\*=UTF-8''([^;]+)/.exec(cd)![1]!;

    expect(value, 'an apostrophe was left literal in the ext-value').not.toContain("'");
    expect(value, 'an asterisk was left literal in the ext-value').not.toContain('*');
    expect(value).not.toContain('(');
    expect(value).not.toContain(')');
    expect(decodeURIComponent(value), 'the name did not survive encoding').toBe(tricky);
  });
});
