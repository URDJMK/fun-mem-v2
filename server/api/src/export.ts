import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import yauzl, { type ZipFile as ReadZip, type Entry } from 'yauzl';
import type { PoolClient } from 'pg';
import { canonicalTitle, normalizeTitle, noteToMarkdown, validateNoteTitle } from '@funmem/core';
import type { App, AppDeps } from './app';
import { isMember } from './membership';
import { mediaVisibleSql, visibleSql } from './views';
import { MEDIA_BUCKET, mediaOriginalKey } from './media';
import { appendRevision, reindexLinks } from './notes';
import { reindexChunks } from './chunks';
import { provisionSignup } from './provision';

/**
 * FM-028 — full export and lossless import round-trip.
 *
 * Export is the product's trust guarantee (spec §4.2, principle 4: "local
 * ownership and graceful exit"). A silently lossy export is worse than no
 * export, so the bundle states what it does NOT carry as loudly as what it does.
 *
 * TWO ARTEFACTS, DELIBERATELY. `notes/*.md` is the human/Obsidian artefact and
 * carries the BODY. `data/notes.jsonl` is machine-authoritative for every
 * column. That split is load-bearing three times over:
 *   - `note_class` has no frontmatter slot (`KNOWN_KEYS` in core), so a
 *     markdown-only import would silently revert every note to the default;
 *   - `noteFromMarkdown` routes `occurred` through `parseFuzzyDate` and THROWS
 *     outside the grammar, so a row written by raw SQL would export fine and
 *     then crash import — the jsonl carries `occurred` as an opaque string;
 *   - NULL `occurred` and the literal string 'unknown' are distinct, and
 *     YAML round-tripping cannot preserve that difference.
 */

export const BUNDLE_SCHEMA_VERSION = '1.0';
/** Refuse a bundle larger than this outright, before unzipping (zip-bomb floor). */
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

/**
 * Attachments are named by content hash, which carries no type. Without a
 * suffix neither Finder nor Obsidian will render an exported photo as an image,
 * so the stored `mime` supplies one. Unknown types get no extension rather than
 * a guessed one.
 */
function extensionFor(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/heic': '.heic',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'audio/ogg': '.ogg',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
  };
  return map[mime.split(';')[0]!.trim().toLowerCase()] ?? '';
}

/** Filenames are a display concern; `data/notes.jsonl[].path` is the authority. */
function sanitize(title: string): string {
  return (
    title
      // Reserved on Windows, meaningful to a path, or a control byte. All are
      // REPLACED rather than removed, so two distinct titles cannot collapse
      // onto one name here; the `(n)` suffix loop is the backstop for the rest.
      // Written as \u escapes deliberately: literal control bytes in this file
      // made git classify it as binary, which hid the entire implementation
      // from the G7b trust-path diff review.
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/[\u0000-\u001f\u007f]/g, '-')
      // FM-050 defence in depth: the index now prevents two forms coexisting,
      // but a legacy row a repair pass missed must still not collide here
      .normalize('NFC')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 120) || 'untitled'
  );
}

