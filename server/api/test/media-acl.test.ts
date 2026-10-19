import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { testContext, type RealSession } from './helpers';

/**
 * FM-057 — media and export leaked private content to any co-member.
 *
 * `GET /export` streamed every blob in the archive while filtering notes,
 * links, audiences and revisions by audience IN THE SAME HANDLER, and all four
 * media routes were `isMember`-only.
 *
 * THE RULE, as shipped (A7): a blob is visible to the caller who UPLOADED it.
 * Five review rounds went into DERIVING a blob's audience from the notes that
 * embed it; every version was gameable, because `links` and `revisions` are
 * caller-writable. The derivation is gone. A1-A6 record what was tried and how
 * each failed; A7 records the removal.
 *
 * KILL-LIST, measured not asserted. Each protection is reverted alone — the
 * predicate replaced by `(m.created_by = $n or true)`, which keeps the bind
 * parameter referenced so the mutant misbehaves rather than raises — and each
 * is killed by exactly one named test. See docs/plans/harnesses/FM-057/. Two
 * earlier operators were discarded for making Postgres raise: a mutant that
 * 500s is killed by its own crash and proves nothing about the assertion.
 *
 * The erasure gate is ONE gate, not two. A first draft also put the predicate
 * on the pre-lock peek; each copy masked the other and neither was individually
 * killable — the FM-056 shape, where three fixes died only as a set.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Read a zip Buffer into { path -> bytes }. */
