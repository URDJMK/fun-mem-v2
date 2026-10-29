import { extractWikilinks, matchKey } from '@funmem/core';
import type { Pool, PoolClient } from 'pg';
import type { AppDeps } from '../app';
import { inTransaction } from '../notes';
import { ensureSubjectNote } from '../stories/profile-store';
import { readProfile } from '../stories/profile';
import { visibleSql } from '../views';
import { addAliases, entityForNote } from './note-entity';
import type { EntityType, NoteRef } from './types';

type Db = Pool | PoolClient;

/**
 * The graph's rows as a member may see them, and how a project's graph comes to exist
 * (graph design 3.3, 3.5).
 */

/**
 * Is entity <alias> visible to $<userParam>? When it is the protagonist's, when its note is
 * visible, or when a story that mentions it or tells one of its relationships is: an entity
 * known only from a private story is seen by that story's author alone.
 */
export function entityVisibleSql(alias: string, userParam: string): string {
  return `(
    exists (select 1 from public.archives va
             where va.id = ${alias}.archive_id and va.subject_note_id = ${alias}.note_id)
    or exists (select 1 from public.notes vn
                where vn.id = ${alias}.note_id and ${visibleSql('vn', userParam)})
    or exists (select 1 from public.graph_mentions vm join public.notes vs on vs.id = vm.note_id
                where vm.entity_id = ${alias}.id and ${visibleSql('vs', userParam)})
    or exists (select 1 from public.graph_relationships vr join public.notes vr_n on vr_n.id = vr.note_id
                where (vr.a_id = ${alias}.id or vr.b_id = ${alias}.id) and ${visibleSql('vr_n', userParam)})
  )`;
}

/**
 * The note of entity <alias> as a {noteId, title} column, or null when it has none or $<userParam>
 * may not see it.
 */
export function entityNoteSql(alias: string, userParam: string): string {
  return `(select json_build_object('noteId', n.id, 'title', n.title) from public.notes n
            where n.id = ${alias}.note_id and ${visibleSql('n', userParam)})`;
}

/** A story's words, its [[links]] read as the words they show: "[[Walter|Dad]]" is "Dad". */
export const plainWords = (text: string): string =>
  text.replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, target: string, shown?: string) =>
    (shown ?? target).trim(),
  );

