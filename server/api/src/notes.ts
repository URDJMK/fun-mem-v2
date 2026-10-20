import { randomUUID } from 'node:crypto';
import {
  canonicalTitle,
  checkFragment,
  ENTITY_TYPES,
  extractWikilinks,
  normalizeTitle,
  parseFuzzyDate,
  renameLinkTargets,
  validateNoteTitle,
} from '@funmem/core';
import { bodyLimit } from 'hono/body-limit';
import type { PoolClient } from 'pg';
import type { Context } from 'hono';
import type { App, AppDeps } from './app';
import { crossNoteMarker } from './conflicts';
import { isMember, UUID_RE, WRITE_ROLES } from './membership';
import { visibleSql, visibleNoteSql } from './views';
import { reindexChunks } from './chunks';

/**
 * Notes CRUD + append-only version log + link reindex (FM-015).
 * Every route: membership BEFORE retrieval (uniform 404, FR-081); every write
 * appends an attributed revision (FR-060) — overwriting the head row without a
 * revision is the forbidden shortcut this module exists to prevent.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413,
    /** a stable code for a page that must not parse English */
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * How long one note may be, and how many links it may hold. Every save rewrites a note's links
 * and chunks while it holds the archive's write lock, so one PUT of 20,000 links (209 KB) held
 * every other writer of that family for 73 s (round-3 review D7). Two hundred thousand
 * characters is about a hundred pages; an import already writes at most 20,000 per memory.
 */
export const MAX_NOTE_CHARS = 200_000;
export const MAX_NOTE_LINKS = 1_000;

/** A note's text, checked before any lock is taken. */
export function checkBody(body: string): void {
  if (body.length > MAX_NOTE_CHARS) {
    throw new ApiError(
      `the text is too long: at most ${MAX_NOTE_CHARS.toLocaleString('en-US')} characters`,
      413,
      'too_long',
    );
  }
  if (extractWikilinks(body).length > MAX_NOTE_LINKS) {
    throw new ApiError(
      `too many links in one note: at most ${MAX_NOTE_LINKS.toLocaleString('en-US')}`,
      400,
      'too_many_links',
    );
  }
}

/**
 * JSON for a set-based insert. A lone UTF-16 surrogate (a broken paste) used to be stored as
 * U+FFFD by the driver's text encoding; in a jsonb parameter it would be refused instead, so it
 * is made well-formed here, the same way.
 */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export const rowsJson = (rows: unknown[]): string =>
  JSON.stringify(rows, (_k, v: unknown) =>
    typeof v === 'string' ? v.replace(LONE_SURROGATE, '�') : v,
  );

/** C0 control characters and DEL, except tab and the two line ends: an import's edits are cleaned the same way */
const noControls = (v: string): string =>
  v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

export interface NoteInput {
  title?: string;
  type?: string;
  body?: string;
  /** null or an empty string clears the date */
  occurred?: string | null;
}

const DATE_HINT = 'the date must look like 1987, 1987-03, 1987-03-15 or ~1948';

/**
 * A note request, checked for SHAPE before anything else. A title that was a number or an
 * object, a body that was JSON null, or a NUL typed into a note each answered 500, and
 * `occurred: 5` was stored as if it were a date (round-3 review D10). The words themselves are
 * the person's: only control characters are taken out (a NUL cannot be stored at all). Whether
 * a date is one the archive can read is `checkDate`'s, which knows the date a note already has.
 */
export function readNoteInput(raw: unknown): NoteInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError('the request must be a JSON object', 400, 'bad_request');
  }
  const r = raw as Record<string, unknown>;
  const out: NoteInput = {};
  for (const k of ['title', 'type', 'body'] as const) {
    const v = r[k];
    if (v === undefined) continue;
    if (typeof v !== 'string') throw new ApiError(`"${k}" must be text`, 400, 'bad_request');
    out[k] = k === 'type' ? v : noControls(v);
  }
  if (r.occurred !== undefined) {
    const v = r.occurred;
    if (v !== null && typeof v !== 'string') throw new ApiError(DATE_HINT, 400, 'date');
    out.occurred = v === null || v.trim() === '' ? null : v.trim();
  }
  return out;
}

/**
 * A NEW date must be one the timeline can read (`1987`, `1987-03`, `1987-03-15`, `~1948`,
 * `unknown`). The date a note already has may be sent back unchanged, whatever it is: a row
 * written before this rule (or by an import of an old bundle) must never make the note
 * impossible to save.
 */
function checkDate(occurred: string | null | undefined, current?: string | null): void {
  if (typeof occurred === 'string' && occurred !== current && parseFuzzyDate(occurred) === null) {
    throw new ApiError(DATE_HINT, 400, 'date');
  }
}

/** A note request may carry a note of at most 200,000 characters, escaped into JSON. */
const NOTE_REQUEST_BYTES = 2 * 1024 * 1024;
const noteBodyLimit = () =>
  bodyLimit({
    maxSize: NOTE_REQUEST_BYTES,
    onError: (c) => c.json({ error: 'the request is too large', code: 'too_large' }, 413),
  });

