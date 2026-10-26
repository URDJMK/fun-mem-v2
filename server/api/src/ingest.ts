import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { App, AppDeps } from './app';
import {
  BusyError,
  IngestJobs,
  SaveError,
  describeError,
  type IngestRequest,
  type JobFailure,
  type MemoryPatch,
} from './ingest-jobs';
import {
  DuplicateImport,
  IMPORT_ROLES,
  ImportNotAllowed,
  listRuns,
  roleOf,
  undoImport,
} from './ingest-save';
import { UUID_RE } from './membership';
import { ApiError, onNotesErased } from './notes';

/**
 * Interview ingestion: the HTTP surface. The pipeline itself is in
 * ingest-pipeline.ts (no database), the AI client in nim.ts, and the transcript
 * reading in transcript.ts. Older imports of these names still work from here.
 */
export { createNimChat, ModelError, type ChatModel } from './nim';
export {
  buildIngestWorkflow,
  hashTurns,
  ingestParsed,
  ingestTranscript,
  IngestCancelled,
  MAX_ROUNDS,
  occurredFor,
  parseProposals,
  type ExitReason,
  type IngestDeps,
  type IngestOptions,
  type IngestProgress,
  type IngestResult,
  type MemoryMethod,
  type ProposedMemory,
} from './ingest-pipeline';

/* ── routes ──────────────────────────────────────────────────────────── */

/**
 * The upload page accepts a file of up to 6 MB, and sends it as a string inside a JSON request,
 * where every quote and line break gains a backslash: 12 MB leaves room for the worst real
 * file. The transcript itself is limited separately, in characters, once it is read.
 */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : undefined;

/**
 * A name written into the notes (a file name, a teller's name): one line, in composed
 * form. macOS hands file names over decomposed (NFD): "José.txt" arrived with its accent split
 * from the letter, and was stored that way in every footer, where no search or comparison
 * matched it (e2e review #13).
 */
const label = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.normalize('NFC').replace(/\s+/g, ' ').trim();
  return t === '' ? undefined : t.slice(0, max);
};

/** The request, checked. Returns the clean request, or a message the person can act on. */
function readRequest(body: Record<string, unknown>): IngestRequest | { error: string } {
  if (body.transcript === undefined || body.transcript === null) {
    return { error: 'the transcript is missing' };
  }
  const ids = Array.isArray(body.interviewees)
    ? body.interviewees
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .slice(0, 10)
    : undefined;
  let names: Record<string, string> | undefined;
  if (
    body.speakerNames &&
    typeof body.speakerNames === 'object' &&
    !Array.isArray(body.speakerNames)
  ) {
    names = {};
    for (const [k, v] of Object.entries(body.speakerNames as Record<string, unknown>).slice(
      0,
      20,
    )) {
      const n = label(v, 80);
      if (n) names[k.slice(0, 100)] = n;
    }
  }
  return {
    transcript: body.transcript,
    ...(ids && ids.length > 0 ? { interviewees: ids.map((x) => x.slice(0, 100)) } : {}),
    ...(str(body.interviewee, 100) ? { interviewee: str(body.interviewee, 100) } : {}),
    ...(names ? { speakerNames: names } : {}),
    ...(label(body.source, 200) ? { source: label(body.source, 200) } : {}),
    ...(label(body.teller, 80) ? { teller: label(body.teller, 80) } : {}),
    save: body.save === true,
    confirm: body.confirm === true,
    force: body.force === true,
  };
}

/**
 * The person's edits, checked for SHAPE. Anything not understood is refused, never dropped:
 * a "leave this one out" that was silently ignored would save the memory the person meant
 * to leave out.
 */
function readPatches(raw: unknown): MemoryPatch[] | { error: string } {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: '"memories" must be a list of changes' };
  if (raw.length > 5000) return { error: 'too many changes in one save' };
  const out: MemoryPatch[] = [];
  for (const [i, m] of raw.entries()) {
    const bad = { error: `change ${i + 1} is not understood` };
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return bad;
    const p = m as Record<string, unknown>;
    if (typeof p.index !== 'number' || !Number.isInteger(p.index) || p.index < 0) {
      return { error: `change ${i + 1}: "index" must be the number of a memory (0, 1, 2, …)` };
    }
    if (p.skip !== undefined && typeof p.skip !== 'boolean') return bad;
    for (const k of ['title', 'type', 'body'] as const) {
      if (p[k] !== undefined && typeof p[k] !== 'string') return bad;
    }
    if (p.occurred !== undefined && p.occurred !== null && typeof p.occurred !== 'string') {
      return bad;
    }
    out.push({
      index: p.index,
      ...(p.skip === true ? { skip: true } : {}),
      ...(typeof p.title === 'string' ? { title: p.title } : {}),
      ...(typeof p.type === 'string' ? { type: p.type } : {}),
      ...(typeof p.body === 'string' ? { body: p.body } : {}),
      ...(p.occurred === null || typeof p.occurred === 'string'
        ? { occurred: p.occurred as string | null }
        : {}),
    });
  }
  return out;
}

