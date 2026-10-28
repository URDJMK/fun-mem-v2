import type { PoolClient } from 'pg';
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
import { onLostConnection } from './notes';
import { formatClock } from './clock';
import { TranscriptError, parseTranscript, type ParsedTranscript } from './transcript';
import {
  archiveLookup,
  defaultInterviewName,
  openInterview,
  renameInterview,
  type InterviewOptions,
} from './stories/interviews';
import { writeStories } from './stories/workflow';
import { profilesFor } from './stories/profile-store';
import { ensureGraph, entityLookup, knownFor } from './graph/store';

/**
 * Interviews are LONG: an hour of speech is tens of model calls, so a request that
 * waits for all of it hits every proxy and browser timeout. An import is therefore a
 * JOB: it starts, reports progress, can be cancelled until it starts writing, and its
 * outcome is fetched when it is ready. The synchronous form of the route simply waits on
 * the same job, so there is one code path.
 *
 * WHAT A JOB HOLDS, AND FOR HOW LONG. Never the raw transcript after it has been read.
 * The outcome (the memories, which are the family's words) is held only so that a
 * person can read, edit and save it, for as long as somebody is looking at it: a job's
 * life is its IDLE time, refreshed whenever its owner reads, saves or cancels it. An
 * unsaved preview lives 60 idle minutes (it is somebody's unfinished work), and never
 * more than 3 hours; every other finished job 15 idle minutes. What jobs hold is capped
 * in bytes per person and for the whole server (see `evict`). Undoing an import drops the
 * words its job was holding at once (`forgetRun`), and an erased note (undone, or deleted by
 * hand) is no longer quoted by any job of its archive (`forgetNotes`). A note deleted by hand
 * is otherwise not tracked here: its own words can stay in the outcome of the job that made
 * it until that job expires.
 *
 * WHERE. A job is a row of `public.ingest_jobs`, shared by every instance of the server (the
 * isolates of a Worker; a Node server and the one that replaces it), so the request that starts
 * it, the queue consumer that runs it and the requests that poll, cancel and save it need not
 * meet in one process. What decides a race between them (a cancel against the step into
 * saving, two saves) is decided in the database. A job whose runner dies goes quiet: after two
 * minutes it is reported failed, `interrupted`, and the atomic save and the duplicate guard make
 * simply trying again safe.
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

/** A job, as the database holds it. */
export interface Job {
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
  /** a save is in flight: refuse a second one, never evict, never cancel */
  saving: boolean;
  /** the hard time limit, not the person, stopped it */
  timedOut: boolean;
  /** what its outcome holds, roughly (its JSON length) */
  bytes: number;
}

/**
 * A job just started. `done` is the job as it finished, when it runs in this instance; when it
 * was handed to a queue, it is the job as it was handed over.
 */
export interface StartedJob extends Job {
  done: Promise<Job>;
}

/**
 * How a deployment runs its jobs. Each one may also come from `deps.ingestJobs`; one given to
 * the constructor wins.
 */
