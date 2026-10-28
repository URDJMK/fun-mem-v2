import { matchKey } from '@funmem/core';
import type { PoolClient } from 'pg';
import { addAliases } from './note-entity';
import { rebuildDescriptions } from './save';
import { ENTITY_TYPES, type EntityType } from './types';

/**
 * Changing the graph by hand (graph design 5.4). Each change is one transaction and one
 * `graph_changes` row: who changed what, and when. An import's undo spares an entity someone has
 * changed. Callers check membership, role and visibility first.
 */
export class EditRefused extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code: string,
    readonly entityId?: string,
  ) {
    super(message);
  }
}

interface Row {
  id: string;
  archive_id: string;
  name: string;
  type: EntityType;
  match_key: string;
  note_id: string | null;
  subject: boolean;
}

async function lockEntity(client: PoolClient, archiveId: string, id: string): Promise<Row> {
  const r = await client.query(
    `select e.id, e.archive_id, e.name, e.type::text as type, e.match_key, e.note_id,
            coalesce(e.note_id = a.subject_note_id, false) as subject
       from public.graph_entities e join public.archives a on a.id = e.archive_id
      where e.id = $1 and e.archive_id = $2
      for update of e`,
    [id, archiveId],
  );
  const row = r.rows[0] as Row | undefined;
  if (!row) throw new EditRefused('not found', 404, 'not_found');
  return row;
}