const statusFor = (f: JobFailure): 400 | 403 | 409 | 413 | 500 | 504 =>
  f.code === 'too_long'
    ? 413
    : f.code === 'cancelled'
      ? 409
      : f.code === 'timeout'
        ? 504
        : f.code === 'forbidden'
          ? 403
          : f.code === 'internal'
            ? 500
            : 400;

const NOT_FOUND = { error: 'not found' } as const;

/** 403 for a member whose role cannot import: never sent to a stranger, who gets 404. */
const roleRefused = (c: Context, message: string) =>
  c.json({ error: message, code: 'forbidden', reason: 'role' }, 403);

export function registerIngestRoutes(app: App, deps: AppDeps): void {
  const jobs = new IngestJobs(deps);
  // a note deleted by hand takes with it what any preview of this archive still quotes of it
  onNotesErased(deps, (archiveId, noteIds) =>
    jobs.forgetNotes(archiveId, noteIds).catch((e: unknown) => {
      // the note is gone either way; what a preview quotes of it goes when the preview does
      console.error(`[ingest] forgetting erased notes failed: ${describeError(e)}`);
    }),
  );

  /**
   * Every id is lower-cased ONCE, here: an upper-case spelling of the same archive must not
   * be a second archive to the busy rule, the job store or the write lock.
   */
  const idOf = (c: Context, name: string): string => (c.req.param(name) ?? '').toLowerCase();

  /** Membership BEFORE anything else: a stranger learns nothing, not even that a job exists. */
  const roleIn = async (archiveId: string, userId: string): Promise<string | null> =>
    UUID_RE.test(archiveId) ? roleOf(deps.pool, archiveId, userId) : null;

  const jobOf = async (c: Context, archiveId: string, userId: string) => {
    const jobId = idOf(c, 'jobId');
    return UUID_RE.test(jobId) ? await jobs.get(jobId, archiveId, userId) : null;
  };

  app.post(
    '/v1/archives/:archiveId/ingest',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'the request is too large', code: 'too_large' }, 413),
    }),
    async (c) => {
      const archiveId = idOf(c, 'archiveId');
      const userId = c.get('userId');
      const role = await roleIn(archiveId, userId);
      if (role === null) return c.json(NOT_FOUND, 404);
      if (!IMPORT_ROLES.includes(role)) {
        return roleRefused(c, 'only an owner, steward or contributor can import interviews');
      }

      const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return c.json({ error: 'the request must be a JSON object', code: 'bad_request' }, 400);
      }
      const req = readRequest(raw);
      if ('error' in req) return c.json({ error: req.error, code: 'empty' }, 400);

      let job;
      try {
        // a request that waits for the outcome runs it here; one that does not may hand it on
        job = await jobs.start(archiveId, userId, req, { wait: raw.async !== true });
      } catch (e) {
        if (e instanceof BusyError) {
          return c.json(
            {
              error: e.message,
              code: 'busy',
              reason: e.why,
              jobId: e.jobId,
              retryAfter: 5,
            },
            429,
            { 'retry-after': '5' },
          );
        }
        throw e;
      }
      if (raw.async === true) return c.json(jobs.view(job), 202);

      const v = jobs.view(await job.done);
      if (v.status === 'failed' || v.status === 'cancelled') {
        const f = v.error!;
        // no longer a member: answered like any stranger
        if (f.code === 'forbidden' && f.reason === 'membership') return c.json(NOT_FOUND, 404);
        return c.json(
          { error: f.message, code: f.code, ...(f.reason ? { reason: f.reason } : {}) },
          statusFor(f),
        );
      }
      if (v.outcome!.status === 'duplicate') {
        return c.json(
          {
            error: 'this interview was already imported',
            code: 'duplicate',
            duplicateOf: v.outcome!.duplicateOf,
            jobId: v.id,
          },
          409,
        );
      }
      return c.json({ ...v.outcome, jobId: v.id });
    },
  );

  /** Following a job also keeps it alive: an open review page polls this. */
  app.get('/v1/archives/:archiveId/ingest/:jobId', async (c) => {
    const archiveId = idOf(c, 'archiveId');
    const userId = c.get('userId');
    if ((await roleIn(archiveId, userId)) === null) return c.json(NOT_FOUND, 404);
    const job = await jobOf(c, archiveId, userId);
    if (!job) return c.json(NOT_FOUND, 404);
    return c.json(jobs.view(job));
  });

  app.post('/v1/archives/:archiveId/ingest/:jobId/cancel', async (c) => {
    const archiveId = idOf(c, 'archiveId');
    const userId = c.get('userId');
    if ((await roleIn(archiveId, userId)) === null) return c.json(NOT_FOUND, 404);
    const job = await jobOf(c, archiveId, userId);
    if (!job) return c.json(NOT_FOUND, 404);
    if ((await jobs.cancel(job)) === 'too_late') {
      return c.json(
        {
          error:
            'it is already being saved and can no longer be stopped; once it is saved it can be undone',
          code: 'too_late',
        },
        409,
      );
    }
    return c.json(jobs.view(job));
  });

  /** Save the preview a finished job is holding, with the person's edits. Atomic. */
  app.post(
    '/v1/archives/:archiveId/ingest/:jobId/save',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'the request is too large', code: 'too_large' }, 413),
    }),
    async (c) => {
      const archiveId = idOf(c, 'archiveId');
      const userId = c.get('userId');
      const role = await roleIn(archiveId, userId);
      if (role === null) return c.json(NOT_FOUND, 404);
      if (!IMPORT_ROLES.includes(role)) {
        return roleRefused(c, 'only an owner, steward or contributor can save an import');
      }
      const job = await jobOf(c, archiveId, userId);
      if (!job) return c.json(NOT_FOUND, 404);

      // no body is "save it as it is"; a body that is not an object is a mistake, not a default
      const raw = (await c.req.json().catch(() => ({}))) as unknown;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return c.json({ error: 'the request must be a JSON object', code: 'bad_request' }, 400);
      }
      const body = raw as { memories?: unknown; force?: unknown };
      const patches = readPatches(body.memories);
      if ('error' in patches) return c.json({ error: patches.error, code: 'bad_request' }, 400);
      try {
        const outcome = await jobs.save(job, patches, body.force === true);
        return c.json({ ...outcome, jobId: job.id });
      } catch (e) {
        if (e instanceof DuplicateImport) {
          return c.json(
            {
              error: 'this interview was already imported',
              code: 'duplicate',
              duplicateOf: e.previous,
            },
            409,
          );
        }
        if (e instanceof ImportNotAllowed) {
          return e.reason === 'role' ? roleRefused(c, e.message) : c.json(NOT_FOUND, 404);
        }
        if (e instanceof SaveError) {
          return c.json(
            {
              error: e.message,
              code: 'cannot_save',
              ...(e.why ? { reason: e.why.reason } : {}),
              ...(e.why?.index !== undefined ? { index: e.why.index } : {}),
            },
            e.status,
          );
        }
        if (e instanceof ApiError)
          return c.json({ error: e.message, code: 'cannot_save' }, e.status);
        console.error(`[ingest] save failed: ${describeError(e)}`);
        return c.json({ error: 'something went wrong; nothing was saved', code: 'internal' }, 500);
      }
    },
  );

  /** The imports of this archive, newest first, so one can be undone after the page is gone. Every member. */
  app.get('/v1/archives/:archiveId/ingest-runs', async (c) => {
    const archiveId = idOf(c, 'archiveId');
    const userId = c.get('userId');
    if ((await roleIn(archiveId, userId)) === null) return c.json(NOT_FOUND, 404);
    try {
      const runs = await listRuns(deps.pool, archiveId);
      return c.json(
        runs.map((x) => ({
          id: x.id,
          createdAt: x.createdAt,
          source: x.source,
          mine: x.createdBy === userId,
          notes: x.notes,
          undone: x.undone,
        })),
      );
    } catch (e) {
      // the framework's own handler would log the raw database error, whose detail can quote values
      console.error(`[ingest] listing imports failed: ${describeError(e)}`);
      return c.json({ error: 'something went wrong', code: 'internal' }, 500);
    }
  });

  /** Take an import back as a unit. Erases the notes it made, except any somebody has worked on since. */
  app.post('/v1/archives/:archiveId/ingest-runs/:runId/undo', async (c) => {
    const archiveId = idOf(c, 'archiveId');
    const runId = idOf(c, 'runId');
    const userId = c.get('userId');
    if ((await roleIn(archiveId, userId)) === null) return c.json(NOT_FOUND, 404);
    if (!UUID_RE.test(runId)) return c.json(NOT_FOUND, 404);
    try {
      const out = await undoImport(deps, archiveId, userId, runId);
      if (!out) return c.json(NOT_FOUND, 404);
      const { erasedIds, ...answer } = out;
      // whatever the job that made it still holds goes with it, and what other jobs quote of it
      await jobs.forgetRun(runId);
      await jobs.forgetNotes(archiveId, erasedIds);
      return c.json(answer);
    } catch (e) {
      if (e instanceof ImportNotAllowed) {
        return e.reason === 'role' ? roleRefused(c, e.message) : c.json(NOT_FOUND, 404);
      }
      if (e instanceof ApiError) return c.json({ error: e.message, code: 'forbidden' }, e.status);
      console.error(`[ingest] undo failed: ${describeError(e)}`);
      return c.json({ error: 'something went wrong; nothing was changed', code: 'internal' }, 500);
    }
  });
}
