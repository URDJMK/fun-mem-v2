import type { Pool } from 'pg';
import { EmbeddingContentError, EmbeddingWorkerError } from './embeddings-real';
import type { EmbeddingProvider } from '@funmem/core';

/**
 * Embedding drain (FM-022). The pending set IS the queue: a chunk with no
 * chunk_embeddings row for (note_id, content_hash, current model_version) is
 * pending — recomputed from the tables, never stored as job state, so a crash
 * or restart loses nothing. Embedding NEVER runs inside the save transaction
 * or its archive advisory lock (a real model there would serialize every save
 * in the archive behind inference).
 */

const BATCH = 32;

/** pgvector text literal: '[x1,x2,...]'. */
function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

interface PendingRow {
  archive_id: string;
  note_id: string;
  content_hash: string;
  content: string;
}

/** Attempts before a chunk is parked. Cleared for free when content or model changes. */
const MAX_ATTEMPTS = 8;

/**
 * Embed a page, isolating chunks the provider refuses.
 *
 * Deliberately NOT exported: a test that could call this directly would not
 * exercise drainOnce's guard, which is exactly how FM-035's test seam hid the
 * defect it was built to catch.
 *
 * Only a SINGLE-ITEM content failure attributes blame — a rejected batch says
 * nothing about which member is bad. A worker-liveness failure aborts the pass
 * with no bookkeeping: counting ~90 minutes of downtime toward MAX_ATTEMPTS
 * would park the entire backlog.
 */
async function embedIsolating(
  pool: Pool,
  provider: EmbeddingProvider,
  rows: PendingRow[],
): Promise<{ vectors: number[][]; rows: PendingRow[] }> {
  if (rows.length === 0) return { vectors: [], rows: [] };
  try {
    const vectors = await provider.embed(rows.map((r) => r.content));
    // A short reply must never be zipped by index — it would key a vector to the
    // wrong chunk, which is worse than writing nothing. Raised as a WORKER fault,
    // not a content one, so it aborts the pass instead of bisecting: bisection
    // would split down to size 1, where a miscounting provider is accidentally
    // correct, and the batch would write after all. A provider that cannot count
    // is broken; the content is innocent and must not be blamed.
    if (vectors.length !== rows.length) {
      throw new EmbeddingWorkerError(
        `provider returned ${vectors.length} vectors for ${rows.length} texts`,
      );
    }
    return { vectors, rows };
  } catch (e) {
    if (!(e instanceof EmbeddingContentError)) throw e; // worker fault: abort the pass
    if (rows.length === 1) {
      await recordFailure(pool, rows[0]!, provider.modelVersion, e.message);
      return { vectors: [], rows: [] };
    }
    const mid = Math.floor(rows.length / 2);
    const left = await embedIsolating(pool, provider, rows.slice(0, mid));
    const right = await embedIsolating(pool, provider, rows.slice(mid));
    return {
      vectors: [...left.vectors, ...right.vectors],
      rows: [...left.rows, ...right.rows],
    };
  }
}

/**
 * The note (or archive) a row belongs to was erased while the pass worked on it: the chunk was
 * there when its batch was read, and its note was gone by the time the row was written. An undo
 * running beside the pass made EVERY such pass fail on this, and the rest of the backlog waited
 * a tick (round-3 review D8). Nothing is owed to a note that no longer exists: skip the row.
 */
const vanished = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23503';

/** reason_code only — a provider message can echo note text. */
async function recordFailure(
  pool: Pool,
  row: PendingRow,
  modelVersion: string,
  message: string,
): Promise<void> {
  // only a single-item content refusal reaches here; the length-mismatch path
  // raises a worker fault and never records blame
  void message; // deliberately unused: a provider string can echo note text
  const reason = 'content';
  try {
    await pool.query(
      `insert into public.chunk_embedding_failures
         (archive_id, note_id, content_hash, model_version, fail_count, last_tried, reason_code)
       values ($1, $2, $3, $4, 1, now(), $5)
       on conflict (note_id, content_hash, model_version)
       do update set fail_count = public.chunk_embedding_failures.fail_count + 1,
                     last_tried = now(),
                     reason_code = excluded.reason_code`,
      [row.archive_id, row.note_id, row.content_hash, modelVersion, reason],
    );
  } catch (e) {
    if (!vanished(e)) throw e; // the note was erased meanwhile: nothing to record
  }
}

