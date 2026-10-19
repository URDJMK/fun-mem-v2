import { randomUUID } from 'node:crypto';
import { ENTITY_TYPES, canonicalTitle, validateNoteTitle, parseFuzzyDate } from '@funmem/core';
import type { AppDeps } from './app';
import {
  IngestCancelled,
  hashTurns,
  ingestParsed,
  type IngestOptions,
  type IngestResult,
} from './ingest-pipeline';
import {
  DuplicateImport,
  ImportNotAllowed,
  annotateImport,
  dropMarkers,
  dropQuotesOf,
  findActiveImport,
  persistImport,
  resolveTitles,
  retitle,
  sharedTitles,
  withIds,
  type CheckReport,
  type ImportMemory,
  type ImportRecord,
  type MarkerLine,
  type SavedNote,
} from './ingest-save';
import { displayNameOf } from './conflicts';
import { formatClock } from './clock';
import { TranscriptError, parseTranscript, type ParsedTranscript } from './transcript';

/**
 * Interviews are LONG: an hour of speech is tens of model calls, so a request that
 * waits for all of it hits every proxy and browser timeout. An import is therefore a
 * JOB: it starts, reports progress, can be cancelled until it starts writing, and its
 * outcome is fetched when it is ready. The synchronous form of the route simply waits on
 * the same job, so there is one code path.
 *
 * WHAT A JOB HOLDS, AND FOR HOW LONG. Never the raw transcript after it has been read.
 * The outcome (the memories, which are the family's words) is held in memory only, so a
 * person can read, edit and save it, for as long as somebody is looking at it: a job's
 * life is its IDLE time, refreshed whenever its owner reads, saves or cancels it. An
 * unsaved preview lives 60 idle minutes (it is somebody's unfinished work), and never
 * more than 3 hours; every other finished job 15 idle minutes. What jobs hold is capped
 * in bytes per person and for the whole server (see `evict`). Undoing an import drops the
 * words its job was holding at once (`forgetRun`), and an erased note (undone, or deleted by
 * hand) is no longer quoted by any job of its archive (`forgetNotes`). A note deleted by hand
 * is otherwise not tracked here: its own words can stay in the outcome of the job that made
 * it until that job expires.
 * A server restart loses every job; the atomic save and the duplicate guard make simply
 * trying again safe.
 */

export type JobStage = 'reading' | 'organizing' | 'checking' | 'saving' | 'done';
export type JobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface IngestRequest extends IngestOptions {
  transcript: unknown;
  /** write the notes now (otherwise: a preview to read, edit and save) */
  save?: boolean;
  /** go ahead although the interviewee was only a low-confidence guess */
  confirm?: boolean;
  /** import it again even though this interview was already imported */
  force?: boolean;
}

export type OutcomeStatus = 'previewed' | 'saved' | 'needs_confirmation' | 'duplicate';

export interface IngestOutcome extends IngestResult {
  status: OutcomeStatus;
  /** every memory carries an `id` that stays the same from preview to save */
  memories: ImportMemory[];
  /** the earlier import of this same interview, if there is one */
  duplicateOf?: ImportRecord;
  runId?: string | null;
  saved?: SavedNote[];
  /** how far the check against the archive got (absent when nothing was checked) */
  check?: CheckReport;
  /** the import was undone: the words this job held are gone */
  undone?: boolean;
}

export interface JobFailure {
  code: string;
  message: string;
  /** with code `forbidden`: `role` (this role cannot import) or `membership` (no longer a member) */
  reason?: string;
}

export interface JobView {
  id: string;
  status: JobStatus;
  stage: JobStage;
  progress: { done: number; total: number };
  startedAt: string;
  finishedAt?: string;
  /** how long it has run (or ran), by the server's clock: a page that reloads mid-import cannot work this out */
  elapsedMs: number;
  /** a cancel can still stop it: running, and not yet writing */
  canCancel: boolean;
  outcome?: IngestOutcome;
  error?: JobFailure;
}

