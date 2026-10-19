import type { Pool } from 'pg';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pre-retrieval membership check (FR-081): handlers 404 on false — existence of a
 * foreign archive is never disclosed, so this returns a bare boolean, no error detail.
 * Malformed ids short-circuit to false: indistinguishable from a foreign archive.
 */
export async function isMember(pool: Pool, userId: string, archiveId: string): Promise<boolean> {
  if (!UUID_RE.test(archiveId)) return false;
  const r = await pool.query(
    `select 1 from public.memberships where user_id = $1 and archive_id = $2`,
    [userId, archiveId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * FR-100: the roles that add or change memories, or anything derived from them. Viewers (and
 * minor viewers), reviewers, gifters and sponsor admins read. One list for the note routes,
 * imports, photographs, the index rebuild and the assistant's writing tools.
 */
export const WRITE_ROLES: readonly string[] = ['owner', 'steward', 'contributor'];

/**
 * The member's role in the archive, or null for a stranger or a malformed id (the caller answers
 * both with the same 404). Used where a route lets every member in but only some of them write.
 */
export async function memberRole(
  pool: Pool,
  userId: string,
  archiveId: string,
): Promise<string | null> {
  if (!UUID_RE.test(archiveId)) return null;
  const r = await pool.query(
    `select role::text as role from public.memberships where user_id = $1 and archive_id = $2`,
    [userId, archiveId],
  );
  return (r.rows[0] as { role: string } | undefined)?.role ?? null;
}