async function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('not a zip'));
      const out = new Map<string, Buffer>();
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (e, rs) => {
          if (e || !rs) return reject(e ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          rs.on('data', (c: Buffer) => chunks.push(c));
          rs.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

async function upload(s: RealSession, archive: string, bytes: Buffer, mime = 'image/png') {
  const r = await ctx.app.request(`/v1/archives/${archive}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': mime },
    body: new Uint8Array(bytes),
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`upload: ${r.status}`);
  const body = (await r.json()) as { id: string; contentHash: string };
  return { ...body, status: r.status, bytes };
}

async function makeNote(s: RealSession, archive: string, title: string, body: string) {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body,
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

/** Fixture mechanism only — never an access-control oracle. */
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

/** Owner uploads a blob and embeds it in a note that is then made private. */
async function privateBlob(owner: RealSession, archive: string, marker: string) {
  const up = await upload(owner, archive, Buffer.from(`${marker}\n`, 'utf8'));
  const note = await makeNote(owner, archive, `비공개 ${marker}`, `![[${up.contentHash}]] 사진`);
  await restrict(archive, note);
  return { ...up, note };
}

describe('FM-057 media visibility', () => {
  it('export omits media embedded only in notes the caller cannot see', async () => {
    const owner = await ctx.realSession(`me1a-${RUN}@test.local`);
    const member = await ctx.realSession(`me1b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ME1 ${RUN}`);
    await addMember(archive, member.userId);

    const secret = await privateBlob(owner, archive, `ZZSECRET${RUN}`);
    // ...and one the MEMBER uploaded, so the export is not merely empty.
    // Uploaded by the member, not the owner: since A7 removed derived
    // visibility, a bundle carries what YOU uploaded, so an owner-uploaded blob
    // would legitimately be absent and the control would prove nothing.
    const open = await upload(member, archive, Buffer.from(`OPEN${RUN}\n`, 'utf8'));
    await makeNote(owner, archive, `공개 ${RUN}`, `![[${open.contentHash}]] 사진`);

    const res = await ctx.api(member.token, 'GET', `/v1/archives/${archive}/export`);
    expect(res.status).toBe(200);
    const files = await unzip(Buffer.from(await res.arrayBuffer()));

    // POSITIVE CONTROL: the visible blob IS in the bundle, so an export that
    // simply dropped all media cannot satisfy this test.
    expect(files.has(`attachments/${open.contentHash}.png`), 'the visible blob was dropped').toBe(
      true,
    );

    // the private one is absent as BYTES, not merely missing from a manifest
    expect(
      files.has(`attachments/${secret.contentHash}.png`),
      'the private blob was streamed into the bundle',
    ).toBe(false);
    const manifest = files.get('data/media.jsonl')!.toString('utf8');
    expect(manifest, 'the private blob is listed in data/media.jsonl').not.toContain(
      secret.contentHash,
    );
    expect(manifest, 'the visible blob vanished from data/media.jsonl').toContain(open.contentHash);
    // and nothing anywhere in the bundle names it — checksums.sha256 lists
    // every file added, so a blob added under any other path shows up here
    const all = [...files.values()].map((b) => b.toString('utf8')).join('\n');
    expect(all, 'the private content hash leaked somewhere in the bundle').not.toContain(
      secret.contentHash,
    );
    expect(all, 'the private bytes leaked somewhere in the bundle').not.toContain(`ZZSECRET${RUN}`);
  });

  it('media by-hash is not a confirmation oracle', async () => {
    const owner = await ctx.realSession(`me2a-${RUN}@test.local`);
    const member = await ctx.realSession(`me2b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ME2 ${RUN}`);
    await addMember(archive, member.userId);
    const secret = await privateBlob(owner, archive, `ZZORACLE${RUN}`);

    // POSITIVE CONTROL: the owner can still read it, so a blanket 404 is not
    // a passing fix.
    const byOwner = await ctx.app.request(
      `/v1/archives/${archive}/media/by-hash/${secret.contentHash}`,
      { headers: { authorization: `Bearer ${owner.token}` } },
    );
    expect(byOwner.status, 'the uploader lost access to their own blob').toBe(200);

    const real = await ctx.app.request(
      `/v1/archives/${archive}/media/by-hash/${secret.contentHash}`,
      { headers: { authorization: `Bearer ${member.token}` } },
    );
    const absent = await ctx.app.request(
      `/v1/archives/${archive}/media/by-hash/${sha(Buffer.from(`nothing-${RUN}`))}`,
      { headers: { authorization: `Bearer ${member.token}` } },
    );

    // A blob that EXISTS but is invisible must be indistinguishable from one
    // that does not exist — otherwise the route answers "is this hash here?"
    expect(real.status, 'an invisible blob was readable').toBe(absent.status);
    expect(await real.text(), 'the two responses differ, which is the oracle').toBe(
      await absent.text(),
    );
    expect(real.status).toBe(404);

    // the by-id route answers identically
    const byId = await ctx.app.request(`/v1/archives/${archive}/media/${secret.id}`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(byId.status, 'the by-id route is still an oracle').toBe(404);
    expect(await byId.text()).not.toContain(`ZZORACLE${RUN}`);
  });

  it('upload dedup does not disclose an invisible blob', async () => {
    const owner = await ctx.realSession(`me3a-${RUN}@test.local`);
    const member = await ctx.realSession(`me3b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ME3 ${RUN}`);
    await addMember(archive, member.userId);
    const secret = await privateBlob(owner, archive, `ZZDEDUP${RUN}`);

    // The member uploads bytes they already hold. They learn nothing about the
    // CONTENT — but a 200-with-existing-id told them the archive already had
    // it, which is the same oracle by-hash was.
    const post = (body: Buffer) =>
      ctx.app.request(`/v1/archives/${archive}/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${member.token}`, 'content-type': 'image/png' },
        body: new Uint8Array(body),
      });
    const guess = await post(secret.bytes);
    // SAME LENGTH as the secret payload on purpose, so `bytes` is a fair
    // comparison below rather than a field the loop has to exempt. `bytes`
    // echoes what the caller just sent, so it is never an oracle — but a
    // difference here would mask one that is.
    const novelBytes = Buffer.from(`NOVELXX${RUN}\n`, 'utf8');
    expect(novelBytes.length, 'the two probe payloads are not the same length').toBe(
      secret.bytes.length,
    );
    const novel = await post(novelBytes);
    const guessBody = (await guess.json()) as Record<string, unknown>;
    const novelBody = (await novel.json()) as Record<string, unknown>;

    expect(guess.status, 'dedup answered a different status for an invisible blob').toBe(
      novel.status,
    );
    expect(Object.keys(guessBody).sort(), 'the two responses have different shapes').toEqual(
      Object.keys(novelBody).sort(),
    );
    // EVERY FIELD, not just the shape. Review found the oracle had simply moved
    // one line down: the dedup branch echoed the STORED row's mime while a
    // fresh insert echoed the request's, so probing with an unusual
    // content-type and reading the reply answered "are these bytes already
    // here?". An earlier version of this test asserted the response did not
    // contain `owner.userId`, which was vacuous — the body has only id,
    // contentHash, mime and bytes, so it could never have contained a user id
    // and the assertion could never fail.
    for (const k of Object.keys(guessBody)) {
      if (k === 'id' || k === 'contentHash') continue; // necessarily differ
      expect(guessBody[k], `field '${k}' distinguishes dedup from a fresh upload`).toEqual(
        novelBody[k],
      );
    }
    // and the probe must not have been answered with the stored mime
    expect(guessBody.mime, 'the response echoed the stored mime, which is the oracle').toBe(
      'image/png',
    );

    // NEGATIVE CONTROL: dedup did not quietly steal ownership. Without this, an
    // implementation that reassigned created_by to the deduping caller — which
    // WOULD make the two responses uniform, and would hand the caller read and
    // erasure rights over Alice's blob — passes every assertion above.
    const rowOwner = await ctx.pool.query<{ created_by: string }>(
      `select created_by from public.media where archive_id = $1 and content_hash = $2`,
      [archive, secret.contentHash],
    );
    expect(rowOwner.rows[0]!.created_by, 'dedup reassigned the blob to the caller').toBe(
      owner.userId,
    );

    // AND THE CONSEQUENCE, ASSERTED RATHER THAN GLOSSED. Because created_by
    // stays with the original uploader and (amendment A1) a note the caller had
    // a hand in does not vouch, the deduping member cannot read the blob back —
    // their own embed of it renders broken. That is a real cost of closing the
    // escalation, it is not fixable without somewhere to record possession, and
    // a comment claiming otherwise shipped once already. This test exists so
    // the limitation cannot be quietly forgotten: if a future change makes the
    // read succeed, this fails and the FM-060 note must be revisited.
    const guessId = guessBody.id as string;
    const backRead = await ctx.app.request(`/v1/archives/${archive}/media/${guessId}`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(backRead.status, 'the documented dedup limitation no longer holds — see FM-060').toBe(
      404,
    );

    // NEGATIVE CONTROL: dedup is not simply disabled. One row, one blob — a fix
    // that inserted a second row per upload would pass every assertion above.
    const rows = await ctx.pool.query(
      `select count(*)::int as n from public.media where archive_id = $1 and content_hash = $2`,
      [archive, secret.contentHash],
    );
    expect(rows.rows[0]!.n, 'dedup was disabled instead of made uniform').toBe(1);
  });

  it('a co-member cannot delete a blob behind a private note', async () => {
    const owner = await ctx.realSession(`me4a-${RUN}@test.local`);
    const member = await ctx.realSession(`me4b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ME4 ${RUN}`);
    await addMember(archive, member.userId);
    const secret = await privateBlob(owner, archive, `ZZDELETE${RUN}`);

    const del = await ctx.app.request(`/v1/archives/${archive}/media/${secret.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(del.status, 'a co-member deleted another member private blob').toBe(404);

    // ...and it is STILL THERE for its owner. Without this, a route that
    // deleted the row and then returned 404 would pass.
    const still = await ctx.app.request(
      `/v1/archives/${archive}/media/by-hash/${secret.contentHash}`,
      { headers: { authorization: `Bearer ${owner.token}` } },
    );
    expect(still.status, 'the blob was destroyed despite the refusal').toBe(200);

    // POSITIVE CONTROL: an ordinary delete by someone who CAN see it still
    // works, so this is not erasure disabled. Uploaded BY the member under A7 —
    // the uploader is who can see it now.
    const open = await upload(member, archive, Buffer.from(`ZZOPENDEL${RUN}\n`, 'utf8'));
    await makeNote(owner, archive, `공개삭제 ${RUN}`, `![[${open.contentHash}]] 사진`);
    const ok = await ctx.app.request(`/v1/archives/${archive}/media/${open.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(ok.status, 'FR-143 erasure stopped working for a visible blob').toBe(200);
  });
});
