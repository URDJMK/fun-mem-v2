import type { Context } from 'hono';
import type { App, AppDeps } from './app';
import { isMember, UUID_RE } from './membership';

/**
 * FM-020 read views: people index (backlink counts) + depth-bounded local
 * neighborhood. Every surface applies THE visibility predicate (FR-081/FR-101):
 * a note is visible to the caller iff they authored it OR its audience is not
 * 'private-to-author' (no audiences row = archive-members = visible). In the
 * neighborhood walk the predicate lives INSIDE the recursion — restricted notes
 * are unreachable, never bridges.
 */

type Ctx = Context<{ Variables: { userId: string } }>;
const NOT_FOUND = { error: 'not found' } as const;
const MAX_DEPTH = 3;

// SQL fragment: is note <alias> visible to $<userParam>? Coalesce absent audience
// row to the default (archive-members = visible). One source of truth, reused by
// notes.ts (list + backlinks) so every read surface filters identically.
export function visibleSql(alias: string, userParam: string): string {
  return `(${alias}.created_by = ${userParam} or coalesce(
      (select a.kind from public.audiences a where a.note_id = ${alias}.id), 'archive-members'
    ) <> 'private-to-author')`;
}

/**
 * FR-081 for a single note fetched BY ID. Composes the one visibility
 * predicate — it does not restate it — so the by-id surfaces cannot drift from
 * the list/graph/search surfaces. Callers must pass the note id, archive id and
 * user id as the three bind params, in that order, and return the uniform 404
 * on a miss (never 403: a 403 confirms the note exists).
 *
 * FM-032: the six by-id routes previously fetched by primary key with NO
 * predicate, so a co-member could read, overwrite and delete a
 * private-to-author note. RLS is not a backstop on the app path (the pool
 * connects as a rolbypassrls table owner), so this predicate is the protection.
 */
export function visibleNoteSql(
  alias: string,
  noteParam: string,
  archiveParam: string,
  userParam: string,
): string {
  return `${alias}.id = ${noteParam} and ${alias}.archive_id = ${archiveParam} and ${visibleSql(alias, userParam)}`;
}

async function gate(c: Ctx, deps: AppDeps): Promise<boolean> {
  const archiveId = c.req.param('archiveId');
  return !!archiveId && (await isMember(deps.pool, c.get('userId'), archiveId));
}

export function registerViewsRoutes(app: App, deps: AppDeps): void {
  // People index: person notes visible to the caller, each with the count of
  // incoming link occurrences whose SOURCE note is also visible (restricted
  // sources never inflate the count — §17).
  app.get('/v1/archives/:archiveId/people', async (c) => {
    if (!(await gate(c, deps))) return c.json(NOT_FOUND, 404);
    const archiveId = c.req.param('archiveId');
    const userId = c.get('userId');
    const rows = await deps.pool.query(
      `select n.id, n.title, n.type,
              count(src.id)::int as backlinks
         from public.notes n
         left join public.links l
           on l.resolved_id = n.id and l.archive_id = n.archive_id
         left join public.notes src
           on src.id = l.source_id and ${visibleSql('src', '$2')}
        where n.archive_id = $1 and n.type = 'person' and ${visibleSql('n', '$2')}
        group by n.id, n.title, n.type
        order by n.title`,
      [archiveId, userId],
    );
    return c.json(
      rows.rows.map((r) => ({ id: r.id, title: r.title, type: r.type, backlinks: r.backlinks })),
    );
  });

  // Depth-bounded neighborhood. The visibility predicate is applied to every
  // node as it is ENTERED (base + recursive terms), so a restricted note is
  // unreachable and cannot bridge to its neighbors.
  app.get('/v1/archives/:archiveId/notes/:noteId/neighborhood', async (c) => {
    if (!(await gate(c, deps))) return c.json(NOT_FOUND, 404);
    const archiveId = c.req.param('archiveId');
    const noteId = c.req.param('noteId');
    const userId = c.get('userId');
    if (!UUID_RE.test(noteId)) return c.json(NOT_FOUND, 404);
    const depthRaw = Number(c.req.query('depth') ?? '1');
    const depth =
      Number.isInteger(depthRaw) && depthRaw >= 1 && depthRaw <= MAX_DEPTH ? depthRaw : 1;

    // seed must exist, be in-archive, and be visible — else uniform 404
    const seed = await deps.pool.query(
      `select id from public.notes n
        where n.id = $1 and n.archive_id = $2 and ${visibleSql('n', '$3')}`,
      [noteId, archiveId, userId],
    );
    if (seed.rowCount === 0) return c.json(NOT_FOUND, 404);

    // symmetrized resolved edges within the archive; BFS with per-branch path
    // prune; a node enters the frontier only if visible. Outer GROUP BY keeps
    // each node at its shortest depth.
    const walk = await deps.pool.query(
      `with recursive edges as (
         select source_id as a, resolved_id as b from public.links
           where archive_id = $2 and resolved_id is not null
         union all
         select resolved_id as a, source_id as b from public.links
           where archive_id = $2 and resolved_id is not null
       ),
       nb(id, depth, path) as (
         select n.id, 0, array[n.id]
           from public.notes n
          where n.id = $1 and n.archive_id = $2 and ${visibleSql('n', '$3')}
         union all
         select nx.id, nb.depth + 1, nb.path || nx.id
           from nb
           join edges e on e.a = nb.id
           join public.notes nx on nx.id = e.b and nx.archive_id = $2
          where nb.depth < $4
            and not (nx.id = any(nb.path))
            and ${visibleSql('nx', '$3')}
       )
       select id, min(depth)::int as depth from nb group by id`,
      [noteId, archiveId, userId, depth],
    );
    const depthById = new Map<string, number>(walk.rows.map((r) => [r.id, r.depth]));
    const ids = [...depthById.keys()];

    const meta = await deps.pool.query(
      `select id, title, type from public.notes where id = any($1) and archive_id = $2`,
      [ids, archiveId],
    );
    const nodes = meta.rows.map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      depth: depthById.get(r.id)!,
    }));

    // edges only between included (visible) nodes — no dangling endpoints
    const included = new Set(ids);
    const edgeRows = await deps.pool.query(
      `select source_id, resolved_id from public.links
        where archive_id = $1 and resolved_id is not null
          and source_id = any($2) and resolved_id = any($2)`,
      [archiveId, ids],
    );
    const seen = new Set<string>();
    const edges: Array<{ source: string; target: string }> = [];
    for (const r of edgeRows.rows) {
      if (!included.has(r.source_id) || !included.has(r.resolved_id)) continue;
      const key = [r.source_id, r.resolved_id].sort().join(':');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: r.source_id, target: r.resolved_id });
    }
    return c.json({ nodes, edges });
  });
}