interface NoteRow {
  id: string;
  title: string;
  type: string;
  note_class: string;
  body: string;
  occurred: string | null;
  recorded: string | null;
  revised: string | null;
  contributors: string[];
  extra: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

const README = (archiveId: string, counts: Record<string, number>, omissions: string[]) =>
  `# Your fun_mem archive

This folder is your memories, in plain files. It does not need fun_mem to open.

## What is here

- \`notes/\` — one Markdown file per memory. Open the folder as an Obsidian vault,
  or read them in any text editor. \`[[Double bracket]]\` links point at other files here.
- \`attachments/\` — the original files that were uploaded, named by content.
- \`data/\` — the same information as machine-readable JSONL, including the
  identifiers and dates that keep links working if you import this again.
- \`checksums.sha256\` — verify nothing was corrupted:
  \`shasum -c checksums.sha256\`
- \`manifest.json\` — versions and counts.

## What is NOT here

${omissions.map((o) => `- ${o}`).join('\n')}

## Contents

${Object.entries(counts)
  .map(([k, v]) => `- ${v} ${k}`)
  .join('\n')}

Exported from archive \`${archiveId}\`. Bundle format ${BUNDLE_SCHEMA_VERSION}.
`;

const OMISSIONS = [
  // Rewritten four times in FM-057, and three of those rewrites stated a rule
  // the predicate did not implement -- each caught by review. This one is short
  // because the RULE is now short: derived visibility is gone, so a file is
  // yours or it is not. The lesson is in the record: a user-facing sentence
  // describing an access rule must be re-read every time that rule changes.
  "Photographs are stored by content inside this bundle, not under the name you uploaded them by. That original name is kept when your device sent one, and it travels with the photograph. A photograph is in your bundle when the memory it belongs to is — the limitation that used to keep other people's photographs out of your bundle is gone, so a photograph someone else uploaded into a memory you can read now comes with it. Photographs in memories you cannot read are not included: neither the image nor its record. A memory you CAN read may still refer to one of them in its text; that reference stays, because it is part of what that memory says. A few older photographs belong to no memory at all; those come to whoever uploaded them and to nobody else. Older still, a handful have no recorded uploader either; those reach nobody, and only an archive owner can remove them.",
  'Sharing settings are carried, but `include_in_export` is not read by anything in the product today.',
  'Consent records are copied exactly if any exist. No part of the product writes them yet.',
  'Archive, tenant and membership identifiers are NOT restored on import — a new archive is created and you become its owner. The original archive id is in `manifest.json` as provenance only.',
  'Edit history is included in `data/revisions.jsonl` for reading, but is not restored on import.',
  'Whole numbers larger than 9,007,199,254,740,991 inside a note’s custom fields lose precision.',
];

export function registerExportRoutes(app: App, deps: AppDeps): void {
  // ------------------------------------------------------------------ export
  app.get('/v1/archives/:archiveId/export', async (c) => {
    const archiveId = c.req.param('archiveId');
    const userId = c.get('userId');
    if (!archiveId || !(await isMember(deps.pool, userId, archiveId))) {
      return c.json({ error: 'not found' }, 404);
    }

    // ACL FIRST, exactly like every other read surface: the visible set bounds
    // everything downstream, so a restricted note cannot reach the bundle
    // through notes, links, audiences or revisions.
    const notes = await deps.pool.query<NoteRow>(
      `select id, title, type::text, note_class::text, body, occurred, recorded, revised,
              contributors, extra, created_by, created_at
         from public.notes n
        where n.archive_id = $1 and ${visibleSql('n', '$2')}
        order by id`,
      [archiveId, userId],
    );

    // both endpoints must be visible: a link FROM a visible note TO a
    // restricted one still discloses that the restricted note exists.
    const links = await deps.pool.query(
      `select l.source_id, l.target, l.resolved_id, l.heading, l.block_id, l.embed,
              l.start_pos, l.end_pos, l.snippet
         from public.links l
         join public.notes src on src.id = l.source_id and ${visibleSql('src', '$2')}
         left join public.notes tgt on tgt.id = l.resolved_id
        where l.archive_id = $1
          and (l.resolved_id is null or ${visibleSql('tgt', '$2')})
        order by l.source_id, l.start_pos`,
      [archiveId, userId],
    );
    const audiences = await deps.pool.query(
      `select a.note_id, a.kind::text, a.include_in_export
         from public.audiences a
         join public.notes n on n.id = a.note_id and ${visibleSql('n', '$2')}
        where a.archive_id = $1 order by a.note_id`,
      [archiveId, userId],
    );
    // FM-057: this was the one query in the handler with no audience predicate,
    // and it is the one that decides which BLOBS are streamed — a co-member got
    // every original in the archive, including photographs attached only to
    // notes they cannot read. `media` carries no note column, so the predicate
    // is the uploader rule; see mediaVisibleSql.
    const media = await deps.pool.query(
      `select m.id, m.content_hash, m.mime, m.bytes, m.created_by, m.created_at,
              m.note_id, m.filename
         from public.media m
        where m.archive_id = $1 and ${mediaVisibleSql('m', '$1', '$2')}
        order by m.id`,
      [archiveId, userId],
    );
    const revisions = await deps.pool.query(
      `select r.id, r.note_id, r.author, r.title, r.reason::text, r.change_id, r.created_at
         from public.revisions r
         join public.notes n on n.id = r.note_id and ${visibleSql('n', '$2')}
        where r.archive_id = $1 order by r.seq`,
      [archiveId, userId],
    );
    const consents = await deps.pool.query(
      `select id, person, scope::text, audience, purpose, version, state::text, created_at
         from public.consents where archive_id = $1 order by id`,
      [archiveId],
    );
    const migrations = await deps.pool
      .query<{ name: string }>(
        `select name from supabase_migrations.schema_migrations order by version`,
      )
      .then((r) => r.rows.map((x) => x.name))
      .catch(() => [] as string[]);

    const zip = new ZipFile();
    const sums: string[] = [];
    const add = (name: string, data: Buffer | string): void => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      // hash exactly the bytes that go in, never a value copied from elsewhere
      sums.push(`${createHash('sha256').update(buf).digest('hex')}  ${name}`);
      zip.addBuffer(buf, name);
    };

    // one markdown file per note; collisions after sanitization get a suffix,
    // and `path` in the jsonl is what import trusts
    const used = new Set<string>();
    const paths = new Map<string, string>();
    for (const n of notes.rows) {
      const base = sanitize(n.title);
      let name = `${base}.md`;
      // Lowercase then NFC — the same order as core's normalizeTitle, so this
      // key and the DB uniqueness rule agree. A .toLowerCase()-only set permits
      // the exact collision it exists to prevent, because two composition forms
      // lowercase to different strings.
      const key = (n: string) => n.toLowerCase().normalize('NFC');
      for (let i = 2; used.has(key(name)); i++) name = `${base} (${i}).md`;
      used.add(key(name));
      paths.set(n.id, `notes/${name}`);
    }

    for (const n of notes.rows) {
      add(
        paths.get(n.id)!,
        noteToMarkdown({
          id: n.id,
          title: n.title,
          body: n.body,
          meta: {
            type: n.type as never,
            // raw string, never re-parsed — see the header note on trap B5
            ...(n.occurred ? { occurred: { raw: n.occurred, kind: 'unknown' as const } } : {}),
            ...(n.recorded ? { recorded: n.recorded } : {}),
            ...(n.revised ? { revised: n.revised } : {}),
            ...(n.contributors.length > 0 ? { contributors: n.contributors } : {}),
            extra: n.extra,
          },
        }),
      );
    }

    const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    add(
      'data/notes.jsonl',
      jsonl(
        notes.rows.map((n) => ({
          id: n.id,
          path: paths.get(n.id),
          title: n.title,
          type: n.type,
          noteClass: n.note_class,
          occurred: n.occurred, // null and 'unknown' stay distinct
          recorded: n.recorded,
          revised: n.revised,
          contributors: n.contributors,
          extra: n.extra,
          createdBy: n.created_by,
          createdAt: n.created_at,
          bodySha256: createHash('sha256').update(n.body, 'utf8').digest('hex'),
        })),
      ),
    );
    add('data/links.jsonl', jsonl(links.rows));
    add('data/audiences.jsonl', jsonl(audiences.rows));
    add(
      'data/media.jsonl',
      jsonl(
        media.rows.map((m) => ({
          ...m,
          // authoritative id<->file mapping: the extension is derived from mime,
          // so import must not have to guess it back
          path: `attachments/${m.content_hash as string}${extensionFor(m.mime as string)}`,
        })),
      ),
    );
    add('data/revisions.jsonl', jsonl(revisions.rows));
    add('data/consents.jsonl', jsonl(consents.rows));

    const counts = {
      notes: notes.rowCount ?? 0,
      links: links.rowCount ?? 0,
      attachments: media.rowCount ?? 0,
      'sharing settings': audiences.rowCount ?? 0,
    };
    add(
      'manifest.json',
      JSON.stringify(
        {
          bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
          exportedAt: new Date().toISOString(),
          sourceArchiveId: archiveId, // provenance only — NOT restored on import
          attributionMode: 'same-instance',
          migrations,
          counts,
          omissions: OMISSIONS,
        },
        null,
        2,
      ),
    );
    add('README.md', README(archiveId, counts, OMISSIONS));

    /**
     * Originals are appended AFTER the response is handed back, one at a time,
     * so the consumer is already draining while they are fetched.
     *
     * This is the part that has to be lazy. Everything above is note text and
     * jsonl — bounded by the archive's prose. Media is not: downloading every
     * blob before returning would put the whole bundle on the heap at once, in
     * a process that also holds a resident BGE-M3 worker. Peak is now one blob
     * plus yazl's internal buffer.
     *
     * Content-addressed and archive-scoped. An earlier version of this comment
     * said the media query "derives audience from" the embed links — true of a
     * rule FM-057 tried and then removed (A7). It derives audience from
     * `created_by` and nothing else, which the comment forty lines above states
     * correctly; this one contradicted it for a whole review round. An
     * `![[<hash>]]` embed still records WHICH memory attaches a file, and the
     * bundle exports that in `data/links.jsonl` — it simply has no bearing on
     * who may read the bytes. The extension comes from the stored `mime` so the
     * file opens by double-click.
     */
    void (async () => {
      try {
        for (const m of media.rows) {
          const hash = m.content_hash as string;
          const key = mediaOriginalKey(archiveId, hash);
          const { data, error } = await deps.storage.storage.from(MEDIA_BUCKET).download(key);
          if (error || !data) continue; // absence from checksums.sha256 is the report
          add(
            `attachments/${hash}${extensionFor(m.mime as string)}`,
            Buffer.from(await data.arrayBuffer()),
          );
        }
      } finally {
        // last, and covers every file but itself
        zip.addBuffer(Buffer.from(sums.join('\n') + '\n', 'utf8'), 'checksums.sha256');
        zip.end();
      }
    })();

    const web = Readable.toWeb(zip.outputStream as unknown as Readable) as ReadableStream;
    return new Response(web, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="funmem-export-${archiveId.slice(0, 8)}.zip"`,
      },
    });
  });

  // ------------------------------------------------------------------ import
  app.post('/v1/import', async (c) => {
    const userId = c.get('userId');
    const form = await c.req.formData().catch(() => null);
    const file = form?.get('bundle');
    if (!(file instanceof File)) return c.json({ error: 'bundle is required' }, 400);
    if (file.size > MAX_BUNDLE_BYTES) return c.json({ error: 'bundle too large' }, 413);

    let files: Map<string, Buffer>;
    try {
      files = await readZip(Buffer.from(await file.arrayBuffer()));
    } catch {
      return c.json({ error: 'bundle is not a readable zip' }, 400);
    }

    // ---- VALIDATE PHASE: everything below completes before ANY write ----
    for (const name of files.keys()) {
      // zip-slip: a bundle-supplied name must never reach a filesystem or
      // Storage key. Rejected outright rather than sanitized, so a crafted
      // bundle cannot smuggle a path through normalization.
      if (
        name.includes('..') ||
        name.startsWith('/') ||
        name.includes('\\') ||
        /^[a-zA-Z]:/.test(name)
      ) {
        return c.json({ error: `unsafe path in bundle: ${name}` }, 400);
      }
    }

    const sumsFile = files.get('checksums.sha256');
    if (!sumsFile) return c.json({ error: 'checksums.sha256 is missing' }, 400);
    const declared = new Map<string, string>();
    for (const line of sumsFile.toString('utf8').split('\n')) {
      const m = /^([0-9a-f]{64})\s\s(.+)$/.exec(line.trim().length > 0 ? line : '');
      if (m) declared.set(m[2]!, m[1]!);
    }
    for (const [name, buf] of files) {
      if (name === 'checksums.sha256') continue;
      const want = declared.get(name);
      if (!want) return c.json({ error: `file not listed in checksums: ${name}` }, 400);
      if (createHash('sha256').update(buf).digest('hex') !== want) {
        return c.json({ error: `checksum mismatch: ${name}` }, 400);
      }
      declared.delete(name);
    }
    if (declared.size > 0) {
      return c.json({ error: `checksums list a missing file: ${[...declared.keys()][0]}` }, 400);
    }

    const parsed = parseJsonl(files, 'data/notes.jsonl');
    if (!parsed) return c.json({ error: 'data/notes.jsonl is missing or malformed' }, 400);

    // Media is content-addressed, so the blob verifies itself: the bytes MUST
    // hash to the name they are filed under. Checked here, in the validate
    // phase, so a tampered original cannot reach Storage.
    // FM-050: titles are validated and canonicalized HERE, in the validate
    // phase. This was the one write door with no validation at all — a crafted
    // bundle could write a title containing [ ] # ^ | or control characters that
    // every other path rejects, and could reintroduce a non-canonical
    // composition form. Twin titles differing only by composition form are
    // rejected by name, rather than surfacing later as an opaque unique
    // violation after an archive has already been provisioned and deleted.
    const seenTitles = new Map<string, string>();
    for (const n of parsed) {
      const title = canonicalTitle(String(n.title ?? ''));
      const titleError = validateNoteTitle(title);
      if (titleError) return c.json({ error: `note "${title}": ${titleError}` }, 400);
      const key = normalizeTitle(title);
      const prior = seenTitles.get(key);
      if (prior !== undefined) {
        return c.json(
          {
            error:
              `two notes in this bundle have titles that are the same after ` +
              `case-folding and Unicode normalization: "${prior}" and "${title}". ` +
              `Titles are unique per archive, so they cannot both exist. Rename ` +
              `one before importing.`,
          },
          400,
        );
      }
      seenTitles.set(key, title);
    }

    const mediaRows = parseJsonl(files, 'data/media.jsonl') ?? [];
    for (const m of mediaRows) {
      const hash = String(m.content_hash);
      const at = String(m.path ?? `attachments/${hash}`);
      const blob = files.get(at);
      if (!blob) return c.json({ error: `attachment missing for media ${hash}` }, 400);
      if (createHash('sha256').update(blob).digest('hex') !== hash) {
        return c.json({ error: `attachment does not match its content hash: ${hash}` }, 400);
      }
    }

    // UUID collision is checked BEFORE provisioning, so a rejected import
    // leaves no archive behind. `on conflict do update` would be cross-archive
    // IDOR: it would let a crafted bundle overwrite another archive's note.
    const ids = parsed.map((n) => String(n.id));
    if (ids.length > 0) {
      const clash = await deps.pool.query<{ id: string }>(
        `select id from public.notes where id = any($1::uuid[]) limit 1`,
        [ids],
      );
      if ((clash.rowCount ?? 0) > 0) {
        return c.json({ error: `UUID_COLLISION: note ${clash.rows[0]!.id} already exists` }, 409);
      }
    }

    const manifest = files.get('manifest.json');
    const subject =
      (manifest ? (JSON.parse(manifest.toString('utf8')) as { subjectName?: string }) : {})
        .subjectName ?? 'Imported archive';

    // ---- APPLY PHASE ----
    const { archiveId } = await provisionSignup(deps.pool, {
      userId,
      subjectName: subject,
      jurisdiction: 'KR',
    });

    const client = await deps.pool.connect();
    // declared outside the try: the rollback path sweeps it
    const uploadedKeys: string[] = [];
    try {
      await client.query('begin');
      // ONE change id for the whole import: this is a single machine action,
      // not N people each editing a note.
      const changeId = randomUUID();
      const audiences = parseJsonl(files, 'data/audiences.jsonl') ?? [];

      for (const n of parsed) {
        // FM-050: the import path had NO title validation at all — it was the
        // one write door a crafted bundle could use to write a title containing
        // [ ] # ^ | or control characters that every other path rejects, and to
        // reintroduce a non-canonical composition form.
        const title = canonicalTitle(String(n.title ?? ''));
        const md = files.get(String(n.path));
        if (!md) throw new Error(`bundle references a missing file: ${String(n.path)}`);
        // body comes from the markdown (byte-exact); every other column comes
        // from the jsonl, which is authoritative
        const raw = md.toString('utf8');
        const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        const inserted = await client.query<{ id: string }>(
          `insert into public.notes
             (id, archive_id, title, type, note_class, body, occurred, recorded, revised,
              contributors, extra, created_by, created_at)
           values ($1,$2,$3,$4::entity_type,$5::note_class,$6,$7,$8,$9,$10,$11,$12,$13)
           returning id`,
          [
            n.id,
            archiveId,
            title,
            n.type,
            n.noteClass ?? 'testimony',
            body,
            n.occurred ?? null, // opaque: null stays null, 'unknown' stays 'unknown'
            n.recorded ?? null,
            n.revised ?? null,
            n.contributors ?? [],
            JSON.stringify(n.extra ?? {}),
            // same-instance only: never accept a foreign identity as the author
            n.createdBy === userId ? userId : null,
            n.createdAt ?? new Date().toISOString(),
          ],
        );
        const noteId = inserted.rows[0]!.id;
        const revId = await appendRevision(
          client,
          archiveId,
          noteId,
          userId,
          title,
          body,
          'import',
          changeId,
        );
        await reindexChunks(client, archiveId, noteId, revId, body);
      }

      // links are DERIVED — re-run the unchanged indexer rather than trusting
      // the bundle's copy, so an imported archive cannot carry a forged graph
      for (const n of parsed) {
        const md = files.get(String(n.path))!;
        const body = md.toString('utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        await reindexLinks(client, archiveId, String(n.id), body);
      }

      // Media, restored for real. Bytes go to Storage BEFORE the row, mirroring
      // media.ts: a failure between the two leaves an invisible orphan blob
      // (safe) rather than a row pointing at bytes that are not there (unsafe).
      // Uploaded keys are tracked so a rollback can sweep them.
      for (const m of mediaRows) {
        const hash = String(m.content_hash);
        const blob = files.get(String(m.path ?? `attachments/${hash}`))!;
        const key = mediaOriginalKey(archiveId, hash);
        const up = await deps.storage.storage
          .from(MEDIA_BUCKET)
          .upload(key, blob, { contentType: String(m.mime), upsert: false });
        if (up.error && !/already exists|duplicate/i.test(up.error.message)) {
          throw new Error(`could not restore attachment ${hash}: ${up.error.message}`);
        }
        uploadedKeys.push(key);
        await client.query(
          /**
           * `note_id` IS RESOLVED, NOT COPIED.
           *
           * A media row reaches a bundle through the visibility predicate, and
           * its memory may not have travelled with it -- the owner can export a
           * photograph homed in a note that `include_in_export` left out, or
           * that simply was not theirs. Copying the id verbatim would then
           * dangle, or worse, land on an unrelated note that happens to share
           * it after a future id reuse.
           *
           * So the subquery only resolves to a note THIS import actually wrote
           * into THIS archive. Anything else lands NULL, which falls to the
           * uploader-only branch -- visible to the importer, erasable by the
           * owner. Fail closed, and never invent an association.
           */
          `insert into public.media
             (id, archive_id, content_hash, mime, bytes, created_by, created_at, note_id, filename)
           values ($1, $2, $3, $4, $5, $6, $7,
                   (select n.id from public.notes n
                     where n.id = $8 and n.archive_id = $2), $9)`,
          [
            m.id,
            archiveId,
            hash,
            m.mime,
            m.bytes,
            // FM-057: the IMPORTER, always — not NULL for a foreign bundle.
            //
            // On `notes` this column is testimony attribution and must never
            // accept a foreign identity, which is why the note insert above
            // nulls it. On `media` it is an upload record: who put these bytes
            // into THIS archive. The importer did, and the manifest already
            // says so ("a new archive is created and you become its owner",
            // attributionMode 'same-instance').
            //
            // It is also load-bearing. `mediaVisibleSql` is `created_by =
            // caller`, so a NULL here matches NOBODY — every imported
            // attachment would be unreadable by everyone, permanently,
            // including the person who just imported it. (An earlier version of
            // this comment gave the right conclusion via the wrong mechanism:
            // it spoke of revision authors and vouching, which A7 deleted.)
            userId,
            m.created_at ?? new Date().toISOString(),
            // $8: candidate note id from the bundle. The subquery above decides
            // whether it resolves; a bundle that carried no memory for this
            // photograph sends null and lands null.
            m.note_id ?? null,
            // $9: the name the file arrived under, when the bundle carried one
            m.filename ?? null,
          ],
        );
      }

