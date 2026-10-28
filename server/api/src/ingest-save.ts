import { saveGraph, undoGraph } from './graph/save';
import type { GraphProposal } from './graph/types';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { canonicalTitle, extractWikilinks, normalizeTitle } from '@funmem/core';
import type { AppDeps } from './app';
import { contentWords, unitsOf, withLines } from './claims';
import { formatClock } from './clock';
import {
  findConflictsInGroups,
  makeRetriever,
  markersFor,
  today,
  type Attribution,
  type CheckShortfall,
  type Conflict,
  type ConflictReport,
  type Passage,
  type Retrieve,
} from './conflicts';
import { STRINGS } from './ingest-lang';
import { IngestCancelled, type IngestResult, type ProposedMemory } from './ingest-pipeline';
import { UUID_RE } from './membership';
import { visibleSql } from './views';
import {
  ApiError,
  WRITE_ROLES,
  createNotesBatch,
  eraseNotes,
  inTransaction,
  withoutMarkersNaming,
} from './notes';
import { forgetInterviewOf, markWritten, recordedAt } from './stories/interviews';

/**
 * Taking an interview into the archive: who may, titles, disagreements, one atomic write,
 * duplicates, and undo.
 *
 * Every rule here exists because an earlier version broke it in a way a person would
 * feel:
 *
 *   - It could LOSE memories: a title that already existed got "(2)".."(8)", and the
 *     ninth identical title was dropped, silently. Titles are now resolved against the
 *     whole archive until they are unique, and a memory is never dropped.
 *   - It could HALF-SAVE: a failure at memory 30 of 45 left 29 notes. The write is ONE
 *     transaction: all of it, or none of it.
 *   - It could DUPLICATE: the same interview uploaded twice filed every memory twice. An
 *     import record (a hash of the words, a count, a change id) makes the second attempt
 *     fail cleanly, and the check runs under the archive's write lock.
 *   - It could not be TAKEN BACK. An import shares one change id across its notes, so
 *     undo erases exactly the notes it made, and never one somebody has since worked on.
 *   - It wrote for people who were no longer allowed to: membership and role are checked
 *     again INSIDE the write, not only when the import started.
 */

type Db = Pool | PoolClient;

/* ── who may ─────────────────────────────────────────────────────────── */

/** FR-100: the roles that add memories (the same as for writing a note by hand). */
export const IMPORT_ROLES: readonly string[] = WRITE_ROLES;
/** Undoing SOMEONE ELSE's import erases their notes: the archive's keepers only. */
const UNDO_ANY_ROLES: readonly string[] = ['owner', 'steward'];

export class ImportNotAllowed extends Error {
  constructor(
    /** `membership`: not (or no longer) a member, which a route answers as a plain 404 */
    readonly reason: 'membership' | 'role',
    message = reason === 'role'
      ? 'only an owner, steward or contributor can import interviews'
      : 'not a member of this archive',
  ) {
    super(message);
  }
}

/** The caller's role in the archive, or null. `lock` holds the membership until the transaction ends. */
export async function roleOf(
  db: Db,
  archiveId: string,
  userId: string,
  lock = false,
): Promise<string | null> {
  const r = await db.query(
    `select role::text as role from public.memberships
      where archive_id = $1 and user_id = $2${lock ? ' for share' : ''}`,
    [archiveId, userId],
  );
  return (r.rows[0] as { role: string } | undefined)?.role ?? null;
}

/** Throws `ImportNotAllowed` unless the caller may add memories to the archive right now. */
export async function requireImporter(
  db: Db,
  archiveId: string,
  userId: string,
  lock = false,
): Promise<string> {
  const role = await roleOf(db, archiveId, userId, lock);
  if (role === null) throw new ImportNotAllowed('membership');
  if (!IMPORT_ROLES.includes(role)) throw new ImportNotAllowed('role');
  return role;
}

/* ── what an import may link to ──────────────────────────────────────── */

/** How many titles the pipeline is offered to link to. */
const TITLES_OFFERED = 500;
/** a rarest title word seen more often than this counts as present without walking every place */
const ANCHOR_SCAN = 500;

/**
 * A text's words (NFC, lower case, letters and digits), and where each one is. A title is in
 * the text when its words are, whole and in order: compared exactly, in any script.
 */
