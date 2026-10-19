import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { testContext, type RealSession } from './helpers';

/**
 * FM-028 — full export and lossless import round-trip.
 *
 * Export is the product's trust guarantee (spec §4.2, principle 4). A silently
 * lossy export is worse than no export, so every assertion here compares
 * CONTENT, never counts: the ledger names "round-trip compared by counts" as
 * the forbidden shortcut, and a count passes while every field is wrong.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

// ------------------------------------------------------------------ helpers

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

async function exportBundle(s: RealSession, archive: string): Promise<Map<string, Buffer>> {
  const res = await ctx.api(s.token, 'GET', `/v1/archives/${archive}/export`);
  if (res.status !== 200) throw new Error(`export failed: ${res.status} ${await res.text()}`);
  return unzip(Buffer.from(await res.arrayBuffer()));
}

/** POST a bundle to the import route as multipart/form-data. */
async function importBundle(s: RealSession, files: Map<string, Buffer>): Promise<Response> {
  const zipped = await rezip(files);
  const form = new FormData();
  form.append('bundle', new Blob([new Uint8Array(zipped)], { type: 'application/zip' }), 'b.zip');
  return ctx.app.request('/v1/import', {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}` },
    body: form,
  });
}

/** Rebuild a zip from a file map so a test can mutate one byte and re-pack. */

/** Rewrite checksums.sha256 after editing a bundle in place. */
async function recomputeChecksums(files: Map<string, Buffer>): Promise<void> {
  const lines: string[] = [];
  for (const [name, bytes] of files) {
    if (name === 'checksums.sha256') continue;
    lines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  files.set('checksums.sha256', Buffer.from(lines.join('\n') + '\n', 'utf8'));
}

async function rezip(files: Map<string, Buffer>): Promise<Buffer> {
  const { ZipFile } = await import('yazl');
  const zf = new ZipFile();
  for (const [name, data] of files) zf.addBuffer(data, name);
  zf.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zf.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zf.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zf.outputStream.on('error', reject);
  });
}

/**
 * Build a single-entry STORED zip with an arbitrary entry name.
 *
 * yazl refuses every traversal form ('../x', 'C:\\x', '/etc/x') at addBuffer,
 * which is a good property of the writer but means a well-behaved library
 * cannot produce the bundle an attacker would send. So this writes the bytes
 * directly — otherwise the zip-slip assertion would only prove yazl works.
 */
function rawZip(entries: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.size, 8);
  eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

async function postZip(s: RealSession, zipped: Buffer): Promise<Response> {
  const form = new FormData();
  form.append('bundle', new Blob([new Uint8Array(zipped)], { type: 'application/zip' }), 'b.zip');
  return ctx.app.request('/v1/import', {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}` },
    body: form,
  });
}

const jsonl = (files: Map<string, Buffer>, name: string): Record<string, unknown>[] =>
  (files.get(name)?.toString('utf8') ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);

/**
 * Canonical, fully-materialized note rows. Never aggregates and never projects
 * to a subset — that is what makes the "compare by counts" shortcut impossible.
 */
async function canonNotes(archive: string): Promise<Record<string, unknown>[]> {
  const r = await ctx.pool.query(
    `select id, title, type::text, note_class::text, body, occurred, recorded,
            contributors, extra, created_at
       from public.notes where archive_id = $1 order by id`,
    [archive],
  );
  return r.rows;
}

async function canonAudiences(archive: string): Promise<Record<string, unknown>[]> {
  const r = await ctx.pool.query(
    `select note_id, kind::text, include_in_export from public.audiences
      where archive_id = $1 order by note_id`,
    [archive],
  );
  return r.rows;
}

/** Links compared on their nine CONTENT columns — never links.id, which is derived. */
async function canonLinks(archive: string): Promise<Record<string, unknown>[]> {
  const r = await ctx.pool.query(
    `select source_id, target, resolved_id, heading, block_id, embed, start_pos, end_pos, snippet
       from public.links where archive_id = $1
      order by source_id, start_pos, target`,
    [archive],
  );
  return r.rows;
}

/**
 * Erase an archive the way the product does. `revisions_no_mutate` refuses any
 * DELETE — including one arriving by FK cascade — unless the transaction opens
 * the FM-017 erasure door first (`notes.ts:459` does the same).
 */
