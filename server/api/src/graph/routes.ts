import type { Context } from 'hono';
import type { App, AppDeps } from '../app';
import { memberRole, UUID_RE } from '../membership';
import { readProfile } from '../stories/profile';
import { visibleSql } from '../views';
import { ensureGraph, entityVisibleSql } from './store';
import type { EntityType } from './types';
import { graphFor, GRAPH_LIMIT } from './view';

/**
 * The graph's routes (graph design 6.4). Every read makes sure the project's graph exists
 * first (`ensureGraph`), and shows only what the member may see.
 */
type Ctx = Context<{ Variables: { userId: string } }>;
const NOT_FOUND = { error: 'not found' } as const;

async function member(c: Ctx, deps: AppDeps): Promise<{ archiveId: string; role: string } | null> {
  const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
  const role = await memberRole(deps.pool, c.get('userId'), archiveId);
  return role === null ? null : { archiveId, role };
}

/** an entity's id, or the id of its note: the People page opens either */
async function entityIdOf(
  deps: AppDeps,
  archiveId: string,
  userId: string,
  raw: string,
): Promise<string | null> {
  const key = raw.toLowerCase();
  if (!UUID_RE.test(key)) return null;
  const r = await deps.pool.query(
    `select e.id from public.graph_entities e
      where e.archive_id = $1 and (e.id = $3 or e.note_id = $3) and ${entityVisibleSql('e', '$2')}
      order by (e.id = $3) desc limit 1`,
    [archiveId, userId, key],
  );
  return (r.rows[0] as { id: string } | undefined)?.id ?? null;
}

export function registerGraphRoutes(app: App, deps: AppDeps): void {
  app.get('/v1/archives/:archiveId/graph', async (c) => {
    const m = await member(c, deps);
    if (!m) return c.json(NOT_FOUND, 404);
    await ensureGraph(deps, m.archiveId);
    const limit = Number(c.req.query('limit') ?? GRAPH_LIMIT);
    return c.json(
      await graphFor(deps.pool, m.archiveId, c.get('userId'), {
        limit: Number.isInteger(limit) && limit > 0 ? limit : GRAPH_LIMIT,
      }),
    );
  });

  app.get('/v1/archives/:archiveId/entities', async (c) => {
    const m = await member(c, deps);
    if (!m) return c.json(NOT_FOUND, 404);
    await ensureGraph(deps, m.archiveId);
    const r = await deps.pool.query(
      `select e.id, e.name, e.type::text as type, e.note_id,
              coalesce(e.note_id = a.subject_note_id, false) as subject,
              coalesce((select array_agg(g.alias order by g.alias) from public.graph_aliases g
                         where g.entity_id = e.id), '{}') as aliases,
              (select count(distinct s.id)::int from public.notes s
                where ${visibleSql('s', '$2')}
                  and (s.id in (select m.note_id from public.graph_mentions m where m.entity_id = e.id)
                       or s.id in (select r.note_id from public.graph_relationships r
                                    where r.a_id = e.id or r.b_id = e.id))) as stories
         from public.graph_entities e join public.archives a on a.id = e.archive_id
        where e.archive_id = $1 and ${entityVisibleSql('e', '$2')}
        order by coalesce(e.note_id = a.subject_note_id, false) desc, e.name`,
      [m.archiveId, c.get('userId')],
    );
    return c.json(
      (
        r.rows as Array<{
          id: string;
          name: string;
          type: EntityType;
          note_id: string | null;
          subject: boolean;
          aliases: string[];
          stories: number;
        }>
      ).map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        noteId: e.note_id,
        subject: e.subject,
        aliases: e.aliases,
        stories: e.stories,
      })),
    );
  });

  app.get('/v1/archives/:archiveId/entities/:entityId', async (c) => {
    const m = await member(c, deps);
    if (!m) return c.json(NOT_FOUND, 404);
    await ensureGraph(deps, m.archiveId);
    const userId = c.get('userId');
    const entityId = await entityIdOf(deps, m.archiveId, userId, c.req.param('entityId') ?? '');
    if (!entityId) return c.json(NOT_FOUND, 404);
    const e = (
      await deps.pool.query(
        `select e.id, e.name, e.type::text as type, e.note_id, e.description,
                coalesce(e.note_id = a.subject_note_id, false) as subject,
                n.extra->'profile' as profile,
                coalesce((select array_agg(g.alias order by g.alias) from public.graph_aliases g
                           where g.entity_id = e.id), '{}') as aliases
           from public.graph_entities e join public.archives a on a.id = e.archive_id
           left join public.notes n on n.id = e.note_id
          where e.id = $1`,
        [entityId],
      )
    ).rows[0] as {
      id: string;
      name: string;
      type: EntityType;
      note_id: string | null;
      description: string;
      subject: boolean;
      profile: unknown;
      aliases: string[];
    };
    const mentions = await deps.pool.query(
      `select m.note_id as story_id, s.title as story_title, s.occurred, m.words, m.line
         from public.graph_mentions m join public.notes s on s.id = m.note_id
        where m.entity_id = $1 and ${visibleSql('s', '$2')}
        order by s.occurred nulls last, s.created_at`,
      [entityId, userId],
    );
    const rels = await deps.pool.query(
      `select r.id, r.description, r.note_id as story_id, s.title as story_title,
              o.id as other_id, o.name as other_name, o.type::text as other_type
         from public.graph_relationships r
         join public.notes s on s.id = r.note_id
         join public.graph_entities o on o.id = case when r.a_id = $1 then r.b_id else r.a_id end
        where (r.a_id = $1 or r.b_id = $1) and ${visibleSql('s', '$2')}
        order by r.created_at, r.id`,
      [entityId, userId],
    );
    return c.json({
      id: e.id,
      name: e.name,
      type: e.type,
      noteId: e.note_id,
      subject: e.subject,
      aliases: e.aliases,
      description: e.description,
      profile: e.subject ? readProfile(e.profile ?? {}) : null,
      mentions: (
        mentions.rows as Array<{
          story_id: string;
          story_title: string;
          occurred: string | null;
          words: string[];
          line: string;
        }>
      ).map((r) => ({
        storyId: r.story_id,
        storyTitle: r.story_title,
        occurred: r.occurred,
        words: r.words,
        line: r.line,
      })),
      relationships: (
        rels.rows as Array<{
          id: string;
          description: string;
          story_id: string;
          story_title: string;
          other_id: string;
          other_name: string;
          other_type: EntityType;
        }>
      ).map((r) => ({
        id: r.id,
        description: r.description,
        storyId: r.story_id,
        storyTitle: r.story_title,
        other: { id: r.other_id, name: r.other_name, type: r.other_type },
      })),
      graph: await graphFor(deps.pool, m.archiveId, userId, { around: entityId, limit: 40 }),
    });
  });
}

/** What a story's page underlines: the words of each entity it mentions that the reader can see. */
export async function mentionsOf(
  deps: AppDeps,
  archiveId: string,
  noteId: string,
  userId: string,
): Promise<Array<{ entityId: string; words: string[] }>> {
  const r = await deps.pool.query(
    `select m.entity_id, m.words from public.graph_mentions m
       join public.graph_entities e on e.id = m.entity_id
      where m.note_id = $1 and m.archive_id = $2 and ${entityVisibleSql('e', '$3')}
      order by m.created_at`,
    [noteId, archiveId, userId],
  );
  return (r.rows as Array<{ entity_id: string; words: string[] }>).map((x) => ({
    entityId: x.entity_id,
    words: x.words,
  }));
}