function wordIndex(text: string): { words: string[]; at: Map<string, number[]> } {
  const words =
    text
      .normalize('NFC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const at = new Map<string, number[]>();
  words.forEach((w, i) => {
    const list = at.get(w);
    if (list) list.push(i);
    else at.set(w, [i]);
  });
  return { words, at };
}

/** Does the title occur in the indexed text, as whole words in order? */
function occursIn(index: ReturnType<typeof wordIndex>, title: string): boolean {
  const parts = title
    .normalize('NFC')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  if (!parts) return false;
  const lists = parts.map((p) => index.at.get(p));
  if (lists.some((l) => l === undefined)) return false;
  if (parts.length === 1) return true;
  // walk the places of the rarest word; the others must stand next to it, in order
  let k = 0;
  lists.forEach((l, j) => {
    if (l!.length < lists[k]!.length) k = j;
  });
  const places = lists[k]!;
  if (places.length > ANCHOR_SCAN) return true;
  return places.some((pk) => parts.every((p, j) => index.words[pk - k + j] === p));
}

/**
 * Titles an imported memory may link to: notes EVERY member can read. An import is shared
 * with the whole family, so a link to a note marked private-to-author (even the importer's
 * own) would show its title to people who may not read it.
 *
 * At most 500, and the ones the interview MENTIONS first: the list used to be the 500
 * longest, so in a large archive the shortest titles, the family's most common subjects
 * ("Mom", "Busan"), were never linked at all (round-2 review #10).
 */
export async function sharedTitles(db: Db, archiveId: string, text = ''): Promise<string[]> {
  const rows = await db.query(
    `select n.title from public.notes n
      where n.archive_id = $1
        and not exists (select 1 from public.audiences a
                         where a.note_id = n.id and a.kind <> 'archive-members')
      order by char_length(n.title) desc, n.title`,
    [archiveId],
  );
  const titles = rows.rows.map((r) => (r as { title: string }).title);
  if (titles.length <= TITLES_OFFERED || text === '') return titles.slice(0, TITLES_OFFERED);
  const index = wordIndex(text);
  const mentioned: string[] = [];
  const rest: string[] = [];
  for (const t of titles) (occursIn(index, t) ? mentioned : rest).push(t);
  return [...mentioned, ...rest].slice(0, TITLES_OFFERED);
}

/* ── memories with a stable id ───────────────────────────────────────── */

/**
 * A memory of an import, with an id that stays the same from preview to save. Positions do
 * not: leaving one memory out shifts every one after it, and a disagreement that named
 * "the memory at position 3" then named the wrong one.
 */
export interface ImportMemory extends ProposedMemory {
  id: string;
}

/** Give every memory an id ("m1", "m2", ...), keeping any it already has. */
export function withIds<T extends ProposedMemory>(memories: T[]): Array<T & { id: string }> {
  const used = new Set(
    memories
      .map((m) => (m as { id?: unknown }).id)
      .filter((x): x is string => typeof x === 'string' && x !== ''),
  );
  let n = 0;
  for (const m of memories) {
    const x = m as T & { id?: string };
    if (typeof x.id === 'string' && x.id !== '') continue;
    do n++;
    while (used.has(`m${n}`));
    x.id = `m${n}`;
    used.add(x.id);
  }
  return memories as Array<T & { id: string }>;
}

/** The memory id a conflict names, when it names another memory of this same interview. */
export const memoryRef = (source: { id: string } | null | undefined): string | null =>
  source && source.id.startsWith('run:') ? source.id.slice(4) : null;

/* ── unique titles ───────────────────────────────────────────────────── */

const TITLE_LIMIT = 100;

/**
 * A title for every memory that is unique in the archive AND within this import,
 * without ever dropping one. First collision: "Title (7:53)" (the time in the
 * interview, which tells two "The wedding"s apart); after that "Title (2)", "(3)", ...
 */
export async function resolveTitles(
  pool: Db,
  archiveId: string,
  wanted: Array<{ title: string; hint?: string | null }>,
): Promise<string[]> {
  const bases = wanted.map(
    (w) => canonicalTitle(w.title).slice(0, TITLE_LIMIT).trim() || 'Untitled',
  );
  const final: string[] = new Array(wanted.length);
  const taken = new Set<string>();
  const attempt: number[] = new Array(wanted.length).fill(0);
  const candidate = (i: number): string => {
    const n = attempt[i]!;
    if (n === 0) return bases[i]!;
    const hint = wanted[i]!.hint;
    if (n === 1 && hint) return `${bases[i]} (${hint})`;
    return `${bases[i]} (${hint ? n : n + 1})`;
  };

  let pending = bases.map((_, i) => i);
  for (let round = 0; round < 300 && pending.length > 0; round++) {
    const candidates = new Map(pending.map((i) => [i, candidate(i)]));
    const keys = [...new Set([...candidates.values()].map(normalizeTitle))];
    const existing = await pool.query(
      `select normalize(lower(btrim(title)), NFC) as k from public.notes
        where archive_id = $1 and normalize(lower(btrim(title)), NFC) = any($2::text[])`,
      [archiveId, keys],
    );
    const used = new Set(existing.rows.map((r) => (r as { k: string }).k));
    const next: number[] = [];
    for (const i of pending) {
      const c = candidates.get(i)!;
      const k = normalizeTitle(c);
      if (used.has(k) || taken.has(k)) {
        attempt[i]!++;
        next.push(i);
      } else {
        final[i] = c;
        taken.add(k);
      }
    }
    pending = next;
  }
  // absurdly many collisions: a short id guarantees uniqueness rather than looping forever
  for (const i of pending) final[i] = `${bases[i]} (${randomUUID().slice(0, 8)})`;
  return final;
}

const hintOf = (m: ProposedMemory): string | null =>
  m.startSec !== null ? formatClock(m.startSec) : null;

/**
 * Every link in `body` whose target is a key of `to` (a normalized title) now names the
 * new title, in ONE pass over the body. All renames happen at once, so "A becomes B, B
 * becomes A" swaps cleanly. Only the target is replaced: an embed's `!`, the spacing, a
 * `#heading` or `#^block`, and a `|shown text` are kept byte for byte (as core's
 * `renameLinkTargets` does for one title).
 */
function renameTargets(body: string, to: Map<string, string>): string {
  if (to.size === 0 || !body.includes('[[')) return body;
  const parts: string[] = [];
  let cursor = 0;
  for (const link of extractWikilinks(body)) {
    const next = to.get(normalizeTitle(link.target));
    if (next === undefined) continue;
    const innerStart = link.start + (link.embed ? 3 : 2); // after "![[" or "[["
    const innerEnd = link.end - 2; // before "]]"
    // the target ends at the first "#" (a fragment) or unescaped "|" (shown text)
    let segEnd = innerEnd;
    for (let i = innerStart; i < innerEnd; i++) {
      const ch = body[i];
      if (ch === '#' || (ch === '|' && body[i - 1] !== '\\')) {
        segEnd = i;
        break;
      }
    }
    let from = innerStart;
    while (from < segEnd && /\s/.test(body[from]!)) from++;
    let end = segEnd;
    while (end > from && /\s/.test(body[end - 1]!)) end--;
    if (from === end) continue; // [[#Heading]]: a link to this note itself
    parts.push(body.slice(cursor, from), next);
    cursor = end;
  }
  if (parts.length === 0) return body;
  parts.push(body.slice(cursor));
  return parts.join('');
}

/**
 * Give the memories new titles, and make every link to an old title follow it: the
 * disagreement markers that name another memory of this interview, and any link the person
 * typed while reviewing. All renames happen at once, so "A becomes B, B becomes C" cannot
 * chain into links to the wrong memory.
 *
 * Linear in the size of the import: one map, one pass per body. It used to rewrite every
 * body once per changed title, so a save that retitled 2,300 memories held the whole server
 * for half a minute (round-2 review #2).
 */
export function retitle(memories: ImportMemory[], to: string[]): void {
  const renames = new Map<string, string>();
  memories.forEach((m, i) => {
    if (m.title !== to[i]) renames.set(normalizeTitle(m.title), to[i]!);
  });
  if (renames.size > 0) for (const m of memories) m.body = renameTargets(m.body, renames);
  memories.forEach((m, i) => (m.title = to[i]!));
  const byId = new Map(memories.map((m) => [m.id, m]));
  for (const m of memories) {
    for (const c of m.conflicts ?? []) {
      const target = byId.get(memoryRef(c.source) ?? '');
      if (target && c.source) c.source = { id: c.source.id, title: target.title };
    }
  }
}

/* ── disagreements, across the archive and within this interview ─────── */

/** One marker line `annotateImport` wrote, so a save can take it out again. */
export interface MarkerLine {
  /** the memory whose body holds the line */
  memory: string;
  /** what the line names: another memory's id, or an archive note's id */
  source: string;
  line: string;
}

/** How far the check against the archive got. */
export interface CheckReport {
  /**
   * every sentence of every memory was compared with what the archive already says: no time
   * limit, call budget or failure of the AI judge cut anything short
   */
  complete: boolean;
  /** memories the 60-second limit kept the check from reaching: their words are untouched */
  skipped: number;
  /**
   * Only when `complete` is false: why, so the page can say it plainly. 'time' the time limit
   * ran out (or the check could not finish) before everything was compared; else 'ai' a call
   * to the AI judge failed, timed out or answered nothing usable; else 'budget' the judge's
   * calls were used up before every sentence it should have read.
   */
  reason?: CheckShortfall;
}

/**
 * The whole check is bounded: an import must not wait minutes on it. 25 s is the longest
 * a single judge call may take, so no call starts after `CHECK_MS - JUDGE_CALL_MS`.
 */
const CHECK_MS = 60_000;
const JUDGE_CALL_MS = 25_000;
const JUDGE_START_MS = 35_000;
/** how long a finished-on-time check may still take to hand back what it has */
const GRACE_MS = 2_000;

/**
 * A "Short answers" note: every line (footer aside) is `- {question} — {answer}`. The question
 * is the interviewer's, quoted for context: only the answer is the relative's testimony, so
 * only the answer is compared with the archive.
 */
const isShortAnswers = (body: string): boolean => {
  const lines = body.split('\n').filter((l) => l.trim() !== '' && !l.trimStart().startsWith('>'));
  return lines.length > 0 && lines.every((l) => /^\s*-\s+/.test(l));
};
const testimonyBody = (body: string): string =>
  isShortAnswers(body)
    ? body
        .split('\n')
        .map((l) => (l.trimStart().startsWith('>') ? l : l.replace(/^\s*-\s+(?:.+? — )?/, '')))
        .join('\n')
    : body;

/** the sentences of a memory that are the relative's own words (not the footer's quotes) */
export const claimsOf = (body: string): string[] =>
  unitsOf(testimonyBody(body))
    .filter((u) => !u.quote)
    .map((u) => u.text);

const prose = (body: string): string => claimsOf(body).join(' ');

/** a transcription tool's own numbering ("SPEAKER_00", "Speaker 2") or a role: not a name */
const NOT_A_NAME =
  /^(?:speaker[ _-]?\d+|spk[ _-]?\d+|unknown|interviewee|respondent|subject|narrator|guest|host|[a-z])$/i;

/** Who is telling a memory, as a name the archive might use; nothing when only a number is known. */
function subjectOf(m: { speaker: string; speakerName?: unknown }): string | undefined {
  const raw =
    typeof m.speakerName === 'string' ? m.speakerName : NOT_A_NAME.test(m.speaker) ? '' : m.speaker;
  const name = raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, 60);
  return name === '' ? undefined : name;
}