async function dropArchive(archiveId: string): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('funmem.erasure', 'on', true)`);
    await client.query(`delete from public.archives where id = $1`, [archiveId]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function canonMedia(archive: string): Promise<Record<string, unknown>[]> {
  const r = await ctx.pool.query(
    `select id, content_hash, mime, bytes from public.media
      where archive_id = $1 order by id`,
    [archive],
  );
  return r.rows;
}

async function restrict(archive: string, noteId: string): Promise<void> {
  await ctx.pool.query(
    `insert into public.audiences (archive_id, note_id, kind)
     values ($1, $2, 'private-to-author')
     on conflict (note_id) do update set kind = excluded.kind`,
    [archive, noteId],
  );
}

async function addMember(archive: string, userId: string): Promise<void> {
  await ctx.pool.query(
    `insert into public.memberships (archive_id, user_id, role)
     values ($1, $2, 'contributor') on conflict do nothing`,
    [archive, userId],
  );
}

/** Upload a real original through the real route (raw body, not JSON). */
async function upload(s: RealSession, archive: string, bytes: Buffer, mime: string) {
  const r = await ctx.app.request(`/v1/archives/${archive}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': mime },
    body: new Uint8Array(bytes),
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`upload: ${r.status}`);
  return (await r.json()) as { id: string; contentHash: string };
}