/**
 * Drain the whole pending set (optionally archive-scoped) in batches; returns
 * the number of embeddings written. Lock-free by design: rows are inserted
 * with ON CONFLICT DO NOTHING, and a chunk deleted mid-flight leaves a
 * harmless orphan row that no query ever surfaces (search joins chunks) and
 * the next save of that note removes. Tests call this directly — the interval
 * loop below calls the same function, never a divergent test-mode path.
 */
export async function drainOnce(
  pool: Pool,
  provider: EmbeddingProvider,
  archiveId?: string,
  signal?: AbortSignal,
): Promise<number> {
  let written = 0;
  // bounded loop: each pass embeds up to BATCH distinct pending texts; a pass
  // that writes nothing new ends the drain even if pending rows raced back in
  for (;;) {
    // A stop (the server shutting down) ends the drain BETWEEN batches: the batch in hand
    // finishes, the rest of the backlog waits for the next start. Without this a SIGTERM
    // waited for the whole backlog: 26 s for 4,600 chunks, minutes with the real model
    // (round-3 review D3).
    if (signal?.aborted) return written;
    // FM-046: the fail_count priority CANNOT be prepended to this ORDER BY —
    // Postgres requires DISTINCT ON expressions to match the initial ORDER BY
    // terms — and appending it is a verified no-op. So the distinct-on runs in a
    // subquery and the priority ordering wraps it.
    //
    // The `f.note_id is null` arm is load-bearing: the LEFT JOIN yields NULL for
    // every chunk that has never failed, and a predicate written only over
    // f.fail_count / f.last_tried evaluates NULL and filters those rows out
    // permanently — dropping the whole healthy backlog, not deferring one chunk.
    const pending = await pool.query<PendingRow>(
      `select archive_id, note_id, content_hash, content
         from (
           select distinct on (c.note_id, c.content_hash)
                  c.archive_id, c.note_id, c.content_hash, c.content,
                  coalesce(f.fail_count, 0) as fail_count
             from public.chunks c
             left join public.chunk_embeddings e
               on e.note_id = c.note_id
              and e.content_hash = c.content_hash
              and e.model_version = $1
             left join public.chunk_embedding_failures f
               on f.note_id = c.note_id
              and f.content_hash = c.content_hash
              and f.model_version = $1
            where e.id is null
              and ($2::uuid is null or c.archive_id = $2)
              and (
                f.note_id is null
                or (
                  f.fail_count < ${MAX_ATTEMPTS}
                  and f.last_tried < now() - make_interval(
                    secs => least(30 * power(2, f.fail_count - 1), 1800)::double precision)
                )
              )
            order by c.note_id, c.content_hash
         ) q
        order by q.fail_count asc, q.note_id, q.content_hash
        limit ${BATCH}`,
      [provider.modelVersion, archiveId ?? null],
    );
    if (pending.rows.length === 0) return written;
    // FM-046: embed() answers per BATCH, so one unembeddable chunk used to fail
    // all 32 of its co-batch and propagate out of drainOnce. Bisect instead, so
    // healthy chunks land in the SAME call — no backoff scheme can do that,
    // because backoff only helps on a later tick.
    const { vectors, rows } = await embedIsolating(pool, provider, pending.rows);
    let wrote = 0;
    let rowError: unknown = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      try {
        // INSERT…SELECT re-validates the chunk still exists at insert time:
        // a note deleted or edited mid-embed contributes no row, so the
        // save-txn's erasure-hygiene delete cannot be raced back in (the
        // window shrinks from the whole embed() to one statement snapshot)
        const res = await pool.query(
          `insert into public.chunk_embeddings
             (archive_id, note_id, content_hash, model_version, embedding)
           select c.archive_id, c.note_id, c.content_hash, $3, $4::extensions.vector
             from public.chunks c
            where c.note_id = $1 and c.content_hash = $2
            limit 1
           on conflict (note_id, content_hash, model_version) do nothing`,
          [r.note_id, r.content_hash, provider.modelVersion, vectorLiteral(vectors[i]!)],
        );
        wrote += res.rowCount ?? 0;
        // DoD 5: a chunk that finally embeds is no longer parked. Without this
        // the row survives as inert bookkeeping and FM-048's steward surface
        // would report an embedded chunk as still failing.
        if ((res.rowCount ?? 0) > 0) {
          await pool.query(
            `delete from public.chunk_embedding_failures
              where note_id = $1 and content_hash = $2 and model_version = $3`,
            [r.note_id, r.content_hash, provider.modelVersion],
          );
        }
      } catch (e) {
        // a note erased meanwhile is skipped; anything else is kept to surface at pass end
        if (!vanished(e)) rowError = e; // keep the batch's other embeddings
      }
    }
    // bound the edit-race orphan window: content whose hash left chunks while
    // we were embedding loses its (invertible) vector before this pass ends
    const touched = [...new Set(pending.rows.map((r) => r.note_id))];
    await pool.query(
      `delete from public.chunk_embeddings e
        where e.note_id = any($1::uuid[])
          and not exists (select 1 from public.chunks c
                           where c.note_id = e.note_id and c.content_hash = e.content_hash)`,
      [touched],
    );
    // DoD 5: the same sweep for parked chunks. An edit rotates content_hash, so
    // the old failure row can never match the join again — leaving it would let
    // dead rows accumulate forever and make the steward surface lie.
    await pool.query(
      `delete from public.chunk_embedding_failures f
        where f.note_id = any($1::uuid[])
          and not exists (select 1 from public.chunks c
                           where c.note_id = f.note_id and c.content_hash = f.content_hash)`,
      [touched],
    );
    if (rowError !== null) throw rowError;
    written += wrote;
    // wrote===0 is terminal only when the SELECT saw the whole pending set; a
    // full all-conflict batch means another drainer wrote those keys — re-scan
    if (wrote === 0 && pending.rows.length < BATCH) return written;
  }
}