/**
 * The words a lookup asks for, whichever way the check joins them ("a or b", "a OR b"). A
 * memory mentions a term when one of its words is the term or starts with it ("boat" is in
 * "boats"), as the archive's own search finds a word inside a longer one.
 */
const termsOf = (q: string): string[] =>
  q
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '' && t !== 'or');
const mentions = (words: Set<string>, term: string): boolean => {
  if (words.has(term)) return true;
  for (const w of words) if (w.startsWith(term)) return true;
  return false;
};

const stopped = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new IngestCancelled();
};

/** `p`, or null if `signal` fires first. */
function untilStopped<T>(p: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onStop = () => resolve(null);
    signal.addEventListener('abort', onStop, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onStop);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onStop);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Settle each memory's final title, then check each one against what the archive
 * already says AND against the memories before it in this interview (a speaker
 * contradicting herself is a disagreement too). A memory that disagrees keeps its
 * words, gains a marked link to what it disagrees with, and carries `conflicts` so
 * the person can see it. Nothing is merged, dropped or overwritten.
 *
 * Bounded: after `deadlineMs` (60 s) the memories not yet checked are left as they are
 * and counted in `check.skipped`. A stopped import (cancel, the hard time limit) throws
 * `IngestCancelled` at once.
 */
export async function annotateImport(
  deps: AppDeps,
  archiveId: string,
  userId: string,
  result: IngestResult,
  who: string | null,
  opts: { signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<{ check: CheckReport; markers: MarkerLine[] }> {
  const started = Date.now();
  const deadlineAt = started + (opts.deadlineMs ?? CHECK_MS);
  const memories = withIds(result.memories);
  stopped(opts.signal);
  // a plain assignment, NOT `retitle`: the links in these bodies so far are the ones the
  // pipeline made, to ARCHIVE notes; a memory titled like one of them ("Busan", renamed
  // "Busan (0:10)") must not pull those links over to itself
  const settled = await resolveTitles(
    deps.pool,
    archiveId,
    memories.map((m) => ({ title: m.title, hint: hintOf(m) })),
  );
  memories.forEach((m, i) => (m.title = settled[i]!));
  stopped(opts.signal);
  if (memories.length === 0) return { check: { complete: true, skipped: 0 }, markers: [] };

  // one stop for the check: the person (or the time limit) stopping the import, or the deadline
  const stop = new AbortController();
  const onStop = () => stop.abort();
  opts.signal?.addEventListener('abort', onStop, { once: true });
  const timer = setTimeout(onStop, Math.max(0, deadlineAt - Date.now()));
  timer.unref?.();

  const fromArchive = makeRetriever(deps, archiveId, userId);
  const wordsOf = memories.map((m) => new Set(contentWords(prose(m.body))));
  /** memories whose sentences were looked up before the check was stopped */
  const reached = new Set<number>();

  // one group per new memory: its own sentences, looked up against the archive AND the
  // memories of this same interview that came before it (cheapest first, by shared words)
  const groups = memories.map((m, i) => {
    const retrieve: Retrieve = async (q) => {
      if (stop.signal.aborted) return [];
      const archive = await fromArchive(q);
      if (!stop.signal.aborted) reached.add(i);
      const asked = termsOf(q);
      const earlier: Passage[] = memories
        .slice(0, i)
        .map((e, j) => ({ j, hits: asked.filter((t) => mentions(wordsOf[j]!, t)).length }))
        .filter((x) => x.hits >= 2)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, 3)
        .map((x) => {
          const e = memories[x.j]!;
          // who tells it: "I was born in 1950" is only weighed against "I was born in 1946"
          // when both are the same person (an unnamed one is known by the transcript's label)
          const teller = subjectOf(e);
          return {
            id: `run:${e.id}`,
            title: e.title,
            text: prose(e.body),
            teller: teller ?? null,
            ...(teller === undefined ? { voice: `speaker:${e.speaker}` } : {}),
          };
        });
      return [...earlier, ...archive];
    };
    const subject = subjectOf(m);
    return {
      retrieve,
      claims: claimsOf(m.body),
      subject,
      ...(subject === undefined ? { voice: `speaker:${m.speaker}` } : {}),
    };
  });

  // Numbers settle most of it with no model. The judge is for what numbers cannot see ("born in
  // Daegu" against "born in Busan"), so it is asked about what the ARCHIVE already holds, not
  // about the interview's own earlier memories; at most 12 calls, four at a time, none started
  // after 35 s and none longer than 25 s: checking must not hold up the import.
  const report: ConflictReport = { incomplete: false };
  const ctx = {
    judge: deps.chat ?? null,
    budget: {
      left: 12,
      until: Math.min(started + JUDGE_START_MS, deadlineAt - JUDGE_CALL_MS),
      timeoutMs: JUDGE_CALL_MS,
    },
    judgeable: (source: Conflict['source']) => source !== null && !source.id.startsWith('run:'),
    // the check stops when this fires; the race below bounds it even if it did not
    signal: stop.signal,
    report,
  };
  const checking = findConflictsInGroups(ctx, groups);
  checking.catch(() => undefined); // a check abandoned at the deadline must not crash the process later
  let found: Conflict[][] | null;
  try {
    found = await untilStopped(checking, stop.signal);
    // stopped by the deadline: the check hands back what it found so far
    if (found === null && !opts.signal?.aborted) {
      found = await untilStopped(checking, AbortSignal.timeout(GRACE_MS)).catch(() => null);
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onStop);
  }
  stopped(opts.signal);

  // the deadline stopped it: memories with something to check that it never reached are counted
  const deadlineHit = stop.signal.aborted;
  const skipped =
    found === null
      ? memories.length
      : deadlineHit
        ? groups.filter((g, i) => g.claims.length > 0 && !reached.has(i)).length
        : 0;
  // "complete" means nothing was missed: no time ran out, and no judge call that should have been
  // made failed, timed out or was left unmade. A silent miss is the one thing the page must not hide
  // (a slow minute at the AI service used to leave a real disagreement unmarked with a clean report).
  const complete =
    found !== null &&
    !deadlineHit &&
    !report.incomplete &&
    (report.judgeFailed ?? 0) === 0 &&
    (report.unjudged ?? 0) === 0;
  // ...and when it is not, the page says why
  // (the conflict check names its own shortfall; a deadline this function enforced is 'time',
  // and when several apply the AI's failure is the most useful thing to say, then time, then budget)
  const timedOut = found === null || deadlineHit;
  const reason: CheckShortfall | undefined = complete
    ? undefined
    : report.reason === 'ai'
      ? 'ai'
      : timedOut || report.reason === 'time' || report.incomplete
        ? 'time'
        : (report.reason ?? 'budget');
  const markers: MarkerLine[] = [];
  memories.forEach((m, i) => {
    const conflicts = found?.[i] ?? [];
    if (conflicts.length === 0) return;
    const attribution: Attribution = {
      when: today(),
      who,
      channel: 'interview',
      teller: typeof m.speakerName === 'string' ? m.speakerName : null,
    };
    // one call per conflict, so each line is known by what it names
    const marks = conflicts.map((c) => markersFor(attribution, [], [c]));
    m.body = withLines(
      m.body,
      marks.flatMap((x) => x.lines),
    );
    m.conflicts = marks.flatMap((x) => x.recorded);
    marks.forEach((x, k) => {
      const source = conflicts[k]!.source;
      const ref = memoryRef(source) ?? source?.id ?? '';
      for (const line of x.lines) markers.push({ memory: m.id, source: ref, line });
    });
    for (const r of m.conflicts) {
      if (r.source) m.notes.push(STRINGS.conflict(r.source.title, r.existing.slice(0, 160)));
    }
  });
  return { check: { complete, skipped, ...(reason ? { reason } : {}) }, markers };
}

/**
 * A memory the person left out takes its markers with it: the line in each other memory's
 * body that named it, and the matching entry in `conflicts`. A line the person changed is
 * theirs and stays.
 */
export function dropMarkers(
  memories: ImportMemory[],
  markers: MarkerLine[],
  skipped: Set<string>,
): void {
  if (skipped.size === 0) return;
  const byId = new Map(memories.map((m) => [m.id, m]));
  for (const mk of markers) {
    if (!skipped.has(mk.source)) continue;
    const m = byId.get(mk.memory);
    if (m) m.body = removeLine(m.body, mk.line);
  }
  for (const m of memories) {
    if (!m.conflicts) continue;
    m.conflicts = m.conflicts.filter((c) => !skipped.has(memoryRef(c.source) ?? ''));
    if (m.conflicts.length === 0) delete m.conflicts;
  }
}

function removeLine(body: string, line: string): string {
  const lines = body.split('\n');
  const at = lines.indexOf(line);
  if (at === -1) return body;
  lines.splice(at, 1);
  // a marker that opened its own block leaves no empty line behind it
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.join('\n');
}

/**
 * Take out of an import's memories everything they quote from archive notes in `gone` (ids):
 * the marker line naming one (as it was written, or in the machine's form under the title it
 * was found by), its `conflicts` entry, and the sentence that told the person about it.
 * Returns whether anything changed. Round-3 review D2: a note erased after the check must not
 * be quoted by the memories that were checked against it.
 */
export function dropQuotesOf(
  result: { memories: ImportMemory[] },
  markers: MarkerLine[],
  gone: ReadonlySet<string>,
): boolean {
  if (gone.size === 0) return false;
  let changed = false;
  const byId = new Map(result.memories.map((m) => [m.id, m]));
  for (const mk of markers) {
    if (!gone.has(mk.source)) continue;
    const m = byId.get(mk.memory);
    if (!m) continue;
    const body = removeLine(m.body, mk.line);
    if (body !== m.body) [m.body, changed] = [body, true];
  }
  for (const m of result.memories) {
    const out = (m.conflicts ?? []).filter(
      (c) => c.source !== null && memoryRef(c.source) === null && gone.has(c.source.id),
    );
    if (out.length === 0) continue;
    changed = true;
    const titles = new Set(out.map((c) => normalizeTitle(c.source!.title)));
    m.body = withoutMarkersNaming(m.body, titles);
    const told = new Set(
      out.map((c) => STRINGS.conflict(c.source!.title, c.existing.slice(0, 160))),
    );
    m.notes = m.notes.filter((n) => !told.has(n));
    m.conflicts = m.conflicts!.filter((c) => !out.includes(c));
    if (m.conflicts.length === 0) delete m.conflicts;
  }
  return changed;
}

/**
 * Under the archive's lock, just before the write: the archive notes the memories quote that
 * may no longer be quoted, because they were erased since the check (an undo, a delete) or are
 * no longer shared with every member (the rule the check found them under).
 */
async function unquotable(
  client: PoolClient,
  memories: ImportMemory[],
  markers: MarkerLine[],
  archiveId: string,
): Promise<Set<string>> {
  const named = new Set<string>();
  for (const mk of markers) if (UUID_RE.test(mk.source)) named.add(mk.source.toLowerCase());
  for (const m of memories) {
    for (const c of m.conflicts ?? []) {
      if (c.source && memoryRef(c.source) === null && UUID_RE.test(c.source.id)) {
        named.add(c.source.id.toLowerCase());
      }
    }
  }
  if (named.size === 0) return new Set();
  const still = await client.query(
    `select n.id from public.notes n left join public.audiences a on a.note_id = n.id
      where n.archive_id = $1 and n.id = any($2::uuid[])
        and coalesce(a.kind::text, 'archive-members') = 'archive-members'`,
    [archiveId, [...named]],
  );
  const kept = new Set(still.rows.map((r) => (r as { id: string }).id));
  return new Set([...named].filter((id) => !kept.has(id)));
}

/* ── import records ──────────────────────────────────────────────────── */

export interface ImportRecord {
  runId: string;
  createdAt: string;
  /** notes of that import that still exist */
  noteCount: number;
  source: string | null;
  createdBy: string;
}

export class DuplicateImport extends Error {
  constructor(readonly previous: ImportRecord) {
    super('this interview was already imported');
  }
}

interface RunRow {
  id: string;
  created_at: Date;
  source_label: string | null;
  created_by: string;
  alive: number;
}

const aliveSql = `(select count(distinct v.note_id)::int from public.revisions v
                    where v.change_id = r.change_id and v.archive_id = r.archive_id)`;

const recordOf = (row: RunRow): ImportRecord => ({
  runId: row.id,
  createdAt: row.created_at.toISOString(),
  noteCount: row.alive,
  source: row.source_label,
  createdBy: row.created_by,
});

/** Every not-undone import of this interview, newest first, with how many of its notes still exist. */
async function runsOf(db: Db, archiveId: string, sourceHash: string): Promise<RunRow[]> {
  const r = await db.query(
    `select r.id, r.created_at, r.source_label, r.created_by, ${aliveSql} as alive
       from public.ingest_runs r
      where r.archive_id = $1 and r.source_hash = $2 and r.undone_at is null
      order by r.created_at desc, r.id`,
    [archiveId, sourceHash],
  );
  return r.rows as RunRow[];
}

/**
 * An import whose notes are all gone keeps no trace of what it was (FR-143): no file name,
 * no hash of the words. The update checks again that nothing is left, so it is safe to run
 * without the archive's lock.
 */
async function forgetEmptyRuns(db: Db, archiveId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `update public.ingest_runs r
        set active = false, source_label = null, source_hash = null
      where r.archive_id = $1 and r.id = any($2::uuid[])
        and not exists (select 1 from public.revisions v
                         where v.change_id = r.change_id and v.archive_id = r.archive_id)`,
    [archiveId, ids],
  );
}

