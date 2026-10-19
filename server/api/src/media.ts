import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { App, AppDeps } from './app';
import { isMember, memberRole, UUID_RE } from './membership';
import { appendRevision, onLostConnection, WRITE_ROLES } from './notes';
import { mediaVisibleSql, visibleNoteSql } from './views';

/**
 * Content-addressed immutable media upload (FM-015, FR-003/004) + FR-143 erasure.
 * Path = archiveId/sha256(content)/original: identical bytes dedup by construction, and a
 * user-chosen filename can never overwrite anything. upsert:false + zero UPDATE
 * call sites is the immutability guarantee (no WORM exists on Supabase; the
 * service key bypasses storage RLS, so discipline lives here). The SOLE remove()
 * call site is the FM-017 erasure path below — hard-delete with a content-free
 * tombstone; anything else touching a stored blob is the forbidden shortcut.
 * FM-040: that erasure removes the whole `${archiveId}/${hash}/` prefix (every
 * depth, every page) PLUS the pre-FM-040 flat key, and reports residue per key.
 */
export const MEDIA_BUCKET = 'media';

/**
 * The ONLY two places a media object key is spelled (FM-040).
 *
 * The trailing slash on the prefix is required, not cosmetic: storage `prefix`
 * is a plain string prefix with no path-boundary semantics, so the slashless
 * form over-matches a sibling hash (`<hash>zzz/...`). Phase-2 derivatives belong
 * at `${archiveId}/${hash}/derived/{type}/{modelVersion}/{filename}` — mirroring
 * `chunk_embeddings.model_version`, so a re-run after a model upgrade writes a
 * sibling path instead of overwriting prior output.
 */
export const mediaPrefix = (archiveId: string, contentHash: string): string =>
  `${archiveId}/${contentHash}/`;
export const mediaOriginalKey = (archiveId: string, contentHash: string): string =>
  `${mediaPrefix(archiveId, contentHash)}original`;
/** The pre-FM-040 flat key. Still erasable; never written again. */
export const mediaLegacyKey = (archiveId: string, contentHash: string): string =>
  `${archiveId}/${contentHash}`;

/**
 * Every object under a prefix, at any depth, across every page.
 *
 * `.list()` is a ONE-LEVEL directory listing: it returns nested folders as
 * placeholder entries with `id: null`, and `remove()` silently no-ops on those
 * while reporting `error: null` — verified live, the derivative stays
 * downloadable. `listV2({ with_delimiter: false })` returns the flat recursive
 * key list instead. `with_delimiter` must never be set true here; it restores
 * exactly the broken behaviour.
 *
 * Paginated deliberately: the page size is a hard cap of 1000 even when a
 * larger `limit` is requested, and v1 `list()` truncates at 100 with no signal.
 *
 * NOTE: `listV2` is `@experimental` in @supabase/storage-js@2.110.6 — this
 * task's erasure guarantee depends on it, so a storage-js upgrade must be
 * reviewed by a human rather than merged on green.
 */
/** The shape of a listV2 page we depend on. */
interface ListV2Page {
  objects?: Array<{ name: string }>;
  hasNext?: boolean;
  nextCursor?: string;
}

export async function listAllUnderPrefix(
  storage: AppDeps['storage'],
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await storage.storage
      .from(bucket)
      .listV2({ prefix, with_delimiter: false, ...(cursor ? { cursor } : {}) });
    if (page.error) throw page.error;
    const data: ListV2Page = page.data ?? {};
    for (const o of data.objects ?? []) keys.push(o.name);
    if (!data.hasNext || !data.nextCursor) return keys;
    cursor = data.nextCursor;
  }
}

/**
 * Keys we meant to remove that storage did not confirm removing.
 *
 * `remove()` reports a missing key and a removed key identically — empty
 * success, `error: null` — so "no error" is not evidence of erasure. The only
 * honest check is a per-key set difference, and each survivor is named.
 */
export function residueOf(expected: string[], removed: string[]): string[] {
  const done = new Set(removed);
  return expected.filter((k) => !done.has(k));
}

/**
 * Session-level advisory lock on (archive, contentHash), held by BOTH the
 * dedup-upload and the erasure path. Unlike a transaction-local lock it
 * survives commit, so the erasure path keeps it across the blob removal —
 * closing the race where an identical-bytes re-upload dedups against a blob
 * the concurrent delete is about to remove (panel finding: resurrected row
 * pointing at missing bytes).
 */

/**
 * Read `x-filename`, which cannot carry the filenames this product exists for.
 *
 * HTTP header values are ISO-8859-1 at best -- a client sending
 * `x-filename: 할머니_생신.HEIC` raises before the request is even dispatched
 * ("character ... greater than 255"). For a Korean family archive that is not
 * an edge case, it is the ORDINARY case, and it would have silently degraded
 * every non-ASCII filename to a date-stamped fallback.
 *
 * Found by a required test that used a realistic Korean filename rather than
 * `test.png`. Clients percent-encode UTF-8; this decodes it, and falls back to
 * the raw value when it is not percent-encoded (plain ASCII names, and any
 * client written before this rule existed) rather than rejecting the upload
 * over a filename, which is decoration and never authorization.
 */