interface Job {
  id: string;
  archiveId: string;
  userId: string;
  status: JobStatus;
  stage: JobStage;
  progress: { done: number; total: number };
  startedAt: number;
  finishedAt?: number;
  /** the last time its owner looked at it: a finished job lives on IDLE time */
  touchedAt: number;
  outcome?: IngestOutcome;
  error?: JobFailure;
  /** the disagreement lines written into the preview, so a save can take one back out */
  markers: MarkerLine[];
  ac: AbortController;
  done: Promise<void>;
  /** a save is in flight: refuse a second one, never evict, never cancel */
  saving: boolean;
  /** the hard time limit, not the person, stopped it */
  timedOut: boolean;
  /** what its outcome holds in memory, roughly (its JSON length) */
  bytes: number;
}

/** Why an import cannot start right now. `previews`: the archive holds too many unsaved previews. */
export type BusyReason = 'archive' | 'user' | 'server' | 'previews';

export class BusyError extends Error {
  constructor(
    readonly jobId: string | null,
    readonly why: BusyReason,
  ) {
    super(
      why === 'previews'
        ? 'this archive is holding too many imports that are waiting to be saved'
        : 'another import is already running',
    );
  }
}

/** An unsaved preview is somebody's unfinished work. */
const PREVIEW_IDLE_MS = 60 * 60_000;
/**
 * ...but not forever: a preview goes 3 hours after it was made, however often it is looked
 * at. A page that polls refreshes the idle time, so without this a few accounts could hold
 * the server's memory full for as long as they kept polling (round-2 review #7).
 */
const PREVIEW_MAX_MS = 3 * 60 * 60_000;
/** Any other finished job: saved, failed, cancelled, a duplicate. */
const DONE_IDLE_MS = 15 * 60_000;
/** The newest finished jobs one person keeps when they start another... */
const KEEP_PER_USER = 10;
/** ...and what they may hold, counted in bytes: about six of the longest interviews */
const USER_BYTES = 8 * 1024 * 1024;
/** Unsaved previews one archive may hold at once. */
const ARCHIVE_PREVIEWS = 20;
/** Finished jobs the whole server holds, and their bytes; past either, new imports wait. */
const KEEP_TOTAL = 500;
const TOTAL_BYTES = 256 * 1024 * 1024;
const HARD_LIMIT_MS = 15 * 60_000;

/** How long one import may run before it is stopped. `INGEST_HARD_LIMIT_MS` overrides it (tests, small hosts). */
const hardLimitMs = (): number => {
  const n = Number(process.env.INGEST_HARD_LIMIT_MS);
  return Number.isFinite(n) && n >= 50 ? n : HARD_LIMIT_MS;
};
/** A byte cap; `INGEST_USER_BYTES` and `INGEST_TOTAL_BYTES` override them (tests, small hosts). */
const bytesCap = (name: 'INGEST_USER_BYTES' | 'INGEST_TOTAL_BYTES', fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
};
const MAX_PER_USER = 2;
const MAX_TOTAL = 6;

const CANCELLABLE: readonly JobStage[] = ['reading', 'organizing', 'checking'];

const isPreview = (j: Job): boolean =>
  j.status === 'succeeded' &&
  (j.outcome?.status === 'previewed' || j.outcome?.status === 'needs_confirmation');

/** Finished, and not being saved: the only jobs that may ever be let go. */
const evictable = (j: Job): boolean =>
  j.status !== 'running' && j.finishedAt !== undefined && !j.saving && j.stage !== 'saving';

const view = (j: Job): JobView => ({
  id: j.id,
  status: j.status,
  stage: j.stage,
  progress: j.progress,
  startedAt: new Date(j.startedAt).toISOString(),
  ...(j.finishedAt ? { finishedAt: new Date(j.finishedAt).toISOString() } : {}),
  elapsedMs: (j.finishedAt ?? Date.now()) - j.startedAt,
  canCancel: j.status === 'running' && !j.saving && CANCELLABLE.includes(j.stage),
  ...(j.outcome ? { outcome: j.outcome } : {}),
  ...(j.error ? { error: j.error } : {}),
});