/**
 * The import that already took this interview in, if any of its notes are still there:
 * the newest one that is not undone. ANY such import guards, not only the newest: after
 * "import it again anyway" and an undo of the second copy, the first copy is still in the
 * archive and must still be found. Imports whose notes are all gone are retired here.
 */
export async function findActiveImport(
  db: Db,
  archiveId: string,
  sourceHash: string,
): Promise<ImportRecord | null> {
  const runs = await runsOf(db, archiveId, sourceHash);
  await forgetEmptyRuns(
    db,
    archiveId,
    runs.filter((r) => r.alive === 0).map((r) => r.id),
  );
  const live = runs.find((r) => r.alive > 0);
  return live ? recordOf(live) : null;
}

/** Under the archive's lock: the newest live import of this interview guards it again. */
async function reactivate(client: PoolClient, archiveId: string, sourceHash: string) {
  const live = (await runsOf(client, archiveId, sourceHash)).find((r) => r.alive > 0);
  if (!live) return;
  await client.query(
    `update public.ingest_runs set active = true
      where id = $1
        and not exists (select 1 from public.ingest_runs a
                         where a.archive_id = $2 and a.source_hash = $3 and a.active)`,
    [live.id, archiveId, sourceHash],
  );
}

export interface RunSummary {
  id: string;
  createdAt: Date;
  source: string | null;
  createdBy: string;
  notes: number;
  undone: boolean;
}