export interface IngestJobsOptions {
  /** the instances that share jobs, and whose jobs the limits count: one per deployment */
  scope?: string;
  /**
   * Hand a job that nobody is waiting on to a queue, whose consumer calls `runQueued`: a Worker
   * may not keep working long after its response. Absent: the job runs in this instance.
   */
  enqueue?: ((jobId: string) => Promise<void>) | null;
  /** how often this instance lets go of expired jobs; null when something else calls `sweep` */
  sweepEveryMs?: number | null;
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

/** How often a running job says it is alive, writes its progress and looks for a cancel. */
const HEARTBEAT_MS = 1_000;
/** A running job silent for this long died with whatever was running it. */
const STALE_MS = 2 * 60_000;

const COLUMNS = `id, archive_id, user_id, status, stage, progress_done, progress_total, started_at,
  finished_at, touched_at, outcome, error, markers, saving, timed_out, bytes`;
/** Finished, and not being saved: the only jobs that may ever be let go. */
const EVICTABLE = `status <> 'running' and finished_at is not null and not saving and stage <> 'saving'`;
const PREVIEW = `(status = 'succeeded' and outcome_status in ('previewed', 'needs_confirmation'))`;
const ms = (n: number) => `${n} * interval '1 millisecond'`;
/** Past its idle time, or a preview past its absolute lifetime, at the time in parameter `now`. */
const expired = (now: string) =>
  `${EVICTABLE} and (
     touched_at < ${now}::timestamptz
                  - (case when ${PREVIEW} then ${PREVIEW_IDLE_MS} else ${DONE_IDLE_MS} end)
                    * interval '1 millisecond'
     or (${PREVIEW} and finished_at < ${now}::timestamptz - ${ms(PREVIEW_MAX_MS)}))`;
const INTERRUPTED: JobFailure = {
  code: 'interrupted',
  message: 'the import stopped before it finished; nothing was saved',
};

interface JobRow {
  id: string;
  archive_id: string;
  user_id: string;
  status: JobStatus;
  stage: JobStage;
  progress_done: number;
  progress_total: number;
  started_at: Date;
  finished_at: Date | null;
  touched_at: Date;
  outcome: IngestOutcome | null;
  error: JobFailure | null;
  markers: MarkerLine[] | null;
  saving: boolean;
  timed_out: boolean;
  bytes: number;
}

const jobOf = (r: JobRow): Job => ({
  id: r.id,
  archiveId: r.archive_id,
  userId: r.user_id,
  status: r.status,
  stage: r.stage,
  progress: { done: r.progress_done, total: r.progress_total },
  startedAt: r.started_at.getTime(),
  ...(r.finished_at ? { finishedAt: r.finished_at.getTime() } : {}),
  touchedAt: r.touched_at.getTime(),
  ...(r.outcome ? { outcome: r.outcome } : {}),
  ...(r.error ? { error: r.error } : {}),
  markers: r.markers ?? [],
  saving: r.saving,
  timedOut: r.timed_out,
  bytes: r.bytes,
});

/** A time for the database: every clock here is Date.now(), so a test can move it. */
const at = (t: number): Date => new Date(t);
/** A value for a jsonb parameter. pg would write an array as a Postgres array, not as JSON. */
const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

/** What making room looks at: a finished job, without its words. */
interface Held {
  id: string;
  userId: string;
  archiveId: string;
  preview: boolean;
  touchedAt: number;
  bytes: number;
}

/**
 * Make room when someone starts an import: the ids of the finished jobs to let go. Never a
 * running job, never one being saved (those are not `Held`).
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
function evictions(held: Held[], userId: string, archiveId: string, now: number): Set<string> {
  const dropped = new Set<string>();
  const live = () => held.filter((j) => !dropped.has(j.id));
  const unwatched = (j: Held) => now - j.touchedAt > DONE_IDLE_MS;
  const order = (a: Held, b: Held) =>
    Number(a.preview) - Number(b.preview) || a.touchedAt - b.touchedAt;

  const mine = live()
    .filter((j) => j.userId === userId)
    .sort(order);
  let count = mine.length;
  let bytes = mine.reduce((s, j) => s + j.bytes, 0);
  const userBytes = bytesCap('INGEST_USER_BYTES', USER_BYTES);
  for (const j of mine) {
    if (count <= KEEP_PER_USER && bytes <= userBytes) break;
    dropped.add(j.id);
    count--;
    bytes -= j.bytes;
  }

  const here = live().filter((j) => j.archiveId === archiveId && j.preview);
  let inArchive = here.length;
  for (const j of [
    ...here.filter(unwatched).sort(order),
    ...here.filter((x) => !unwatched(x) && x.userId === userId).sort(order),
  ]) {
    if (inArchive < ARCHIVE_PREVIEWS) break;
    dropped.add(j.id);
    inArchive--;
  }

  // room for the job about to start
  const all = live();
  let total = all.length;
  let size = all.reduce((s, j) => s + j.bytes, 0);
  const totalBytes = bytesCap('INGEST_TOTAL_BYTES', TOTAL_BYTES);
  for (const j of all.filter((x) => !x.preview || unwatched(x)).sort(order)) {
    if (total < KEEP_TOTAL && size <= totalBytes) break;
    dropped.add(j.id);
    total--;
    size -= j.bytes;
  }
  return dropped;
}

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
  private readonly scope: string;
  private readonly enqueue: ((jobId: string) => Promise<void>) | null;
  /** the jobs running in this instance: a cancel that arrives here stops one at once */
  private readonly local = new Map<string, AbortController>();

