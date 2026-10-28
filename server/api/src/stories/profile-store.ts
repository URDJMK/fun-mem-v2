import type { Pool, PoolClient } from 'pg';
import type { App, AppDeps } from '../app';
import { memberRole, UUID_RE, WRITE_ROLES } from '../membership';
import { createNotesBatch } from '../notes';
import { visibleSql } from '../views';
import { parseProfileInput, readProfile, type Profile, type ProfileFields } from './profile';

/**
 * Where profiles live (PRD 7.5): on person notes, in `extra.profile`. A personal project points
 * at its protagonist's note (`archives.subject_note_id`), made with the project or, for a project
 * made before profiles existed, the first time its profile is saved.
 */
type Db = Pool | PoolClient;

const NOT_FOUND = { error: 'not found' };
const EMPTY: ProfileFields = { born: null, died: null, aliases: [] };

async function setProfile(db: Db, noteId: string, fields: ProfileFields): Promise<void> {
  await db.query(
    `update public.notes
        set extra = jsonb_set(coalesce(extra, '{}'::jsonb), '{profile}', $2::jsonb, true)
      where id = $1`,
    [noteId, JSON.stringify(fields)],
  );
}

/**
 * The protagonist's person note, made if it is missing: a personal project's only. A person note
 * with their name already there (written by hand) is adopted rather than doubled.
 */
export async function ensureSubjectNote(
  deps: AppDeps,
  archiveId: string,
  userId: string,
): Promise<string | null> {
  const a = await deps.pool.query(
    `select subject_name, kind::text as kind, subject_note_id from public.archives where id = $1`,
    [archiveId],
  );
  const row = a.rows[0] as
    { subject_name: string; kind: string; subject_note_id: string | null } | undefined;
  if (!row || row.kind !== 'personal') return null;
  if (row.subject_note_id) return row.subject_note_id;
  const same = await deps.pool.query(
    `select id from public.notes
      where archive_id = $1 and type = 'person'
        and normalize(lower(btrim(title)), NFC) = normalize(lower(btrim($2)), NFC)
      limit 1`,
    [archiveId, row.subject_name],
  );
  let id = (same.rows[0] as { id: string } | undefined)?.id;
  if (!id) {
    const made = await createNotesBatch(
      deps,
      archiveId,
      userId,
      [{ title: row.subject_name, type: 'person', body: '', extra: { profile: EMPTY } }],
      'create',
    );
    id = made.notes[0]!.id;
  }
  // two at once: the first to set it wins, and both answer with that one
  const set = await deps.pool.query(
    `update public.archives set subject_note_id = coalesce(subject_note_id, $2)
      where id = $1 returning subject_note_id`,
    [archiveId, id],
  );
  return (set.rows[0] as { subject_note_id: string }).subject_note_id;
}

/** A personal project's profile is entered with it; a bad one refuses the project (checked first). */
export async function setSubjectProfile(
  deps: AppDeps,
  archiveId: string,
  userId: string,
  fields: ProfileFields,
): Promise<string | null> {
  const id = await ensureSubjectNote(deps, archiveId, userId);
  if (id) await setProfile(deps.pool, id, fields);
  return id;
}

const toProfile = (r: { id: string; title: string; profile: unknown }): Profile => ({
  noteId: r.id,
  name: r.title,
  ...readProfile(r.profile ?? {}),
});

/**
 * The profiles an interview's stories are written with (D14): the protagonist's, and those of the
 * person notes named like its tellers (by title or by a name the family uses). A personal project
 * with no profile saved yet still says who it is about, by the project's subject name.
 */