/** The imports of an archive, newest first. Ones whose notes are all gone are retired as they are seen. */
export async function listRuns(db: Db, archiveId: string, limit = 30): Promise<RunSummary[]> {
  const r = await db.query(
    `select r.id, r.created_at, r.source_label, r.source_hash, r.created_by, r.undone_at, r.active,
            ${aliveSql} as alive
       from public.ingest_runs r where r.archive_id = $1
      order by r.created_at desc, r.id limit $2`,
    [archiveId, limit],
  );
  const rows = r.rows as Array<
    RunRow & { undone_at: Date | null; source_hash: string | null; active: boolean }
  >;
  const empty = rows.filter(
    (x) => x.alive === 0 && (x.source_label !== null || x.source_hash !== null || x.active),
  );
  await forgetEmptyRuns(
    db,
    archiveId,
    empty.map((x) => x.id),
  );
  const gone = new Set(empty.map((x) => x.id));
  return rows.map((x) => ({
    id: x.id,
    createdAt: x.created_at,
    source: gone.has(x.id) ? null : x.source_label,
    createdBy: x.created_by,
    notes: x.alive,
    undone: x.undone_at !== null,
  }));
}

/* ── the atomic write ────────────────────────────────────────────────── */

export interface SavedNote {
  id: string;
  title: string;
  method: string;
  /** position in `result.memories` */
  index: number;
}