  constructor(
    private readonly deps: AppDeps,
    opts: IngestJobsOptions = {},
  ) {
    const from = deps.ingestJobs ?? {};
    this.scope = opts.scope ?? from.scope ?? 'default';
    this.enqueue = opts.enqueue !== undefined ? opts.enqueue : (from.enqueue ?? null);
    const every =
      opts.sweepEveryMs !== undefined
        ? opts.sweepEveryMs
        : from.sweepEveryMs !== undefined
          ? from.sweepEveryMs
          : 60_000;
    if (every) {
      const t = setInterval(() => {
        this.sweep().catch((e: unknown) => {
          console.error(`[ingest] letting go of expired jobs failed: ${describeError(e)}`);
        });
      }, every);
      t.unref?.();
    }
  }

  /**
   * Let go of finished jobs nobody has looked at for their idle time, and of previews older
   * than their absolute lifetime whoever is looking; report a job whose runner died as failed.
   * A timer calls this on a Node server, a cron on a Worker, and every start does it too.
   */
  async sweep(now = Date.now()): Promise<void> {
    await this.expire(this.deps.pool, now);
  }

  private async expire(db: Pick<PoolClient, 'query'>, now: number): Promise<void> {
    // a job whose runner went quiet died with it: a restarted server, an isolate let go
    await db.query(
      `update public.ingest_jobs
          set status = 'failed', stage = 'done', finished_at = $2, touched_at = $2,
              saving = false, error = $3::jsonb, request = null
        where scope = $1 and status = 'running' and heartbeat_at < $4`,
      [this.scope, at(now), json(INTERRUPTED), at(now - STALE_MS)],
    );
    // a save whose saver went quiet is not in flight any more (its transaction rolled back)
    await db.query(
      `update public.ingest_jobs set saving = false
        where scope = $1 and saving and status <> 'running' and heartbeat_at < $2`,
      [this.scope, at(now - STALE_MS)],
    );
    await db.query(`delete from public.ingest_jobs where scope = $1 and ${expired('$2')}`, [
      this.scope,
      at(now),
    ]);
  }

  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.deps.pool.connect();
    const unguard = onLostConnection(client);
    try {
      await client.query('begin');
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      unguard();
      client.release();
    }
  }

  /**
   * Start an import. Throws BusyError when this archive already has one running, or when
   * there is no room. With `wait`, or with no queue, it runs in this instance and `done` is
   * the job as it finished; otherwise it is handed to the queue.
   */
  async start(
    archiveId: string,
    userId: string,
    req: IngestRequest,
    opts: { wait?: boolean } = {},
  ): Promise<StartedJob> {
    const now = Date.now();
    const queue = opts.wait ? null : this.enqueue;
    const job = await this.transaction(async (client) => {
      // one start at a time for the whole deployment: the rules below read, then insert
      await client.query('select pg_advisory_xact_lock(hashtext($1)::bigint)', [
        `ingest_jobs:${this.scope}`,
      ]);
      await this.expire(client, now);
      const held = (
        await client.query(
          `select id, user_id, archive_id, ${PREVIEW} as preview, touched_at, bytes
             from public.ingest_jobs where scope = $1 and ${EVICTABLE}`,
          [this.scope],
        )
      ).rows.map(
        (r: {
          id: string;
          user_id: string;
          archive_id: string;
          preview: boolean;
          touched_at: Date;
          bytes: number;
        }): Held => ({
          id: r.id,
          userId: r.user_id,
          archiveId: r.archive_id,
          preview: r.preview,
          touchedAt: r.touched_at.getTime(),
          bytes: r.bytes,
        }),
      );
      const dropped = evictions(held, userId, archiveId, now);
      if (dropped.size > 0) {
        await client.query('delete from public.ingest_jobs where id = any($1::uuid[])', [
          [...dropped],
        ]);
      }
      const finished = held.filter((j) => !dropped.has(j.id));
      const running = (
        await client.query(
          `select id, archive_id, user_id from public.ingest_jobs
            where scope = $1 and (status = 'running' or saving)`,
          [this.scope],
        )
      ).rows as Array<{ id: string; archive_id: string; user_id: string }>;
      const here = running.find((j) => j.archive_id === archiveId);
      // the id is only worth giving to the person who can look at that job
      if (here) throw new BusyError(here.user_id === userId ? here.id : null, 'archive');
      if (running.filter((j) => j.user_id === userId).length >= MAX_PER_USER) {
        throw new BusyError(null, 'user');
      }
      if (running.length >= MAX_TOTAL) throw new BusyError(null, 'server');
      // only previews that people are still reviewing are left: wait rather than take one
      if (
        !req.save &&
        finished.filter((j) => j.archiveId === archiveId && j.preview).length >= ARCHIVE_PREVIEWS
      ) {
        throw new BusyError(null, 'previews');
      }
      if (
        finished.length >= KEEP_TOTAL ||
        finished.reduce((s, j) => s + j.bytes, 0) > bytesCap('INGEST_TOTAL_BYTES', TOTAL_BYTES)
      ) {
        throw new BusyError(null, 'server');
      }
      const r = await client.query(
        `insert into public.ingest_jobs
           (scope, archive_id, user_id, status, stage, started_at, touched_at, heartbeat_at, request)
         values ($1, $2, $3, 'running', 'reading', $4, $4, $4, $5)
         returning ${COLUMNS}`,
        // the transcript waits in the row only for a queue consumer; run here, it never does
        [this.scope, archiveId, userId, at(now), queue ? JSON.stringify(req) : null],
      );
      return jobOf(r.rows[0] as JobRow);
    });

    if (queue) {
      try {
        await queue(job.id);
      } catch (e) {
        await this.finish(job, 'failed', { error: failureOf(e) });
        throw e;
      }
      return { ...job, done: Promise.resolve(job) };
    }
    const done = this.run(job, req);
    // nobody may be waiting on it (an async import): a failure to write its end is logged here
    done.catch((e: unknown) => console.error(`[ingest] job ${job.id}: ${describeError(e)}`));
    return { ...job, done };
  }

  /**
   * Run a job that was handed to the queue (the consumer calls this). The first delivery takes
   * the request out of the row, so the transcript is not kept once it has been read, and a
   * message delivered twice finds nothing to run.
   */
  async runQueued(id: string): Promise<void> {
    const r = await this.deps.pool.query(
      `with picked as (
         select id, request from public.ingest_jobs
          where id = $1 and scope = $2 and status = 'running' and request is not null
          for update)
       update public.ingest_jobs j set request = null, heartbeat_at = $3
         from picked where j.id = picked.id
       returning j.*, picked.request as picked`,
      [id, this.scope, at(Date.now())],
    );
    const row = r.rows[0] as (JobRow & { cancel_requested: boolean; picked: string }) | undefined;
    if (!row) return;
    await this.run(jobOf(row), JSON.parse(row.picked) as IngestRequest, row.cancel_requested);
  }

  /** A job, but only for the person who started it, in this archive. Looking at it keeps it alive. */
  async get(id: string, archiveId: string, userId: string): Promise<Job | null> {
    const now = Date.now();
    const pool = this.deps.pool;
    // a job still marked running whose runner died is answered as what it is
    await pool.query(
      `update public.ingest_jobs
          set status = 'failed', stage = 'done', finished_at = $3, touched_at = $3,
              saving = false, error = $4::jsonb, request = null
        where id = $1 and scope = $2 and status = 'running' and heartbeat_at < $5`,
      [id, this.scope, at(now), json(INTERRUPTED), at(now - STALE_MS)],
    );
    const r = await pool.query(
      `update public.ingest_jobs set touched_at = $5
        where id = $1 and scope = $2 and archive_id = $3 and user_id = $4
          and not (${expired('$5')})
        returning ${COLUMNS}`,
      [id, this.scope, archiveId, userId, at(now)],
    );
    return r.rows[0] ? jobOf(r.rows[0] as JobRow) : null;
  }

  view(j: Job): JobView {
    return view(j);
  }

  /**
   * `stopping`: it will end as cancelled, nothing saved. `too_late`: it is being written
   * and will finish (it can be undone once saved). `finished`: nothing to stop.
   */
  async cancel(j: Job): Promise<'stopping' | 'too_late' | 'finished'> {
    const pool = this.deps.pool;
    // decided in the database, against the runner's own step into saving (see `run`)
    const r = await pool.query(
      `update public.ingest_jobs set cancel_requested = true
        where id = $1 and status = 'running' and not saving and stage = any($2::text[])
        returning id`,
      [j.id, CANCELLABLE],
    );
    if (r.rowCount) {
      this.local.get(j.id)?.abort();
      return 'stopping';
    }
    const now = (
      await pool.query('select status, saving from public.ingest_jobs where id = $1', [j.id])
    ).rows[0] as { status: JobStatus; saving: boolean } | undefined;
    // a preview being saved is a finished job that is writing: too late, not "finished"
    // (it was answered 200 as if nothing were happening, then saved; round-2 review #9)
    if (now?.saving) return 'too_late';
    if (!now || now.status !== 'running') return 'finished';
    return 'too_late';
  }

  /**
   * An import was undone: drop the words its job is still holding, and the file name, date
   * and size other jobs hold about it (a duplicate refused because of it, a preview warned
   * about it: round-2 review #8).
   */
  async forgetRun(runId: string): Promise<void> {
    await this.transaction(async (client) => {
      const r = await client.query(
        `select id, outcome, markers from public.ingest_jobs
          where scope = $1 and outcome is not null
            and (outcome->>'runId' = $2 or outcome->'duplicateOf'->>'runId' = $2)
          for update`,
        [this.scope, runId],
      );
      for (const row of r.rows as Array<{
        id: string;
        outcome: IngestOutcome;
        markers: MarkerLine[];
      }>) {
        const o = row.outcome;
        let next: IngestOutcome;
        let markers = row.markers;
        if (o.runId === runId) {
          next = forgotten(o);
          markers = [];
        } else if (o.status === 'duplicate') {
          // the page that was told "already imported" still needs a record to show
          next = { ...o, duplicateOf: { ...o.duplicateOf!, source: null } };
        } else {
          // a preview's warning about an import that is no longer there is not true any more
          next = { ...o };
          delete next.duplicateOf;
        }
        await client.query(
          `update public.ingest_jobs set outcome = $2::jsonb, markers = $3::jsonb, bytes = $4
            where id = $1`,
          [row.id, json(next), json(markers), sizeOf(next)],
        );
      }
    });
  }

  /**
   * Notes were erased (an import undone, a note deleted): no job of that archive goes on
   * quoting them, in a preview's marker lines, its `conflicts` or the sentences shown to the
   * person (round-3 review D2). A save already under way checks again under the lock.
   */
  async forgetNotes(archiveId: string, noteIds: string[]): Promise<void> {
    if (noteIds.length === 0) return;
    const gone = new Set(noteIds.map((id) => id.toLowerCase()));
    await this.transaction(async (client) => {
      const r = await client.query(
        `select id, outcome, markers from public.ingest_jobs
          where scope = $1 and archive_id = $2 and outcome is not null
            and coalesce(outcome->>'undone', 'false') <> 'true'
          for update`,
        [this.scope, archiveId.toLowerCase()],
      );
      for (const row of r.rows as Array<{
        id: string;
        outcome: IngestOutcome;
        markers: MarkerLine[];
      }>) {
        const o = row.outcome;
        const markers = row.markers ?? [];
        if (!dropQuotesOf(o, markers, gone)) continue;
        await client.query(
          `update public.ingest_jobs set outcome = $2::jsonb, markers = $3::jsonb, bytes = $4
            where id = $1`,
          [row.id, json(o), json(markers.filter((mk) => !gone.has(mk.source))), sizeOf(o)],
        );
      }
    });
  }

  /**
   * Write how a job ended. `unlessCancelled`: a cancel that reached the database first wins,
   * and the job ends cancelled instead (it was answered "stopping").
   */
  private async finish(
    job: Job,
    status: JobStatus,
    extra: Partial<Job> = {},
    unlessCancelled = false,
  ): Promise<Job> {
    const now = Date.now();
    const done: Job = {
      ...job,
      ...extra,
      status,
      stage: 'done',
      finishedAt: now,
      touchedAt: now,
      saving: false,
    };
    done.bytes = sizeOf(done.outcome);
    const r = await this.deps.pool.query(
      `update public.ingest_jobs
          set status = $2, stage = 'done', finished_at = $3, touched_at = $3,
              outcome = $4::jsonb, outcome_status = $5, error = $6::jsonb, markers = $7::jsonb,
              bytes = $8, saving = false, timed_out = $9, progress_done = $10,
              progress_total = $11, request = null
        where id = $1 ${unlessCancelled ? 'and not cancel_requested' : ''}
        returning id`,
      [
        done.id,
        status,
        at(now),
        json(done.outcome),
        done.outcome?.status ?? null,
        json(done.error),
        json(done.markers),
        done.bytes,
        done.timedOut,
        done.progress.done,
        done.progress.total,
      ],
    );
    if (unlessCancelled && r.rowCount === 0) {
      return this.finish({ ...job, markers: [] }, 'cancelled', {
        outcome: undefined,
        error: failureOf(new IngestCancelled()),
      });
    }
    const o = done.outcome;
    // content-free: counts and codes, never words
    console.info(
      JSON.stringify({
        evt: 'ingest',
        job: done.id,
        archive: done.archiveId,
        status,
        outcome: o?.status,
        ms: now - done.startedAt,
        turns: o?.stats.turns,
        windows: o?.stats.windows,
        degraded: o?.degraded.windows,
        retried: o?.stats.retried,
        memories: o?.memories.length,
        saved: o?.saved?.length,
        unchecked: o?.check?.skipped,
        error: done.error?.code,
      }),
    );
    return done;
  }

  /**
   * Run a job here. Every second it says it is alive, writes its progress, and looks for a
   * cancel sent to another instance; the hard time limit counts from when the job started.
   */
  /**
   * Stories mode (AppDeps.importMode): keep the interview with its transcript, then write its
   * stories (stories/workflow.ts). The interview is kept even when they cannot be written yet.
   */
  private async writeStoriesOf(
    job: Job,
    req: IngestRequest,
    parsed: ParsedTranscript,
    hash: string,
    titles: string[],
    signal: AbortSignal,
    onProgress: (p: { done: number; total: number }) => void,
  ): Promise<IngestResult> {
    const pool = this.deps.pool;
    const named = typeof req.source === 'string' && req.source.trim() ? req.source.trim() : null;
    const options: InterviewOptions = {};
    if (typeof req.teller === 'string') options.teller = req.teller;
    if (typeof req.interviewee === 'string') options.interviewee = req.interviewee;
    if (Array.isArray(req.interviewees)) options.interviewees = req.interviewees;
    if (req.speakerNames && typeof req.speakerNames === 'object')
      options.speakerNames = req.speakerNames;
    const interviewId = await openInterview(pool, {
      archiveId: job.archiveId,
      userId: job.userId,
      hash,
      name: named ?? defaultInterviewName(),
      transcript:
        typeof req.transcript === 'string' ? req.transcript : JSON.stringify(req.transcript),
      options,
    });
    // a personal project is about one person: an unnamed narrator ("SPEAKER_00") is them
    const project = await pool.query(
      `select subject_name, kind::text as kind from public.archives where id = $1`,
      [job.archiveId],
    );
    const p = project.rows[0] as { subject_name: string; kind: string } | undefined;
    // who the interview is about, and who tells it: in every step's prompt (PRD D14)
    const tellers = [
      req.teller,
      req.interviewee,
      ...(Array.isArray(req.interviewees) ? req.interviewees : []),
      ...Object.values(
        req.speakerNames && typeof req.speakerNames === 'object' ? req.speakerNames : {},
      ),
    ].filter((t): t is string => typeof t === 'string');
    const profiles = await profilesFor(pool, job.archiveId, job.userId, tellers);
    // the project's graph, for the Graph step after the stories (graph design 4.1)
    await ensureGraph(this.deps, job.archiveId);
    const known = await knownFor(pool, job.archiveId, job.userId, tellers);
    const result = await writeStories(parsed, req, {
      profiles,
      graph: { lookup: entityLookup(pool, job.archiveId, job.userId), known },
      chat: this.deps.chat ?? null,
      judge: this.deps.chat ?? null,
      lookup: archiveLookup(this.deps, job.archiveId, job.userId),
      titles,
      signal,
      onProgress,
      interviewName: named,
      subject: p?.kind === 'personal' ? p.subject_name : null,
    });
    result.interviewId = interviewId;
    if (!named && result.interviewName)
      await renameInterview(pool, interviewId, result.interviewName);
    return result;
  }

  private async run(job: Job, req: IngestRequest, cancelled = false): Promise<Job> {
    const pool = this.deps.pool;
    const ac = new AbortController();
    if (cancelled) ac.abort();
    this.local.set(job.id, ac);
    let timedOut = false;
    const limit = setTimeout(
      () => {
        timedOut = true;
        ac.abort();
      },
      Math.max(0, hardLimitMs() - (Date.now() - job.startedAt)),
    );
    limit.unref?.();
    let beating: Promise<void> = Promise.resolve();
    const beat = async (): Promise<void> => {
      const r = await pool.query(
        `update public.ingest_jobs set heartbeat_at = $2, progress_done = $3, progress_total = $4
          where id = $1 returning cancel_requested`,
        [job.id, at(Date.now()), job.progress.done, job.progress.total],
      );
      if ((r.rows[0] as { cancel_requested?: boolean } | undefined)?.cancel_requested) ac.abort();
    };
    const tick = setInterval(() => {
      beating = beating.then(beat).catch(() => undefined);
    }, HEARTBEAT_MS);
    tick.unref?.();
    const stage = async (s: JobStage): Promise<void> => {
      job.stage = s;
      await pool.query('update public.ingest_jobs set stage = $2 where id = $1', [job.id, s]);
    };
    const signal = ac.signal;
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
      const duplicate = await findActiveImport(pool, job.archiveId, hash);
      if (req.save && duplicate && !req.force) {
        job.outcome = blockedDuplicate(parsed.turns.length, hash, duplicate);
        return await this.finish(job, 'succeeded', {}, true);
      }
      if (signal.aborted) throw new IngestCancelled();

      // 2. organise it. It may link only to notes every member can read: it is shared with all of them.
      await stage('organizing');
      // the titles the interview mentions come first, so short ones ("Mom") are not crowded out
      const titles = await sharedTitles(
        pool,
        job.archiveId,
        parsed.turns.map((t) => t.text).join('\n'),
      );
      const onProgress = (p: { done: number; total: number }) => {
        job.progress = { done: p.done, total: p.total };
      };
      const result = (
        this.deps.importMode === 'stories'
          ? await this.writeStoriesOf(job, req, parsed, hash, titles, signal, onProgress)
          : await ingestParsed(parsed, req, {
              chat: this.deps.chat ?? null,
              titles,
              signal,
              onProgress,
            })
      ) as IngestOutcome;
      if (signal.aborted) throw new IngestCancelled();
      withIds(result.memories);

      // 3. settle titles, and mark what disagrees with what the archive already says (bounded, stoppable)
      await stage('checking');
      const who = await displayNameOf(pool, job.userId);
      const checked = await annotateImport(this.deps, job.archiveId, job.userId, result, who, {
        signal,
      });
      result.check = checked.check;
      job.markers = checked.markers;
      if (duplicate) result.duplicateOf = duplicate;

      // 4. decide. This is the last moment a cancel (or the time limit) stops it: from the
      // next step on it is being written, and a cancel is answered "too late".
      if (signal.aborted) throw new IngestCancelled();
      // stories that could not be written yet: nothing to save, the interview keeps the words
      if (!req.save || result.pending) {
        result.status = 'previewed';
      } else if (result.roles.needsConfirmation && !req.confirm) {
        result.status = 'needs_confirmation';
      } else {
        // Whether a cancel came first is decided in the database: one that reached it before
        // this step is answered "stopping", so it stops; after it, cancels are "too late".
        const writing = await pool.query(
          `update public.ingest_jobs set stage = 'saving', saving = true, heartbeat_at = $2
            where id = $1 and not cancel_requested returning id`,
          [job.id, at(Date.now())],
        );
        if (!writing.rowCount) throw new IngestCancelled();
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
        job.outcome = result;
        // written: it stands, whatever arrives now
        return await this.finish(job, 'succeeded', { timedOut });
      }
      job.outcome = result;
      return await this.finish(job, 'succeeded', { timedOut }, true);
    } catch (e) {
      if (e instanceof DuplicateImport) {
        job.outcome = blockedDuplicate(0, '', e.previous);
        return await this.finish(job, 'succeeded', { timedOut });
      }
      if (e instanceof IngestCancelled && timedOut) {
        return await this.finish(job, 'failed', {
          timedOut,
          error: { code: 'timeout', message: 'the import took too long; nothing was saved' },
        });
      }
      if (e instanceof IngestCancelled || e instanceof ImportNotAllowed) {
        return await this.finish(job, e instanceof IngestCancelled ? 'cancelled' : 'failed', {
          error: failureOf(e),
        });
      }
      if (!(e instanceof TranscriptError)) {
        console.error(`[ingest] job ${job.id} failed: ${describeError(e)}`);
      }
      return await this.finish(job, 'failed', { error: failureOf(e) });
    } finally {
      clearTimeout(limit);
      clearInterval(tick);
      await beating;
      this.local.delete(job.id);
    }
  }

  /**
   * Save the preview a finished job is holding, optionally with the person's edits.
   * Writes atomically; a second attempt (or a double-click, or the same click arriving at
   * two instances) is refused.
   */
  async save(job: Job, patches: MemoryPatch[] = [], force = false): Promise<IngestOutcome> {
    const pool = this.deps.pool;
    const claim = await pool.query(
      `update public.ingest_jobs set saving = true, heartbeat_at = $2
        where id = $1 and status = 'succeeded' and not saving
          and outcome_status in ('previewed', 'needs_confirmation')
        returning outcome, markers`,
      [job.id, at(Date.now())],
    );
    const held = claim.rows[0] as { outcome: IngestOutcome; markers: MarkerLine[] } | undefined;
    if (!held) {
      const now = (
        await pool.query(
          'select status, saving, outcome_status from public.ingest_jobs where id = $1',
          [job.id],
        )
      ).rows[0] as
        { status: JobStatus; saving: boolean; outcome_status: string | null } | undefined;
      const preview =
        now?.status === 'succeeded' &&
        (now.outcome_status === 'previewed' || now.outcome_status === 'needs_confirmation');
      if (preview && now.saving) {
        throw new SaveError('already saving', 409, { reason: 'already_saving' });
      }
      throw new SaveError('there is nothing to save', 409, { reason: 'nothing_to_save' });
    }
    let saved: IngestOutcome | null = null;
    try {
      const { outcome: edited, wanted, skipped } = applyPatches(held.outcome, patches);
      if (edited.memories.length === 0)
        throw new SaveError('nothing is selected to save', 400, { reason: 'nothing_selected' });
      // a memory left out takes the markers that named it with it
      const markers = held.markers ?? [];
      dropMarkers(edited.memories, markers, skipped);
      // edits may have changed titles, and the archive may have gained notes since the
      // preview: settle again, and every link to an old title follows it
      retitle(
        edited.memories,
        await resolveTitles(
          pool,
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
      saved = edited;
      return edited;
    } finally {
      await pool.query(
        saved
          ? `update public.ingest_jobs
                set saving = false, touched_at = $2, outcome = $3::jsonb, outcome_status = 'saved',
                    markers = '[]', bytes = $4
              where id = $1`
          : 'update public.ingest_jobs set saving = false, touched_at = $2 where id = $1',
        saved ? [job.id, at(Date.now()), json(saved), sizeOf(saved)] : [job.id, at(Date.now())],
      );
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