export async function profilesFor(
  db: Db,
  archiveId: string,
  userId: string,
  tellers: readonly string[],
): Promise<Profile[]> {
  const names = [...new Set(tellers.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const r = await db.query(
    `select n.id, n.title, n.extra->'profile' as profile,
            n.id = a.subject_note_id as subject
       from public.notes n join public.archives a on a.id = n.archive_id
      where n.archive_id = $1 and n.type = 'person' and ${visibleSql('n', '$2')}
        and (n.id = a.subject_note_id
             or lower(btrim(n.title)) = any($3::text[])
             or exists (select 1 from jsonb_array_elements_text(
                          case when jsonb_typeof(n.extra->'profile'->'aliases') = 'array'
                               then n.extra->'profile'->'aliases' else '[]'::jsonb end) x
                         where lower(btrim(x)) = any($3::text[])))
      order by (n.id = a.subject_note_id) desc, n.title
      limit 8`,
    [archiveId, userId, names],
  );
  const found = (r.rows as Array<{ id: string; title: string; profile: unknown }>).map(toProfile);
  const a = await db.query(
    `select subject_name from public.archives
      where id = $1 and kind = 'personal' and subject_note_id is null`,
    [archiveId],
  );
  const subject = (a.rows[0] as { subject_name: string } | undefined)?.subject_name;
  const known = (n: string) =>
    found.some((p) => p.name.trim().toLowerCase() === n.trim().toLowerCase());
  return subject && !known(subject) ? [{ noteId: null, name: subject, ...EMPTY }, ...found] : found;
}

export function registerProfileRoutes(app: App, deps: AppDeps): void {
  /** a personal project's protagonist; a family project has none (404) */
  app.get('/v1/archives/:archiveId/profile', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    if ((await memberRole(deps.pool, c.get('userId'), archiveId)) === null) {
      return c.json(NOT_FOUND, 404);
    }
    const r = await deps.pool.query(
      `select a.subject_name, a.kind::text as kind, n.id, n.title, n.extra->'profile' as profile
         from public.archives a left join public.notes n on n.id = a.subject_note_id
        where a.id = $1`,
      [archiveId],
    );
    const row = r.rows[0] as
      | {
          subject_name: string;
          kind: string;
          id: string | null;
          title: string | null;
          profile: unknown;
        }
      | undefined;
    if (!row || row.kind !== 'personal') return c.json(NOT_FOUND, 404);
    if (!row.id) return c.json({ noteId: null, name: row.subject_name, ...EMPTY });
    return c.json(toProfile({ id: row.id, title: row.title!, profile: row.profile }));
  });

  app.put('/v1/archives/:archiveId/profile', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const userId = c.get('userId');
    const role = await memberRole(deps.pool, userId, archiveId);
    if (role === null) return c.json(NOT_FOUND, 404);
    if (!WRITE_ROLES.includes(role)) {
      return c.json(
        { error: 'only people who can add memories can change this', code: 'forbidden' },
        403,
      );
    }
    const fields = parseProfileInput(await c.req.json().catch(() => null));
    if (typeof fields === 'string') return c.json({ error: fields, code: 'bad_request' }, 400);
    const id = await setSubjectProfile(deps, archiveId, userId, fields);
    if (!id) return c.json(NOT_FOUND, 404);
    const r = await deps.pool.query(
      `select id, title, extra->'profile' as profile from public.notes where id = $1`,
      [id],
    );
    return c.json(toProfile(r.rows[0] as { id: string; title: string; profile: unknown }));
  });

  /** a family narrator's (or anyone's) profile, on their own person note */
  app.put('/v1/archives/:archiveId/people/:noteId/profile', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const noteId = (c.req.param('noteId') ?? '').toLowerCase();
    const userId = c.get('userId');
    const role = await memberRole(deps.pool, userId, archiveId);
    if (role === null || !UUID_RE.test(noteId)) return c.json(NOT_FOUND, 404);
    if (!WRITE_ROLES.includes(role)) {
      return c.json(
        { error: 'only people who can add memories can change this', code: 'forbidden' },
        403,
      );
    }
    const fields = parseProfileInput(await c.req.json().catch(() => null));
    if (typeof fields === 'string') return c.json({ error: fields, code: 'bad_request' }, 400);
    const r = await deps.pool.query(
      `select n.id, n.title from public.notes n
        where n.id = $1 and n.archive_id = $2 and n.type = 'person' and ${visibleSql('n', '$3')}`,
      [noteId, archiveId, userId],
    );
    const note = r.rows[0] as { id: string; title: string } | undefined;
    if (!note) return c.json(NOT_FOUND, 404);
    await setProfile(deps.pool, note.id, fields);
    return c.json({ noteId: note.id, name: note.title, ...fields });
  });
}