/** the sentence of `body` holding the character at `at`, its links read as words */
function sentenceAt(body: string, at: number): string {
  const lineStart = body.lastIndexOf('\n', Math.max(0, at - 1)) + 1;
  const lineEnd = body.indexOf('\n', at);
  const line = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd);
  const offset = at - lineStart;
  let from = 0;
  for (const m of line.matchAll(/[.!?]["”’)]?\s+/g)) {
    const end = m.index + m[0].length;
    if (end > offset) {
      return plainWords(line.slice(from, end)).replace(/^>\s*/, '').trim().slice(0, 300);
    }
    from = end;
  }
  return plainWords(line.slice(from)).replace(/^>\s*/, '').trim().slice(0, 300);
}

async function ownerOf(db: Db, archiveId: string): Promise<string | null> {
  const r = await db.query(
    `select user_id from public.memberships where archive_id = $1 and role = 'owner'
      order by created_at limit 1`,
    [archiveId],
  );
  return (r.rows[0] as { user_id: string } | undefined)?.user_id ?? null;
}

/**
 * Make sure a project's graph exists: the protagonist's note and entity (made as the project's
 * owner), and, once, its person, place and object notes as entities, the [[links]] its stories
 * make to them as mentions, and the names in their profiles as aliases. Nothing is edited.
 */
export async function ensureGraph(deps: AppDeps, archiveId: string): Promise<void> {
  const r = await deps.pool.query(
    `select kind::text as kind, subject_note_id, graph_backfilled_at
       from public.archives where id = $1`,
    [archiveId],
  );
  const a = r.rows[0] as
    { kind: string; subject_note_id: string | null; graph_backfilled_at: Date | null } | undefined;
  if (!a) return;
  if (a.kind === 'personal' && !a.subject_note_id) {
    const owner = await ownerOf(deps.pool, archiveId);
    if (owner) await ensureSubjectNote(deps, archiveId, owner);
  }
  if (a.graph_backfilled_at) return;
  await inTransaction(deps, archiveId, async (client) => {
    const locked = await client.query(
      `select graph_backfilled_at from public.archives where id = $1 for update`,
      [archiveId],
    );
    if ((locked.rows[0] as { graph_backfilled_at: Date | null }).graph_backfilled_at) return;
    const notes = await client.query(
      `select id, title, type::text as type, created_by, extra->'profile' as profile
         from public.notes
        where archive_id = $1 and type in ('person', 'place', 'object')
        order by created_at, id`,
      [archiveId],
    );
    for (const n of notes.rows as Array<{
      id: string;
      title: string;
      type: string;
      created_by: string;
      profile: unknown;
    }>) {
      await entityForNote(client, {
        id: n.id,
        archiveId,
        title: n.title,
        type: n.type,
        createdBy: n.created_by,
      });
      const aliases = n.profile ? readProfile(n.profile).aliases : [];
      if (aliases.length) {
        const e = await client.query(`select id from public.graph_entities where note_id = $1`, [
          n.id,
        ]);
        const id = (e.rows[0] as { id: string } | undefined)?.id;
        if (id) await addAliases(client, archiveId, id, aliases);
      }
    }
    // a story's [[link]] to one of them is a mention: the words it shows, and its sentence
    const links = await client.query(
      `select l.source_id, l.start_pos, l.end_pos, e.id as entity_id, s.body
         from public.links l
         join public.graph_entities e on e.note_id = l.resolved_id
         join public.notes s on s.id = l.source_id
        where l.archive_id = $1 and l.source_id <> l.resolved_id
          and s.type not in ('person', 'place', 'object')
        order by l.source_id, l.start_pos`,
      [archiveId],
    );
    const mentions = new Map<
      string,
      { entity: string; story: string; words: string[]; line: string }
    >();
    for (const l of links.rows as Array<{
      source_id: string;
      start_pos: number;
      end_pos: number;
      entity_id: string;
      body: string;
    }>) {
      const link = extractWikilinks(l.body.slice(l.start_pos, l.end_pos))[0];
      const words = (link?.alias ?? link?.target ?? '').trim();
      const key = `${l.entity_id}:${l.source_id}`;
      const m = mentions.get(key) ?? {
        entity: l.entity_id,
        story: l.source_id,
        words: [],
        line: sentenceAt(l.body, l.start_pos),
      };
      if (words && !m.words.includes(words)) m.words.push(words);
      mentions.set(key, m);
    }
    for (const m of mentions.values()) {
      await client.query(
        `insert into public.graph_mentions (archive_id, entity_id, note_id, words, line)
         values ($1, $2, $3, $4, $5) on conflict (entity_id, note_id) do nothing`,
        [archiveId, m.entity, m.story, m.words, m.line],
      );
    }
    await client.query(`update public.archives set graph_backfilled_at = now() where id = $1`, [
      archiveId,
    ]);
  });
}

/* ── what the AI's tools read (graph design 4.1) ─────────────────────── */

export interface FoundEntity {
  id: string;
  name: string;
  type: EntityType;
  aliases: string[];
  /** a few of its lines, from stories the member can see */
  lines: string[];
  /** only a close spelling: a candidate, never a match */
  close?: boolean;
  /** its note; null when it has none, or one this member cannot see (saving decides again) */
  note: NoteRef | null;
}

/** an entity the Graph step starts from: the protagonist, and each teller found */
export interface KnownEntity {
  id: string;
  name: string;
  type: EntityType;
  aliases: string[];
  /** the person the project is about */
  subject?: boolean;
  /** its note; null when it has none, or one this member cannot see (saving decides again) */
  note?: NoteRef | null;
}

export interface EntityLookup {
  find(name: string): Promise<FoundEntity[]>;
  read(id: string): Promise<{
    id: string;
    name: string;
    type: EntityType;
    aliases: string[];
    description: string;
    relationships: string[];
  } | null>;
}

/** at most one letter added, dropped or changed */
function nearlySame(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return a.length - i - j <= 1 && b.length - i - j <= 1;
}

export function entityLookup(db: Db, archiveId: string, userId: string): EntityLookup {
  const visible = entityVisibleSql('e', '$2');
  return {
    async find(name) {
      const key = matchKey(name);
      if (!key) return [];
      const all = await db.query(
        `select e.id, e.name, e.type::text as type, e.match_key,
                coalesce(array_agg(g.alias order by g.alias) filter (where g.id is not null), '{}') as aliases,
                coalesce(array_agg(g.match_key) filter (where g.id is not null), '{}') as alias_keys,
                ${entityNoteSql('e', '$2')} as note
           from public.graph_entities e
           left join public.graph_aliases g on g.entity_id = e.id
          where e.archive_id = $1 and ${visible}
          group by e.id`,
        [archiveId, userId],
      );
      const rows = all.rows as Array<{
        id: string;
        name: string;
        type: EntityType;
        match_key: string;
        aliases: string[];
        alias_keys: string[];
        note: NoteRef | null;
      }>;
      const exact = rows.filter((r) => r.match_key === key || r.alias_keys.includes(key));
      const close =
        key.length >= 5
          ? rows.filter(
              (r) =>
                !exact.includes(r) &&
                [r.match_key, ...r.alias_keys].some((k) => k.length >= 5 && nearlySame(k, key)),
            )
          : [];
      const found = [...exact, ...close].slice(0, 8);
      if (found.length === 0) return [];
      const lines = await db.query(
        `select m.entity_id, m.line from public.graph_mentions m
           join public.notes s on s.id = m.note_id
          where m.entity_id = any($1::uuid[]) and m.line <> '' and ${visibleSql('s', '$2')}
          order by m.created_at`,
        [found.map((f) => f.id), userId],
      );
      return found.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        aliases: r.aliases,
        note: r.note,
        lines: (lines.rows as Array<{ entity_id: string; line: string }>)
          .filter((l) => l.entity_id === r.id)
          .slice(0, 3)
          .map((l) => l.line),
        ...(exact.includes(r) ? {} : { close: true }),
      }));
    },
    async read(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const e = await db.query(
        `select e.id, e.name, e.type::text as type, e.description,
                coalesce((select array_agg(g.alias order by g.alias) from public.graph_aliases g
                           where g.entity_id = e.id), '{}') as aliases
           from public.graph_entities e
          where e.id = $3 and e.archive_id = $1 and ${visible}`,
        [archiveId, userId, id],
      );
      const row = e.rows[0] as
        | { id: string; name: string; type: EntityType; description: string; aliases: string[] }
        | undefined;
      if (!row) return null;
      const rel = await db.query(
        `select r.description from public.graph_relationships r
           join public.notes s on s.id = r.note_id
          where (r.a_id = $3 or r.b_id = $3) and r.archive_id = $1 and ${visibleSql('s', '$2')}
          order by r.created_at limit 20`,
        [archiveId, userId, id],
      );
      return {
        ...row,
        relationships: (rel.rows as Array<{ description: string }>).map((r) => r.description),
      };
    },
  };
}

