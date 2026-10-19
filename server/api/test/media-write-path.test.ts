import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-065 — the association is a server-set, authorization-checked write.
 *
 * This is the property the whole photo-as-note design rests on. Are.na resolves
 * visibility over channel membership safely because adding a block to a channel
 * is itself an authorization-checked WRITE; `![[hash]]` in a body never was.
 * FM-057 spent eight review rounds proving the converse.
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

async function upload(
  s: RealSession,
  archive: string,
  bytes: Buffer,
  opts: { note?: string; filename?: string } = {},
) {
  const q = opts.note ? `?note=${opts.note}` : '';
  const headers: Record<string, string> = {
    authorization: `Bearer ${s.token}`,
    'content-type': 'image/png',
  };
  // HTTP headers are ISO-8859-1: a Korean filename must be percent-encoded,
  // which is what a real client does and what the server now decodes.
  if (opts.filename) headers['x-filename'] = encodeURIComponent(opts.filename);
  const r = await ctx.app.request(`/v1/archives/${archive}/media${q}`, {
    method: 'POST',
    headers,
    body: new Uint8Array(bytes),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, string> };
}

const addMember = (archive: string, userId: string) =>
  ctx.pool.query(
    `insert into public.memberships (archive_id, user_id, role)
     values ($1, $2, 'contributor') on conflict do nothing`,
    [archive, userId],
  );

const restrict = (archive: string, noteId: string) =>
  ctx.pool.query(
    `insert into public.audiences (archive_id, note_id, kind)
     values ($1, $2, 'private-to-author')
     on conflict (note_id) do update set kind = excluded.kind`,
    [archive, noteId],
  );

const homeOf = async (mediaId: string) =>
  (
    await ctx.pool.query<{ note_id: string | null }>(
      `select note_id from public.media where id = $1`,
      [mediaId],
    )
  ).rows[0]?.note_id ?? null;

describe('FM-065 the write path', () => {
  it('an upload attaches to a memory the caller can see', async () => {
    const owner = await ctx.realSession(`w1a-${RUN}@test.local`);
    const member = await ctx.realSession(`w1b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `W1 ${RUN}`);
    await addMember(archive, member.userId);

    // a note the MEMBER did not author but CAN see — visibility, not authorship
    const note = await makeNote(owner, archive, `가족 사진 ${RUN}`);
    const up = await upload(member, archive, Buffer.from(`ZZATTACH${RUN}\n`), { note });

    expect(up.status).toBe(201);
    expect(await homeOf(up.body.id!), 'the upload did not attach to the memory').toBe(note);
  });

  it('a caller cannot attach an upload to a memory they cannot see', async () => {
    /**
     * The check is `visibleNoteSql`, the same one every by-id note surface
     * uses, and a miss answers the UNIFORM 404 — never a 403, which would
     * confirm the note exists. Two misses are asserted here for that reason: a
     * private note that exists, and a uuid that does not.
     */
    const owner = await ctx.realSession(`w2a-${RUN}@test.local`);
    const attacker = await ctx.realSession(`w2b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `W2 ${RUN}`);
    await addMember(archive, attacker.userId);

    const priv = await makeNote(owner, archive, `비공개 ${RUN}`);
    await restrict(archive, priv);

    const hidden = await upload(attacker, archive, Buffer.from(`ZZHIDDEN${RUN}\n`), { note: priv });
    expect(hidden.status, 'attached to a memory the caller cannot see').toBe(404);

    const absent = await upload(attacker, archive, Buffer.from(`ZZABSENT${RUN}\n`), {
      note: randomUUID(),
    });
    expect(absent.status, 'a missing note answered differently than a hidden one').toBe(404);

    // nothing was written on either refusal
    const rows = await ctx.pool.query<{ n: string }>(
      `select count(*)::int as n from public.media where archive_id = $1 and created_by = $2`,
      [archive, attacker.userId],
    );
    expect(Number(rows.rows[0]!.n), 'a refused attach still created a media row').toBe(0);
  });

  it('a minted photo-note is private until someone says otherwise', async () => {
    /**
     * NOT the ordinary archive-members default. This note is minted by the ACT
     * OF UPLOADING, before the uploader has said who it is for, so defaulting
     * to visible would publish a photograph on a decision the user has not
     * made. FM-057's escalation battery caught exactly that.
     */
    const owner = await ctx.realSession(`w3a-${RUN}@test.local`);
    const member = await ctx.realSession(`w3b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `W3 ${RUN}`);
    await addMember(archive, member.userId);

    const up = await upload(owner, archive, Buffer.from(`ZZMINT${RUN}\n`), {
      filename: '할머니_생신.HEIC',
    });
    expect(up.status).toBe(201);
    const note = await homeOf(up.body.id!);
    expect(note, 'no note was minted for an unattached upload').not.toBeNull();

    const aud = await ctx.pool.query<{ kind: string }>(
      `select kind from public.audiences where note_id = $1`,
      [note],
    );
    expect(aud.rows[0]?.kind, 'a minted photo-note was not private').toBe('private-to-author');

    // and the co-member cannot read the photograph through it
    const r = await ctx.app.request(
      `/v1/archives/${archive}/media/by-hash/${up.body.contentHash}`,
      { headers: { authorization: `Bearer ${member.token}` } },
    );
    expect(r.status, 'a minted note published the photograph to the archive').toBe(404);

    // the title came from the filename, and is link-safe
    const t = await ctx.pool.query<{ title: string }>(
      `select title from public.notes where id = $1`,
      [note],
    );
    expect(t.rows[0]!.title).toContain('할머니_생신');
    expect(t.rows[0]!.title, 'the minted title carries characters wikilinks refuse').not.toMatch(
      /[[\]#^|]/,
    );
  });

  it('fifty photographs sharing a filename all arrive', async () => {
    /**
     * The phone dump. Fifty uploads land at once, all carrying ONE `x-filename`,
     * so every one of them wants the same title. `lockHash` does not serialize
     * them -- it keys on the CONTENT HASH, and these are fifty different
     * photographs -- so the unique title index is the only real arbiter, and a
     * loser must retry rather than answer 500.
     */
    const owner = await ctx.realSession(`w4-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `W4 ${RUN}`);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        upload(owner, archive, Buffer.from(`ZZDUMP${RUN}-${i}\n`), { filename: 'IMG_0001.HEIC' }),
      ),
    );

    const failed = results.filter((r) => r.status !== 201);
    expect(failed.length, `${failed.length} of 50 uploads failed: ${failed[0]?.status}`).toBe(0);

    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size, 'uploads collapsed into fewer rows than photographs').toBe(50);

    const notes = await ctx.pool.query<{ n: string }>(
      `select count(distinct note_id)::int as n from public.media where archive_id = $1`,
      [archive],
    );
    expect(Number(notes.rows[0]!.n), 'fifty photographs did not get fifty memories').toBe(50);
  });

  it('two memories can each hold the same photograph', async () => {
    /**
     * THE CLAIM THIS UNIT'S RECORD MADE AND THE CODE DID NOT DELIVER.
     *
     * The dedup short-circuit ran before `?note=` was ever read, so an upload
     * of bytes the archive already held returned the EXISTING row's id and
     * attached nothing. The caller's memory got no photograph, and the id they
     * were handed belonged to another member's row -- which their own GET
     * answers 404 for. The attach vanished behind a 201.
     *
     * Every earlier test used freshly randomised bytes, so all four took the
     * fresh-insert branch and none could see it. The G8 panel found the gap and
     * found that it falsified three claims in the record, including the FM-066
     * coupling warning. This test is the pin, in both directions.
     */
    const owner = await ctx.realSession(`w5a-${RUN}@test.local`);
    const member = await ctx.realSession(`w5b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `W5 ${RUN}`);
    await addMember(archive, member.userId);

    const bytes = Buffer.from(`ZZSHARED${RUN}\n`, 'utf8');
    const noteA = await makeNote(owner, archive, `첫 기억 ${RUN}`);
    const noteB = await makeNote(member, archive, `둘째 기억 ${RUN}`);

    const first = await upload(owner, archive, bytes, { note: noteA });
    const second = await upload(member, archive, bytes, { note: noteB });

    expect(first.status).toBe(201);
    expect(second.status, 'the second attach was refused').toBe(201);
    expect(second.body.id, 'the second attach was deduped into the first row').not.toBe(
      first.body.id,
    );
    expect(await homeOf(first.body.id!)).toBe(noteA);
    expect(await homeOf(second.body.id!), 'the second upload did not attach to its memory').toBe(
      noteB,
    );

    // one hash, two rows -- which is why FM-066's sibling check is not optional
    const rows = await ctx.pool.query<{ n: string }>(
      `select count(*)::int as n from public.media where archive_id = $1 and content_hash = $2`,
      [archive, first.body.contentHash],
    );
    expect(Number(rows.rows[0]!.n), 'two memories did not each get their own row').toBe(2);

    // ...and each caller can read the photograph through their OWN memory
    for (const [who, s] of [
      ['the first uploader', owner],
      ['the second uploader', member],
    ] as const) {
      const r = await ctx.app.request(
        `/v1/archives/${archive}/media/by-hash/${first.body.contentHash}`,
        { headers: { authorization: `Bearer ${s.token}` } },
      );
      expect(r.status, `${who} cannot read the photograph in their own memory`).toBe(200);
    }
  });
});