async function record(
  client: PoolClient,
  e: { archive_id: string; id: string },
  userId: string,
  kind: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await client.query(
    `insert into public.graph_changes (archive_id, entity_id, kind, before, after, created_by)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [e.archive_id, e.id, kind, JSON.stringify(before), JSON.stringify(after), userId],
  );
}

/** the entity (other than `self`) a name already belongs to, by name or alias */
async function owner(
  client: PoolClient,
  archiveId: string,
  type: EntityType,
  key: string,
  self: string,
): Promise<string | null> {
  const r = await client.query(
    `select id from public.graph_entities
      where archive_id = $1 and type = $2 and match_key = $3 and id <> $4
     union all
     select entity_id from public.graph_aliases
      where archive_id = $1 and match_key = $3 and entity_id <> $4
     limit 1`,
    [archiveId, type, key, self],
  );
  return (r.rows[0] as { id: string } | undefined)?.id ?? null;
}

/** A new name (the old one kept as an alias), or a new type. A name someone else has: merge instead. */
export async function changeEntity(
  client: PoolClient,
  archiveId: string,
  userId: string,
  id: string,
  change: { name?: unknown; type?: unknown },
): Promise<void> {
  const e = await lockEntity(client, archiveId, id);
  if (change.name !== undefined) {
    const name = typeof change.name === 'string' ? change.name.replace(/\s+/g, ' ').trim() : '';
    const key = matchKey(name);
    if (!name || !key || name.length > 200)
      throw new EditRefused('give a name of up to 200 characters', 400, 'bad_request');
    if (name !== e.name) {
      const other = await owner(client, archiveId, e.type, key, e.id);
      if (other) {
        throw new EditRefused(
          'another entity has that name: merge them instead',
          409,
          'taken',
          other,
        );
      }
      // its own alias becoming its name is no longer an alias
      await client.query(
        `delete from public.graph_aliases where entity_id = $1 and match_key = $2`,
        [e.id, key],
      );
      await client.query(
        `update public.graph_entities set name = $2, match_key = $3, updated_at = now() where id = $1`,
        [e.id, name, key],
      );
      if (matchKey(e.name) !== key) await addAliases(client, archiveId, e.id, [e.name]);
      await record(client, e, userId, 'rename', { name: e.name }, { name });
    }
  }
  if (change.type !== undefined) {
    const type = ENTITY_TYPES.find((t) => t === change.type);
    if (!type) throw new EditRefused('the type is person, place or thing', 400, 'bad_request');
    if (type !== e.type) {
      const current = await lockEntity(client, archiveId, id);
      const other = await owner(client, archiveId, type, current.match_key, e.id);
      if (other) {
        throw new EditRefused(
          `a ${type} has that name already: merge them instead`,
          409,
          'taken',
          other,
        );
      }
      await client.query(
        `update public.graph_entities set type = $2, updated_at = now() where id = $1`,
        [e.id, type],
      );
      await record(client, e, userId, 'type', { type: e.type }, { type });
    }
  }
}

/**
 * Merge `fromId` into `keepId`: its mentions (a story naming both keeps one, the words joined),
 * relationships (one between the two goes, a pair told twice by a story keeps one), names and,
 * when the kept one has none, its note. Then it is removed. The protagonist is never merged away.
 */
export async function mergeEntities(
  client: PoolClient,
  archiveId: string,
  userId: string,
  keepId: string,
  fromId: string,
): Promise<void> {
  if (keepId === fromId) throw new EditRefused('pick another entity to merge', 400, 'bad_request');
  // locked in id order, as every writer here locks
  const [first, second] = [keepId, fromId].sort();
  const a = await lockEntity(client, archiveId, first!);
  const b = await lockEntity(client, archiveId, second!);
  const keep = a.id === keepId ? a : b;
  const from = a.id === keepId ? b : a;
  if (from.subject) {
    throw new EditRefused(
      'the person the project is about cannot be merged away; merge the other into them',
      409,
      'subject',
    );
  }
  // mentions: a story naming both keeps the kept one's, with both sets of words
  await client.query(
    `update public.graph_mentions k
        set words = k.words || array(select w from unnest(f.words) w where not (w = any(k.words)))
       from public.graph_mentions f
      where k.entity_id = $1 and f.entity_id = $2 and k.note_id = f.note_id`,
    [keep.id, from.id],
  );
  await client.query(
    `delete from public.graph_mentions f
      where f.entity_id = $2
        and exists (select 1 from public.graph_mentions k where k.entity_id = $1 and k.note_id = f.note_id)`,
    [keep.id, from.id],
  );
  await client.query(`update public.graph_mentions set entity_id = $1 where entity_id = $2`, [
    keep.id,
    from.id,
  ]);
  // relationships: none between the two; none twice for a pair in a story
  await client.query(
    `delete from public.graph_relationships
      where (a_id = $1 and b_id = $2) or (a_id = $2 and b_id = $1)`,
    [keep.id, from.id],
  );
  await client.query(
    `delete from public.graph_relationships f
      where (f.a_id = $2 or f.b_id = $2)
        and exists (
          select 1 from public.graph_relationships k
           where k.note_id = f.note_id
             and ((k.a_id = $1 and k.b_id = case when f.a_id = $2 then f.b_id else f.a_id end)
               or (k.b_id = $1 and k.a_id = case when f.a_id = $2 then f.b_id else f.a_id end)))`,
    [keep.id, from.id],
  );
  await client.query(`update public.graph_relationships set a_id = $1 where a_id = $2`, [
    keep.id,
    from.id,
  ]);
  await client.query(`update public.graph_relationships set b_id = $1 where b_id = $2`, [
    keep.id,
    from.id,
  ]);
  // names: its aliases, and its name
  const names = (
    await client.query(`select alias from public.graph_aliases where entity_id = $1`, [from.id])
  ).rows.map((r: { alias: string }) => r.alias);
  await client.query(`delete from public.graph_aliases where entity_id = $1`, [from.id]);
  const note = from.note_id;
  await client.query(`delete from public.graph_entities where id = $1`, [from.id]);
  await addAliases(client, archiveId, keep.id, [from.name, ...names]);
  if (note && !keep.note_id) {
    await client.query(
      `update public.graph_entities set note_id = $2, updated_at = now() where id = $1`,
      [keep.id, note],
    );
  }
  await record(client, keep, userId, 'merge', { from: { id: from.id, name: from.name } }, {});
  await rebuildDescriptions(client, archiveId, [keep.id]);
}

/** An entity removed, with its mentions, relationships and names. Stories and notes stay. */
export async function removeEntity(
  client: PoolClient,
  archiveId: string,
  userId: string,
  id: string,
): Promise<void> {
  const e = await lockEntity(client, archiveId, id);
  if (e.subject) {
    throw new EditRefused('the person the project is about cannot be removed', 409, 'subject');
  }
  await client.query(`delete from public.graph_entities where id = $1`, [e.id]);
  await record(client, e, userId, 'remove', { name: e.name, type: e.type }, {});
}

/** One relationship removed. */
export async function removeRelationship(
  client: PoolClient,
  archiveId: string,
  userId: string,
  id: string,
): Promise<void> {
  const r = await client.query(
    `delete from public.graph_relationships where id = $1 and archive_id = $2
     returning a_id, b_id, description`,
    [id, archiveId],
  );
  const row = r.rows[0] as { a_id: string; b_id: string; description: string } | undefined;
  if (!row) throw new EditRefused('not found', 404, 'not_found');
  await record(
    client,
    { archive_id: archiveId, id: row.a_id },
    userId,
    'remove-relationship',
    { a: row.a_id, b: row.b_id, description: row.description },
    {},
  );
}
