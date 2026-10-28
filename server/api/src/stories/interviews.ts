import type { Pool, PoolClient } from 'pg';
import type { App, AppDeps } from '../app';
import { isMember } from '../membership';
import { parseTranscript } from '../transcript';
import { visibleSql } from '../views';
import type { StoryLookup } from './tools';

/**
 * Interviews keep their transcript (PRD 7.1, migration 20261028120000_interviews.sql). A row is
 * written when an import starts in stories mode, so the words are kept even when the stories
 * cannot be written yet; it is marked written when an import of its stories is saved, and
 * deleted when that import is undone.
 */
type Db = Pool | PoolClient;

const NOT_FOUND = { error: 'not found' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the transcript came with, so its stories can be written again the same way. */
export interface InterviewOptions {
  teller?: string;
  interviewee?: string;
  interviewees?: string[];
  speakerNames?: Record<string, string>;
}

/** "Interview, 28 Oct 2026": the name of an interview nobody named. */
export function defaultInterviewName(at: Date = new Date()): string {
  return `Interview, ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
}

/**
 * The waiting interview with these words, or a new one. Bringing the same transcript in again
 * picks up the interview that is still waiting for its stories, rather than keeping it twice.
 */
export async function openInterview(
  db: Db,
  i: {
    archiveId: string;
    userId: string;
    hash: string;
    name: string;
    transcript: string;
    options: InterviewOptions;
  },
): Promise<string> {
  const r = await db.query(
    `insert into public.interviews (archive_id, created_by, name, source_hash, transcript, options)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (archive_id, source_hash) where stories_status = 'pending'
     do update set name = excluded.name, transcript = excluded.transcript, options = excluded.options
     returning id`,
    [i.archiveId, i.userId, i.name.slice(0, 120), i.hash, i.transcript, JSON.stringify(i.options)],
  );
  return (r.rows[0] as { id: string }).id;
}

export async function renameInterview(db: Db, id: string, name: string): Promise<void> {
  await db.query('update public.interviews set name = $2 where id = $1', [id, name.slice(0, 120)]);
}

/** When it was recorded: the time each of its stories says it was told. */
export async function recordedAt(db: Db, id: string): Promise<string | null> {
  const r = await db.query('select recorded_at from public.interviews where id = $1', [id]);
  const at = (r.rows[0] as { recorded_at?: Date } | undefined)?.recorded_at;
  return at ? at.toISOString() : null;
}

/** The interview's stories are saved, by this import. */
export async function markWritten(db: Db, interviewId: string, runId: string): Promise<void> {
  await db.query(`update public.interviews set stories_status = 'written' where id = $1`, [
    interviewId,
  ]);
  await db.query('update public.ingest_runs set interview_id = $1 where id = $2', [
    interviewId,
    runId,
  ]);
}

/** Undo: the import keeps no words, so the interview it wrote goes with it. */
export async function forgetInterviewOf(db: Db, runId: string): Promise<void> {
  await db.query(
    `delete from public.interviews
      where id = (select interview_id from public.ingest_runs where id = $1)`,
    [runId],
  );
}

/** What the AI's tools read of the project: notes the person importing may read. */
export function archiveLookup(deps: AppDeps, archiveId: string, userId: string): StoryLookup {
  return {
    search: async (query) => {
      const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
      const r = await deps.pool.query(
        `select n.id, n.title, n.type::text as type,
                left(regexp_replace(n.body, '\\s+', ' ', 'g'), 200) as snippet
           from public.notes n
          where n.archive_id = $1 and ${visibleSql('n', '$2')}
            and (n.title ilike $3 or n.body ilike $3)
          order by (n.title ilike $3) desc, n.revised desc nulls last
          limit 8`,
        [archiveId, userId, like],
      );
      return r.rows as Array<{ id: string; title: string; type: string; snippet: string }>;
    },
    read: async (key) => {
      const r = await deps.pool.query(
        `select n.id, n.title, n.type::text as type, n.body
           from public.notes n
          where n.archive_id = $1 and ${visibleSql('n', '$2')}
            and (n.id::text = $3 or lower(n.title) = lower($3))
          limit 1`,
        [archiveId, userId, key],
      );
      return (
        (r.rows[0] as { id: string; title: string; type: string; body: string } | undefined) ?? null
      );
    },
  };
}

export function registerInterviewRoutes(app: App, deps: AppDeps): void {
  app.get('/v1/archives/:archiveId/interviews', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const userId = c.get('userId');
    if (!(await isMember(deps.pool, userId, archiveId))) return c.json(NOT_FOUND, 404);
    const r = await deps.pool.query(
      `select i.id, i.name, i.recorded_at as "recordedAt", i.stories_status as status,
              i.created_by = $2 as mine,
              coalesce((select r.note_count from public.ingest_runs r
                         where r.interview_id = i.id and r.undone_at is null
                         order by r.created_at desc limit 1), 0)::int as stories
         from public.interviews i
        where i.archive_id = $1
        order by i.created_at desc
        limit 200`,
      [archiveId, userId],
    );
    return c.json(r.rows);
  });

  app.get('/v1/archives/:archiveId/interviews/:interviewId', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const id = (c.req.param('interviewId') ?? '').toLowerCase();
    const userId = c.get('userId');
    if (!UUID_RE.test(id) || !(await isMember(deps.pool, userId, archiveId))) {
      return c.json(NOT_FOUND, 404);
    }
    const r = await deps.pool.query(
      `select i.id, i.name, i.recorded_at as "recordedAt", i.stories_status as status,
              i.created_by = $3 as mine, i.transcript, i.options
         from public.interviews i
        where i.id = $1 and i.archive_id = $2`,
      [id, archiveId, userId],
    );
    const row = r.rows[0] as { transcript: string } | undefined;
    if (!row) return c.json(NOT_FOUND, 404);
    let turns: Array<{ speaker: string; start: number | null; text: string }> = [];
    try {
      turns = parseTranscript(row.transcript).turns.map((t) => ({
        speaker: t.speaker,
        start: t.start,
        text: t.text,
      }));
    } catch {
      /* kept as it arrived: the transcript itself is still there */
    }
    return c.json({ ...row, turns });
  });
}