/** A failure as the person should hear it: a stable code, and plain words. */
export function failureOf(e: unknown): JobFailure {
  if (e instanceof TranscriptError) return { code: e.code, message: e.message };
  if (e instanceof IngestCancelled)
    return { code: 'cancelled', message: 'the import was cancelled; nothing was saved' };
  if (e instanceof ImportNotAllowed) {
    return {
      code: 'forbidden',
      reason: e.reason,
      message:
        e.reason === 'role'
          ? `${e.message}; nothing was saved`
          : 'you are no longer a member of this archive; nothing was saved',
    };
  }
  return { code: 'internal', message: 'something went wrong; nothing was saved' };
}

/**
 * An error, described for a log line WITHOUT the words it may carry: a parser's message
 * can quote the transcript, a database error can quote a value. The kind, a database
 * code, and where in our code it happened.
 */
export function describeError(e: unknown): string {
  if (e instanceof TranscriptError) return `transcript ${e.code}`;
  const pg = e as { code?: unknown; constraint?: unknown };
  if (typeof pg.code === 'string' && /^[0-9A-Z]{5}$/.test(pg.code)) {
    return `pg ${pg.code}${typeof pg.constraint === 'string' ? ` ${pg.constraint}` : ''}`;
  }
  if (e instanceof Error) {
    const frame = /at (?:([\w.$<>]+) )?\(?(?:.*[/\\])?([\w.-]+\.[cm]?[jt]s):(\d+)/.exec(
      e.stack?.split('\n')[1] ?? '',
    );
    return `${e.name || 'Error'}${frame ? ` at ${frame[1] ? `${frame[1]} ` : ''}${frame[2]}:${frame[3]}` : ''}`;
  }
  return typeof e;
}

/** The outcome of an undone import: what it was, without a word of what it said. */
const forgotten = (o: IngestOutcome): IngestOutcome => ({
  status: o.status,
  undone: true,
  ...(o.runId !== undefined ? { runId: o.runId } : {}),
  format: o.format,
  language: o.language,
  providerVersion: o.providerVersion,
  roles: o.roles,
  warnings: o.warnings,
  degraded: o.degraded,
  stats: o.stats,
  ...(o.check ? { check: o.check } : {}),
  sourceHash: '',
  interviewee: '',
  interviewees: [],
  speakers: [],
  memories: [],
  saved: [],
});

/** What an outcome holds in memory, roughly: the length of its JSON (once per job, not per look). */
const sizeOf = (o: IngestOutcome | undefined): number => (o ? JSON.stringify(o).length : 0);

const hintOf = (m: { startSec: number | null }): string | null =>
  m.startSec !== null ? formatClock(m.startSec) : null;

export class IngestJobs {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly deps: AppDeps) {
    const t = setInterval(() => this.sweep(), 60_000);
    t.unref?.();
  }

  /**
   * Let go of finished jobs nobody has looked at for their idle time, and of previews older
   * than their absolute lifetime whoever is looking.
   */
  private sweep(now = Date.now()): void {
    for (const [id, j] of this.jobs) {
      if (!evictable(j)) continue;
      const preview = isPreview(j);
      if (
        now - j.touchedAt > (preview ? PREVIEW_IDLE_MS : DONE_IDLE_MS) ||
        (preview && now - j.finishedAt! > PREVIEW_MAX_MS)
      ) {
        this.jobs.delete(id);
      }
    }
  }

  private finished(): Job[] {
    return [...this.jobs.values()].filter(evictable);
  }

  /**
   * Make room when someone starts an import. Never a running job, never one being saved.
   *
   *   - The person's OWN finished jobs beyond their share (10 jobs, 8 MB) go first: done
   *     jobs before previews, oldest first.
   *   - An archive holds at most 20 unsaved previews: ones nobody has looked at for 15
   *     minutes go, then the person's own oldest there.
   *   - The server holds at most 500 finished jobs and 256 MB: done jobs go, then previews
   *     nobody has looked at for 15 minutes.
   *
   * Nobody else's activity takes a preview from under a person who is reviewing it; when
   * only such previews are left, the new import waits instead (see `start`).
   */
  private evict(userId: string, archiveId: string): void {
    const now = Date.now();
    this.sweep(now);
    const unwatched = (j: Job) => now - j.touchedAt > DONE_IDLE_MS;
    const order = (a: Job, b: Job) =>
      Number(isPreview(a)) - Number(isPreview(b)) || a.touchedAt - b.touchedAt;
    const drop = (j: Job) => this.jobs.delete(j.id);

    const mine = this.finished()
      .filter((j) => j.userId === userId)
      .sort(order);
    let count = mine.length;
    let bytes = mine.reduce((s, j) => s + j.bytes, 0);
    const userBytes = bytesCap('INGEST_USER_BYTES', USER_BYTES);
    for (const j of mine) {
      if (count <= KEEP_PER_USER && bytes <= userBytes) break;
      drop(j);
      count--;
      bytes -= j.bytes;
    }

    const here = this.finished().filter((j) => j.archiveId === archiveId && isPreview(j));
    let held = here.length;
    for (const j of [
      ...here.filter(unwatched).sort(order),
      ...here.filter((x) => !unwatched(x) && x.userId === userId).sort(order),
    ]) {
      if (held < ARCHIVE_PREVIEWS) break;
      drop(j);
      held--;
    }

    // room for the job about to start
    const all = this.finished();
    let total = all.length;
    let size = all.reduce((s, j) => s + j.bytes, 0);
    const totalBytes = bytesCap('INGEST_TOTAL_BYTES', TOTAL_BYTES);
    for (const j of all.filter((x) => !isPreview(x) || unwatched(x)).sort(order)) {
      if (total < KEEP_TOTAL && size <= totalBytes) break;
      drop(j);
      total--;
      size -= j.bytes;
    }
  }

  private running(): Job[] {
    return [...this.jobs.values()].filter((j) => j.status === 'running' || j.saving);
  }

  /** Start an import. Throws BusyError when this archive already has one running. */
  start(archiveId: string, userId: string, req: IngestRequest): Job {
    this.evict(userId, archiveId);
    const running = this.running();
    const here = running.find((j) => j.archiveId === archiveId);
    // the id is only worth giving to the person who can look at that job
    if (here) throw new BusyError(here.userId === userId ? here.id : null, 'archive');
    if (running.filter((j) => j.userId === userId).length >= MAX_PER_USER) {
      throw new BusyError(null, 'user');
    }
    if (running.length >= MAX_TOTAL) throw new BusyError(null, 'server');
    const finished = this.finished();
    // only previews that people are still reviewing are left: wait rather than take one
    if (
      !req.save &&
      finished.filter((j) => j.archiveId === archiveId && isPreview(j)).length >= ARCHIVE_PREVIEWS
    ) {
      throw new BusyError(null, 'previews');
    }
    if (
      finished.length >= KEEP_TOTAL ||
      finished.reduce((s, j) => s + j.bytes, 0) > bytesCap('INGEST_TOTAL_BYTES', TOTAL_BYTES)
    ) {
      throw new BusyError(null, 'server');
    }

    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      archiveId,
      userId,
      status: 'running',
      stage: 'reading',
      progress: { done: 0, total: 0 },
      startedAt: now,
      touchedAt: now,
      markers: [],
      ac: new AbortController(),
      done: Promise.resolve(),
      saving: false,
      timedOut: false,
      bytes: 0,
    };
    this.jobs.set(job.id, job);
    const limit = setTimeout(() => {
      job.timedOut = true;
      job.ac.abort();
    }, hardLimitMs());
    limit.unref?.();
    job.done = this.run(job, req).finally(() => clearTimeout(limit));
    return job;
  }

  /** A job, but only for the person who started it, in this archive. Looking at it keeps it alive. */
  get(id: string, archiveId: string, userId: string): Job | null {
    const j = this.jobs.get(id);
    if (!j || j.archiveId !== archiveId || j.userId !== userId) return null;
    j.touchedAt = Date.now();
    return j;
  }

  view(j: Job): JobView {
    return view(j);
  }

  /**
   * `stopping`: it will end as cancelled, nothing saved. `too_late`: it is being written
   * and will finish (it can be undone once saved). `finished`: nothing to stop.
   */
  cancel(j: Job): 'stopping' | 'too_late' | 'finished' {
    // a preview being saved is a finished job that is writing: too late, not "finished"
    // (it was answered 200 as if nothing were happening, then saved; round-2 review #9)
    if (j.saving) return 'too_late';
    if (j.status !== 'running') return 'finished';
    if (!CANCELLABLE.includes(j.stage)) return 'too_late';
    j.ac.abort();
    return 'stopping';
  }

  /**
   * An import was undone: drop the words its job is still holding, and the file name, date
   * and size other jobs hold about it (a duplicate refused because of it, a preview warned
   * about it: round-2 review #8).
   */
  forgetRun(runId: string): void {
    for (const j of this.jobs.values()) {
      const o = j.outcome;
      if (!o) continue;
      if (o.runId === runId) {
        j.outcome = forgotten(o);
        j.markers = [];
      } else if (o.duplicateOf?.runId === runId) {
        if (o.status === 'duplicate') {
          // the page that was told "already imported" still needs a record to show
          j.outcome = { ...o, duplicateOf: { ...o.duplicateOf, source: null } };
        } else {
          // a preview's warning about an import that is no longer there is not true any more
          const rest: IngestOutcome = { ...o };
          delete rest.duplicateOf;
          j.outcome = rest;
        }
      } else continue;
      j.bytes = sizeOf(j.outcome);
    }
  }

  /**
   * Notes were erased (an import undone, a note deleted): no job of that archive goes on
   * quoting them, in a preview's marker lines, its `conflicts` or the sentences shown to the
   * person (round-3 review D2). A save already under way checks again under the lock.
   */
  forgetNotes(archiveId: string, noteIds: string[]): void {
    if (noteIds.length === 0) return;
    const gone = new Set(noteIds.map((id) => id.toLowerCase()));
    const archive = archiveId.toLowerCase();
    for (const j of this.jobs.values()) {
      const o = j.outcome;
      if (j.archiveId !== archive || !o || o.undone) continue;
      if (!dropQuotesOf(o, j.markers, gone)) continue;
      j.markers = j.markers.filter((mk) => !gone.has(mk.source));
      j.bytes = sizeOf(o);
    }
  }

  private finish(job: Job, status: JobStatus, extra: Partial<Job> = {}): void {
    job.status = status;
    job.stage = 'done';
    job.finishedAt = Date.now();
    job.touchedAt = job.finishedAt;
    Object.assign(job, extra);
    const o = job.outcome;
    job.bytes = sizeOf(o);
    // content-free: counts and codes, never words
    console.info(
      JSON.stringify({
        evt: 'ingest',
        job: job.id,
        archive: job.archiveId,
        status,
        outcome: o?.status,
        ms: job.finishedAt - job.startedAt,
        turns: o?.stats.turns,
        windows: o?.stats.windows,
        degraded: o?.degraded.windows,
        retried: o?.stats.retried,
        memories: o?.memories.length,
        saved: o?.saved?.length,
        unchecked: o?.check?.skipped,
        error: job.error?.code,
      }),
    );
  }

  private async run(job: Job, req: IngestRequest): Promise<void> {
    const signal = job.ac.signal;
    try {
      // 1. read it, and see whether this interview is already in
      let parsed: ParsedTranscript;
      try {
        parsed = parseTranscript(req.transcript);
      } catch (e) {
        if (e instanceof TranscriptError) throw e;
        // the reader touches nothing but the input: whatever made it fail is in the file
        console.error(`[ingest] job ${job.id}: the reader failed (${describeError(e)})`);
        throw new TranscriptError(
          'the transcript could not be read; export it again from the transcription tool, or paste it as plain text',
          'unreadable',
        );
      }
      const hash = hashTurns(parsed.turns);
      const duplicate = await findActiveImport(this.deps.pool, job.archiveId, hash);
      if (req.save && duplicate && !req.force) {
        job.outcome = blockedDuplicate(parsed.turns.length, hash, duplicate);
        this.finish(job, 'succeeded');
        return;
      }
      if (signal.aborted) throw new IngestCancelled();

      // 2. organise it. It may link only to notes every member can read: it is shared with all of them.
      job.stage = 'organizing';
      const result = (await ingestParsed(parsed, req, {
        chat: this.deps.chat ?? null,
        // the titles the interview mentions come first, so short ones ("Mom") are not crowded out
        titles: await sharedTitles(
          this.deps.pool,
          job.archiveId,
          parsed.turns.map((t) => t.text).join('\n'),
        ),
        signal,
        onProgress: (p) => {
          job.progress = { done: p.done, total: p.total };
        },
      })) as IngestOutcome;
      if (signal.aborted) throw new IngestCancelled();
      withIds(result.memories);

      // 3. settle titles, and mark what disagrees with what the archive already says (bounded, stoppable)
      job.stage = 'checking';
      const who = await displayNameOf(this.deps.pool, job.userId);
      const checked = await annotateImport(this.deps, job.archiveId, job.userId, result, who, {
        signal,
      });
      result.check = checked.check;
      job.markers = checked.markers;
      if (duplicate) result.duplicateOf = duplicate;

      // 4. decide. This is the last moment a cancel (or the time limit) stops it: from the
      // next line on it is being written, and a cancel is answered "too late".
      if (signal.aborted) throw new IngestCancelled();
      if (!req.save) {
        result.status = 'previewed';
      } else if (result.roles.needsConfirmation && !req.confirm) {
        result.status = 'needs_confirmation';
      } else {
        job.stage = 'saving';
        job.saving = true;
        const out = await persistImport(this.deps, job.archiveId, job.userId, result, {
          force: req.force,
          markers: job.markers,
        });
        result.status = 'saved';
        result.runId = out.runId;
        result.saved = out.saved;
        job.markers = [];
      }
      job.outcome = result;
      this.finish(job, 'succeeded');
    } catch (e) {
      if (e instanceof DuplicateImport) {
        job.outcome = blockedDuplicate(0, '', e.previous);
        this.finish(job, 'succeeded');
      } else if (e instanceof IngestCancelled && job.timedOut) {
        this.finish(job, 'failed', {
          error: { code: 'timeout', message: 'the import took too long; nothing was saved' },
        });
      } else if (e instanceof IngestCancelled || e instanceof ImportNotAllowed) {
        this.finish(job, e instanceof IngestCancelled ? 'cancelled' : 'failed', {
          error: failureOf(e),
        });
      } else {
        if (!(e instanceof TranscriptError)) {
          console.error(`[ingest] job ${job.id} failed: ${describeError(e)}`);
        }
        this.finish(job, 'failed', { error: failureOf(e) });
      }
    } finally {
      job.saving = false;
    }
  }

  /**
   * Save the preview a finished job is holding, optionally with the person's edits.
   * Writes atomically; a second attempt (or a double-click) is refused.
   */
  async save(job: Job, patches: MemoryPatch[] = [], force = false): Promise<IngestOutcome> {
    const o = job.outcome;
    if (
      job.status !== 'succeeded' ||
      !o ||
      (o.status !== 'previewed' && o.status !== 'needs_confirmation')
    ) {
      throw new SaveError('there is nothing to save', 409, { reason: 'nothing_to_save' });
    }
    if (job.saving) throw new SaveError('already saving', 409, { reason: 'already_saving' });
    job.saving = true;
    try {
      const { outcome: edited, wanted, skipped } = applyPatches(o, patches);
      if (edited.memories.length === 0)
        throw new SaveError('nothing is selected to save', 400, { reason: 'nothing_selected' });
      // a memory left out takes the markers that named it with it
      const markers = job.markers;
      dropMarkers(edited.memories, markers, skipped);
      // edits may have changed titles, and the archive may have gained notes since the
      // preview: settle again, and every link to an old title follows it
      retitle(
        edited.memories,
        await resolveTitles(
          this.deps.pool,
          job.archiveId,
          edited.memories.map((m, i) => ({ title: wanted[i]!, hint: hintOf(m) })),
        ),
      );
      const out = await persistImport(this.deps, job.archiveId, job.userId, edited, {
        force,
        markers,
      });
      edited.status = 'saved';
      edited.runId = out.runId;
      edited.saved = out.saved;
      job.outcome = edited;
      job.markers = [];
      job.bytes = sizeOf(edited);
      return edited;
    } finally {
      job.saving = false;
      job.touchedAt = Date.now();
    }
  }
}

