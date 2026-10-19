import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_URL } from './helpers';

/**
 * FM-069 — media gets a home-note column (supersedes FM-063, D-66).
 *
 * These are SQL-level tests on purpose. This unit changes no API behaviour --
 * `mediaVisibleSql` still resolves on `created_by` until FM-064 -- so asserting
 * through routes would prove something about the app, not about the schema.
 * They insert and delete through the pool and assert what the DDL guarantees.
 */
const pool = new Pool({ connectionString: DB_URL, max: 4 });
const RUN = randomUUID().slice(0, 8);
const T = randomUUID();
const A = randomUUID();
const U = randomUUID();

beforeAll(async () => {
  await pool.query(
    `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
    [U, `fm069-${RUN}@test.local`],
  );
  await pool.query(
    `insert into public.tenants (id, kind, name) values ($1, 'personal', $2)
     on conflict (id) do nothing`,
    [T, `fm069-${RUN}`],
  );
  await pool.query(
    `insert into public.archives (id, tenant_id, subject_name, jurisdiction)
     values ($1, $2, '할머니', 'KR') on conflict (id) do nothing`,
    [A, T],
  );
  await pool.query(
    `insert into public.memberships (archive_id, user_id, role) values ($1, $2, 'owner')
     on conflict do nothing`,
    [A, U],
  );
});

afterAll(async () => {
  await pool.end();
});

async function makeNote(title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `insert into public.notes (archive_id, title, type, note_class, body, created_by)
     values ($1, $2, 'source', 'testimony', '', $3) returning id`,
    [A, title, U],
  );
  return r.rows[0]!.id;
}

async function makeMedia(hash: string, noteId: string | null, filename?: string) {
  const r = await pool.query<{ id: string }>(
    `insert into public.media (archive_id, note_id, content_hash, mime, bytes, created_by, filename)
     values ($1, $2, $3, 'image/png', 1024, $4, $5) returning id`,
    [A, noteId, hash, U, filename ?? null],
  );
  return r.rows[0]!.id;
}

describe('FM-069 media carries a home note', () => {
  it('deleting a memory leaves its photograph behind, unhomed', async () => {
    /**
     * P1. The reference CLEARS, it does not cascade.
     *
     * `on delete cascade` was FM-060's first version and it is the FM-057 A2
     * failure shape: erasing a memory would delete the media ROW, leaving the
     * bytes in Storage with no row and no tombstone pointing at them --
     * unreachable by anyone and erasable by nobody, which FR-143 does not
     * admit. Clearing the reference drops the row to the uploader-only branch,
     * where the archive owner can still erase it.
     */
    const note = await makeNote(`추억 ${RUN}-1`);
    const media = await makeMedia(
      `aa${RUN}0000000000000000000000000000000000000000000000000001`,
      note,
    );

    await pool.query(`delete from public.notes where id = $1`, [note]);

    const after = await pool.query<{ id: string; note_id: string | null }>(
      `select id, note_id from public.media where id = $1`,
      [media],
    );
    expect(after.rowCount, 'the photograph row was destroyed with its memory').toBe(1);
    expect(after.rows[0]!.note_id, 'the dangling reference survived the delete').toBeNull();
  });

  it('two memories can hold the same photograph', async () => {
    /**
     * P2. `unique(archive_id, content_hash)` made one blob carry one audience,
     * so two memories could not each hold the same photograph. Removing it is
     * the whole point of this line of work.
     *
     * The cost belongs to FM-066, not here: row<->blob is no longer 1:1, so
     * erasure must count siblings before removing bytes. This unit does not
     * pretend to solve that.
     */
    const hash = `bb${RUN}0000000000000000000000000000000000000000000000000002`;
    const n1 = await makeNote(`결혼식 ${RUN}`);
    const n2 = await makeNote(`가족 앨범 ${RUN}`);

    const m1 = await makeMedia(hash, n1);
    const m2 = await makeMedia(hash, n2);

    expect(m1).not.toBe(m2);
    const rows = await pool.query<{ n: string }>(
      `select count(*)::int as n from public.media where archive_id = $1 and content_hash = $2`,
      [A, hash],
    );
    expect(Number(rows.rows[0]!.n), 'the two rows collapsed into one').toBe(2);
  });

  it('a photograph row records the filename it arrived under', async () => {
    /**
     * P3. `media` never stored a filename (verified before this unit: the
     * column did not exist), so an upload had nothing to mint a readable note
     * title from -- a phone dump of fifty photographs had fifty identical
     * candidate titles. FM-065 uses this column.
     */
    const note = await makeNote(`제주도 ${RUN}`);
    const media = await makeMedia(
      `cc${RUN}0000000000000000000000000000000000000000000000000003`,
      note,
      '할머니_생신_2019.HEIC',
    );
    const r = await pool.query<{ filename: string | null }>(
      `select filename from public.media where id = $1`,
      [media],
    );
    expect(r.rows[0]!.filename).toBe('할머니_생신_2019.HEIC');
  });

  it('no migration in this unit gives a photograph a memory', async () => {
    /**
     * P4, and the reason this unit exists in isolation. BOTH of FM-060's
     * blocking review rejections were adoption heuristics:
     *
     *   1. "adopt when exactly one note embeds the hash" -- the member who
     *      PLANTED the embed became the owner.
     *   2. "adopt only when the note's AUTHOR is the uploader" -- still wrong,
     *      because a `links` row is written by whoever wrote the EMBED, and
     *      `PUT /notes/:noteId` has no author check.
     *
     * STATED PLAINLY BECAUSE THE PANEL HAS CAUGHT WEAKER VERSIONS OF THIS:
     * this is a STATIC check over the unit's own migration file, not a
     * behavioural one. That is deliberate, and it is the honest instrument --
     * you cannot behaviourally observe the absence of a backfill after it has
     * not run. It fails the moment a statement writing `note_id` appears in
     * this unit's DDL, which is exactly the regression it exists to catch.
     */
    /**
     * SCANS EVERY MIGRATION, not just this unit's. Two earlier versions were
     * both weaker AND more fragile:
     *
     *   1. matching the filename prefix `20260819100000` proved nothing about
     *      any other migration -- a backfill under a different timestamp walked
     *      straight past;
     *   2. deriving the file set from `git diff` against base_sha missed
     *      UNTRACKED migrations (verified: dropping one in left this green),
     *      and shelling out to `state.mjs task-get` broke inside the harness's
     *      own sandbox clone, where the ledger is rewritten -- which is what
     *      turned `harness.test.sh` red.
     *
     * Scanning the whole directory is stronger than the contract's "no
     * migration in this unit" (it is a superset) and depends on nothing but
     * the filesystem. `note_id` did not exist before this unit, so NO migration
     * anywhere may write it.
     */
    const dir = join(fileURLToPath(new URL('.', import.meta.url)), '../../../supabase/migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    expect(files.length, 'no migrations found, so the guard is vacuous').toBeGreaterThan(0);
    const sql = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    // strip line and block comments: the rationale PROSE names the rejected
    // heuristics verbatim, and matching on it would be a false positive
    const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // `public.` is OPTIONAL in these patterns. The panel pointed out that
    // schema-qualifying them let an unqualified `insert into media (...,
    // note_id, ...)` walk past all three checks.
    expect(code, 'the migration UPDATEs media').not.toMatch(/update\s+(public\.)?media\b/i);
    expect(code, 'the migration INSERTs into media').not.toMatch(
      /insert\s+into\s+(public\.)?media\b/i,
    );
    expect(code, 'the migration writes note_id').not.toMatch(/set\s+note_id/i);
    // and the column is added, so the test cannot pass by the file being absent
    expect(code, 'the migration does not add note_id').toMatch(/add\s+column\s+note_id/i);
  });

  it('an upload still dedups when the unique constraint is gone', async () => {
    /**
     * A1. `media.ts` used `on conflict (archive_id, content_hash) do nothing`,
     * and that inference REQUIRES the unique index this unit drops -- without
     * it Postgres raises and every upload answers 500.
     *
     * This test goes through the ROUTE, unlike the other four, because the
     * property is about the app surviving a schema change rather than about
     * the DDL. It pins both halves of FM-057's oracle fix: the second upload
     * must answer 201, the same status as the first, with the same shape.
     */
    const { testContext } = await import('./helpers');
    const ctx = testContext();
    try {
      const owner = await ctx.realSession(`fm069dedup-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(owner, `DEDUP ${RUN}`);
      const bytes = Buffer.from(`ZZDEDUP${RUN}\n`, 'utf8');

      const post = () =>
        ctx.app.request(`/v1/archives/${archive}/media`, {
          method: 'POST',
          headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'image/png' },
          body: new Uint8Array(bytes),
        });

      const first = await post();
      expect(first.status, 'a fresh upload failed').toBe(201);
      const second = await post();
      expect(second.status, 'the deduped upload did not match a fresh one').toBe(201);

      const a = (await first.json()) as Record<string, unknown>;
      const b = (await second.json()) as Record<string, unknown>;
      expect(Object.keys(b).sort(), 'the two answers differ in shape').toEqual(
        Object.keys(a).sort(),
      );
      expect(b.contentHash, 'the deduped answer named a different blob').toBe(a.contentHash);
    } finally {
      await ctx.close();
    }
  });

  it('the dedup lock stays session-scoped and on the inserting client', () => {
    /**
     * With `unique(archive_id, content_hash)` gone the database no longer
     * refuses a duplicate, so dedup is a check-then-insert whose soundness
     * rests entirely on `lockHash`: SESSION-level, on the same client that
     * then selects and inserts.
     *
     * WHY THIS IS A STATIC CHECK AND NOT A RACE TEST. I wrote the race test
     * first -- ten concurrent identical uploads, assert one row. It PASSED
     * against a deliberately broken lock (`pg_advisory_xact_lock`, which
     * outside a transaction releases immediately and serializes nothing),
     * because the check-then-insert window is too narrow to lose reliably.
     * A concurrency test that goes green on the broken implementation claims
     * coverage it does not have, which is worse than no test. This one names
     * the specific regressions instead and actually fails on them.
     */
    const src = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), '../src/media.ts'),
      'utf8',
    );
    const lock = src.slice(src.indexOf('async function lockHash'));
    expect(lock.slice(0, 400), 'the dedup lock is no longer session-scoped').toContain(
      'pg_advisory_lock(',
    );
    expect(
      lock.slice(0, 400),
      'a transaction-scoped lock does not outlive its statement',
    ).not.toContain('pg_advisory_xact_lock(');
    // and the upload path must take it on the client it inserts with
    const upload = src.slice(src.indexOf("app.post('/v1/archives/:archiveId/media'"));
    const lockAt = upload.indexOf('lockHash(client');
    const selectAt = upload.indexOf('select id from public.media');
    const insertAt = upload.indexOf('insert into public.media');
    expect(lockAt, 'the upload path no longer locks on its own client').toBeGreaterThan(-1);
    expect(selectAt, 'the dedup select moved').toBeGreaterThan(-1);
    expect(insertAt, 'the upload insert moved').toBeGreaterThan(-1);
    // BOTH halves, not just the insert. An earlier version asserted only
    // lock < insert, which a reorder placing the lock BETWEEN the select and
    // the insert would satisfy while leaving the race wide open -- the whole
    // point is that the read and the write happen under one lock.
    expect(lockAt, 'the dedup select now happens before the lock is taken').toBeLessThan(selectAt);
    expect(selectAt, 'the insert no longer follows its own dedup select').toBeLessThan(insertAt);
  });
});
