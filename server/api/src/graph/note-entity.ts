import { matchKey } from '@funmem/core';
import type { Pool, PoolClient } from 'pg';
import { ENTITY_OF_NOTE } from './types';

type Db = Pool | PoolClient;

/**
 * A person, place or object note is about an entity (graph design 3.5): made with it, or the
 * entity of the same name adopts it when it has no note yet. A second note whose name has the
 * same key ("Mrs Han" after "Mrs. Han") stays a note on its own: nothing here may fail a save.
 */
export async function entityForNote(
  db: Db,
  note: { id: string; archiveId: string; title: string; type: string; createdBy: string },
): Promise<void> {
  const type = ENTITY_OF_NOTE[note.type];
  const key = matchKey(note.title);
  if (!type || !key) return;
  await db.query(
    `insert into public.graph_entities (archive_id, type, name, match_key, note_id, created_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (archive_id, type, match_key) do update
        set note_id = coalesce(public.graph_entities.note_id, excluded.note_id),
            updated_at = now()
      where public.graph_entities.note_id is null`,
    [note.archiveId, type, note.title.slice(0, 200), key, note.id, note.createdBy],
  );
}

/**
 * Other names for an entity. A name that is the entity's own, another entity's name, or
 * already someone's alias is skipped: one name means one entity.
 */
export async function addAliases(
  db: Db,
  archiveId: string,
  entityId: string,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    const alias = name.replace(/\s+/g, ' ').trim().slice(0, 200);
    const key = matchKey(alias);
    if (!key) continue;
    await db.query(
      `insert into public.graph_aliases (archive_id, entity_id, alias, match_key)
       select $1, $2, $3, $4
        where not exists (select 1 from public.graph_entities e
                           where e.archive_id = $1 and e.match_key = $4)
       on conflict (archive_id, match_key) do nothing`,
      [archiveId, entityId, alias, key],
    );
  }
}

/**
 * The names a profile gives (Settings) are its entity's aliases: those taken off the profile
 * are taken off the entity, those added are added.
 */
export async function syncProfileAliases(
  db: Db,
  noteId: string,
  before: readonly string[],
  after: readonly string[],
): Promise<void> {
  const e = await db.query(`select id, archive_id from public.graph_entities where note_id = $1`, [
    noteId,
  ]);
  const entity = e.rows[0] as { id: string; archive_id: string } | undefined;
  if (!entity) return;
  const kept = new Set(after.map(matchKey));
  const gone = before.map(matchKey).filter((k) => k && !kept.has(k));
  if (gone.length) {
    await db.query(
      `delete from public.graph_aliases where entity_id = $1 and match_key = any($2::text[])`,
      [entity.id, gone],
    );
  }
  await addAliases(db, entity.archive_id, entity.id, after);
}