export interface NoteRow {
  id: string;
  archive_id: string;
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

export function noteShape(r: NoteRow) {
  return {
    id: r.id,
    title: r.title,
    type: r.type,
    noteClass: r.note_class,
    body: r.body,
    occurred: r.occurred,
    recorded: r.recorded,
    revised: r.revised,
    contributors: r.contributors,
    extra: r.extra,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** Trimmed containing line — mirrors FM-012's snippet semantics. */
function snippetAt(body: string, start: number): string {
  const lineStart = body.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const lineEnd = body.indexOf('\n', start);
  return body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd).trim();
}

/** FM-050: was a private duplicate of core's rule and did not import it. */
const normalize = normalizeTitle;

/**
 * Delete-and-reinsert this note's outgoing link occurrences (FM-012 pattern).
 * Targets resolve through the CI-unique title index; empty target = self-reference.
 */
export async function reindexLinks(
  client: PoolClient,
  archiveId: string,
  noteId: string,
  body: string,
): Promise<void> {
  await client.query(`delete from public.links where source_id = $1`, [noteId]);
  const links = extractWikilinks(body);
  if (links.length === 0) return;
  const targets = [...new Set(links.map((l) => normalize(l.target)).filter((t) => t !== ''))];
  const resolved = new Map<string, string>();
  if (targets.length > 0) {
    const rows = await client.query(
      // FM-050: both operands normalized, and written EXACTLY as the index
      // expression so the planner can still use notes_archive_title_ci
      // FM-056 — the SAME invariant, at the primary resolution site. This
      // resolved a title to ANY note carrying it, so every save silently linked
      // a member's `[[title]]` to another member's private note of that name.
      // It is the site the other two feed from, and it was the one missing.
      //
      // The subject is the SOURCE note's author, passed as a scalar subquery so
      // `visibleSql` is composed rather than restated.
      `select n.id, normalize(lower(btrim(n.title)), NFC) as norm from public.notes n
        where n.archive_id = $1 and normalize(lower(btrim(n.title)), NFC) = any($2)
          and ${visibleSql('n', '(select created_by from public.notes where id = $3)')}`,
      [archiveId, targets, noteId],
    );
    for (const r of rows.rows) resolved.set(r.norm, r.id);
  }
  // ONE statement for all of the note's links: a statement per link is what made a note with
  // thousands of links hold the archive's write lock for over a minute (round-3 review D7)
  await client.query(
    `insert into public.links
       (archive_id, source_id, target, resolved_id, heading, block_id, embed, start_pos, end_pos, snippet)
     select $1, $2, r.target, r.resolved_id, r.heading, r.block_id, r.embed, r.start_pos,
            r.end_pos, r.snippet
       from jsonb_to_recordset($3::jsonb) as r(
              target text, resolved_id uuid, heading text, block_id text, embed boolean,
              start_pos int, end_pos int, snippet text)`,
    [
      archiveId,
      noteId,
      rowsJson(
        links.map((l) => ({
          target: l.target,
          resolved_id: l.target === '' ? noteId : (resolved.get(normalize(l.target)) ?? null),
          heading: l.heading ?? null,
          block_id: l.blockId ?? null,
          embed: l.embed,
          start_pos: l.start,
          end_pos: l.end,
          snippet: snippetAt(body, l.start),
        })),
      ),
    ],
  );
}

/**
 * A renamed note releases incoming occurrences whose authored target no longer
 * matches its title (FM-012 demote law) — a later note with the old title can
 * then claim them; without this, stale resolved_id rows diverge from a rebuild.
 */
async function demoteStale(
  client: PoolClient,
  archiveId: string,
  noteId: string,
  newTitle: string,
): Promise<void> {
  await client.query(
    `update public.links set resolved_id = null
      where archive_id = $1 and resolved_id = $2
        and normalize(lower(btrim(target)), NFC) <> $3
        and btrim(target) <> ''`,
    [archiveId, noteId, normalize(newTitle)],
  );
}

/** A new/renamed note claims archive-wide unresolved occurrences of its title. */
async function promoteUnresolved(
  client: PoolClient,
  archiveId: string,
  noteId: string,
  title: string,
): Promise<void> {
  // FM-056: the same invariant, at the point the edge is CREATED. This update
  // ran archive-wide, so a member's dangling `[[title]]` silently resolved to
  // another member's private note of that title — which is how the rename
  // cascade came to have anything to leak into.
  await client.query(
    `update public.links l set resolved_id = $1
       from public.notes s, public.notes t
      where l.source_id = s.id and t.id = $1
        and l.archive_id = $2 and l.resolved_id is null
        and normalize(lower(btrim(l.target)), NFC) = $3
        and ${visibleSql('t', 's.created_by')}`,
    [noteId, archiveId, normalize(title)],
  );
}

/**
 * FR-022 rename cascade: rewrite the authored link text in every referrer body
 * (leaving stale text and relying on UUID resolution is the forbidden shortcut).
 * Runs inside the caller's advisory-locked transaction AFTER the head row holds
 * the new title, so reindex resolves the rewritten text back to this note.
 * Each rewritten referrer gains its own attributed revision (DoD 3).
 */
async function rewriteReferrers(
  client: PoolClient,
  archiveId: string,
  noteId: string,
  oldTitle: string,
  newTitle: string,
  userId: string,
  changeId: string,
): Promise<void> {
  // FM-056 — THE INVARIANT: a link may be resolved only when its target is
  // visible to the AUTHOR OF ITS SOURCE. Without this the cascade rewrote a
  // private note's new title into other members' bodies and stamped each with a
  // permanent, exported `rename-cascade` revision: the victim learned the title
  // of a note they may not read, and their own words were edited by a machine.
  //
  // The predicate is COMPOSED, not restated — `visibleSql` with the referrer's
  // author as the subject. A second copy is how FM-032's by-id surfaces drifted
  // apart from the list surfaces in the first place.
  //
  // It must hold AT THE QUERY. Filtering the rows afterwards in TypeScript would
  // mean the private title had already been read into the process.
  // DoD 4 (occurrences that cannot be rewritten demote to unresolved) is
  // satisfied by `demoteStale`, which already runs immediately after this on the
  // rename path: it nulls every link resolved here whose target text no longer
  // matches the new title, and a skipped referrer's target matched the OLD title
  // by definition. An extra demotion UPDATE here was unreachable — mutation
  // testing showed disabling it entirely failed nothing — so it is gone rather
  // than left advertising a protection it never provided.
  // in id order: every writer that locks several notes takes them in the same order, so
  // two of them can never each hold a row the other is waiting for
  const referrers = await client.query(
    `select distinct l.source_id from public.links l
       join public.notes s on s.id = l.source_id
       join public.notes t on t.id = l.resolved_id
      where l.archive_id = $1 and l.resolved_id = $2 and l.source_id <> $2
        and ${visibleSql('t', 's.created_by')}
      order by l.source_id`,
    [archiveId, noteId],
  );

  for (const r of referrers.rows) {
    const ref = await client.query(
      `select title, body from public.notes where id = $1 and archive_id = $2 for update`,
      [r.source_id, archiveId],
    );
    if (ref.rowCount === 0) continue;
    const { title, body } = ref.rows[0] as { title: string; body: string };
    const rewritten = renameLinkTargets(body, oldTitle, newTitle);
    if (rewritten === body) continue; // stale-index guard: nothing really matched
    await client.query(`update public.notes set body = $1, revised = now() where id = $2`, [
      rewritten,
      r.source_id,
    ]);
    const refRev = await appendRevision(
      client,
      archiveId,
      r.source_id,
      userId,
      title,
      rewritten,
      'rename-cascade',
      changeId,
    );
    await reindexLinks(client, archiveId, r.source_id, rewritten);
    await reindexChunks(client, archiveId, r.source_id, refRev, rewritten);
  }
}

/* ── an erased note's words do not stay quoted elsewhere (FR-143) ──────── */

interface MarkerForm {
  /** everything before the title, through `[[` */
  open: string;
  /** what follows the title: `]] · ` */
  shut: string;
  /** what comes just before the quoted words */
  says: string;
  /** what closes the line after them */
  end: string;
}

let markerForm: MarkerForm | null = null;

/**
 * The fixed words of a "may disagree with [[note]]" line, read off the one function that writes
 * it (`crossNoteMarker`), so this reader cannot drift from the writer.
 */
function form(): MarkerForm {
  if (markerForm) return markerForm;
  const [T, W, E] = ['qqtitleqq', 'qqwhenqq', 'qqexistingqq'];
  const line = crossNoteMarker(
    { when: W, who: null, channel: 'interview' },
    { claim: 'A sentence in English.', title: T, existing: E },
  );
  const t = line.indexOf(`[[${T}]]`);
  const e = line.indexOf(E);
  markerForm = {
    open: `${line.slice(0, t)}[[`,
    shut: line.slice(t + 2 + T.length, line.indexOf(W)),
    says: line.slice(line.lastIndexOf(': ', e), e),
    end: line.slice(e + E.length),
  };
  return markerForm;
}

/**
 * The title a machine-written "may disagree with [[note]]" line names (an import's or the
 * assistant's), or null for any other line. A line a person has rewritten out of that shape is
 * theirs, and is not one. The title and the words quoted may be in any script: only the fixed
 * words around them are read.
 */
export function markerTarget(line: string): string | null {
  const l = line.endsWith('\r') ? line.slice(0, -1) : line;
  const f = form();
  if (!l.startsWith(f.open) || !l.endsWith(f.end)) return null;
  const close = l.indexOf(f.shut, f.open.length);
  if (close <= f.open.length || l.indexOf(f.says, close) === -1) return null;
  return l.slice(f.open.length, close);
}

/**
 * A body without the machine-written "may disagree" lines naming one of `titles` (normalized).
 * Nothing else changes: a line that was a block of its own leaves no empty paragraph behind.
 */
export function withoutMarkersNaming(body: string, titles: ReadonlySet<string>): string {
  if (titles.size === 0 || !body.includes('[[')) return body;
  const lines = body.split('\n');
  const out: string[] = [];
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    const target = markerTarget(lines[i]!);
    if (target === null || !titles.has(normalize(target))) {
      out.push(lines[i]!);
      continue;
    }
    removed = true;
    const next = lines[i + 1];
    if (out.length > 0 && out[out.length - 1]!.trim() === '' && (next ?? '').trim() === '') {
      out.pop();
    }
  }
  return removed ? out.join('\n') : body;
}

/**
 * Before notes are erased, in the erasing transaction: every OTHER note that quotes one of them
 * in a machine-written "may disagree with [[note]] … that note says “…”" line loses that line
 * (round-3 review D2: undo answered `{erased: 1}` while another memory still carried the erased
 * sentence word for word, under a dead link). Found while their links still resolve to the notes
 * being erased, locked in id order like every writer here, read again after the lock. Each note
 * changed gains an `erasure-cascade` revision, which an undo does not count as somebody's work,
 * and its links, chunks and vectors follow. A person's own words, links included, are not
 * touched. Its earlier revisions are history and keep what they held (the revision log is
 * append-only). Returns how many notes changed.
 */
export async function scrubQuotesOf(
  client: PoolClient,
  archiveId: string,
  noteIds: string[],
  userId: string,
  changeId: string,
): Promise<number> {
  if (noteIds.length === 0) return 0;
  const named = await client.query(
    `select title from public.notes where archive_id = $1 and id = any($2::uuid[])`,
    [archiveId, noteIds],
  );
  const titles = new Set(named.rows.map((r) => normalize((r as { title: string }).title)));
  if (titles.size === 0) return 0;
  const referrers = await client.query(
    `select n.id from public.notes n
      where n.id in (select l.source_id from public.links l
                      where l.archive_id = $1 and l.resolved_id = any($2::uuid[]))
        and not (n.id = any($2::uuid[]))
      order by n.id
      for update of n`,
    [archiveId, noteIds],
  );
  if (referrers.rowCount === 0) return 0;
  const rows = await client.query(
    `select id, title, body from public.notes where id = any($1::uuid[]) order by id`,
    [referrers.rows.map((r) => (r as { id: string }).id)],
  );
  let changed = 0;
  for (const r of rows.rows as Array<{ id: string; title: string; body: string }>) {
    const body = withoutMarkersNaming(r.body, titles);
    if (body === r.body) continue;
    await client.query(`update public.notes set body = $1, revised = now() where id = $2`, [
      body,
      r.id,
    ]);
    const rev = await appendRevision(
      client,
      archiveId,
      r.id,
      userId,
      r.title,
      body,
      'erasure-cascade',
      changeId,
    );
    await reindexLinks(client, archiveId, r.id, body);
    await reindexChunks(client, archiveId, r.id, rev, body);
    changed++;
  }
  return changed;
}

/**
 * Who is told, per app, that notes were erased: the import jobs, whose previews may still hold
 * quotes of them. Keyed by the app's deps, so two apps in one process never hear each other.
 */
const erasureListeners = new WeakMap<AppDeps, (archiveId: string, noteIds: string[]) => void>();

export function onNotesErased(
  deps: AppDeps,
  listener: (archiveId: string, noteIds: string[]) => void,
): void {
  erasureListeners.set(deps, listener);
}

/** After the erasing transaction has committed. */
export function notesErased(deps: AppDeps, archiveId: string, noteIds: string[]): void {
  if (noteIds.length > 0) erasureListeners.get(deps)?.(archiveId.toLowerCase(), noteIds);
}

/**
 * Why a revision exists (FM-039). `rename-cascade` is the load-bearing one: a
 * machine rewrite of someone else's note must never read as that person editing
 * their own words. `erasure-cascade` is its sibling: a "may disagree with" line
 * taken out because the note it quoted was erased (round-3 review D2). Mirrors
 * `public.revision_reason`.
 */
export type RevisionReason =
  'create' | 'edit' | 'rename-cascade' | 'erasure-cascade' | 'restore' | 'import' | 'ai-suggestion';

/**
 * Append the attributed revision row — the version log IS the history (§4.6) —
 * and return its id so the chunk index can cite it (FR-044 provenance).
 *
 * `reason` and `changeId` are REQUIRED, deliberately: a defaulted parameter is
 * how a call site added later silently records 'edit' for a machine rewrite.
 */
export async function appendRevision(
  client: PoolClient,
  archiveId: string,
  noteId: string,
  author: string,
  title: string,
  body: string,
  reason: RevisionReason,
  changeId: string,
): Promise<string> {
  const r = await client.query(
    `insert into public.revisions (note_id, archive_id, author, title, body, reason, change_id)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [noteId, archiveId, author, title, body, reason, changeId],
  );
  return r.rows[0].id as string;
}

/**
 * The change id is minted HERE, once per transaction, and handed to the
 * callback — so a rename that rewrites 40 referrers produces 41 revisions
 * sharing one id without any call site having to remember. Minting it inside
 * appendRevision would give every row its own, which is the thing being
 * prevented.
 */
export async function inTransaction<T>(
  deps: AppDeps,
  archiveId: string,
  fn: (client: PoolClient, changeId: string) => Promise<T>,
): Promise<T> {
  return queued(archiveId.toLowerCase(), () => transact(deps, archiveId, fn));
}

/**
 * Writers to ONE archive wait their turn here, in this process, before they take a database
 * connection. They used to take one first and wait on the archive's lock while holding it,
 * so twelve saves queued on one archive held all ten connections of the pool and every other
 * family's requests stalled behind them (round-2 review, measured: a read elsewhere waited
 * 3 s). The database lock below still serialises writers across processes.
 */
const turns = new Map<string, Promise<void>>();
async function queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = turns.get(key) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((resolve) => (done = resolve));
  const tail = before.then(() => mine);
  turns.set(key, tail);
  await before;
  try {
    return await fn();
  } finally {
    done();
    if (turns.get(key) === tail) turns.delete(key);
  }
}

/**
 * A checked-out connection that dies mid-request (a database restart, a failover) emits an
 * 'error' EVENT as well as failing the query in progress, and with no listener that event ended
 * the whole process (round-3 review D5). The request fails as it should; the dead client is
 * dropped by the pool when it is released. Returns the function that takes the listener off.
 */
export function onLostConnection(client: PoolClient): () => void {
  const ignore = () => undefined;
  client.on('error', ignore);
  return () => client.removeListener('error', ignore);
}

async function transact<T>(
  deps: AppDeps,
  archiveId: string,
  fn: (client: PoolClient, changeId: string) => Promise<T>,
): Promise<T> {
  const client = await deps.pool.connect();
  const unguard = onLostConnection(client);
  const changeId = randomUUID();
  try {
    await client.query('begin');
    // one writer per archive: serializes link resolve/promote/demote against
    // concurrent note creation (read-committed write skew would otherwise leave
    // occurrences unresolved that a rebuild from bodies would resolve).
    //
    // Keyed on the LOWER-CASED id: a uuid in a URL may arrive in either case, and
    // two spellings of one archive were two locks, so an edit sent with an
    // upper-case id ran alongside an undo and the undo erased the note it had
    // just changed (round-2 review #3).
    await client.query('select pg_advisory_xact_lock(hashtext(lower($1))::bigint)', [archiveId]);
    const result = await fn(client, changeId);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    unguard();
    client.release();
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

type Ctx = Context<{ Variables: { userId: string } }>;

function respondError(c: Ctx, e: unknown) {
  // a writer demoted while the write waited: the same answer the gate gives
  if (e instanceof WriteRefused) return c.json(READ_ONLY, 403);
  if (e instanceof ApiError) {
    return c.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
  }
  if (isUniqueViolation(e)) return c.json({ error: 'title already exists in this archive' }, 409);
  return c.json({ error: 'internal error' }, 500);
}

/** Membership gate + noteId shape check; uniform 404 keeps foreign/unknown/malformed identical. */
async function gate(c: Ctx, deps: AppDeps, requireNoteId: boolean): Promise<boolean> {
  const archiveId = c.req.param('archiveId');
  if (!archiveId || !(await isMember(deps.pool, c.get('userId'), archiveId))) return false;
  if (requireNoteId) {
    const noteId = c.req.param('noteId');
    if (!noteId || !UUID_RE.test(noteId)) return false;
  }
  return true;
}

/** FR-100's writing roles, defined once in membership.ts (kept importable from here). */
export { WRITE_ROLES };

/** A write turned away because the writer's role, read inside the transaction, only reads. */
export class WriteRefused extends ApiError {
  constructor() {
    super('only an owner, steward or contributor can change memories', 403);
  }
}

/**
 * Inside a write's transaction, before anything is read or written: the writer must STILL be a
 * member with a writing role. The route checked it before the write queued, and a member
 * demoted or removed while their write waited (behind an import's save: seconds) still wrote
 * (round-3 review D6). The membership row is held (for share) until the transaction ends.
 */
async function requireWriter(client: PoolClient, archiveId: string, userId: string) {
  const r = await client.query(
    `select role::text as role from public.memberships
      where archive_id = $1 and user_id = $2 for share`,
    [archiveId, userId],
  );
  const role = (r.rows[0] as { role: string } | undefined)?.role;
  if (role === undefined) throw new ApiError('not found', 404);
  if (!WRITE_ROLES.includes(role)) throw new WriteRefused();
}

/**
 * The gate for a route that WRITES. A stranger still learns nothing (the same 404 as
 * `gate`); a member whose role only reads is told so. Without this a viewer could create,
 * overwrite and delete memories, and an edit by someone who may not write marked an
 * imported memory as worked on, so it could no longer be undone (round-2 review #6).
 */
async function writeGate(
  c: Ctx,
  deps: AppDeps,
  requireNoteId: boolean,
): Promise<'ok' | 'not_found' | 'forbidden'> {
  const archiveId = c.req.param('archiveId');
  if (!archiveId || !UUID_RE.test(archiveId)) return 'not_found';
  const r = await deps.pool.query(
    `select role::text as role from public.memberships where user_id = $1 and archive_id = $2`,
    [c.get('userId'), archiveId],
  );
  const role = (r.rows[0] as { role: string } | undefined)?.role;
  if (role === undefined) return 'not_found';
  if (requireNoteId) {
    const noteId = c.req.param('noteId');
    if (!noteId || !UUID_RE.test(noteId)) return 'not_found';
  }
  return WRITE_ROLES.includes(role) ? 'ok' : 'forbidden';
}

const NOT_FOUND = { error: 'not found' } as const;
const READ_ONLY = {
  error: 'only an owner, steward or contributor can change memories',
  code: 'forbidden',
  reason: 'role',
} as const;

/** The answer to a write that `writeGate` turned away, or null to go ahead. */
async function refuseWrite(c: Ctx, deps: AppDeps, requireNoteId: boolean) {
  const g = await writeGate(c, deps, requireNoteId);
  return g === 'ok' ? null : g === 'forbidden' ? c.json(READ_ONLY, 403) : c.json(NOT_FOUND, 404);
}

/**
 * FM-044: how many backlink occurrences one note may return. A hub note in a
 * dense archive has unbounded fan-in and the sidebar renders one row per
 * occurrence, so this is the difference between a page and a hang. Live max
 * fan-in today is 6 — a ceiling, not a limit anyone is hitting.
 */
const BACKLINK_LIMIT = 50;

/**
 * `{ fragmentStatus }` when the occurrence carries a fragment, `{}` otherwise —
 * spread into the response so the key is genuinely absent rather than
 * `undefined`, which `JSON.stringify` would drop but `'fragmentStatus' in obj`
 * would still report.
 */
function fragmentField(
  targetBody: string,
  heading: string | null,
  blockId: string | null,
): { fragmentStatus?: 'ok' | 'broken' } {
  // One of TWO independent guards on the same property — this early exit, and
  // the `status === undefined` branch below. Mutation-verified: removing either
  // alone still leaves fragmentless links unlabelled; removing both does not.
  // So neither is dead code and neither is individually load-bearing.
  if (heading === null && blockId === null) return {};
  const status = checkFragment(targetBody, {
    raw: '',
    target: '',
    ...(heading !== null ? { heading } : {}),
    ...(blockId !== null ? { blockId } : {}),
    embed: false,
    start: 0,
    end: 0,
  });
  return status === undefined ? {} : { fragmentStatus: status };
}

/**
 * Create a note, with its create revision, links, chunks and link promotion, in
 * one transaction. The route and the AI agent share this, so a note an AI writes
 * is indistinguishable in shape from one a person writes EXCEPT for `reason`,
 * which is required and is what marks a revision as machine-made.
 */
export async function createNoteCore(
  deps: AppDeps,
  archiveId: string,
  userId: string,
  input: NoteInput,
  reason: RevisionReason,
): Promise<NoteRow> {
  // FM-050: canonical at the door. Composition only — never case-folded.
  const title = input.title ? canonicalTitle(input.title) : undefined;
  const type = input.type;
  if (!title || !type || !(ENTITY_TYPES as readonly string[]).includes(type)) {
    throw new ApiError('title and a valid type are required', 400, 'bad_request');
  }
  const titleError = validateNoteTitle(title);
  if (titleError) throw new ApiError(titleError, 400);
  const body = typeof input.body === 'string' ? input.body : '';
  checkBody(body);
  checkDate(input.occurred);
  const row = await inTransaction(deps, archiveId, async (client, changeId) => {
    await requireWriter(client, archiveId, userId);
    const inserted = await client.query(
      `insert into public.notes (archive_id, title, type, body, occurred, created_by)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [archiveId, title, type, body, input.occurred ?? null, userId],
    );
    const note = inserted.rows[0] as NoteRow;
    const createRev = await appendRevision(
      client,
      archiveId,
      note.id,
      userId,
      title,
      body,
      reason,
      changeId,
    );
    await reindexLinks(client, archiveId, note.id, body);
    await reindexChunks(client, archiveId, note.id, createRev, body);
    await promoteUnresolved(client, archiveId, note.id, title);
    return note;
  });
  return row;
}