function readFilename(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * An opaque keyset cursor over `(created_at, id)`.
 *
 * Base64url so it survives a query string untouched, and opaque so the client
 * cannot construct one — the encoding is ours to change, and a client that
 * parsed it would pin the ordering columns into the public contract.
 */
function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): { at: string; id: string } | null {
  if (raw === undefined || raw === '') return null;
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  // Validated, not trusted: `id` is spliced into a uuid-cast comparison and
  // `at` into a timestamptz cast, and a bad value there is a 500 rather than
  // the 400 the caller has earned.
  if (!at || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}

/**
 * Mint a unique, link-safe title for a photo-note.
 *
 * THE LARGEST HIDDEN COST OF "a photo is a note", and it came from reading the
 * schema rather than from any researcher. `notes.title` is NOT NULL, and
 * `notes_archive_title_ci` is UNIQUE on
 * `(archive_id, NORMALIZE(lower(btrim(title)), NFC))`. `validateNoteTitle`
 * additionally refuses empty titles and `[ ] # ^ |`, because titles are spliced
 * verbatim into other members' bodies by FM-016's rename cascade.
 *
 * So a phone dump of fifty photographs needs fifty unique, non-empty,
 * link-safe titles. `media.filename` (FM-069) is the source; a date fallback
 * covers a client that sends no name; FM-061 will improve that with EXIF.
 */
export async function mintPhotoTitle(
  client: PoolClient,
  archiveId: string,
  filename?: string,
): Promise<string> {
  const stripped = (filename ?? '')
    .replace(/\.[A-Za-z0-9]{1,8}$/, '') // drop one extension, not every dot
    .replace(/[[\]#^|]/g, ' ') // exactly what validateNoteTitle refuses
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  const base = stripped !== '' ? stripped : `\uc0ac\uc9c4 ${new Date().toISOString().slice(0, 10)}`;

  for (let n = 1; n <= 500; n++) {
    const candidate = n === 1 ? base : `${base} (${n})`;
    const clash = await client.query(
      `select 1 from public.notes
        where archive_id = $1
          and normalize(lower(btrim(title)), NFC) = normalize(lower(btrim($2)), NFC)`,
      [archiveId, candidate],
    );
    if (clash.rowCount === 0) return candidate;
  }
  // 500 collisions on one base is not a naming problem, it is a bug or an
  // attack; a random suffix is honest about giving up on a readable name.
  return `${base} (${randomUUID().slice(0, 8)})`;
}

/**
 * Insert a minted photo-note, letting `notes_archive_title_ci` settle title
 * races instead of pretending the clash SELECT settled them.
 *
 * CHECK-THEN-INSERT IS A RACE, and the phone dump is exactly when it fires:
 * fifty uploads land at once, two carry the same `x-filename`, both clear the
 * clash SELECT because neither has committed, and the second INSERT dies on the
 * unique index. `lockHash` does not help -- it keys on the CONTENT HASH, and
 * two different photographs from one camera roll collide on the TITLE while
 * hashing differently, so they hold different locks.
 *
 * The savepoint is CONDITIONAL: the upload route holds a session-level advisory
 * lock and opens no transaction, where SAVEPOINT is an error and is also
 * unnecessary (a failed INSERT is its own transaction and poisons nothing).
 * Inside a transaction it is required, because a unique violation aborts the
 * whole thing. The probe runs PER ATTEMPT rather than once -- an earlier
 * version of this comment said "probe once and remember", which the code never
 * did. Per-attempt is correct anyway: a caller could open a transaction
 * between attempts, and a failed SAVEPOINT outside one costs a round trip and
 * nothing else.
 */
export async function insertMintedPhotoNote(
  client: PoolClient,
  archiveId: string,
  userId: string,
  filename?: string,
): Promise<{ id: string; title: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const minted = await mintPhotoTitle(client, archiveId, filename);
    // attempts after the first append a random suffix rather than re-walking
    // the `(n)` ladder: the loser of a race would otherwise recompute the same
    // losing candidate, since the winner still has not committed
    const title = attempt === 0 ? minted : `${minted} (${randomUUID().slice(0, 8)})`;
    let savepointed = true;
    try {
      await client.query('savepoint mint_photo_note');
    } catch {
      savepointed = false;
    }
    try {
      const note = await client.query(
        `insert into public.notes (archive_id, title, type, note_class, body, created_by)
         values ($1, $2, 'source', 'testimony', '', $3) returning id`,
        [archiveId, title, userId],
      );
      if (savepointed) await client.query('release savepoint mint_photo_note');
      return { id: note.rows[0].id as string, title };
    } catch (err) {
      // 23505 = unique_violation. Anything else is not ours to swallow.
      if ((err as { code?: string }).code !== '23505') throw err;
      if (savepointed) await client.query('rollback to savepoint mint_photo_note');
    }
  }
  throw new Error('could not mint a unique photo-note title after 5 attempts');
}

/**
 * LOAD-BEARING FOR CORRECTNESS, NOT JUST FOR TIDINESS -- read before changing.
 *
 * FM-069 dropped `unique(archive_id, content_hash)`, so the database no longer
 * refuses a duplicate row. The upload path's dedup is therefore a
 * check-then-insert, and the ONLY thing that makes that sound is this lock:
 * SESSION-level (`pg_advisory_lock`, not `..._xact_`), taken on the SAME
 * `PoolClient` that then runs the select and the insert, keyed on
 * (archive, hash).
 *
 * Three changes would silently reintroduce duplicate rows instead of raising:
 * making it transaction-scoped, taking it on a different client from the one
 * doing the insert, or adding a second insert site that does not take it.
 *
 * WHAT ACTUALLY GUARDS THAT, STATED EXACTLY. `media-home-note-schema.test.ts`
 * carries a STATIC source scan that catches the first two: it fails if this
 * function stops using session-level `pg_advisory_lock`, and if the upload path
 * stops taking the lock before its dedup SELECT and its INSERT. THE THIRD IS
 * NOT COVERED -- a second insert site added elsewhere in this file, or in
 * `export.ts`, is caught by nothing.
 *
 * There is deliberately no concurrency test. One was written and deleted: it
 * asserted ten simultaneous identical uploads leave one row, and it PASSED
 * against a deliberately broken `pg_advisory_xact_lock`, because the
 * check-then-insert window is too narrow to lose reliably. A race test that
 * goes green on the broken implementation claims coverage it does not have.
 * An earlier version of THIS comment claimed that deleted test as the pin --
 * the same false-record class it now warns about, caught by the G8 panel.
 *
 * Known and accepted: `export.ts`'s import path inserts media WITHOUT this
 * lock, so a bundle carrying duplicate hashes produces duplicate rows. That is
 * harmless for visibility (every imported row gets `created_by` = the importer)
 * and is why FM-066's sibling check before blob removal is not optional.
 */
async function lockHash(client: PoolClient, archiveId: string, hash: string): Promise<void> {
  await client.query(`select pg_advisory_lock(hashtext($1), hashtext($2))`, [archiveId, hash]);
}

async function unlockHash(client: PoolClient, archiveId: string, hash: string): Promise<void> {
  await client
    .query(`select pg_advisory_unlock(hashtext($1), hashtext($2))`, [archiveId, hash])
    .catch(() => {});
}

/**
 * Types this server is willing to serve INLINE. `media.mime` is whatever the
 * uploader's `content-type` header said -- caller-supplied data, and it always
 * was.
 *
 * WHY AN ALLOWLIST RATHER THAN AN ORDERING. `/by-hash` also gained a
 * deterministic ORDER BY so a caller's own row wins the mime for a shared hash.
 * That is NOT the security control, and believing it was is the mistake FM-060
 * made twice: ordering only protects a caller who OWNS a row for that hash. A
 * third member with none falls through to `created_at asc`, so the EARLIEST
 * uploader -- who may have declared `text/html` over bytes that are a valid PNG
 * *and* valid HTML -- chooses the Content-Type their browser sees, on a route
 * that sets `content-disposition: inline`. That is a scripting bug.
 *
 * The disease is that a caller-supplied string reached a response header at
 * all. Anything off this list is served as an opaque attachment, so the worst a
 * caller can do to someone else's request is make bytes arrive as a download.
 */
const SAFE_INLINE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
]);