const violated = (e: unknown, constraint: string): boolean =>
  (e as { code?: string; constraint?: string }).code === '23505' &&
  (e as { constraint?: string }).constraint === constraint;

/**
 * Write every memory in ONE transaction, with the import record. Inside it, under the
 * archive's write lock and before a single note is written: the caller must still be a
 * member with a role that adds memories (`ImportNotAllowed`), and the interview must not
 * already be in (`DuplicateImport`) unless `force`. Titles are settled against the archive
 * under that same lock, links following, so a note made in the meantime cannot collide; a
 * collision with a writer that skips the lock rolls back and is retried.
 */
export async function persistImport(
  deps: AppDeps,
  archiveId: string,
  userId: string,
  result: IngestResult,
  opts: {
    force?: boolean;
    /** the marker lines the check wrote, so one naming a note erased since can be taken out */
    markers?: MarkerLine[];
  } = {},
): Promise<{ runId: string | null; saved: SavedNote[] }> {
  const memories = withIds(result.memories);
  if (memories.length === 0) return { runId: null, saved: [] };
  // a quick refusal before any work; the transaction checks again, holding the membership
  await requireImporter(deps.pool, archiveId, userId);

  for (let attempt = 0; attempt < 4; attempt++) {
    let runId: string | null = null;
    try {
      const { notes } = await createNotesBatch(
        deps,
        archiveId,
        userId,
        // Titles are settled HERE, under the archive's lock, links following: settled before
        // it, they could be taken by another save while this one waited, and twelve saves at
        // once into one archive failed with "could not save" (round-2 review, measured). The
        // retry around this is left for writers that do not take the lock.
        async (client) => {
          // what the check quoted of a note erased (or made private) since is not written
          // (round-3 review D2: a stale preview put erased words into a new note)
          dropQuotesOf(
            { memories },
            opts.markers ?? [],
            await unquotable(client, memories, opts.markers ?? [], archiveId),
          );
          retitle(
            memories,
            await resolveTitles(
              client,
              archiveId,
              memories.map((m) => ({ title: m.title, hint: hintOf(m) })),
            ),
          );
          // a story carries its metadata (PRD 7.3): when it was told, by whom, from which lines
          const told = result.interviewId ? await recordedAt(client, result.interviewId) : null;
          return memories.map((m) =>
            m.method === 'story'
              ? {
                  title: m.title,
                  type: m.type,
                  body: m.body,
                  occurred: m.occurred,
                  recorded: told ?? new Date().toISOString(),
                  contributors: m.tellers ?? [],
                  extra: {
                    interviewId: result.interviewId ?? null,
                    tellings: [{ interviewId: result.interviewId ?? null, at: told }],
                    ...(m.until ? { until: m.until } : {}),
                    sources: m.sources ?? [],
                    ...(m.flags?.length ? { flags: m.flags } : {}),
                    ...(m.dateBasis ? { dateBasis: m.dateBasis } : {}),
                    ...(m.writtenBy ? { writtenBy: m.writtenBy } : {}),
                  },
                }
              : { title: m.title, type: m.type, body: m.body, occurred: m.occurred },
          );
        },
        memories.some((m) => m.method === 'story') ? 'import' : 'ai-suggestion',
        {
          before: async (client) => {
            // held until commit: a member removed now waits for this write, or this write fails
            await requireImporter(client, archiveId, userId, true);
            const runs = await runsOf(client, archiveId, result.sourceHash);
            await forgetEmptyRuns(
              client,
              archiveId,
              runs.filter((r) => r.alive === 0).map((r) => r.id),
            );
            const live = runs.find((r) => r.alive > 0);
            if (live && !opts.force) throw new DuplicateImport(recordOf(live));
          },
          after: async (client, ctx) => {
            // the newest import of an interview is the one that guards it
            await client.query(
              `update public.ingest_runs set active = false
                where archive_id = $1 and source_hash = $2 and active`,
              [archiveId, result.sourceHash],
            );
            const run = await client.query(
              `insert into public.ingest_runs
                 (archive_id, created_by, source_hash, source_label, change_id, note_count)
               values ($1, $2, $3, $4, $5, $6) returning id`,
              [
                archiveId,
                userId,
                result.sourceHash,
                result.source ? result.source.slice(0, 120) : null,
                ctx.changeId,
                ctx.notes.length,
              ],
            );
            runId = (run.rows[0] as { id: string }).id;
            if (result.interviewId) await markWritten(client, result.interviewId, runId);
            // the people, places and things in these stories (graph design 5.2)
            await saveGraph(client, {
              archiveId,
              userId,
              runId,
              proposal: result.graph,
              storyNote: new Map(memories.map((m, i) => [m.id, ctx.notes[i]!.id])),
              interviewId: result.interviewId ?? null,
            });
          },
        },
      );
      const saved = notes.map((n, index) => ({
        id: n.id,
        title: n.title,
        method: memories[index]!.method,
        index,
      }));
      // a memory that disagrees with an EARLIER memory of this interview named it by its id
      const at = new Map(memories.map((m, i) => [m.id, i]));
      for (const m of memories) {
        for (const c of m.conflicts ?? []) {
          const i = at.get(memoryRef(c.source) ?? '');
          const s = i === undefined ? undefined : saved[i];
          if (s) c.source = { id: s.id, title: s.title };
        }
      }
      return { runId, saved };
    } catch (e) {
      if (e instanceof DuplicateImport || e instanceof ImportNotAllowed) throw e;
      if (violated(e, 'ingest_runs_active_source_idx')) {
        // only possible for a writer that did not take the archive's lock
        const previous = await findActiveImport(deps.pool, archiveId, result.sourceHash);
        if (previous && !opts.force) throw new DuplicateImport(previous);
        continue;
      }
      if (violated(e, 'notes_archive_title_ci')) continue; // a title went stale: re-resolve
      throw e;
    }
  }
  throw new ApiError('could not save the interview; nothing was changed', 409);
}

