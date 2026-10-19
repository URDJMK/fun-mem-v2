import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-057 unit 2 — nothing a caller can WRITE grants access to a photograph.
 *
 * This file used to be 950 lines pinning five successive versions of a derived
 * visibility rule (amendments A1-A6). Derivation is gone — see A7 — so the
 * property collapsed to one sentence, and so did the file.
 *
 * WHY THE ATTACK TESTS SURVIVE ANYWAY. Under the uploader rule they are all
 * trivially 404, and a reader could reasonably ask why they are still here.
 * They are the regression guard against RE-INTRODUCING derivation: each one
 * encodes an attack that a plausible future "let members see photos in notes
 * they can read" change would reopen. Whoever writes that change — FM-060 will,
 * properly, via a home-note FK — has to make these pass on purpose.
 *
 * Removed with the derivation, and why (A7 records this in full):
 *   - `a member still sees a blob embedded in someone else s visible note`
 *   - `editing a note does not cost the editor the photographs in it`
 *   - `a spaced embed by the uploader still attaches the file`
 *   - `detaching a file from a note revokes access through that note`
 *   - `an embed with no carrying revision vouches for nobody`
 *   - `an embed in another archive confers nothing`
 * Every one asserted a behaviour of the carrier machinery. There is no carrier.
 * They are not weakened assertions that were dropped to get green — they are
 * assertions about code that no longer exists.
 *
 * `RESIDUAL R6` is INVERTED rather than removed: it asserted the fenced-mention
 * hole was open (expecting 200). It now asserts 404, because the hole is closed.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function upload(s: RealSession, archive: string, bytes: Buffer) {
  const r = await ctx.app.request(`/v1/archives/${archive}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'image/png' },
    body: new Uint8Array(bytes),
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`upload: ${r.status}`);
  return (await r.json()) as { id: string; contentHash: string };
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

const read = (s: RealSession, archive: string, hash: string) =>
  ctx.app.request(`/v1/archives/${archive}/media/by-hash/${hash}`, {
    headers: { authorization: `Bearer ${s.token}` },
  });

/** Owner uploads a blob and attaches it to a note that is then made private. */
async function privateBlob(owner: RealSession, archive: string, marker: string) {
  const up = await upload(owner, archive, Buffer.from(`${marker}\n`, 'utf8'));
  const note = await makeNote(owner, archive, `비공개 ${marker}`, `![[${up.contentHash}]] 사진`);
  /**
   * THE BLOB IS HOMED IN THE PRIVATE NOTE, not merely embedded in its text.
   *
   * Under FM-057 these fixtures were unhomed, and after FM-064 that made the
   * whole battery pass through the fail-closed NULL branch -- every attack was
   * refused because the blob had no memory at all, not because the home-note
   * rule refused it. The G8 panel called that coverage decay, correctly: a
   * regression guard that passes for the wrong reason has stopped guarding.
   *
   * Homing it server-side (FM-065 owns the `?note=` write path) makes these
   * attacks run against the rule they were written to break.
   */
  await ctx.pool.query(`update public.media set note_id = $2 where id = $1`, [up.id, note]);
  await restrict(archive, note);
  return { ...up, note };
}

describe('FM-057 nothing a caller writes grants access to a photograph', () => {
  it('the uploader can read their own blob and a co-member cannot', async () => {
    // THE WHOLE RULE, in one test, with both directions. Without the first
    // assertion a predicate of `false` would pass everything else in this file.
    const owner = await ctx.realSession(`up1a-${RUN}@test.local`);
    const member = await ctx.realSession(`up1b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `UP1 ${RUN}`);
    await addMember(archive, member.userId);

    const blob = await upload(owner, archive, Buffer.from(`ZZOWN${RUN}\n`, 'utf8'));
    // an ORDINARY, fully visible note — no audiences row at all
    await makeNote(owner, archive, `가족 사진 ${RUN}`, `![[${blob.contentHash}]] 온 가족`);

    expect(
      (await read(owner, archive, blob.contentHash)).status,
      'the uploader cannot read their own blob',
    ).toBe(200);

    // ...and the embed in a note the member CAN read confers nothing. This is
    // the deliberate cost of the uploader rule, asserted rather than described.
    const co = await read(member, archive, blob.contentHash);
    expect(co.status, 'an embed granted access — derivation is back').toBe(404);
    expect(await co.text()).not.toContain(`ZZOWN${RUN}`);
  });

  it('a member cannot grant themselves a blob by embedding its hash in their own note', async () => {
    const owner = await ctx.realSession(`esc1a-${RUN}@test.local`);
    const attacker = await ctx.realSession(`esc1b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ESC1 ${RUN}`);
    await addMember(archive, attacker.userId);
    const blob = await privateBlob(owner, archive, `ZZESCALATE${RUN}`);

    expect((await read(attacker, archive, blob.contentHash)).status).toBe(404);

    // The hash is readable from public.media via PostgREST under the
    // membership-only RLS policy (R1, still open, carried to FM-060) — so this
    // fixture hands it over rather than pretending it is secret.
    await makeNote(attacker, archive, `내 노트 ${RUN}`, `![[${blob.contentHash}]] 이건 내 노트야`);

    const after = await read(attacker, archive, blob.contentHash);
    expect(after.status, 'a member read a private blob via their own note').toBe(404);
    expect(await after.text()).not.toContain(`ZZESCALATE${RUN}`);

    const del = await ctx.app.request(`/v1/archives/${archive}/media/${blob.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${attacker.token}` },
    });
    expect(del.status, 'the self-grant conferred erasure rights').toBe(404);
    expect(
      (await read(owner, archive, blob.contentHash)).status,
      'the blob was destroyed by the refusal path',
    ).toBe(200);
  });

  it('a member cannot grant themselves a blob by editing someone else s note', async () => {
    // `PUT /notes/:noteId` gates on isMember plus visibleNoteSql with NO author
    // check, so any member may edit any visible note while `created_by` stays
    // put. Every authorship-based rule died on this.
    const owner = await ctx.realSession(`esc6a-${RUN}@test.local`);
    const attacker = await ctx.realSession(`esc6b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ESC6 ${RUN}`);
    await addMember(archive, attacker.userId);
    const blob = await privateBlob(owner, archive, `ZZEDITGRANT${RUN}`);

    const host = await makeNote(owner, archive, `가족 이야기 ${RUN}`, '평범한 이야기');
    const edit = await ctx.api(attacker.token, 'PUT', `/v1/archives/${archive}/notes/${host}`, {
      body: `평범한 이야기\n\n![[${blob.contentHash}]] 사진`,
    });
    expect(edit.status, 'the fixture failed: the edit was refused, so nothing is proven').toBe(200);
    const rows = await ctx.pool.query<{ n: string }>(
      `select count(*)::int as n from public.links where source_id = $1 and embed`,
      [host],
    );
    expect(Number(rows.rows[0]!.n), 'the fixture failed: no embed row was created').toBe(1);

    const after = await read(attacker, archive, blob.contentHash);
    expect(after.status, 'a member read a private blob by editing another member note').toBe(404);
    expect(await after.text()).not.toContain(`ZZEDITGRANT${RUN}`);
  });

  it('a planted embed stays worthless after the note is saved by someone else', async () => {
    // Laundering: a revision snapshots the WHOLE body, so any later save by
    // another member re-attributes a planted embed. This killed the third rule.
    const owner = await ctx.realSession(`esc8a-${RUN}@test.local`);
    const planter = await ctx.realSession(`esc8b-${RUN}@test.local`);
    const bystander = await ctx.realSession(`esc8c-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ESC8 ${RUN}`);
    await addMember(archive, planter.userId);
    await addMember(archive, bystander.userId);
    const blob = await privateBlob(owner, archive, `ZZLAUNDER${RUN}`);

    const host = await makeNote(owner, archive, `가족 이야기 ${RUN}`, '평범한 이야기');
    await ctx.api(planter.token, 'PUT', `/v1/archives/${archive}/notes/${host}`, {
      body: `평범한 이야기\n\n![[${blob.contentHash}]] 사진`,
    });
    // the laundering save: the OWNER edits their own note for an unrelated
    // reason, snapshotting the planted embed into an owner-authored revision
    await ctx.api(owner.token, 'PUT', `/v1/archives/${archive}/notes/${host}`, {
      body: `평범한 이야기입니다\n\n![[${blob.contentHash}]] 사진`,
    });

    for (const [who, s] of [
      ['the planter', planter],
      ['a bystander', bystander],
    ] as const) {
      expect((await read(s, archive, blob.contentHash)).status, `${who} read it`).toBe(404);
      const del = await ctx.app.request(`/v1/archives/${archive}/media/${blob.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(del.status, `${who} erased it`).toBe(404);
    }
    expect((await read(owner, archive, blob.contentHash)).status).toBe(200);
  });

  it('a fenced mention by the uploader confers nothing', async () => {
    // WAS `RESIDUAL R6`, which asserted this hole was OPEN (expecting 200).
    // Inverted, because removing the derivation closed it.
    //
    // The hole: `l.embed` came from the PARSER, which ignores code fences
    // (FM-054's codeMask), while the carrier test was a raw-text regex, which
    // does not. So the uploader quoting `![[H]]` as inert fenced text became an
    // "uploader-authored carrier", and any member adding a real embed to that
    // note inherited read AND erasure on a private blob.
    const owner = await ctx.realSession(`esc14a-${RUN}@test.local`);
    const bob = await ctx.realSession(`esc14b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ESC14 ${RUN}`);
    await addMember(archive, bob.userId);
    const blob = await privateBlob(owner, archive, `ZZFENCED${RUN}`);

    const host = await makeNote(
      owner,
      archive,
      `문법 설명 ${RUN}`,
      '이렇게 씁니다:\n\n```\n![[' + blob.contentHash + ']]\n```\n',
    );
    const parsed = await ctx.pool.query<{ n: string }>(
      `select count(*)::int as n from public.links where source_id = $1 and embed`,
      [host],
    );
    expect(
      Number(parsed.rows[0]!.n),
      'the fixture failed: the parser DID emit an embed row for fenced text',
    ).toBe(0);

    await ctx.api(bob.token, 'PUT', `/v1/archives/${archive}/notes/${host}`, {
      body:
        '이렇게 씁니다:\n\n```\n![[' +
        blob.contentHash +
        ']]\n```\n\n![[' +
        blob.contentHash +
        ']] 진짜',
    });

    const after = await read(bob, archive, blob.contentHash);
    expect(after.status, 'the fenced-mention hole (R6) is open again').toBe(404);
    expect(await after.text()).not.toContain(`ZZFENCED${RUN}`);
  });

  it('a blob with no recorded uploader vouches for nobody', async () => {
    // Imported rows carry NULL created_by, and A6 records an earlier spelling
    // (`is not distinct from`) making NULL match NULL and FAIL OPEN. Plain `=`
    // yields unknown, therefore false. FM-057 measured 1,826 of 2,160 rows in
    // this state, so it is the common case, not a corner.
    const owner = await ctx.realSession(`esc11a-${RUN}@test.local`);
    const attacker = await ctx.realSession(`esc11b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ESC11 ${RUN}`);
    await addMember(archive, attacker.userId);
    const blob = await privateBlob(owner, archive, `ZZNULLUP${RUN}`);
    await ctx.pool.query(`update public.media set created_by = null where id = $1`, [blob.id]);

    await makeNote(attacker, archive, `내 노트 ${RUN}`, `![[ ${blob.contentHash}]] 사진`);

    /**
     * WHAT CHANGED UNDER FM-064, AND WHY THIS IS NOT A WEAKENING.
     *
     * This used to assert 404 for BOTH callers, because FM-057's rule was
     * `created_by = caller` and a NULL uploader matched nobody at all. The
     * property in the test's name -- a blob with no recorded uploader vouches
     * for nobody -- is unchanged and still asserted: the NULL grants nothing.
     *
     * The owner now reads it for a DIFFERENT and legitimate reason: they
     * authored the private memory it is homed in, so they can read the memory,
     * so they can read its photograph. Asserting 404 for them would be
     * asserting that FM-064 did not happen.
     *
     * The security half is unchanged and is what this test defends: the
     * attacker, who did not author that memory and cannot read it, is still
     * refused -- and the second fixture below proves the NULL branch itself
     * confers nothing, by removing the home note entirely.
     */
    expect(
      (await read(attacker, archive, blob.contentHash)).status,
      'an uploaderless blob in a memory the attacker cannot read was readable by them',
    ).toBe(404);
    expect(
      (await read(owner, archive, blob.contentHash)).status,
      'the author of the memory lost the photograph inside it',
    ).toBe(200);

    // ...and with NO home note, the NULL uploader vouches for nobody at all --
    // which is the sentence in this test's name, asserted directly.
    await ctx.pool.query(`update public.media set note_id = null where id = $1`, [blob.id]);
    for (const [who, s] of [
      ['the attacker', attacker],
      ['the owner', owner],
    ] as const) {
      expect(
        (await read(s, archive, blob.contentHash)).status,
        `an unhomed, uploaderless blob was readable by ${who}`,
      ).toBe(404);
    }
    const del = await ctx.app.request(`/v1/archives/${archive}/media/${blob.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${attacker.token}` },
    });
    expect(del.status, 'the NULL branch conferred erasure').toBe(404);
  });

  it('the archive owner can erase a blob no one can see', async () => {
    // FR-143. Gating erasure on visibility alone strands blobs NOBODY can
    // delete — import stores created_by NULL, and most rows have no uploader.
    // Erasure authority is not read authority; the negative control pins that.
    const owner = await ctx.realSession(`esc5a-${RUN}@test.local`);
    const member = await ctx.realSession(`esc5b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ESC5 ${RUN}`);
    await addMember(archive, member.userId);

    const orphan = await upload(member, archive, Buffer.from(`ZZORPHAN${RUN}\n`, 'utf8'));
    await ctx.pool.query(`update public.media set created_by = null where id = $1`, [orphan.id]);
    expect((await read(owner, archive, orphan.contentHash)).status).toBe(404);

    const del = await ctx.app.request(`/v1/archives/${archive}/media/${orphan.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(del.status, 'FR-143: an un-erasable blob').toBe(200);
    const gone = await ctx.pool.query(`select 1 from public.media where id = $1`, [orphan.id]);
    expect(gone.rowCount, 'the row survived a 200 delete').toBe(0);

    // NEGATIVE CONTROL: erasure authority did not become read authority.
    const priv = await upload(member, archive, Buffer.from(`ZZOWNERBLIND${RUN}\n`, 'utf8'));
    const peek = await read(owner, archive, priv.contentHash);
    expect(peek.status, 'the owner gained read access through the erasure clause').toBe(404);
    expect(await peek.text()).not.toContain(`ZZOWNERBLIND${RUN}`);
  });
});