async function note(
  s: RealSession,
  archive: string,
  title: string,
  body: string,
  extra?: Record<string, unknown>,
): Promise<string> {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body,
    ...extra,
  });
  if (res.status !== 201) throw new Error(`create '${title}': ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

// -------------------------------------------------------------------- tests

describe('FM-028 export and import', () => {
  it('the round trip reproduces every note field, not counts', async () => {
    const s = await ctx.realSession(`x1-${RUN}@test.local`);
    const src = await ctx.provisionArchive(s, `X1 ${RUN}`);

    // (a) every optional field populated, including a non-default note_class
    // and an audiences row; (b) every optional field absent, and NO audiences
    // row. A bug that drops a column produces identical counts either way.
    const full = await note(s, src, `Full ${RUN}`, `A rich note. ^anchor-1`, {
      occurred: '~1963',
      noteClass: 'entity',
      contributors: ['엄마'],
      extra: { mood: 'warm', takes: 3 },
    });
    // `occurred` outside the date grammar ('1963~'): the API refuses a NEW one (round-3 review
    // D10), but a row can hold one (written before that rule), and the bundle must carry it as is
    await ctx.pool.query(
      `update public.notes set contributors = $2, extra = $3, note_class = 'entity',
              recorded = '2026-07-19T04:11:02.417Z', occurred = '1963~'
        where id = $1`,
      [full, ['엄마'], JSON.stringify({ mood: 'warm', takes: 3 })],
    );
    await ctx.pool.query(
      `insert into public.audiences (archive_id, note_id, kind, include_in_export)
       values ($1, $2, 'archive-members', false) on conflict (note_id) do nothing`,
      [src, full],
    );
    const bare = await note(s, src, `Bare ${RUN}`, `Nothing optional set. Links [[Full ${RUN}]].`);
    // NULL occurred and the literal string 'unknown' are semantically distinct
    await ctx.pool.query(`update public.notes set occurred = null where id = $1`, [bare]);
    const unk = await note(s, src, `Unknown ${RUN}`, 'Undated on purpose.', {
      occurred: 'unknown',
    });
    // an ORIGINAL. Without one the media clause of DoD 3 is vacuous — which is
    // exactly how a round trip that silently discarded every attachment shipped
    // green the first time.
    const blob = Buffer.from(`a tiny original ${RUN}\n`, 'utf8');
    const up = await upload(s, src, blob, 'image/png');

    const before = {
      notes: await canonNotes(src),
      audiences: await canonAudiences(src),
      links: await canonLinks(src),
      media: await canonMedia(src),
    };

    const files = await exportBundle(s, src);
    // the archive is then LOST — which is what an export is for. Same-instance
    // UUID reuse is only legal once the originals are gone; a live collision is
    // covered by its own test.
    await dropArchive(src);
    const res = await importBundle(s, files);
    // read the body ONCE: an `await res.text()` inside the assertion message is
    // evaluated eagerly and consumes it before res.json() can
    const payload = (await res.json()) as { archiveId?: string; error?: string };
    expect(res.status, JSON.stringify(payload)).toBe(201);
    const dst = payload.archiveId!;
    expect(dst).not.toBe(src);

    // toStrictEqual, deliberately: it distinguishes {note_class: undefined}
    // from {} — exactly the KNOWN_KEYS-drop failure mode.
    expect(await canonNotes(dst)).toStrictEqual(before.notes);
    expect(await canonAudiences(dst)).toStrictEqual(before.audiences);
    expect(await canonLinks(dst)).toStrictEqual(before.links);
    expect(await canonMedia(dst), 'media rows were not restored').toStrictEqual(before.media);

    // DoD 3 asserts the BYTES, not the row: the blob must be back in Storage and
    // must hash to the name it is filed under.
    const restored = await ctx.admin.storage
      .from('media')
      .download(`${dst}/${up.contentHash}/original`);
    expect(restored.error, 'the original was never restored to Storage').toBeNull();
    const got = Buffer.from(await restored.data!.arrayBuffer());
    expect(createHash('sha256').update(got).digest('hex')).toBe(up.contentHash);
    expect(got.equals(blob), 'restored bytes differ from the original').toBe(true);

    // ...and REACHABLE, which the Storage check above cannot show: it reads
    // with the service key, which bypasses every access rule. FM-057 derives a
    // blob's audience from who introduced its embed, so an import that recorded
    // the wrong uploader restores bytes that no user can ever read — a bundle
    // that imports "successfully" into an archive of broken images.
    const readBack = await ctx.app.request(`/v1/archives/${dst}/media/by-hash/${up.contentHash}`, {
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(readBack.status, 'the restored attachment is unreadable through the API').toBe(200);
    expect(Buffer.from(await readBack.arrayBuffer()).equals(blob)).toBe(true);

    // and the two traps, asserted directly so a regression names itself
    const rows = await canonNotes(dst);
    expect(rows.find((r) => r.id === bare)!.occurred, 'NULL occurred was coerced').toBeNull();
    expect(rows.find((r) => r.id === unk)!.occurred).toBe('unknown');
    expect(rows.find((r) => r.id === full)!.note_class, 'note_class reverted to default').toBe(
      'entity',
    );
    expect(rows.find((r) => r.id === full)!.extra).toStrictEqual({ mood: 'warm', takes: 3 });
  });

  it("a restricted note never appears in a co-member's bundle", async () => {
    const author = await ctx.realSession(`x2a-${RUN}@test.local`);
    const other = await ctx.realSession(`x2b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(author, `X2 ${RUN}`);
    await addMember(archive, other.userId);

    const SECRET = `ZZSECRET${RUN}`;
    const OPEN = `ZZOPEN${RUN}`;
    // The marker lives ONLY in the restricted note's BODY. Its title is plain,
    // because the visible note links to it by title, and that link text is the
    // author's own words inside a note the reader is allowed to read. Quoting
    // a title is not the leak; disclosing the restricted body, id or file is.
    const secretTitle = `Private note ${RUN}`;
    const secretId = await note(author, archive, secretTitle, `never told a soul. ${SECRET}`);
    await note(author, archive, `Open ${OPEN}`, `shared freely. ${OPEN} and [[${secretTitle}]].`);
    await restrict(archive, secretId);

    const files = await exportBundle(other, archive);
    const everything = Buffer.concat([...files.values()]).toString('utf8');
    const names = [...files.keys()].join('\n');

    // negative control: the export ran and did contain the visible note
    expect(everything, 'the export produced nothing — the query never matched').toContain(OPEN);

    // named, not just flagged: a bare boolean here cost a debugging round-trip
    const offenders = [...files.entries()]
      .filter(([, b]) => b.toString('utf8').includes(SECRET))
      .map(([n]) => n);
    expect(offenders, 'the restricted note leaked into the bundle').toEqual([]);
    expect(everything, 'the restricted note UUID leaked').not.toContain(secretId);
    expect(names, 'the restricted note got its own file').not.toContain(secretTitle);
    // a link stub carrying resolvedId is still a disclosure
    for (const l of jsonl(files, 'data/links.jsonl')) {
      expect(l.resolvedId).not.toBe(secretId);
    }
    // and no credential or address ever ships
    expect(everything).not.toContain('@test.local');
    expect(everything).not.toContain('service_role');
  });

  it('import rejects a colliding note uuid and writes nothing', async () => {
    const s = await ctx.realSession(`x3-${RUN}@test.local`);
    const src = await ctx.provisionArchive(s, `X3a ${RUN}`);
    const keep = await note(s, src, `Original ${RUN}`, 'the original body, untouched.');
    const files = await exportBundle(s, src);

    const beforeRow = (await ctx.pool.query(`select * from public.notes where id = $1`, [keep]))
      .rows[0];

    // importing the same bundle again: its note UUIDs already exist
    const res = await importBundle(s, files);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/uuid|collision/i);

    // the original is byte-identical and nothing new was written anywhere
    expect(
      (await ctx.pool.query(`select * from public.notes where id = $1`, [keep])).rows[0],
    ).toStrictEqual(beforeRow);
    const strays = await ctx.pool.query(
      `select count(*)::int n from public.notes
        where created_by = $1 and archive_id <> $2`,
      [s.userId, src],
    );
    expect(strays.rows[0].n, 'a partial import survived the rejection').toBe(0);
  });

  it('import aborts on a corrupted checksum and on a traversal path, writing nothing', async () => {
    const s = await ctx.realSession(`x4-${RUN}@test.local`);
    const src = await ctx.provisionArchive(s, `X4 ${RUN}`);
    await note(s, src, `Sound ${RUN}`, 'a perfectly good note.');
    const clean = await exportBundle(s, src);

    const archivesAfterDrop = async (): Promise<number> =>
      (
        await ctx.pool.query<{ n: number }>(
          `select count(*)::int n from public.archives a
             join public.memberships m on m.archive_id = a.id where m.user_id = $1`,
          [s.userId],
        )
      ).rows[0]!.n;

    // The source archive is removed first, so a UUID collision cannot stand in
    // for the rejection we are actually testing. Without this, deleting the
    // checksum guard still yields 409 and a status-only assertion passes.
    await dropArchive(src);

    // (1) flip one byte inside a note, leaving checksums.sha256 untouched
    const tampered = new Map(clean);
    const mdName = [...clean.keys()].find((k) => k.startsWith('notes/'))!;
    const body = Buffer.from(clean.get(mdName)!);
    body[body.length - 1] = body[body.length - 1]! ^ 0x01;
    tampered.set(mdName, body);
    const r1 = await importBundle(s, tampered);
    const e1 = (await r1.json()) as { error?: string };
    expect(r1.status, `a corrupted bundle was accepted: ${JSON.stringify(e1)}`).toBe(400);
    // the CHECKSUM must be what rejected it, not some later incidental failure
    expect(e1.error, 'rejected for the wrong reason').toMatch(/checksum mismatch/i);

    // (2) a zip-slip entry must be refused before anything is written. Built by
    // hand: yazl refuses '../x', '/x' and 'C:\\x' at addBuffer, so a real
    // attacker's bundle cannot be produced with it. Its checksum is ALSO listed
    // correctly, so the checksum gate passes and only the path guard can reject
    // — otherwise removing the path guard still fails on "not listed".
    const evil = Buffer.from('pwned');
    const slip = new Map(clean);
    slip.set('../../evil.md', evil);
    slip.set(
      'checksums.sha256',
      Buffer.from(
        clean.get('checksums.sha256')!.toString('utf8') +
          `${createHash('sha256').update(evil).digest('hex')}  ../../evil.md\n`,
        'utf8',
      ),
    );
    const r2 = await postZip(s, rawZip(slip));
    const e2 = (await r2.json()) as { error?: string };
    expect(r2.status, `a traversal path was accepted: ${JSON.stringify(e2)}`).toBe(400);
    expect(e2.error, 'rejected for the wrong reason').toMatch(/unsafe path/i);

    // neither attempt created an archive — validation precedes every write
    expect(await archivesAfterDrop(), 'a rejected import still provisioned an archive').toBe(0);
  });

  it('import records exactly one import revision per note', async () => {
    const s = await ctx.realSession(`x5-${RUN}@test.local`);
    const src = await ctx.provisionArchive(s, `X5 ${RUN}`);
    for (let i = 0; i < 3; i++) await note(s, src, `Note ${i} ${RUN}`, `body number ${i}.`);
    const files = await exportBundle(s, src);
    await dropArchive(src);

    const res = await importBundle(s, files);
    // read the body ONCE: an `await res.text()` inside the assertion message is
    // evaluated eagerly and consumes it before res.json() can
    const payload = (await res.json()) as { archiveId?: string; error?: string };
    expect(res.status, JSON.stringify(payload)).toBe(201);
    const dst = payload.archiveId!;

    const revs = await ctx.pool.query<{ reason: string; n: string }>(
      `select reason::text, count(*)::text as n from public.revisions
        where archive_id = $1 group by reason`,
      [dst],
    );
    // a machine bulk-write must never read as a person authoring their own words
    expect(revs.rows.map((r) => [r.reason, Number(r.n)])).toStrictEqual([['import', 3]]);

    const cid = await ctx.pool.query<{ n: string }>(
      `select count(distinct change_id)::text as n from public.revisions where archive_id = $1`,
      [dst],
    );
    expect(Number(cid.rows[0]!.n), 'each imported note got its own change_id').toBe(1);
  });

  it('every wikilink in the bundle resolves to a file that is in the bundle', async () => {
    const s = await ctx.realSession(`x6-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `X6 ${RUN}`);
    const target = `Grandmother ${RUN}`;
    await note(s, archive, target, 'She kept letters.');
    await note(s, archive, `Seaside ${RUN}`, `We walked with [[${target}]] past the pier.`);
    // an intentionally dangling link: unresolved at source stays unresolved,
    // and must NOT be reported as a broken vault
    await note(s, archive, `Dangling ${RUN}`, `Refers to [[Nobody ${RUN}]] who has no note.`);

    const files = await exportBundle(s, archive);
    const noteFiles = [...files.keys()].filter((k) => k.startsWith('notes/'));
    expect(noteFiles.length).toBeGreaterThan(0);
    // a vault carries no app config
    expect([...files.keys()].some((k) => k.includes('.obsidian'))).toBe(false);

    const stems = new Set(
      noteFiles.map((k) =>
        k
          .replace(/^notes\//, '')
          .replace(/\.md$/, '')
          .toLowerCase(),
      ),
    );
    const unresolvedAtSource = new Set(
      (
        await ctx.pool.query<{ target: string }>(
          `select target from public.links where archive_id = $1 and resolved_id is null`,
          [archive],
        )
      ).rows.map((r) => r.target.trim().toLowerCase()),
    );

    for (const f of noteFiles) {
      const text = files.get(f)!.toString('utf8');
      for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) {
        const t = m[1]!.trim().toLowerCase();
        if (unresolvedAtSource.has(t)) continue;
        expect(stems.has(t), `[[${m[1]!.trim()}]] in ${f} points outside the bundle`).toBe(true);
      }
    }

    // checksums cover every file but themselves
    const sums = files.get('checksums.sha256')!.toString('utf8');
    for (const [name, bytes] of files) {
      if (name === 'checksums.sha256') continue;
      const want = createHash('sha256').update(bytes).digest('hex');
      expect(sums, `${name} missing from checksums.sha256`).toContain(name);
      expect(sums, `${name} checksum wrong`).toContain(want);
    }
  });

  it('a photograph keeps its memory across export and re-import', async () => {
    /**
     * FM-060's FIRST blocking review finding was that export silently did not
     * carry `note_id` while the close notes claimed it did -- so every imported
     * photograph lost its memory and became readable only by the importer.
     *
     * This asserts the ROUND TRIP, not the zip: the archive is erased and the
     * bundle re-imported, because checking the export half alone is exactly the
     * mistake that shipped last time.
     */
    const s = await ctx.realSession(`fm067a-${RUN}@test.local`);
    const src = await ctx.provisionArchive(s, `FM067A ${RUN}`);
    const memory = await note(s, src, `제주도 여행 ${RUN}`, '가족 여행');

    const up = await ctx.app.request(`/v1/archives/${src}/media?note=${memory}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${s.token}`,
        'content-type': 'image/png',
        'x-filename': encodeURIComponent('할머니_생신.HEIC'),
      },
      body: new Uint8Array(Buffer.from(`ZZTRIP${RUN}\n`, 'utf8')),
    });
    expect(up.status).toBe(201);

    const files = await exportBundle(s, src);
    await dropArchive(src);
    const res = await importBundle(s, files);
    const payload = (await res.json()) as { archiveId?: string; error?: string };
    expect(res.status, JSON.stringify(payload)).toBe(201);

    const restored = await ctx.pool.query<{ note_id: string | null; filename: string | null }>(
      `select m.note_id, m.filename from public.media m where m.archive_id = $1`,
      [payload.archiveId],
    );
    expect(restored.rowCount, 'the photograph did not survive the round trip').toBe(1);
    expect(restored.rows[0]!.note_id, 'the photograph lost its memory on import').toBe(memory);
    expect(restored.rows[0]!.filename, 'the filename did not travel').toBe('할머니_생신.HEIC');

    // and the restored association points at a note that actually exists here
    const n = await ctx.pool.query(`select 1 from public.notes where id = $1 and archive_id = $2`, [
      restored.rows[0]!.note_id,
      payload.archiveId,
    ]);
    expect(n.rowCount, 'note_id resolved to a note outside the imported archive').toBe(1);
  });

  it('import resolves the memory rather than copying its id', async () => {
    /**
     * A media row reaches a bundle through the visibility predicate; its memory
     * may not travel with it. Copying `note_id` verbatim would leave a dangling
     * reference into a note that does not exist in the new archive.
     *
     * Here the bundle is edited to name a note id that is NOT in it, which is
     * what a partial export produces. The row must land with note_id NULL --
     * failing closed to uploader-only -- rather than carrying a broken pointer.
     */
    const s = await ctx.realSession(`fm067b-${RUN}@test.local`);
    const src = await ctx.provisionArchive(s, `FM067B ${RUN}`);
    const memory = await note(s, src, `기억 ${RUN}`, '사진 한 장');
    const up = await ctx.app.request(`/v1/archives/${src}/media?note=${memory}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'image/png' },
      body: new Uint8Array(Buffer.from(`ZZRESOLVE${RUN}\n`, 'utf8')),
    });
    expect(up.status).toBe(201);

    const files = await exportBundle(s, src);
    const mediaPath = [...files.keys()].find((k) => k.endsWith('media.jsonl'))!;
    const orphan = randomUUID();
    const rewritten = files
      .get(mediaPath)!
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const row = JSON.parse(line) as Record<string, unknown>;
        row.note_id = orphan; // a memory that is not in this bundle
        return JSON.stringify(row);
      })
      .join('\n');
    files.set(mediaPath, Buffer.from(rewritten + '\n', 'utf8'));
    await recomputeChecksums(files);

    await dropArchive(src);
    const res = await importBundle(s, files);
    const payload = (await res.json()) as { archiveId?: string; error?: string };
    expect(res.status, JSON.stringify(payload)).toBe(201);

    const row = await ctx.pool.query<{ note_id: string | null }>(
      `select note_id from public.media where archive_id = $1`,
      [payload.archiveId],
    );
    expect(
      row.rows[0]!.note_id,
      'import copied a dangling memory id instead of resolving',
    ).toBeNull();
  });

  it('the bundle carries no photograph the owner cannot see', async () => {
    /**
     * Export composes the same `mediaVisibleSql` every read surface uses. Under
     * FM-064 that is the home-note rule, so a photograph in a memory the
     * exporter cannot read must not appear -- neither its bytes nor its row.
     */
    const owner = await ctx.realSession(`fm067c-${RUN}@test.local`);
    const other = await ctx.realSession(`fm067d-${RUN}@test.local`);
    const src = await ctx.provisionArchive(owner, `FM067C ${RUN}`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role)
       values ($1, $2, 'contributor') on conflict do nothing`,
      [src, other.userId],
    );

    // the OTHER member's photograph, in their own private memory
    const theirs = await note(other, src, `그들의 비공개 ${RUN}`, '');
    await ctx.pool.query(
      `insert into public.audiences (archive_id, note_id, kind)
       values ($1, $2, 'private-to-author') on conflict (note_id) do update set kind = excluded.kind`,
      [src, theirs],
    );
    const hidden = await ctx.app.request(`/v1/archives/${src}/media?note=${theirs}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${other.token}`, 'content-type': 'image/png' },
      body: new Uint8Array(Buffer.from(`ZZPRIVATE${RUN}\n`, 'utf8')),
    });
    expect(hidden.status).toBe(201);
    const hiddenHash = ((await hidden.json()) as { contentHash: string }).contentHash;

    const files = await exportBundle(owner, src);
    const mediaPath = [...files.keys()].find((k) => k.endsWith('media.jsonl'));
    const body = mediaPath ? files.get(mediaPath)!.toString('utf8') : '';
    expect(body, "another member's private photograph is in the bundle").not.toContain(hiddenHash);
    for (const name of files.keys()) {
      expect(name, 'the hidden blob was attached to the bundle').not.toContain(hiddenHash);
    }
  });
});