/**
 * Server-runtime loop: drain on an interval. A LISTEN/NOTIFY latency hint was
 * considered and deliberately omitted — NOTIFY is not durable, so the poll is
 * the guarantee either way; the interval IS the design. Returns a stop
 * function. The running server calls this once at boot when a provider is
 * available; tests never need it (they call drainOnce).
 */
export function startEmbeddingLoop(
  pool: Pool,
  provider: EmbeddingProvider,
  intervalMs = 15_000,
  /** tests only: drain one archive instead of all of them */
  archiveId?: string,
): () => Promise<void> {
  let current: Promise<void> | null = null;
  let consecutiveFailures = 0;
  const stopping = new AbortController();
  const kick = () => {
    if (current || stopping.signal.aborted) return;
    current = drainOnce(pool, provider, archiveId, stopping.signal)
      .then(() => {
        consecutiveFailures = 0;
      })
      .catch((e: unknown) => {
        // stopped: the pool may be closing under the batch that was in hand, and an error
        // then is the shutdown itself, not a fault worth a log line
        if (stopping.signal.aborted) return;
        // a failed pass retries next tick; log the first failure of a streak
        // so a permanent fault (bad column, dead worker) is not silent forever
        consecutiveFailures += 1;
        if (consecutiveFailures === 1) console.error('embedding drain failed:', e);
      })
      .finally(() => {
        current = null;
      });
  };
  const timer = setInterval(kick, intervalMs);
  timer.unref?.();
  kick();
  // Stopping clears the timer, tells the running pass to end after the batch in hand, and waits
  // for that: a pass spends most of its time computing vectors with NO connection checked out,
  // so "no connection in use" does not mean "no pass running", and closing the pool under it
  // logged "Cannot use a pool after calling end" on a SIGTERM (round 2). The caller bounds the
  // wait (main.ts), since one batch of the real model can take seconds.
  return async () => {
    clearInterval(timer);
    stopping.abort();
    await current;
  };
}