/**
 * RFC 5987 `ext-value`. A STRICT ALLOWLIST, deliberately not
 * `encodeURIComponent`.
 *
 * `media.filename` is caller-supplied -- it is the `x-filename` header,
 * percent-DECODED at upload -- and the download route below is the first place
 * it reaches a response header. Header values are ISO-8859-1, and a decoded
 * `\r\n` inside a filename would split the response, so this encoding is a
 * security control before it is an i18n convenience. Every byte outside RFC
 * 5987's `attr-char` set is percent-encoded, which covers CR, LF and NUL by
 * construction rather than by a blocklist that has to anticipate them.
 *
 * `encodeURIComponent` is NOT sufficient here: it leaves `! ' ( ) *` literal,
 * and `'` and `*` are the delimiters of the ext-value grammar itself.
 */
function rfc5987(value: string): string {
  // attr-char = ALPHA / DIGIT / "!" / "#" / "$" / "&" / "+" / "-" / "." /
  //             "^" / "_" / "`" / "|" / "~"
  const attr = new Set([0x21, 0x23, 0x24, 0x26, 0x2b, 0x2d, 0x2e, 0x5e, 0x5f, 0x60, 0x7c, 0x7e]);
  let out = '';
  for (const b of new TextEncoder().encode(value)) {
    const alnum = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
    out +=
      alnum || attr.has(b)
        ? String.fromCharCode(b)
        : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * Stream one original. Shared by the by-id and by-hash reads so the ACL answer
 * and the headers cannot drift apart. A row whose blob is gone is a broken
 * archive rather than a missing object, but the caller gets the same uniform
 * 404 either way — the distinction is ours, not theirs.
 *
 * FM-070 adds `?download=1` and the stored filename. Note what the flag can and
 * cannot do: it only ever moves `inline` -> `attachment`. There is no path from
 * a query parameter to rendering a type the allowlist refused, so the allowlist
 * above remains the entire security story for inline serving.
 */
async function streamOriginal(
  deps: AppDeps,
  archiveId: string,
  contentHash: string,
  mime: string,
  opts: { download?: boolean; filename?: string | null } = {},
): Promise<Response> {
  const { data, error } = await deps.storage.storage
    .from(MEDIA_BUCKET)
    .download(mediaOriginalKey(archiveId, contentHash));
  if (error || !data) return Response.json({ error: 'not found' }, { status: 404 });
  const safe = SAFE_INLINE_MIME.has(mime.split(';')[0]!.trim().toLowerCase());
  const disposition = opts.download || !safe ? 'attachment' : 'inline';
  const name = opts.filename?.trim();
  return new Response(data.stream(), {
    headers: {
      // NEVER echo a caller-supplied type into an INLINE response
      'content-type': safe ? mime : 'application/octet-stream',
      // content-addressed: the bytes under a hash never change
      'cache-control': 'private, max-age=31536000, immutable',
      /**
       * The quoted ASCII fallback stays the HASH, always. A browser too old to
       * read `filename*` must not be handed a name we have not encoded -- and
       * the hash is the one string here that cannot contain a quote, a
       * backslash or a newline, because the routes validate it as 64 hex
       * characters before it is used at all.
       */
      'content-disposition':
        `${disposition}; filename="${contentHash}"` +
        (name ? `; filename*=UTF-8''${rfc5987(name)}` : ''),
      // even an allowlisted type must not be re-sniffed into something else
      'x-content-type-options': 'nosniff',
    },
  });
}

/** The home note named by an upload no longer exists (FK `media_note_id_fkey`). */
const noteErased = (e: unknown): boolean => {
  const pg = e as { code?: unknown; constraint?: unknown } | null;
  return pg?.code === '23503' && pg.constraint === 'media_note_id_fkey';
};

export function registerMediaRoutes(app: App, deps: AppDeps): void {
  app.post('/v1/archives/:archiveId/media', async (c) => {
    const archiveId = c.req.param('archiveId');
    const role = archiveId ? await memberRole(deps.pool, c.get('userId'), archiveId) : null;
    if (role === null) return c.json({ error: 'not found' }, 404);
    // a photograph belongs to a memory, so adding one is writing (FR-100): a read-only member is told so
    if (!WRITE_ROLES.includes(role)) {
      return c.json(
        {
          error: 'only an owner, steward or contributor can add photos',
          code: 'forbidden',
          reason: 'role',
        },
        403,
      );
    }
    const userId = c.get('userId');
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length === 0) return c.json({ error: 'empty body' }, 400);
    const mime = c.req.header('content-type') ?? 'application/octet-stream';
    const contentHash = createHash('sha256').update(bytes).digest('hex');

    const client = await deps.pool.connect();
    const unguard = onLostConnection(client); // a dropped connection fails this upload, not the server
    let locked = false;
    try {
      await lockHash(client, archiveId, contentHash);
      locked = true;

      // upload BEFORE the metadata row: a failure in between leaves an invisible
      // orphan blob (safe), never a row pointing at missing bytes (unsafe)
      const uploaded = await deps.storage.storage
        .from(MEDIA_BUCKET)
        .upload(mediaOriginalKey(archiveId, contentHash), bytes, {
          contentType: mime,
          upsert: false,
        });
      // duplicate on a content-addressed path IS success: the bytes are identical
      if (uploaded.error && !/already exists|duplicate/i.test(uploaded.error.message)) {
        return c.json({ error: 'upload failed' }, 500);
      }

      /**
       * DEDUP IS NOW AN EXPLICIT CHECK, NOT `on conflict`.
       *
       * This used to read `on conflict (archive_id, content_hash) do nothing`.
       * That is not a stylistic choice -- the inference REQUIRES a unique index
       * on those columns, and FM-069 drops it, so the statement raises and
       * every upload answers 500. `apps/web`'s media-embed e2e caught it at G1.
       *
       * Recorded because the mistake is instructive: dropping a constraint is
       * not a schema-only change when application code depends on the
       * constraint's INFERENCE rather than on its enforcement.
       *
       * Check-then-insert is safe HERE specifically, and nowhere else by
       * default: `lockHash` above holds a session-level advisory lock keyed on
       * (archive, hash), so two concurrent uploads of identical bytes are
       * serialized. That lock is exactly what makes this sound.
       */
      const existing = await client.query(
        `select id from public.media
          where archive_id = $1 and content_hash = $2
          order by created_at asc, id asc
          limit 1`,
        [archiveId, contentHash],
      );
      /**
       * `?note=` OVERRIDES DEDUP, and that is the point of this unit.
       *
       * The dedup short-circuit used to run FIRST, so an upload carrying
       * `?note=` for bytes the archive already held returned the EXISTING row's
       * id with 201 and never attached anything: the caller's memory got no
       * photograph, and the id they were handed belonged to someone else's row,
       * which their own GET answers 404 for. The attach vanished behind a
       * success status. The G8 panel caught it, and caught that it also made
       * three claims in this task's record false -- "two memories may each hold
       * the same photograph" was impossible through the API while dedup won.
       *
       * So a request that NAMES a memory always gets its own row. Two rows may
       * now share a hash, which is exactly the design (the unique constraint
       * went in FM-069 for this reason) and exactly why FM-066's sibling check
       * before blob removal is not optional.
       *
       * A request with NO `?note=` keeps the FM-057 behaviour untouched: the
       * existing row's id, same status and shape as a fresh upload, because
       * that uniformity is what closed the confirmation oracle. Attaching is an
       * explicit act; deduping is not.
       */
      const attaching = c.req.query('note') !== undefined;
      if ((existing.rowCount ?? 0) === 0 || attaching) {
        /**
         * THE ASSOCIATION IS ESTABLISHED HERE, BY THE SERVER, ON THIS REQUEST.
         * `note_id` is never read from the request body and no route patches it
         * afterwards. That is what makes P1 hold by CONSTRUCTION rather than by
         * argument: a caller cannot write the field that decides their own
         * access.
         *
         * "On this request", not "in this transaction" -- this route opens no
         * transaction. It holds a session-level advisory lock across
         * autocommitted statements, which is why the savepoint inside
         * `insertMintedPhotoNote` is conditional, and why a crash between the
         * note INSERT and the media INSERT leaves an empty photo-note behind:
         * harmless, deletable by its author, and better written down than
         * discovered.
         */
        const noteParam = c.req.query('note');
        let homeNoteId: string;
        let mintedTitle: string | undefined;

        if (noteParam) {
          if (!UUID_RE.test(noteParam)) return c.json({ error: 'not found' }, 404);
          /**
           * `?note=` IS ITSELF AN AUTHORIZATION-CHECKED WRITE, which is the
           * whole difference between this design and FM-057's. The caller must
           * be able to SEE the note, checked with the same `visibleNoteSql`
           * every other by-id surface uses, and a miss answers the uniform 404
           * so they learn nothing about a note they may not see.
           */
          const target = await client.query(
            `select n.id from public.notes n where ${visibleNoteSql('n', '$1', '$2', '$3')}`,
            [noteParam, archiveId, userId],
          );
          if (target.rowCount === 0) return c.json({ error: 'not found' }, 404);
          homeNoteId = noteParam;
        } else {
          const minted = await insertMintedPhotoNote(
            client,
            archiveId,
            userId,
            readFilename(c.req.header('x-filename')),
          );
          homeNoteId = minted.id;
          mintedTitle = minted.title;
          /**
           * A MINTED PHOTO-NOTE IS PRIVATE UNTIL SOMEONE SAYS OTHERWISE.
           *
           * Notes default to archive-members, and copying that default here was
           * wrong: an ordinary note is created by someone who has just decided
           * what to write, whereas this note is minted by the ACT OF UPLOADING,
           * before the uploader has said anything about who it is for.
           * Defaulting to visible publishes a photograph on a decision the user
           * has not made yet. FM-057's escalation battery caught exactly this.
           */
          await client.query(
            `insert into public.audiences (archive_id, note_id, kind)
             values ($1, $2, 'private-to-author') on conflict (note_id) do nothing`,
            [archiveId, homeNoteId],
          );
        }

        let inserted;
        try {
          inserted = await client.query(
            `insert into public.media (archive_id, note_id, content_hash, mime, bytes, created_by, filename)
             values ($1, $2, $3, $4, $5, $6, $7)
             returning id`,
            [
              archiveId,
              homeNoteId,
              contentHash,
              mime,
              bytes.length,
              userId,
              readFilename(c.req.header('x-filename')) ?? null,
            ],
          );
        } catch (e) {
          /**
           * THE MEMORY WAS ERASED BETWEEN THE CHECK ABOVE AND THIS ROW: an undo of the import
           * that made it, or a delete, committed in between (this route opens no transaction).
           * The foreign key refuses the row, and the answer is the same uniform 404 as a note
           * that was never there, not a 500 (round-3 review D9). The bytes already stored are
           * the residue this route has always accepted for a failure between blob and row:
           * unreachable, and erasure stays the module's sole `remove()` site.
           */
          if (noteErased(e)) return c.json({ error: 'not found' }, 404);
          throw e;
        }
        if (mintedTitle !== undefined) {
          // FM-039 provenance: a minted note is a real note and gets a real
          // creating revision, so its history does not start blank.
          await appendRevision(
            client,
            archiveId,
            homeNoteId,
            userId,
            mintedTitle,
            '',
            'create',
            randomUUID(),
          );
        }
        return c.json({ id: inserted.rows[0].id, contentHash, mime, bytes: bytes.length }, 201);
      }
      /**
       * FM-057: dedup answered 200-with-existing-id where a fresh upload
       * answered 201, which made this route the same confirmation oracle as
       * by-hash — "the archive already holds these exact bytes" is disclosure
       * even when the caller cannot read the blob. The two answers are now
       * identical in status and shape.
       *
       * Returning the existing id is NOT the disclosure: the caller has no
       * prior knowledge of anyone else's media ids, so an existing id and a
       * fresh one are indistinguishable to them, and they need one to embed the
       * file.
       *
       * WHAT THIS RESPONSE DOES NOT DO IS GRANT ACCESS, and an earlier version
       * of this comment claimed otherwise — that the blob "becomes visible to
       * them when they save a note that embeds it". The G8 panel caught it.
       * `created_by` stays the original uploader, and the rule is `created_by
       * = caller`, so a second member who uploads a photograph the archive
       * already holds gets a 201 and an id whose every read answers 404 — a
       * broken attachment in their own note.
       * Two relatives uploading the same photograph is an ordinary thing in a
       * family archive, not a corner case.
       *
       * It is not fixable here, and the reason has CHANGED under FM-069 --
       * this paragraph used to say "media is one row per (archive,
       * content_hash) with a single `created_by`, and this task adds no
       * migration", which FM-069 falsified by dropping that constraint. Several
       * rows may now share a hash. What is still missing is a place to record
       * that a caller legitimately POSSESSES these bytes: the home note is
       * FM-065's, and until a row can be attributed to this caller without
       * stealing attribution from the original uploader, the residual stands. Reassigning `created_by` to the deduper
       * would steal attribution from the original uploader AND hand them read
       * plus erasure over a blob they may never have been allowed to see, which
       * is the escalation the uploader rule exists to stop. Pinned by a test that asserts the
       * 404 rather than pretending it is a 200. The schema question is no
       * longer FM-060's -- that task was reverted and split under D-65 -- and
       * belongs to FM-065, which introduces the home note a second uploader's
       * row could legitimately carry.
       *
       * BOTH BRANCHES ECHO THE REQUEST'S `mime`, and that is the point rather
       * than sloppiness. This branch used to echo the STORED row's mime while a
       * fresh insert echoed the caller's, which left the oracle wide open one
       * field below the status code: probe with `content-type: application/x-probe`,
       * and a reply naming `image/jpeg` says the archive already holds those
       * bytes. Review caught it and reproduced it live. Uniform values are the
       * only way the two answers are actually indistinguishable.
       *
       * The stored row is NOT relabelled — immutability is unchanged, and
       * notes.test.ts asserts that against the database rather than against
       * this response, which is where that assertion always belonged.
       *
       * Residual, stated rather than hidden: this route still confirms prior
       * existence to someone who already holds the exact bytes, because the id
       * they get back is Alice's row and `GET /media/:id` on it answers 404
       * while a genuinely new upload answers 200. Closing that would require
       * either denying an uploader their own blob or granting a deduper someone
       * else's — it is inherent to per-archive content-addressed dedup plus
       * uploader-derived visibility, not a channel that can be patched here. It
       * is a preimage attack: it reveals nothing about content the caller does
       * not already hold.
       */
      return c.json({ id: existing.rows[0].id, contentHash, mime, bytes: bytes.length }, 201);
    } finally {
      if (locked) await unlockHash(client, archiveId, contentHash);
      unguard();
      client.release();
    }
  });

  /**
   * THE MEDIA A CALLER MAY SEE, AS A LIST.
   *
   * This route is why photographs did not appear in the web app, and it is
   * worth being precise about the diagnosis because the obvious one was wrong.
   * Nothing was broken in storage: the bytes upload, the blob is reachable, and
   * `by-hash` streams it correctly. What did not exist was any way to ASK "what
   * photographs does this memory hold". `POST` hands back one id at upload
   * time and nothing enumerated afterwards, so a photograph was invisible on
   * the next visit unless its 64-character hash had been typed into a body by
   * hand. A different storage backend would not have changed that by a line.
   *
   * `?note=` scopes to one memory and is gated with `visibleNoteSql` — the same
   * by-id rule every other single-note surface uses — so a memory the caller
   * may not see answers the uniform 404 rather than a bare empty list, which
   * would itself distinguish "no photographs" from "not yours".
   *
   * Unscoped, it enumerates the archive through `mediaVisibleSql`, so a row
   * appears here exactly when its own by-id read would succeed. The two rules
   * are the same expression, not two copies that can drift.
   *
   * KEYSET pagination on `(created_at, id)`, not OFFSET. An archive is
   * append-heavy: an offset walk re-reads every earlier row per page, and a row
   * inserted mid-walk shifts the window so an item is silently skipped. `id`
   * breaks ties because a phone dump writes many rows inside one millisecond,
   * and `created_at` alone is therefore not a total order.
   */
  app.get('/v1/archives/:archiveId/media', async (c) => {
    const archiveId = c.req.param('archiveId');
    const userId = c.get('userId');
    if (!archiveId || !(await isMember(deps.pool, userId, archiveId))) {
      return c.json({ error: 'not found' }, 404);
    }

    const noteParam = c.req.query('note');
    if (noteParam !== undefined) {
      if (!UUID_RE.test(noteParam)) return c.json({ error: 'not found' }, 404);
      const target = await deps.pool.query(
        `select n.id from public.notes n where ${visibleNoteSql('n', '$1', '$2', '$3')}`,
        [noteParam, archiveId, userId],
      );
      if (target.rowCount === 0) return c.json({ error: 'not found' }, 404);
    }

    const rawCursor = c.req.query('cursor');
    const cursor = decodeCursor(rawCursor);
    // A malformed cursor must NOT quietly mean "from the beginning": a paging
    // client would then loop on page one forever instead of failing loudly.
    if (rawCursor !== undefined && cursor === null) return c.json({ error: 'bad cursor' }, 400);

    const limit = Math.min(Math.max(Math.trunc(Number(c.req.query('limit'))) || 60, 1), 200);

    /**
     * `cursor_at` IS A STRING FROM POSTGRES, NOT A JS DATE, and that is a
     * correctness requirement rather than a preference.
     *
     * A timestamptz keeps MICROSECONDS. node-postgres parses it into a JS Date,
     * which holds only milliseconds, so a cursor built by re-serialising that
     * Date lands strictly BEFORE the row it came from -- and the row comparison
     * below then matches that row again. Every page repeats its own last rows
     * and the walk never reaches the end.
     *
     * Caught by the pagination test, which asserts that no page repeats a row:
     * it saw four distinct rows across six slots.
     */
    const rows = await deps.pool.query(
      `select m.id, m.note_id, m.content_hash, m.mime, m.bytes, m.filename, m.created_at,
              to_char(m.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                as cursor_at,
              n.title as note_title
         from public.media m
         join public.notes n on n.id = m.note_id
        where m.archive_id = $1
          and ($2::uuid is null or m.note_id = $2::uuid)
          and ${mediaVisibleSql('m', '$1', '$3')}
          and ($4::timestamptz is null
               or (m.created_at, m.id) > ($4::timestamptz, $5::uuid))
        order by m.created_at asc, m.id asc
        limit $6`,
      [archiveId, noteParam ?? null, userId, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
    );

    /**
     * An INNER join on the home note, which is a real filter and not just
     * decoration for the title. `mediaVisibleSql` already fails closed on a
     * NULL `note_id` (FM-064), and this join drops the same rows for the same
     * reason — a row whose home note is gone is unreachable by every other
     * surface, so listing it would offer the caller something they cannot open.
     */
    const page = rows.rows.slice(0, limit);
    const hasMore = rows.rows.length > limit;
    const last = page[page.length - 1];
    return c.json({
      items: page.map((r) => ({
        id: r.id as string,
        noteId: r.note_id as string,
        noteTitle: r.note_title as string,
        contentHash: r.content_hash as string,
        mime: r.mime as string,
        // `bytes` is bigint; node-postgres hands those back as strings
        bytes: Number(r.bytes),
        filename: (r.filename as string | null) ?? null,
        createdAt: new Date(r.created_at as string).toISOString(),
      })),
      nextCursor:
        hasMore && last ? encodeCursor(last.cursor_at as string, last.id as string) : null,
    });
  });

  /**
   * FM-055: the read path. Media was write-only — POST and DELETE existed and
   * nothing could read a blob back, so an uploaded original was unreachable by
   * anyone (§17 criterion 2).
   *
   * PROXIED, not a signed URL. Supabase can mint a time-limited URL and it
   * would be cheaper, but FR-081 wants the access check BEFORE retrieval and a
   * signed URL is retrieval without one: for its whole lifetime anyone holding
   * it fetches with no membership test and no revocation. Proxying costs the
   * API the bytes and keeps the storage key server-side.
   */
  app.get('/v1/archives/:archiveId/media/by-hash/:contentHash', async (c) => {
    const archiveId = c.req.param('archiveId');
    const hash = c.req.param('contentHash') ?? '';
    if (!archiveId || !(await isMember(deps.pool, c.get('userId'), archiveId))) {
      return c.json({ error: 'not found' }, 404);
    }
    // the hash IS the object name, so validate its shape before it is used to
    // build a storage key
    if (!/^[0-9a-f]{64}$/.test(hash)) return c.json({ error: 'not found' }, 404);
    // FM-057: membership is not the check. This route took a caller-supplied
    // hash and answered "yes, that is here" for ANY blob in the archive,
    // including one embedded solely in a note the caller may not read. The
    // visibility predicate lives in the lookup, so an invisible blob and an
    // absent one produce the same row count and therefore the same 404.
    const row = await deps.pool.query<{ mime: string; filename: string | null }>(
      /**
       * ORDERED, because FM-069 dropped `unique(archive_id, content_hash)`:
       * several rows may share a hash and each carries its own caller-supplied
       * `mime`. Unordered, `limit 1` would hand an arbitrary row's type to the
       * caller. Prefer the caller's OWN row, then the oldest.
       *
       * `IS TRUE`, not a bare comparison. `created_by` is NULL on legacy and
       * imported rows, `(NULL = $3)` is NULL, and Postgres sorts NULLS FIRST
       * under DESC -- so a bare `desc` puts an UPLOADERLESS row ahead of the
       * caller's own and hands the mime to exactly the row this ordering exists
       * to demote. Those rows are real: they are the FM-057 population FM-069
       * deliberately did not adopt.
       *
       * This is determinism, NOT authorization. The allowlist above is what
       * makes a hostile `mime` harmless; see its comment.
       */
      `select m.mime, m.filename from public.media m
        where m.archive_id = $1 and m.content_hash = $2
          and ${mediaVisibleSql('m', '$1', '$3')}
        order by (m.created_by = $3) is true desc, m.created_at asc, m.id asc
        limit 1`,
      [archiveId, hash, c.get('userId')],
    );
    if (row.rowCount === 0) return c.json({ error: 'not found' }, 404);
    // stream directly rather than redirecting to the by-id route: a 302 costs
    // every embed a second round trip, and the id it would disclose adds
    // nothing the caller cannot already derive
    return streamOriginal(deps, archiveId, hash, row.rows[0]!.mime, {
      download: c.req.query('download') !== undefined,
      filename: row.rows[0]!.filename,
    });
  });

  app.get('/v1/archives/:archiveId/media/:mediaId', async (c) => {
    const archiveId = c.req.param('archiveId');
    const mediaId = c.req.param('mediaId');
    // membership BEFORE retrieval, and a uniform 404 on every miss — a 403
    // would confirm the object exists
    if (!archiveId || !(await isMember(deps.pool, c.get('userId'), archiveId))) {
      return c.json({ error: 'not found' }, 404);
    }
    if (!UUID_RE.test(mediaId ?? '')) return c.json({ error: 'not found' }, 404);

    // scoped by BOTH ids: looking the row up by media id alone would answer
    // "does this id exist anywhere" and make the route a cross-archive oracle.
    // FM-057 adds the audience predicate on the same query, so within the
    // archive an invisible blob is likewise indistinguishable from an absent one.
    const row = await deps.pool.query<{
      content_hash: string;
      mime: string;
      filename: string | null;
    }>(
      `select m.content_hash, m.mime, m.filename from public.media m
        where m.id = $1 and m.archive_id = $2 and ${mediaVisibleSql('m', '$2', '$3')}`,
      [mediaId, archiveId, c.get('userId')],
    );
    if (row.rowCount === 0) return c.json({ error: 'not found' }, 404);

    const { content_hash: hash, mime, filename } = row.rows[0]!;
    return streamOriginal(deps, archiveId, hash, mime, {
      download: c.req.query('download') !== undefined,
      filename,
    });
  });

  app.delete('/v1/archives/:archiveId/media/:mediaId', async (c) => {
    const archiveId = c.req.param('archiveId');
    if (!archiveId || !(await isMember(deps.pool, c.get('userId'), archiveId))) {
      return c.json({ error: 'not found' }, 404);
    }
    const mediaId = c.req.param('mediaId');
    if (!mediaId || !UUID_RE.test(mediaId)) return c.json({ error: 'not found' }, 404);
    const userId = c.get('userId');

    // row + tombstone first, blob second (FR-143 ordering): a crash in between
    // leaves an unreachable orphan blob (safe), never a row without bytes
    const client = await deps.pool.connect();
    const unguard = onLostConnection(client); // a dropped connection fails this erase, not the server
    let lockedHash: string | null = null;
    try {
      // Not a gate — this exists only to learn the content hash, which is the
      // lock key. The audience check is the `for update` re-read below, inside
      // the transaction, and it is deliberately the ONLY one: an earlier draft
      // put the same predicate here as well, and mutation testing showed
      // neither copy was individually killable because each masked the other.
      const peek = await client.query(
        `select content_hash from public.media where id = $1 and archive_id = $2`,
        [mediaId, archiveId],
      );
      if (peek.rowCount === 0) return c.json({ error: 'not found' }, 404);
      const contentHash = peek.rows[0].content_hash as string;
      await lockHash(client, archiveId, contentHash);
      lockedHash = contentHash;

      await client.query('begin');
      /**
       * FM-057: THE gate on erasure, and the reason it is here rather than at
       * the top of the handler. Membership was the only check, so any
       * co-member could destroy the photograph behind another member's private
       * note — the one operation in this file that is not undoable.
       *
       * Inside the transaction and under `for update`, so the audience that is
       * read is the audience that holds while the row is deleted. A check made
       * before `begin` can be true and stale by the time the delete runs.
       *
       * ERASURE AUTHORITY IS NOT READ AUTHORITY, hence the owner clause -- and
       * hence the UPLOADER clause spelled out below rather than composed from
       * `mediaVisibleSql`.
       *
       * FM-064 WIDENED READS AND DELIBERATELY DID NOT WIDEN THIS. While the
       * read predicate was `created_by = caller`, composing it here meant
       * uploader-or-owner and the sentence above stayed true. FM-064 makes
       * reads resolve through the home note, so composing it would have handed
       * every member who can READ a memory the power to permanently destroy
       * another member's photograph and its bytes -- an irreversible authority,
       * broadened as a side effect of a visibility change, contradicting the
       * sentence directly above it. The G8 panel caught that. Erasure stays
       * uploader-or-owner; if it should follow reads, that is FM-066's call to
       * make on purpose, with its own required test.
       *
       * Gating erasure on visibility alone strands blobs that NOBODY can delete: the
       * import path stores `created_by` as NULL whenever the bundle's author id
       * is not the importer's, so an imported blob that no imported note embeds
       * satisfies neither disjunct for any user, forever. FR-143 does not admit
       * an undeletable object, and the archive owner is the data controller.
       * This grants no ability to READ anything — it is bound to this one
       * statement, and a negative control in media-escalation.test.ts pins that.
       */
      const row = await client.query(
        `select 1 from public.media m
          where m.id = $1 and m.archive_id = $2
            and (m.created_by = $3 or exists (
                  select 1 from public.memberships ms
                   where ms.archive_id = $2 and ms.user_id = $3 and ms.role = 'owner'))
          for update`,
        [mediaId, archiveId, userId],
      );
      if (row.rowCount === 0) {
        // the caller may not see this blob, or lost a race with another delete
        // of the same row. Same uniform answer either way.
        await client.query('rollback');
        return c.json({ error: 'not found' }, 404);
      }
      await client.query(
        `insert into public.tombstones (archive_id, subject_id, kind, deleted_by)
         values ($1, $2, 'media', $3)`,
        [archiveId, mediaId, userId],
      );
      await client.query(`delete from public.media where id = $1`, [mediaId]);

      /**
       * COUNT SIBLINGS BEFORE COMMIT, under the advisory lock this path already
       * holds on (archive, hash). Inside the transaction and after the delete,
       * so the number is what will be true once it commits; a count taken
       * before `begin`, or after `commit`, can be stale by the time Storage is
       * touched, and the lock is what stops a concurrent upload interleaving.
       */
      const siblings = await client.query<{ n: string }>(
        `select count(*)::int as n from public.media
          where archive_id = $1 and content_hash = $2`,
        [archiveId, contentHash],
      );
      /**
       * FAILING TOWARD KEEPING BYTES. `?? 1` reads as "assume a sibling exists"
       * if the count is somehow absent: an unreferenced blob is sweepable
       * residue, while a wrongly removed one breaks an unrelated memory with no
       * recovery. The two errors are not symmetric, so the default is not
       * symmetric either.
       */
      const lastReference = Number(siblings.rows[0]?.n ?? 1) === 0;
      await client.query('commit');

      if (!lastReference) {
        /**
         * ANOTHER MEMORY STILL HOLDS THIS PHOTOGRAPH. The row is gone and the
         * tombstone is written; the bytes stay, because they are not this
         * caller's to destroy.
         *
         * THE RESPONSE SHAPE IS DELIBERATELY IDENTICAL to the last-reference
         * branch. Reporting `bytesRetained` here and omitting it below would
         * let a caller who possesses bytes upload them, delete their own row,
         * and learn from the shape whether ANOTHER member also holds them.
         * Preimage-class, but the same family as the R3 dedup oracle this line
         * of work already closed once. Whether the blob survives is the
         * server's business; the caller's row is gone either way.
         */
        return c.json({ id: mediaId, deleted: true });
      }

      // remove() reports missing AND blocked paths as empty success — verify by
      // diffing; residue becomes future-sweep work.
      const prefix = mediaPrefix(archiveId, contentHash);
      const legacy = mediaLegacyKey(archiveId, contentHash);
      try {
        const leaves = await listAllUnderPrefix(deps.storage, MEDIA_BUCKET, prefix);
        // the legacy key is ALWAYS a target, never gated on the listing being
        // empty: a row can be mixed (flat original + new-shape derivative), and
        // gating would leave the original behind. It also guarantees the array
        // is non-empty — remove([]) is a 400.
        const targets = [...leaves, legacy];
        // a row with bytes has them somewhere: an empty prefix means the row is
        // legacy-shaped, so the legacy key's absence from `removed` is residue
        const expected = leaves.length > 0 ? leaves : [legacy];
        const removed = await deps.storage.storage.from(MEDIA_BUCKET).remove(targets);
        if (removed.error) {
          console.error(
            `media erasure residue: remove failed for ${prefix} (${removed.error.message})`,
          );
        } else {
          for (const key of residueOf(
            expected,
            (removed.data ?? []).map((o) => o.name),
          )) {
            console.error(`media erasure residue: blob ${key} not confirmed removed`);
          }
        }
      } catch (e) {
        console.error(`media erasure residue: removal threw for ${prefix} (${String(e)})`);
      }
      return c.json({ id: mediaId, deleted: true });
    } catch {
      await client.query('rollback').catch(() => {});
      return c.json({ error: 'internal error' }, 500);
    } finally {
      if (lockedHash) await unlockHash(client, archiveId, lockedHash);
      unguard();
      client.release();
    }
  });
}