/** Why a save was refused, for a page that must not parse English. */
export type SaveReason =
  | 'no_memory'
  | 'title'
  | 'type'
  | 'body_too_long'
  | 'date'
  | 'nothing_selected'
  | 'nothing_to_save'
  | 'already_saving';

export class SaveError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
    /** a stable code for the page, and the 0-based position of the memory it is about */
    readonly why?: { reason: SaveReason; index?: number },
  ) {
    super(message);
  }
}

function blockedDuplicate(turns: number, hash: string, previous: ImportRecord): IngestOutcome {
  return {
    status: 'duplicate',
    duplicateOf: previous,
    memories: [],
    sourceHash: hash,
    format: '',
    language: 'en',
    providerVersion: '',
    interviewee: '',
    interviewees: [],
    speakers: [],
    roles: { source: 'sender', confidence: 'high', reasons: [], needsConfirmation: false },
    warnings: [],
    degraded: { windows: 0, reasons: [] },
    stats: {
      turns,
      intervieweeTurns: 0,
      windows: 0,
      failedWindows: 0,
      rounds: 0,
      retried: 0,
      exit: 'no_model',
      coverage: { covered: 0, total: 0 },
    },
  };
}

/* ── the person's edits to a preview ─────────────────────────────────── */

export interface MemoryPatch {
  /** position in the preview's `memories` */
  index: number;
  /** leave this memory out */
  skip?: boolean;
  title?: string;
  type?: string;
  body?: string;
  occurred?: string | null;
}