/**
 * The button's run (graph design 4.4): the graph found in saved stories, written as a run of its
 * own (`kind = 'graph'`, no notes), so it can be undone as one. A story deleted or made private
 * since the preview takes what it said with it.
 */
export async function persistGraphRun(
  deps: AppDeps,
  archiveId: string,
  userId: string,
  proposal: GraphProposal,
): Promise<{ runId: string }> {
  await requireImporter(deps.pool, archiveId, userId);
  return inTransaction(deps, archiveId, async (client, changeId) => {
    await requireImporter(client, archiveId, userId, true);
    const run = await client.query(
      `insert into public.ingest_runs
         (archive_id, created_by, source_hash, source_label, change_id, note_count, active, kind)
       values ($1, $2, null, 'People, places and things', $3, 0, false, 'graph')
       returning id`,
      [archiveId, userId, changeId],
    );
    const runId = (run.rows[0] as { id: string }).id;
    const stories = [
      ...new Set([
        ...proposal.entities.flatMap((e) => e.mentions.map((m) => m.story)),
        ...proposal.relationships.map((r) => r.story),
      ]),
    ].filter((id) => UUID_RE.test(id));
    const live = await client.query(
      `select n.id from public.notes n
        where n.archive_id = $1 and n.id = any($2::uuid[]) and ${visibleSql('n', '$3')}`,
      [archiveId, stories, userId],
    );
    await saveGraph(client, {
      archiveId,
      userId,
      runId,
      proposal,
      storyNote: new Map(live.rows.map((r: { id: string }) => [r.id, r.id])),
      interviewId: null,
    });
    return { runId };
  });
}

/* ── undo ────────────────────────────────────────────────────────────── */

/** Why a note of the import was kept rather than erased. */
export type KeptReason = 'edited' | 'linked';

export interface UndoOutcome {
  /** notes erased */
  erased: number;
  /** notes of the import somebody has worked on since: they are kept */
  kept: Array<{ id: string; title: string; reason: KeptReason }>;
  alreadyUndone: boolean;
}