/**
 * The entities an interview's Graph step starts from (graph design 4.1): the protagonist, and
 * each teller found by name or alias. The AI is told their ids, so it does not make them twice.
 */
export async function knownFor(
  db: Db,
  archiveId: string,
  userId: string,
  tellers: readonly string[],
): Promise<KnownEntity[]> {
  const keys = [...new Set(tellers.map(matchKey).filter(Boolean))];
  const r = await db.query(
    `select e.id, e.name, e.type::text as type,
            coalesce((select array_agg(g.alias order by g.alias) from public.graph_aliases g
                       where g.entity_id = e.id), '{}') as aliases,
            coalesce(e.note_id = a.subject_note_id, false) as subject,
            ${entityNoteSql('e', '$2')} as note
       from public.graph_entities e join public.archives a on a.id = e.archive_id
      where e.archive_id = $1 and ${entityVisibleSql('e', '$2')}
        and (e.note_id = a.subject_note_id
             or (e.type = 'person'
                 and (e.match_key = any($3::text[])
                      or exists (select 1 from public.graph_aliases g
                                  where g.entity_id = e.id and g.match_key = any($3::text[])))))
      order by subject desc, e.name
      limit 12`,
    [archiveId, userId, keys],
  );
  return r.rows as KnownEntity[];
}
