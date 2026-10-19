import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { MEDIA_BUCKET } from '../src/media';

// Local Supabase stack (must be running — these tests FAIL when it is down; loop rule 1).
const SUPABASE_URL = process.env.FUNMEM_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const DB_URL =
  process.env.FUNMEM_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const ANON_KEY =
  process.env.FUNMEM_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
// service key is a TEST FIXTURE ONLY: mints real GoTrue sessions + owns the Storage
// client injected into the app. It never appears in an access-control assertion.
const SERVICE_KEY =
  process.env.FUNMEM_SERVICE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const pool = new Pool({ connectionString: DB_URL, max: 4 });
const admin: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

let app: App;
let setupError: unknown = null;

const RUN = randomUUID().slice(0, 8);

interface RealSession {
  token: string;
  userId: string;
}

/** Real GoTrue session via the magic-link token flow — no mocked auth. */
async function realSession(email: string): Promise<RealSession> {
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error && !/already/i.test(created.error.message)) throw created.error;
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error) throw link.error;
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let verified = await anon.auth.verifyOtp({
    type: 'email',
    token_hash: link.data.properties.hashed_token,
  });
  if (verified.error) {
    verified = await anon.auth.verifyOtp({
      type: 'magiclink',
      token_hash: link.data.properties.hashed_token,
    });
  }
  if (verified.error) throw verified.error;
  const session = verified.data.session;
  const user = verified.data.user;
  if (!session || !user) throw new Error('verifyOtp returned no session');
  return { token: session.access_token, userId: user.id };
}