      for (const a of audiences) {
        await client.query(
          `insert into public.audiences (archive_id, note_id, kind, include_in_export)
           values ($1, $2, $3::audience_kind, $4) on conflict (note_id) do nothing`,
          [archiveId, a.note_id, a.kind, a.include_in_export ?? true],
        );
      }

      await client.query('commit');
      return c.json({ archiveId, notes: parsed.length }, 201);
    } catch (e) {
      await client.query('rollback').catch(() => {});
      // Storage is not transactional, so blobs written before the failure are
      // swept by hand. Best-effort: a leftover blob is invisible and harmless,
      // a missing one would be a row pointing at nothing.
      for (const k of uploadedKeys) {
        await deps.storage.storage
          .from(MEDIA_BUCKET)
          .remove([k])
          .catch(() => undefined);
      }
      // the archive was provisioned in its own transaction; drop it so a failed
      // import leaves nothing behind
      await deps.pool
        .query(`delete from public.archives where id = $1`, [archiveId])
        .catch(() => {});
      return c.json({ error: `import failed: ${String(e)}` }, 400);
    } finally {
      client.release();
    }
  });
}

// ------------------------------------------------------------------ zip read

function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    // decodeStrings:false disables yauzl's OWN filename validation on purpose.
    // It rejects '..' and absolute paths by default, which would make the path
    // guard below unreachable dead code — a security property owned by a
    // library's incidental default rather than by us, and untestable because no
    // mutant could reach it. We decode the name and enforce the rule ourselves.
    yauzl.fromBuffer(
      buf,
      { lazyEntries: true, decodeStrings: false },
      (err: Error | null, zip?: ReadZip) => {
        if (err || !zip) return reject(err ?? new Error('not a zip'));
        const out = new Map<string, Buffer>();
        zip.on('entry', (entry: Entry) => {
          const name = Buffer.isBuffer(entry.fileName)
            ? (entry.fileName as Buffer).toString('utf8')
            : String(entry.fileName);
          if (name.endsWith('/')) return zip.readEntry();
          zip.openReadStream(entry, (e: Error | null, rs?: NodeJS.ReadableStream) => {
            if (e || !rs) return reject(e ?? new Error('no stream'));
            const chunks: Buffer[] = [];
            rs.on('data', (ch: Buffer) => chunks.push(ch));
            rs.on('end', () => {
              out.set(name, Buffer.concat(chunks));
              zip.readEntry();
            });
            rs.on('error', reject);
          });
        });
        zip.on('end', () => resolve(out));
        zip.on('error', reject);
        zip.readEntry();
      },
    );
  });
}

function parseJsonl(files: Map<string, Buffer>, name: string): Record<string, unknown>[] | null {
  const f = files.get(name);
  if (!f) return null;
  try {
    return f
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export type { PoolClient };