export interface NewNoteInput {
  title: string;
  type: string;
  body: string;
  occurred?: string | null;
}

export interface BatchHooks {
  /**
   * Runs first, under the archive's write lock, before any note is written: a check that
   * can refuse the whole write by throwing (who may write, whether it is a duplicate).
   */
  before?: (client: PoolClient, ctx: { changeId: string }) => Promise<void>;
  /** Runs last, in the same transaction, after every note is written (the import record). */
  after?: (client: PoolClient, ctx: { changeId: string; notes: NoteRow[] }) => Promise<void>;
}

/**
 * Write several notes in ONE transaction: all of them, or none.
 *
 * Used by interview import, where 45 memories must not half-land. Every note gets
 * its create revision, links, chunks and link promotion exactly as `createNoteCore`
 * does, and every revision shares one `change_id`, which is how an import is later
 * found and undone as a unit. `hooks.before` runs first and may refuse; `hooks.after`
 * runs after the last insert (the import record is written there, so a duplicate
 * import rolls the notes back with it).
 *
 * Titles must be unique; a collision raises Postgres 23505 and rolls back. `inputs` may be
 * a function, called inside the transaction after `hooks.before`, under the archive's
 * lock: titles settled THERE cannot be taken by another writer before they are written.
 */
export async function createNotesBatch(
  deps: AppDeps,
  archiveId: string,
  userId: string,
  inputs: NewNoteInput[] | ((client: PoolClient) => Promise<NewNoteInput[]>),
  reason: RevisionReason,
  hooks: BatchHooks = {},
): Promise<{ notes: NoteRow[]; changeId: string }> {
  const prepare = (list: NewNoteInput[]) =>
    list.map((input) => {
      const title = input.title ? canonicalTitle(input.title) : undefined;
      if (!title || !input.type || !(ENTITY_TYPES as readonly string[]).includes(input.type)) {
        throw new ApiError('title and a valid type are required', 400, 'bad_request');
      }
      const titleError = validateNoteTitle(title);
      if (titleError) throw new ApiError(titleError, 400);
      checkBody(input.body ?? '');
      return { title, type: input.type, body: input.body ?? '', occurred: input.occurred ?? null };
    });
  // known inputs are checked before any connection is taken
  const early = Array.isArray(inputs) ? prepare(inputs) : null;
  return inTransaction(deps, archiveId, async (client, changeId) => {
    if (hooks.before) await hooks.before(client, { changeId });
    const prepared =
      early ?? prepare(await (inputs as (c: PoolClient) => Promise<NewNoteInput[]>)(client));
    const notes: NoteRow[] = [];
    for (const n of prepared) {
      const inserted = await client.query(
        `insert into public.notes (archive_id, title, type, body, occurred, created_by)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [archiveId, n.title, n.type, n.body, n.occurred, userId],
      );
      const note = inserted.rows[0] as NoteRow;
      const createRev = await appendRevision(
        client,
        archiveId,
        note.id,
        userId,
        n.title,
        n.body,
        reason,
        changeId,
      );
      await reindexLinks(client, archiveId, note.id, n.body);
      await reindexChunks(client, archiveId, note.id, createRev, n.body);
      await promoteUnresolved(client, archiveId, note.id, n.title);
      notes.push(note);
    }
    if (hooks.after) await hooks.after(client, { changeId, notes });
    return { notes, changeId };
  });
}

/**
 * Erase notes for good (FR-143), inside a transaction the caller owns: the notes, whose
 * revisions cascade away through the erasure door, then a content-free tombstone for each
 * note actually erased. Incoming links are left unresolved, and a person's words in other
 * notes are not rewritten; what the MACHINE quoted of them elsewhere (a "may disagree with"
 * line) is taken out first (`scrubQuotesOf`). The notes are locked first, in id order, so the
 * quotes removed are exactly those of the notes that go (round-3 D2). Returns the ids erased.
 */
export async function eraseNotes(
  client: PoolClient,
  archiveId: string,
  noteIds: string[],
  userId: string,
  opts: { changeId: string },
): Promise<string[]> {
  if (noteIds.length === 0) return [];
  await client.query(
    `select id from public.notes where archive_id = $1 and id = any($2::uuid[])
      order by id for update`,
    [archiveId, noteIds],
  );
  const going = (
    await client.query(
      `select n.id from public.notes n
        where n.archive_id = $1 and n.id = any($2::uuid[])`,
      [archiveId, noteIds],
    )
  ).rows.map((r) => (r as { id: string }).id);
  if (going.length === 0) return [];
  await scrubQuotesOf(client, archiveId, going, userId, opts.changeId);
  // transaction-local flag: it lets the revisions cascade pass the append-only trigger HERE ONLY
  await client.query(`select set_config('funmem.erasure', 'on', true)`);
  const gone = await client.query(
    `delete from public.notes n
      where n.archive_id = $1 and n.id = any($2::uuid[])
      returning n.id`,
    [archiveId, going],
  );
  const erased = gone.rows.map((r) => (r as { id: string }).id);
  if (erased.length > 0) {
    await client.query(
      `insert into public.tombstones (archive_id, subject_id, kind, deleted_by)
       select $1, id, 'note', $3 from unnest($2::uuid[]) as id`,
      [archiveId, erased, userId],
    );
  }
  return erased;
}

/**
 * Replace a note's title/body/occurred. Shared by the PUT route and the AI agent;
 * `reason` is required for the same reason `appendRevision`'s is: an AI edit must
 * never be recorded as the person editing their own words.
 */
export async function updateNoteCore(
  deps: AppDeps,
  archiveId: string,
  noteId: string,
  userId: string,
  input: Omit<NoteInput, 'type'>,
  reason: RevisionReason,
): Promise<NoteRow> {
  if (typeof input.body === 'string') checkBody(input.body);
  return inTransaction(deps, archiveId, async (client, changeId) => {
    await requireWriter(client, archiveId, userId);
    const current = await client.query(
      `select * from public.notes n where ${visibleNoteSql('n', '$1', '$2', '$3')} for update`,
      [noteId, archiveId, userId],
    );
    if (current.rowCount === 0) throw new ApiError('not found', 404);
    const head = current.rows[0] as NoteRow;
    checkDate(input.occurred, head.occurred);
    // `|| head.title` preserved from before FM-050: a whitespace-only
    // title falls back to the head rather than becoming '' and failing
    // validation. Canonicalization must not smuggle in a behaviour change.
    const title = (input.title ? canonicalTitle(input.title) : '') || head.title;
    // FM-050: compare CANONICAL bytes, not the case-folded key. A title
    // resubmitted in a different composition form is the same title, and
    // treating it as a rename would splice non-canonical bytes into every
    // referring member's body. But a CASE change is a real rename — FM-016
    // rewrites `[[Mom Four]]` to `[[MOM FOUR]]` in referrers — so
    // normalizeTitle (which lowercases) is the wrong comparison here.
    const renamed = title !== canonicalTitle(head.title);
    if (renamed) {
      const titleError = validateNoteTitle(title);
      if (titleError) throw new ApiError(titleError, 400);
    }
    // FM-051: prose and links to OTHER notes are stored byte-for-byte as
    // the client sent them. On a title change, this note's own
    // just-invalidated self-title occurrences are corrected in place — the
    // same correction every other referrer receives.
    //
    // This used to be skipped whenever the request supplied a body, on the
    // stated grounds that a user-supplied body is authoritative. That left
    // a permanently unresolved self-link which a later note taking the old
    // title then claimed, surfacing the renamed note's own sentence on a
    // stranger's backlinks page. The original rationale (FM-016-findings:
    // "stored positions valid against the kept body") describes a design
    // that was never shipped — renameLinkTargets re-extracts live and holds
    // no offsets, so it is surgical by construction.
    let body = typeof input.body === 'string' ? input.body : head.body;
    if (renamed) {
      body = renameLinkTargets(body, head.title, title);
    }
    const occurred = input.occurred !== undefined ? input.occurred : head.occurred;
    // FM-038: a PUT that changes nothing is not evidence. The 700ms autosave
    // debounce coalesces keystrokes, so typing a character and deleting it
    // inside one window sends a body identical to head — and every such PUT
    // would append a permanent row to a log revisions_no_mutate makes
    // uncompactable. Compare the RESOLVED locals, never raw input.*: the
    // real client sends `{ body }` alone, so `input.title === head.title`
    // would be `undefined !== '...'` and the guard would never fire.
    // Returning here commits the transaction and releases the locks normally.
    if (title === head.title && body === head.body && occurred === head.occurred) {
      return head as NoteRow;
    }
    const updated = await client.query(
      `update public.notes set title = $1, body = $2, occurred = $3, revised = now()
        where id = $4 returning *`,
      [title, body, occurred, noteId],
    );
    const rev = await appendRevision(
      client,
      archiveId,
      noteId,
      userId,
      title,
      body,
      reason,
      changeId,
    );
    await reindexLinks(client, archiveId, noteId, body);
    await reindexChunks(client, archiveId, noteId, rev, body);
    if (renamed) {
      await rewriteReferrers(client, archiveId, noteId, head.title, title, userId, changeId);
      await demoteStale(client, archiveId, noteId, title);
      await promoteUnresolved(client, archiveId, noteId, title);
    }
    return updated.rows[0] as NoteRow;
  });
}

export function registerNotesRoutes(app: App, deps: AppDeps): void {
  app.post('/v1/archives/:archiveId/notes', noteBodyLimit(), async (c) => {
    const refused = await refuseWrite(c, deps, false);
    if (refused) return refused;
    const archiveId = c.req.param('archiveId');
    const userId = c.get('userId');
    try {
      // text that is not JSON is refused like any other malformed request, never read as "no change"
      const input = readNoteInput(await c.req.json().catch(() => null));
      const row = await createNoteCore(deps, archiveId, userId, input, 'create');
      return c.json(noteShape(row), 201);
    } catch (e) {
      return respondError(c, e);
    }
  });

  // D-24: the ONE fence-amended addition — archive home + editor TitleSource
  // enumeration. Summaries only (no bodies); membership gated before retrieval.
  // FM-020: carries `occurred` (timeline source) and applies the visibility
  // predicate so private-to-author notes never enumerate to non-authors.
  app.get('/v1/archives/:archiveId/notes', async (c) => {
    if (!(await gate(c, deps, false))) return c.json(NOT_FOUND, 404);
    const rows = await deps.pool.query(
      `select id, title, type, revised, occurred from public.notes n
        where archive_id = $1 and ${visibleSql('n', '$2')}
        order by revised desc nulls last, created_at desc`,
      [c.req.param('archiveId'), c.get('userId')],
    );
    return c.json(
      rows.rows.map((r) => ({
        id: r.id,
        title: r.title,
        type: r.type,
        revised: r.revised,
        occurred: r.occurred,
      })),
    );
  });

  app.get('/v1/archives/:archiveId/notes/:noteId', async (c) => {
    if (!(await gate(c, deps, true))) return c.json(NOT_FOUND, 404);
    const found = await deps.pool.query(
      `select * from public.notes n where ${visibleNoteSql('n', '$1', '$2', '$3')}`,
      [c.req.param('noteId'), c.req.param('archiveId'), c.get('userId')],
    );
    if (found.rowCount === 0) return c.json(NOT_FOUND, 404);
    return c.json(noteShape(found.rows[0] as NoteRow));
  });

  app.put('/v1/archives/:archiveId/notes/:noteId', noteBodyLimit(), async (c) => {
    const refused = await refuseWrite(c, deps, true);
    if (refused) return refused;
    const archiveId = c.req.param('archiveId');
    const noteId = c.req.param('noteId');
    const userId = c.get('userId');
    try {
      // text that is not JSON is refused like any other malformed request, never read as "no change"
      const input = readNoteInput(await c.req.json().catch(() => null));
      const row = await updateNoteCore(deps, archiveId, noteId, userId, input, 'edit');
      return c.json(noteShape(row));
    } catch (e) {
      return respondError(c, e);
    }
  });

  app.delete('/v1/archives/:archiveId/notes/:noteId', async (c) => {
    const refused = await refuseWrite(c, deps, true);
    if (refused) return refused;
    const archiveId = c.req.param('archiveId');
    const noteId = c.req.param('noteId');
    const userId = c.get('userId');
    try {
      const deletedAt = await inTransaction(deps, archiveId, async (client, changeId) => {
        await requireWriter(client, archiveId, userId);
        const current = await client.query(
          `select id from public.notes n where ${visibleNoteSql('n', '$1', '$2', '$3')} for update`,
          [noteId, archiveId, userId],
        );
        if (current.rowCount === 0) throw new ApiError('not found', 404);
        // what the machine quoted of it in other notes goes first, while their links still find it
        await scrubQuotesOf(client, archiveId, [current.rows[0].id as string], userId, changeId);
        // the erasure door (FR-143): transaction-local flag, dies with the txn;
        // it lets the revisions cascade pass the append-only trigger HERE ONLY
        await client.query(`select set_config('funmem.erasure', 'on', true)`);
        const stone = await client.query(
          `insert into public.tombstones (archive_id, subject_id, kind, deleted_by)
           values ($1, $2, 'note', $3) returning deleted_at`,
          [archiveId, noteId, userId],
        );
        // cascade: revisions (through the door), outgoing links + snippets,
        // audiences; links.resolved_id SET NULL leaves incoming occurrences
        // unresolved with the referrers' own words untouched (only the machine's
        // quotes of this note were taken out, above).
        // Deliberately NO appendRevision: a delete revision would retain content.
        await client.query(`delete from public.notes where id = $1`, [noteId]);
        return stone.rows[0].deleted_at as string;
      });
      // an import preview still quoting it lets go of the quote too
      notesErased(deps, archiveId, [noteId.toLowerCase()]);
      return c.json({ id: noteId, deletedAt });
    } catch (e) {
      return respondError(c, e);
    }
  });

  app.get('/v1/archives/:archiveId/notes/:noteId/revisions', async (c) => {
    if (!(await gate(c, deps, true))) return c.json(NOT_FOUND, 404);
    const note = await deps.pool.query(
      `select 1 from public.notes n where ${visibleNoteSql('n', '$1', '$2', '$3')}`,
      [c.req.param('noteId'), c.req.param('archiveId'), c.get('userId')],
    );
    if (note.rowCount === 0) return c.json(NOT_FOUND, 404);
    // FM-039: metadata only. Selecting `body` here shipped a note's ENTIRE
    // history on every list — unbounded, and nothing in the UI needed it.
    // Fetch one body through the sibling route below.
    const revs = await deps.pool.query(
      `select id, author, title, reason, change_id, length(body) as char_count, created_at
         from public.revisions
        where note_id = $1 and archive_id = $2 order by seq desc`,
      [c.req.param('noteId'), c.req.param('archiveId')],
    );
    return c.json(
      revs.rows.map((r) => ({
        id: r.id,
        author: r.author,
        title: r.title,
        reason: r.reason,
        changeId: r.change_id,
        charCount: r.char_count,
        createdAt: r.created_at,
      })),
    );
  });

  /**
   * FM-039: one revision's body. This is a SEVENTH by-id surface and therefore
   * composes `visibleNoteSql` exactly as the six FM-032 fixed do — that sweep
   * predates this route, so it cannot vouch for it. 404 on miss, never 403.
   */
  app.get('/v1/archives/:archiveId/notes/:noteId/revisions/:revisionId', async (c) => {
    if (!(await gate(c, deps, true))) return c.json(NOT_FOUND, 404);
    const revisionId = c.req.param('revisionId');
    if (!UUID_RE.test(revisionId)) return c.json(NOT_FOUND, 404);
    const note = await deps.pool.query(
      `select 1 from public.notes n where ${visibleNoteSql('n', '$1', '$2', '$3')}`,
      [c.req.param('noteId'), c.req.param('archiveId'), c.get('userId')],
    );
    if (note.rowCount === 0) return c.json(NOT_FOUND, 404);
    const rev = await deps.pool.query(
      `select id, author, title, body, reason, change_id, created_at
         from public.revisions
        where id = $1 and note_id = $2 and archive_id = $3`,
      [revisionId, c.req.param('noteId'), c.req.param('archiveId')],
    );
    if (rev.rowCount === 0) return c.json(NOT_FOUND, 404);
    const r = rev.rows[0];
    return c.json({
      id: r.id,
      author: r.author,
      title: r.title,
      body: r.body,
      reason: r.reason,
      changeId: r.change_id,
      createdAt: r.created_at,
    });
  });

  app.post('/v1/archives/:archiveId/notes/:noteId/restore', async (c) => {
    const refused = await refuseWrite(c, deps, true);
    if (refused) return refused;
    const archiveId = c.req.param('archiveId');
    const noteId = c.req.param('noteId');
    const userId = c.get('userId');
    const input = (await c.req.json().catch(() => ({}))) as { revisionId?: string };
    try {
      if (!input.revisionId || !UUID_RE.test(input.revisionId)) {
        throw new ApiError('not found', 404);
      }
      const row = await inTransaction(deps, archiveId, async (client, changeId) => {
        await requireWriter(client, archiveId, userId);
        const current = await client.query(
          `select * from public.notes n where ${visibleNoteSql('n', '$1', '$2', '$3')} for update`,
          [noteId, archiveId, userId],
        );
        if (current.rowCount === 0) throw new ApiError('not found', 404);
        const head = current.rows[0] as NoteRow;
        const rev = await client.query(
          `select title, body from public.revisions
            where id = $1 and note_id = $2 and archive_id = $3`,
          [input.revisionId, noteId, archiveId],
        );
        if (rev.rowCount === 0) throw new ApiError('not found', 404);
        const raw = rev.rows[0] as { title: string; body: string };
        const title = canonicalTitle(raw.title);
        // FM-051: a revision written before that fix can carry a title and a
        // body that disagree — title already renamed, body still linking the
        // old one. Restoring it verbatim resurrects the same dangling self-link
        // the PUT path now prevents, so correct it here too.
        const body =
          title !== head.title ? renameLinkTargets(raw.body, head.title, title) : raw.body;
        if (title !== head.title) {
          // legacy revisions may carry titles that predate validation
          const titleError = validateNoteTitle(title);
          if (titleError) throw new ApiError(`restored revision: ${titleError}`, 400);
        }
        const updated = await client.query(
          `update public.notes set title = $1, body = $2, revised = now()
            where id = $3 returning *`,
          [title, body, noteId],
        );
        // restore never rewrites history — it appends a new attributed revision
        const newRev = await appendRevision(
          client,
          archiveId,
          noteId,
          userId,
          title,
          body,
          'restore',
          changeId,
        );
        await reindexLinks(client, archiveId, noteId, body);
        await reindexChunks(client, archiveId, noteId, newRev, body);
        if (title !== head.title) {
          // a restore that changes the head title IS a rename — same cascade
          await rewriteReferrers(client, archiveId, noteId, head.title, title, userId, changeId);
          await demoteStale(client, archiveId, noteId, title);
          await promoteUnresolved(client, archiveId, noteId, title);
        }
        return updated.rows[0] as NoteRow;
      });
      return c.json(noteShape(row));
    } catch (e) {
      return respondError(c, e);
    }
  });

  app.get('/v1/archives/:archiveId/notes/:noteId/backlinks', async (c) => {
    if (!(await gate(c, deps, true))) return c.json(NOT_FOUND, 404);
    // FM-052: the existence check selected a literal 1; selecting the body
    // instead gives the target's anchors and headings for free. Exactly one
    // extra column, no extra round trip — every occurrence below resolves to
    // THIS note, so one body answers all of them.
    const note = await deps.pool.query<{ body: string }>(
      `select n.body from public.notes n where ${visibleNoteSql('n', '$1', '$2', '$3')}`,
      [c.req.param('noteId'), c.req.param('archiveId'), c.get('userId')],
    );
    if (note.rowCount === 0) return c.json(NOT_FOUND, 404);
    const targetBody = note.rows[0]!.body;
    // FM-020 (§17): a backlink from a private-to-author source must not leak its
    // snippet to non-authors — join the source note through the visibility test
    // FM-044: src.title/src.occurred are projected so a backlink renders as
    // evidence (who said it, when) rather than a bare 200-char fragment — the
    // join to `src` was already here for the ACL test and selected nothing.
    //
    // And the list is BOUNDED. This query had no LIMIT and the sidebar maps
    // every row, so fan-in was the only thing keeping the page renderable.
    // `count(*) over ()` still visits the filtered set, so the guarantee is on
    // what is transferred and rendered, not on the scan — that is the half
    // that grows without bound in the browser.
    const occ = await deps.pool.query(
      `select l.source_id, l.target, l.resolved_id, l.heading, l.block_id,
              l.embed, l.start_pos, l.end_pos, l.snippet,
              src.title as source_title, src.occurred as source_occurred,
              count(*) over () as total
         from public.links l
         join public.notes src on src.id = l.source_id and ${visibleSql('src', '$3')}
        where l.resolved_id = $1 and l.archive_id = $2
        order by l.source_id, l.start_pos
        limit ${BACKLINK_LIMIT}`,
      [c.req.param('noteId'), c.req.param('archiveId'), c.get('userId')],
    );
    const total = occ.rows.length > 0 ? Number(occ.rows[0].total) : 0;
    return c.json({
      occurrences: occ.rows.map((r) => ({
        sourceId: r.source_id,
        target: r.target,
        resolvedId: r.resolved_id,
        heading: r.heading ?? undefined,
        blockId: r.block_id ?? undefined,
        embed: r.embed,
        start: r.start_pos,
        end: r.end_pos,
        snippet: r.snippet,
        sourceTitle: r.source_title,
        sourceOccurred: r.source_occurred ?? null,
        // FM-052: purely ADDITIVE. `resolvedId` above still holds the note id
        // for a fragment-broken occurrence — marking brokenness by nulling it
        // would drop this referrer from the rename cascade, which selects
        // strictly on `where resolved_id = $2`. Absent when there is no
        // fragment: "no fragment" and "fine" are different answers.
        ...fragmentField(targetBody, r.heading, r.block_id),
      })),
      total,
      truncated: total > occ.rows.length,
    });
  });
}