/** JSON request helper against the in-process app. */
async function api(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Provision an archive through the real FM-014 endpoint. */
async function provisionArchive(s: RealSession, name: string): Promise<string> {
  const res = await api(s.token, 'POST', '/v1/provision', {
    subjectName: name,
    jurisdiction: 'KR',
  });
  if (res.status !== 201) throw new Error(`provision failed: ${res.status}`);
  const { archiveId } = (await res.json()) as { archiveId: string };
  return archiveId;
}

beforeAll(async () => {
  try {
    app = createApp({
      embeddings: null,
      pool,
      storage: admin,
      auth: {
        jwksUrl: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
        issuer: `${SUPABASE_URL}/auth/v1`,
      },
    });
    // bucket is declared in config.toml; creating it here keeps the suite
    // independent of a stack restart (db reset wipes bucket metadata)
    const made = await admin.storage.createBucket(MEDIA_BUCKET, { public: false });
    if (made.error && !/already exist/i.test(made.error.message)) throw made.error;
  } catch (e) {
    setupError = e;
  }
});

afterAll(async () => {
  await pool.end();
});

function requireSetup(): void {
  if (setupError) throw setupError;
}

/**
 * FM-039: the revisions list is metadata-only, so body assertions read through
 * the revision-by-id route. Kept as a helper so these tests keep asserting the
 * exact body text rather than being weakened to a length check.
 */
async function revisionBody(
  token: string,
  archive: string,
  noteId: string,
  revisionId: string,
): Promise<string> {
  const r = await api(
    token,
    'GET',
    `/v1/archives/${archive}/notes/${noteId}/revisions/${revisionId}`,
  );
  if (r.status !== 200) throw new Error(`revision fetch failed: ${r.status}`);
  return ((await r.json()) as { body: string }).body;
}

describe('FM-015 notes CRUD, version log, media', () => {
  it('note create read update append attributed revisions per edit', async () => {
    requireSetup();
    const s = await realSession(`crud-${RUN}@test.local`);
    const archive = await provisionArchive(s, `Crud ${RUN}`);

    const created = await api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: 'Beach Trip',
      type: 'event',
      body: 'We went with [[Mom]] to the sea.',
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const read = await api(s.token, 'GET', `/v1/archives/${archive}/notes/${id}`);
    expect(read.status).toBe(200);
    const note = (await read.json()) as Record<string, unknown>;
    expect(note.title).toBe('Beach Trip');
    expect(note.body).toBe('We went with [[Mom]] to the sea.');
    expect(note.createdBy).toBe(s.userId);

    const updated = await api(s.token, 'PUT', `/v1/archives/${archive}/notes/${id}`, {
      body: 'We went with [[Mom]] and [[Dad]].',
    });
    expect(updated.status).toBe(200);

    // every edit appended an attributed revision: create + update = 2, newest first
    const revs = await api(s.token, 'GET', `/v1/archives/${archive}/notes/${id}/revisions`);
    expect(revs.status).toBe(200);
    const revisions = (await revs.json()) as Array<{ id: string; author: string }>;
    expect(revisions).toHaveLength(2);
    expect(await revisionBody(s.token, archive, id, revisions[0]!.id)).toBe(
      'We went with [[Mom]] and [[Dad]].',
    );
    expect(await revisionBody(s.token, archive, id, revisions[1]!.id)).toBe(
      'We went with [[Mom]] to the sea.',
    );
    for (const r of revisions) expect(r.author).toBe(s.userId);

    // case-insensitive duplicate title in the same archive is refused, not swallowed
    const dup = await api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: '  BEACH TRIP ',
      type: 'event',
      body: 'dup',
    });
    expect(dup.status).toBe(409);
  });

  it('foreign and unknown notes and archives return uniform 404', async () => {
    requireSetup();
    const owner = await realSession(`owner15-${RUN}@test.local`);
    const stranger = await realSession(`stranger15-${RUN}@test.local`);
    const archive = await provisionArchive(owner, `Gate ${RUN}`);
    const created = await api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: 'Private Note',
      type: 'event',
      body: 'secret',
    });
    expect(created.status).toBe(201); // anti-vacuous anchor: the resource really exists
    const { id } = (await created.json()) as { id: string };

    const base = `/v1/archives/${archive}/notes/${id}`;
    // stranger: every verb, uniform 404 — never 403, no existence signal
    expect((await api(stranger.token, 'GET', base)).status).toBe(404);
    expect((await api(stranger.token, 'PUT', base, { body: 'x' })).status).toBe(404);
    expect((await api(stranger.token, 'GET', `${base}/revisions`)).status).toBe(404);
    expect((await api(stranger.token, 'GET', `${base}/backlinks`)).status).toBe(404);
    expect(
      (
        await api(stranger.token, 'POST', `/v1/archives/${archive}/notes`, {
          title: 'sneak',
          type: 'event',
          body: 'x',
        })
      ).status,
    ).toBe(404);
    // unknown/malformed ids are indistinguishable from foreign ones
    expect(
      (await api(owner.token, 'GET', `/v1/archives/${archive}/notes/${randomUUID()}`)).status,
    ).toBe(404);
    expect((await api(owner.token, 'GET', `/v1/archives/${archive}/notes/not-a-uuid`)).status).toBe(
      404,
    );
    expect((await api(owner.token, 'GET', `/v1/archives/${randomUUID()}/notes/${id}`)).status).toBe(
      404,
    );
    // owner still sees it (the 404s above were access decisions, not absence)
    expect((await api(owner.token, 'GET', base)).status).toBe(200);
  });

  it('media uploads are content addressed attributed and immutable', async () => {
    requireSetup();
    const s = await realSession(`media-${RUN}@test.local`);
    const stranger = await realSession(`mediastranger-${RUN}@test.local`);
    const archive = await provisionArchive(s, `Media ${RUN}`);
    const bytes = Buffer.from(`unique media payload ${RUN}`);
    const expectedHash = createHash('sha256').update(bytes).digest('hex');

    const upload = () =>
      app.request(`/v1/archives/${archive}/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/pdf' },
        body: bytes,
      });

    const first = await upload();
    expect(first.status).toBe(201);
    const media = (await first.json()) as { id: string; contentHash: string };
    expect(media.contentHash).toBe(expectedHash);

    // metadata row: content-addressed + attributed
    const row = await pool.query(
      `select content_hash, mime, bytes, created_by from public.media where archive_id = $1`,
      [archive],
    );
    expect(row.rows).toEqual([
      {
        content_hash: expectedHash,
        mime: 'application/pdf',
        bytes: String(bytes.length),
        created_by: s.userId,
      },
    ]);

    // the blob itself lives content-addressed in Storage and round-trips intact
    // (FM-040: source bytes now live at <archive>/<hash>/original)
    const blob = await admin.storage
      .from(MEDIA_BUCKET)
      .download(`${archive}/${expectedHash}/original`);
    expect(blob.error).toBeNull();
    expect(Buffer.from(await blob.data!.arrayBuffer()).equals(bytes)).toBe(true);

    // capture the stored object's identity BEFORE the duplicate upload — an
    // upsert:true regression would overwrite it and change updated_at.
    // FM-040: list ONE LEVEL DEEPER and match 'original'. Listing the archive
    // now yields a folder placeholder named <hash> with id:null, so the old
    // form made both comparisons below `null === null` — a tautology that a
    // real upsert regression passed.
    const objAt = async () =>
      (await admin.storage.from(MEDIA_BUCKET).list(`${archive}/${expectedHash}`)).data?.find(
        (o) => o.name === 'original',
      );
    const objBefore = await objAt();
    expect(objBefore).toBeDefined();
    expect(objBefore?.id).toBeTruthy(); // a real object, not a folder placeholder

    // re-upload of identical content dedups: same hash, same single row, blob unchanged
    const second = await upload();
    expect([200, 201]).toContain(second.status);
    // immutability: the duplicate upload was REJECTED by storage, not overwritten
    const objAfter = await objAt();
    expect(objAfter?.id).toBe(objBefore?.id);
    expect(objAfter?.updated_at).toBe(objBefore?.updated_at);
    // a mislabeled duplicate must not relabel the stored row either
    const relabeled = await app.request(`/v1/archives/${archive}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'image/png' },
      body: bytes,
    });
    // FM-057 made the dedup answer identical to a fresh upload's — in status
    // AND in every field. A distinct 200, or a `mime` echoing the stored row
    // rather than the request, told a caller the archive already held those
    // exact bytes, which is disclosure about a blob they may not read.
    expect(relabeled.status).toBe(201);
    expect(((await relabeled.json()) as { mime: string }).mime).toBe('image/png');
    // ...which is why the invariant this block exists for is now asserted
    // against the ROW. That is the real claim — a mislabeled duplicate must not
    // relabel stored media — and reading it from the database rather than
    // inferring it from the response is strictly stronger.
    const storedMime = await pool.query<{ mime: string }>(
      `select mime from public.media where archive_id = $1 and content_hash = $2`,
      [archive, expectedHash],
    );
    expect(storedMime.rows[0]!.mime, 'a mislabeled duplicate relabelled the stored row').toBe(
      'application/pdf',
    );
    const again = (await second.json()) as { id: string; contentHash: string };
    expect(again.contentHash).toBe(expectedHash);
    expect(again.id).toBe(media.id);
    const count = await pool.query(
      `select count(*)::int as n from public.media where archive_id = $1`,
      [archive],
    );
    expect(count.rows[0].n).toBe(1);

    // strangers cannot upload into a foreign archive — uniform 404
    const foreign = await app.request(`/v1/archives/${archive}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stranger.token}`, 'content-type': 'application/pdf' },
      body: bytes,
    });
    expect(foreign.status).toBe(404);
  });

  it('link occurrences reindex on save and backlinks endpoint serves them', async () => {
    requireSetup();
    const s = await realSession(`links-${RUN}@test.local`);
    const archive = await provisionArchive(s, `Links ${RUN}`);

    // A mentions Mom before the Mom note exists (unresolved occurrence)
    const a = await api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: 'Beach Trip',
      type: 'event',
      body: 'We went with [[Mom]] to the sea.\nIt was warm.',
    });
    expect(a.status).toBe(201);
    const noteA = ((await a.json()) as { id: string }).id;

    // creating Mom promotes the existing occurrence to resolved (FM-012 semantics)
    const b = await api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: 'Mom',
      type: 'person',
      body: 'She loves the sea.',
    });
    expect(b.status).toBe(201);
    const noteB = ((await b.json()) as { id: string }).id;

    const backs = await api(s.token, 'GET', `/v1/archives/${archive}/notes/${noteB}/backlinks`);
    expect(backs.status).toBe(200);
    const occurrences = (
      (await backs.json()) as {
        occurrences: Array<Record<string, unknown>>;
      }
    ).occurrences;
    expect(occurrences).toHaveLength(1);
    // the full FM-012 LinkOccurrence shape, not a subset
    const bodyA = 'We went with [[Mom]] to the sea.\nIt was warm.';
    const rawLink = '[[Mom]]';
    expect(occurrences[0]).toMatchObject({
      sourceId: noteA,
      target: 'Mom',
      resolvedId: noteB,
      embed: false,
      start: bodyA.indexOf(rawLink),
      end: bodyA.indexOf(rawLink) + rawLink.length,
      snippet: 'We went with [[Mom]] to the sea.',
    });
    expect(occurrences[0]?.heading).toBeUndefined();
    expect(occurrences[0]?.blockId).toBeUndefined();

    // editing A to drop the link reindexes on save: stale occurrence disappears
    const edit = await api(s.token, 'PUT', `/v1/archives/${archive}/notes/${noteA}`, {
      body: 'We went alone to the sea.',
    });
    expect(edit.status).toBe(200);
    const after = await api(s.token, 'GET', `/v1/archives/${archive}/notes/${noteB}/backlinks`);
    expect(((await after.json()) as { occurrences: unknown[] }).occurrences).toHaveLength(0);

    // renaming a note REWRITES referrer text (FM-016 / D-20 supersession): the
    // occurrence follows the renamed note, so a later note carrying the old
    // title has nothing to claim
    await api(s.token, 'PUT', `/v1/archives/${archive}/notes/${noteA}`, {
      body: 'Back with [[Mom]] again.',
    });
    const rename = await api(s.token, 'PUT', `/v1/archives/${archive}/notes/${noteB}`, {
      title: 'Grandma Kim',
    });
    expect(rename.status).toBe(200);
    const followed = await api(s.token, 'GET', `/v1/archives/${archive}/notes/${noteB}/backlinks`);
    const followedRows = (
      (await followed.json()) as {
        occurrences: Array<{ sourceId: string; target: string }>;
      }
    ).occurrences;
    expect(followedRows).toHaveLength(1);
    expect(followedRows[0]).toMatchObject({ sourceId: noteA, target: 'Grandma Kim' });
    const rewrittenA = await api(s.token, 'GET', `/v1/archives/${archive}/notes/${noteA}`);
    expect(((await rewrittenA.json()) as { body: string }).body).toBe(
      'Back with [[Grandma Kim]] again.',
    );
    const c2 = await api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: 'Mom',
      type: 'person',
      body: 'The new Mom note.',
    });
    expect(c2.status).toBe(201);
    const noteC = ((await c2.json()) as { id: string }).id;
    const claimed = await api(s.token, 'GET', `/v1/archives/${archive}/notes/${noteC}/backlinks`);
    expect(((await claimed.json()) as { occurrences: unknown[] }).occurrences).toHaveLength(0);
  });

  it('saving an unchanged note appends no revision and bumps no timestamp', async () => {
    requireSetup();
    const s = await realSession(`noop-${RUN}@test.local`);
    const archive = await provisionArchive(s, `Noop ${RUN}`);
    const created = await api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: `Noop note ${RUN}`,
      type: 'event',
      body: 'unchanged body',
    });
    const id = ((await created.json()) as { id: string }).id;

    const before = await pool.query<{ n: string; revised: string | null }>(
      `select (select count(*) from public.revisions where note_id = $1) as n,
              (select revised from public.notes where id = $1) as revised`,
      [id],
    );

    // the shape the real client sends: { body } alone. Comparing raw input.*
    // instead of the resolved locals makes undefined !== null and the guard
    // never fires — which is exactly the mutation this test must kill.
    const put = await api(s.token, 'PUT', `/v1/archives/${archive}/notes/${id}`, {
      body: 'unchanged body',
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { body: string }).body).toBe('unchanged body');

    const after = await pool.query<{ n: string; revised: string | null }>(
      `select (select count(*) from public.revisions where note_id = $1) as n,
              (select revised from public.notes where id = $1) as revised`,
      [id],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(after.rows[0]!.revised).toEqual(before.rows[0]!.revised);

    // negative control: a REAL change still appends, so the guard is not just
    // refusing every write
    const real = await api(s.token, 'PUT', `/v1/archives/${archive}/notes/${id}`, {
      body: 'changed body',
    });
    expect(real.status).toBe(200);
    const grew = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.revisions where note_id = $1`,
      [id],
    );
    expect(Number(grew.rows[0]!.n)).toBe(Number(before.rows[0]!.n) + 1);
  });

  it('restore from any revision creates a new attributed revision', async () => {
    requireSetup();
    const s = await realSession(`restore-${RUN}@test.local`);
    const archive = await provisionArchive(s, `Restore ${RUN}`);
    const created = await api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: 'Letter',
      type: 'source',
      body: 'version one',
    });
    const id = ((await created.json()) as { id: string }).id;
    await api(s.token, 'PUT', `/v1/archives/${archive}/notes/${id}`, { body: 'version two' });

    const revs = (await (
      await api(s.token, 'GET', `/v1/archives/${archive}/notes/${id}/revisions`)
    ).json()) as Array<{ id: string }>;
    expect(revs).toHaveLength(2);
    const bodies = await Promise.all(
      revs.map(async (r) => ({ id: r.id, body: await revisionBody(s.token, archive, id, r.id) })),
    );
    const revV1 = bodies.find((r) => r.body === 'version one');
    expect(revV1).toBeDefined();

    const restored = await api(s.token, 'POST', `/v1/archives/${archive}/notes/${id}/restore`, {
      revisionId: revV1!.id,
    });
    expect(restored.status).toBe(200);

    // head shows v1 again; history has THREE revisions (restore appended, rewrote nothing)
    const head = (await (
      await api(s.token, 'GET', `/v1/archives/${archive}/notes/${id}`)
    ).json()) as { body: string };
    expect(head.body).toBe('version one');
    const after = (await (
      await api(s.token, 'GET', `/v1/archives/${archive}/notes/${id}/revisions`)
    ).json()) as Array<{ id: string; author: string; reason: string }>;
    expect(after).toHaveLength(3);
    expect(after[0]?.author).toBe(s.userId);
    // FM-039: the restore is labelled as such, not as an ordinary edit
    expect(after[0]?.reason).toBe('restore');
    const afterBodies = await Promise.all(
      after.map((r) => revisionBody(s.token, archive, id, r.id)),
    );
    expect(afterBodies[0]).toBe('version one');
    expect(afterBodies).toContain('version two');
  });
});