const MAX_BODY = 20_000;

/**
 * A copy of the preview with the person's edits applied and checked, the skipped memories
 * left out. Their words are theirs: only the SHAPE is validated. Titles are not changed
 * here but returned as `wanted` (aligned with the copy's memories), so the caller can
 * settle them against the archive and make links follow.
 */
/** C0 control characters and DEL, except tab and the two line ends */
const noControls = (v: string): string =>
  v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

function applyPatches(
  o: IngestOutcome,
  patches: MemoryPatch[],
): { outcome: IngestOutcome; wanted: string[]; skipped: Set<string> } {
  const copy = structuredClone(o);
  const memories = withIds(copy.memories);
  const wanted = memories.map((m) => m.title);
  const skip = new Set<number>();
  for (const p of patches) {
    const m = Number.isInteger(p.index) && p.index >= 0 ? memories[p.index] : undefined;
    if (!m) {
      throw new SaveError(`there is no memory number ${p.index}`, 400, { reason: 'no_memory' });
    }
    if (p.skip) {
      skip.add(p.index);
      continue;
    }
    if (p.title !== undefined) {
      const t = canonicalTitle(noControls(p.title));
      const err = validateNoteTitle(t);
      if (err) {
        throw new SaveError(`memory ${p.index + 1}: ${err}`, 400, {
          reason: 'title',
          index: p.index,
        });
      }
      wanted[p.index] = t;
    }
    if (p.type !== undefined) {
      if (!(ENTITY_TYPES as readonly string[]).includes(p.type)) {
        throw new SaveError(`memory ${p.index + 1}: unknown type`, 400, {
          reason: 'type',
          index: p.index,
        });
      }
      m.type = p.type as typeof m.type;
    }
    if (p.body !== undefined) {
      if (typeof p.body !== 'string' || p.body.length > MAX_BODY) {
        throw new SaveError(`memory ${p.index + 1}: the text is too long`, 400, {
          reason: 'body_too_long',
          index: p.index,
        });
      }
      // a NUL (or another control character) typed or pasted into a card would make the database refuse it
      m.body = noControls(p.body);
    }
    if (p.occurred !== undefined) {
      if (
        p.occurred !== null &&
        p.occurred.trim() !== '' &&
        parseFuzzyDate(p.occurred.trim()) === null
      ) {
        throw new SaveError(
          `memory ${p.index + 1}: the date must look like 1987, 1987-03 or ~1948`,
          400,
          { reason: 'date', index: p.index },
        );
      }
      m.occurred = p.occurred === null || p.occurred.trim() === '' ? null : p.occurred.trim();
    }
  }
  const skipped = new Set([...skip].map((i) => memories[i]!.id));
  copy.memories = memories.filter((_, i) => !skip.has(i));
  return { outcome: copy, wanted: wanted.filter((_, i) => !skip.has(i)), skipped };
}