/**
 * Take an import back as a unit: erase exactly the notes it made, but never one somebody
 * has worked on since, because that would destroy their work. Worked on means:
 *
 *   edited   a revision other than the import's own. A rename cascade does not count:
 *            it is the machine following another note's new title, not a person; nor
 *            does an erasure cascade (a quote of an erased note taken out of it).
 *   linked   another note links to it that a PERSON wrote, edited or restored after the
 *            import, or another memory of this import that a person has edited. A link
 *            another import (or the assistant) made by itself, because the words matched
 *            this title, is not somebody building on the memory; nor is a link between two
 *            memories of this import that nobody has touched.
 *
 * Your own import: any role that adds memories. Someone else's: an owner or a steward.
 * The run row is locked, so two undos at once erase once and the second is told so; the
 * notes are locked before anything is decided about them.
 */
export async function undoImport(
  deps: AppDeps,
  archiveId: string,
  userId: string,
  runId: string,
): Promise<(UndoOutcome & { erasedIds: string[] }) | null> {
  return inTransaction(deps, archiveId, async (client, changeId) => {
    const found = await client.query(
      `select r.change_id, r.created_by, r.created_at, r.undone_at, r.source_hash, r.kind
         from public.ingest_runs r where r.id = $1 and r.archive_id = $2 for update`,
      [runId, archiveId],
    );
    const run = found.rows[0] as
      | {
          change_id: string;
          created_by: string;
          created_at: Date;
          undone_at: Date | null;
          source_hash: string | null;
          kind: string;
        }
      | undefined;
    if (!run) return null;
    const role = await roleOf(client, archiveId, userId, true);
    if (role === null) return null; // not (or no longer) a member: the uniform not-found
    const mine = run.created_by === userId;
    if (!(mine ? IMPORT_ROLES : UNDO_ANY_ROLES).includes(role)) {
      throw new ImportNotAllowed(
        'role',
        mine
          ? 'only an owner, steward or contributor can undo an import'
          : 'only the person who imported it, or an owner or steward, can undo an import',
      );
    }
    if (run.undone_at) return { erased: 0, kept: [], alreadyUndone: true, erasedIds: [] };

    // 1. LOCK the import's notes, in id order (the order every writer here locks notes in).
    // A writer that got to one of them first (an edit) is waited for here.
    const locked = await client.query(
      `select n.id from public.notes n
        where n.archive_id = $1
          and n.id in (select v.note_id from public.revisions v
                        where v.change_id = $2 and v.archive_id = $1)
        order by n.id
        for update of n`,
      [archiveId, run.change_id],
    );
    const ids = locked.rows.map((r) => (r as { id: string }).id);

    // 2. THEN decide, in a new statement. A statement sees what was committed when it began,
    // so deciding in the one that waited for the locks judged a note by how it looked BEFORE
    // the wait: an edit that won the race was not seen, and its note was erased (round-2
    // review #3).
    //   edited  a revision other than the import's own; a rename or erasure cascade is the machine
    //   linked  a note links to it that a person has worked on since: written, edited or
    //           restored after the import, OR another memory of this import that is itself
    //           edited (a person who edits memory A and links it to memory B has built on B;
    //           links among memories nobody touched still do not hold an undo back)
    const flags = await client.query(
      `with imp as (select unnest($4::uuid[]) as id),
            edited as (
              select i.id from imp i
               where exists (select 1 from public.revisions v
                              where v.note_id = i.id and v.change_id is distinct from $2
                                and v.reason::text not in ('rename-cascade', 'erasure-cascade')))
       select n.id, n.title,
              n.id in (select id from edited) as edited,
              exists (select 1 from public.links l
                       where l.resolved_id = n.id and l.archive_id = $1 and l.source_id <> n.id
                         and (l.source_id in (select id from edited)
                              or (l.source_id not in (select id from imp)
                                  and exists (select 1 from public.revisions sv
                                               where sv.note_id = l.source_id
                                                 and sv.created_at > $3
                                                 and sv.reason in ('create', 'edit', 'restore')))))
                as linked
         from public.notes n
        where n.archive_id = $1 and n.id = any($4::uuid[])
        order by n.created_at, n.id`,
      [archiveId, run.change_id, run.created_at, ids],
    );
    const rows = flags.rows as Array<{
      id: string;
      title: string;
      edited: boolean;
      linked: boolean;
    }>;
    const reasonOf = (r: (typeof rows)[number]): KeptReason | null =>
      r.edited ? 'edited' : r.linked ? 'linked' : null;
    // what other notes quote of the ones that go is taken out of them first (D2)
    const erasedIds = new Set(
      await eraseNotes(
        client,
        archiveId,
        rows.filter((r) => reasonOf(r) === null).map((r) => r.id),
        userId,
        { changeId },
      ),
    );
    // every note asked for was locked in step 1, so exactly those were erased: a note that is
    // still here is one with a reason
    const kept = rows
      .filter((r) => !erasedIds.has(r.id))
      .map((r) => ({ id: r.id, title: r.title, reason: reasonOf(r)! }));
    const erase = [...erasedIds];
    // the interview whose stories these were goes too: the import keeps no words after an undo
    await forgetInterviewOf(client, runId);
    // and the people, places and things only it brought (graph design 5.3)
    await undoGraph(client, archiveId, runId, { everything: run.kind === 'graph' });
    // what is left of the record is content-free: no file name, no hash of the words
    await client.query(
      `update public.ingest_runs
          set undone_at = now(), active = false, source_label = null, source_hash = null
        where id = $1`,
      [runId],
    );
    // an earlier import of the same interview whose notes are still there guards it again
    if (run.source_hash) await reactivate(client, archiveId, run.source_hash);
    return { erased: erase.length, kept, alreadyUndone: false, erasedIds: erase };
  });
}
