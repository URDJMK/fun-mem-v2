import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { testContext, type RealSession } from './helpers';

/**
 * FM-050 — Unicode NFC normalization across identity, links and export.
 *
 * Every fixture builds its NFD form with `.normalize('NFD')` and asserts the
 * BYTE LENGTH in the setup, not the assertion. A pasted "NFD" string that some
 * editor silently recomposed would otherwise make these tests pass while
 * testing nothing.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

/** 바다 — 6 bytes composed, 12 decomposed. */
const NFC_T = (r: string) => `바다${r}`.normalize('NFC');
const NFD_T = (r: string) => `바다${r}`.normalize('NFD');

afterAll(async () => {
  await ctx.close();
});

/**
 * Seed rows the CURRENT index forbids. A pre-migration archive held exactly
 * these, and the defence-in-depth paths (export sanitize, dedup) still have to
 * cope with any the repair pass missed. The index is restored in `finally`.
 */
async function withLegacyCollision<T>(archiveId: string, fn: () => Promise<T>): Promise<T> {
  await ctx.pool.query('drop index public.notes_archive_title_ci');
  try {
    return await fn();
  } finally {
    // PURGE FIRST. The rows this helper exists to create are exactly the rows
    // the index refuses, so leaving them behind makes the index unrestorable
    // and takes every later test in the file down with it.
    const c = await ctx.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('funmem.erasure', 'on', true)`);
      await c.query(`delete from public.notes where archive_id = $1`, [archiveId]);
      await c.query('commit');
    } catch {
      await c.query('rollback').catch(() => {});
    } finally {
      c.release();
    }
    await ctx.pool.query(
      `create unique index notes_archive_title_ci
         on public.notes (archive_id, normalize(lower(btrim(title)), NFC))`,
    );
  }
}

async function post(s: RealSession, archive: string, title: string, body = 'x') {
  return ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, { title, type: 'event', body });
}

async function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('not a zip'));
      const out = new Map<string, Buffer>();
      zip.on('entry', (e) => {
        if (e.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(e, (er, rs) => {
          if (er || !rs) return reject(er ?? new Error('no stream'));
          const cs: Buffer[] = [];
          rs.on('data', (c: Buffer) => cs.push(c));
          rs.on('end', () => {
            out.set(e.fileName, Buffer.concat(cs));
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

/** The SHIPPED repair SQL, extracted from the migration file by its own markers. */
function repairSql(): string {
  const dir = path.resolve(__dirname, '../../../supabase/migrations');
  const file = readdirSync(dir).find((f) => /nfc|normaliz/i.test(f));
  if (!file) throw new Error('FM-050 migration not found');
  const sql = readFileSync(path.join(dir, file), 'utf8');
  const m = /-- >>> FM-050 REPAIR BEGIN([\s\S]*?)-- <<< FM-050 REPAIR END/.exec(sql);
  if (!m) throw new Error('repair markers missing from the migration');
  return m[1]!;
}

describe('FM-050 unicode title normalization', () => {
  it('an NFD title collides with an existing NFC title in the same archive', async () => {
    const s = await ctx.realSession(`n1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `N1 ${RUN}`);
    const nfc = NFC_T(RUN);
    const nfd = NFD_T(RUN);
    // the fixture proves itself: same glyphs, different bytes
    expect(nfc).not.toBe(nfd);
    expect(Buffer.byteLength(nfc, 'utf8')).toBeLessThan(Buffer.byteLength(nfd, 'utf8'));

    // NFD FIRST, deliberately. Posting the composed form first lets a
    // non-canonicalizing write path store canonical bytes by luck; posting the
    // decomposed form first means only real canonicalization can satisfy the
    // stored-bytes assertion below.
    expect((await post(s, archive, nfd)).status).toBe(201);
    const second = await post(s, archive, nfc);
    expect(
      second.status,
      'two composition forms of one title were accepted as distinct notes',
    ).not.toBe(201);
    expect(second.status).toBeGreaterThanOrEqual(400);

    // and only one row exists, under the canonical form
    const rows = await ctx.pool.query<{ title: string }>(
      `select title from public.notes where archive_id = $1`,
      [archive],
    );
    expect(rows.rows).toHaveLength(1);
    // the row was WRITTEN decomposed and must have been canonicalized at the door
    expect(rows.rows[0]!.title, 'the stored title is not canonical').toBe(nfc);
    expect(Buffer.byteLength(rows.rows[0]!.title, 'utf8')).toBe(Buffer.byteLength(nfc, 'utf8'));
  });

  it('a wikilink typed in NFD resolves to an NFC-titled note', async () => {
    const s = await ctx.realSession(`n2-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `N2 ${RUN}`);
    const nfc = NFC_T(`t${RUN}`);
    const nfd = NFD_T(`t${RUN}`);
    expect(Buffer.byteLength(nfd, 'utf8')).toBeGreaterThan(Buffer.byteLength(nfc, 'utf8'));

    const target = await post(s, archive, nfc);
    const targetId = ((await target.json()) as { id: string }).id;
    // the REFERRER types the decomposed form, as a Korean IME may emit it
    await post(s, archive, `Ref ${RUN}`, `see [[${nfd}]] here.`);

    const link = await ctx.pool.query<{ resolved_id: string | null; target: string }>(
      `select resolved_id, target from public.links
        where archive_id = $1 and target <> '' order by start_pos limit 1`,
      [archive],
    );
    expect(link.rows[0]!.resolved_id, 'an NFD-authored wikilink did not resolve').toBe(targetId);
    // body bytes are NEVER rewritten — only the comparison is normalized
    expect(
      Buffer.byteLength(link.rows[0]!.target, 'utf8'),
      'the stored link target was rewritten',
    ).toBe(Buffer.byteLength(nfd, 'utf8'));
  });

  it('export dedups filenames that differ only by composition form', async () => {
    const s = await ctx.realSession(`n3-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `N3 ${RUN}`);
    const nfc = NFC_T(`x${RUN}`);
    const nfd = NFD_T(`x${RUN}`);
    // LEGACY rows: the shipped index now forbids these, which is the fix — but
    // a pre-migration archive held them, and the export must still not clobber.
    const files = await withLegacyCollision(archive, async () => {
      for (const t of [nfc, nfd]) {
        await ctx.pool.query(
          `insert into public.notes (archive_id, title, type, body, created_by)
           values ($1, $2, 'event', 'legacy', $3)`,
          [archive, t, s.userId],
        );
      }
      const res = await ctx.api(s.token, 'GET', `/v1/archives/${archive}/export`);
      expect(res.status).toBe(200);
      return unzip(Buffer.from(await res.arrayBuffer()));
    });
    const notes = [...files.keys()].filter((k) => k.startsWith('notes/'));

    expect(notes, 'one note was clobbered by a same-name entry').toHaveLength(2);
    expect(new Set(notes).size, 'two entries share a byte-identical name').toBe(2);
    // every emitted name is canonical, so extraction on any filesystem is safe
    for (const n of notes) expect(n, `${n} is not NFC`).toBe(n.normalize('NFC'));
  });

  it('the migration repairs a seeded collision deterministically', async () => {
    const s = await ctx.realSession(`n4-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `N4 ${RUN}`);
    const nfc = NFC_T(`m${RUN}`);
    const nfd = NFD_T(`m${RUN}`);

    const client = await ctx.pool.connect();
    try {
      await client.query('begin');
      // pre-migration state: the index this migration installs does not exist yet
      await client.query('drop index public.notes_archive_title_ci');
      const a = await client.query<{ id: string }>(
        `insert into public.notes (archive_id, title, type, body, created_by, created_at)
         values ($1,$2,'event','first',$3, now() - interval '1 day') returning id`,
        [archive, nfc, s.userId],
      );
      const b = await client.query<{ id: string }>(
        `insert into public.notes (archive_id, title, type, body, created_by, created_at)
         values ($1,$2,'event','second',$3, now()) returning id`,
        [archive, nfd, s.userId],
      );
      await client.query(
        `insert into public.links (archive_id, source_id, target, resolved_id, embed, start_pos, end_pos, snippet)
         values ($1,$2,$3,$4,false,0,1,'s')`,
        [archive, a.rows[0]!.id, nfd, b.rows[0]!.id],
      );

      // run the SHIPPED repair, not a copy of it
      await client.query(repairSql());

      const after = await client.query<{ id: string; title: string }>(
        `select id, title from public.notes where archive_id = $1 order by created_at`,
        [archive],
      );
      // the survivor is the earliest row and its bytes are untouched
      expect(after.rows[0]!.id).toBe(a.rows[0]!.id);
      expect(after.rows[0]!.title, 'the survivor was mutated').toBe(nfc);
      // the loser is renamed, with no wikilink metacharacters in the marker
      expect(after.rows[1]!.title).not.toBe(nfd);
      expect(after.rows[1]!.title).toMatch(/normalization-collision/);
      expect(after.rows[1]!.title, 'the marker can forge links').not.toMatch(/[[\]#^|]/);

      // no collisions remain, so the unique index could now be built
      const left = await client.query(
        `select 1 from public.notes where archive_id = $1
          group by normalize(lower(btrim(title)), NFC) having count(*) > 1`,
        [archive],
      );
      expect(left.rowCount, 'a collision survived the repair').toBe(0);

      // links to the renamed row are demoted, target bytes untouched
      const l = await client.query<{ resolved_id: string | null; target: string }>(
        `select resolved_id, target from public.links where archive_id = $1`,
        [archive],
      );
      expect(l.rows[0]!.resolved_id, 'a link still points at a renamed title').toBeNull();
      expect(Buffer.byteLength(l.rows[0]!.target, 'utf8')).toBe(Buffer.byteLength(nfd, 'utf8'));
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  });

  it('title resolution uses an index scan, not a sequential scan', async () => {
    const s = await ctx.realSession(`n5-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `N5 ${RUN}`);
    // A plan is only meaningful once the planner has a reason to prefer an
    // index, so seed enough rows and ANALYZE — the contract asks for proof, not
    // for an assertion that happens to hold on an empty table.
    await ctx.pool.query(
      `insert into public.notes (archive_id, title, type, body, created_by)
       select $1, 'Seed ' || g || ' ' || $2, 'event', 'b', $3 from generate_series(1, 2000) g`,
      [archive, RUN, s.userId],
    );
    await ctx.pool.query('analyze public.notes');

    // the production shape reindexLinks issues: archive_id equality AND the
    // normalized key, both spelled exactly as the index expression
    const plan = await ctx.pool.query<{ 'QUERY PLAN': string }>(
      `explain (analyze, buffers)
       select id, normalize(lower(btrim(title)), NFC) as norm from public.notes
        where archive_id = $1 and normalize(lower(btrim(title)), NFC) = any($2)`,
      [archive, [`seed 7 ${RUN}`.toLowerCase()]],
    );
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(text, `title resolution did not use the title index:\n${text}`).toContain(
      'notes_archive_title_ci',
    );
    expect(text, `title resolution fell back to a scan:\n${text}`).not.toMatch(/Seq Scan on notes/);

    // Plans depend on statistics; operand TEXT does not. Keep both: this is the
    // assertion that actually fails when a comparison site drifts.
    const src = readFileSync(path.resolve(__dirname, '../src/notes.ts'), 'utf8');
    const bare = src.match(/(?<!normalize\()lower\(btrim\(/g) ?? [];
    expect(bare, `${bare.length} un-normalized lower(btrim( site(s) remain`).toEqual([]);
  });

  it('importing a bundle with composition-form twin titles fails with an actionable error', async () => {
    const s = await ctx.realSession(`n6-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `N6 ${RUN}`);
    const nfc = NFC_T(`i${RUN}`);
    const nfd = NFD_T(`i${RUN}`);

    // A real, valid bundle first — then its notes.jsonl is replaced with twin
    // titles. Built by hand rather than exported from legacy rows, because the
    // point is the IMPORT validate phase, not a database constraint.
    await post(s, archive, `Seed ${RUN}`, 'seed');
    const exported = await ctx.api(s.token, 'GET', `/v1/archives/${archive}/export`);
    const files = await unzip(Buffer.from(await exported.arrayBuffer()));

    const rows = [nfc, nfd].map((t, i) => ({
      id: randomUUID(),
      path: `notes/twin${i}.md`,
      title: t,
      type: 'event',
      noteClass: 'testimony',
      occurred: null,
      recorded: null,
      revised: null,
      contributors: [],
      extra: {},
      createdBy: s.userId,
      createdAt: new Date().toISOString(),
    }));
    files.delete([...files.keys()].find((k) => k.startsWith('notes/'))!);
    for (const r of rows) files.set(r.path, Buffer.from(`---\nid: ${r.id}\n---\nbody\n`, 'utf8'));
    files.set(
      'data/notes.jsonl',
      Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n'),
    );
    // checksums must match, or THAT is what rejects the bundle
    const sums = [...files.entries()]
      .filter(([n]) => n !== 'checksums.sha256')
      .map(([n, b]) => `${createHash('sha256').update(b).digest('hex')}  ${n}`);
    files.set('checksums.sha256', Buffer.from(sums.join('\n') + '\n', 'utf8'));

    const { ZipFile } = await import('yazl');
    const zf = new ZipFile();
    for (const [n, d] of files) zf.addBuffer(d, n);
    zf.end();
    const zipped: Buffer = await new Promise((resolve, reject) => {
      const cs: Buffer[] = [];
      zf.outputStream.on('data', (c: Buffer) => cs.push(c));
      zf.outputStream.on('end', () => resolve(Buffer.concat(cs)));
      zf.outputStream.on('error', reject);
    });
    const form = new FormData();
    form.append('bundle', new Blob([new Uint8Array(zipped)], { type: 'application/zip' }), 'b.zip');
    const res = await ctx.app.request('/v1/import', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}` },
      body: form,
    });
    const payload = (await res.json()) as { error?: string };

    expect(res.status, JSON.stringify(payload)).toBe(400);
    // actionable: names the cause and the offending title, not
    // "import failed: [object Object]"
    expect(payload.error ?? '', 'the error does not say what went wrong').toMatch(
      /normaliz|composition|unicode/i,
    );
    expect(payload.error ?? '').toContain(nfc);
  });
});
