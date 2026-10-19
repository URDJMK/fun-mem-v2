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
 * FR-081 for MEDIA (FM-064). A photograph is visible to its UPLOADER, or to
 * anyone who can read the MEMORY IT BELONGS TO. That is the whole rule.
 *
 * It took a long time to earn. `public.media` had no note column, so a blob's
 * audience had to be DERIVED from which notes embed it, and every derivation
 * failed: `links` and `revisions` are both caller-writable, because
 * `PUT /notes/:noteId` lets any member edit any visible note with no author
 * check. Four rules, four different failures (A1-A6 in progress.md), and a
 * fifth that survived attack while still shipping a hole where the parser and
 * the carrier test disagreed about what an embed IS.
 *
 * WHY THIS DERIVATION IS SAFE WHERE THOSE WERE NOT. It reads `media.note_id`
 * and nothing else -- no `links`, no `revisions`, no note body. `note_id` is
 * set by the SERVER on the creating request (FM-065) and patchable by no
 * route, so a caller cannot write the field that decides their own access.
 * Are.na resolves a block's visibility over channel membership exactly like
 * this and has no equivalent history, because adding a block to a channel is
 * itself an authorization-checked WRITE. `![[hash]]` inside a body never was.
 * That distinction -- not the disjunction -- is what makes derivation safe.
 *
 * A NULL `note_id` FAILS CLOSED, and does so WITHOUT a null test:
 * `n.id = media.note_id` is unknown when `note_id` is NULL, so the `exists`
 * finds nothing and only the `created_by` disjunct can match. Never "improve"
 * this with `is not distinct from` -- that makes NULL match NULL and fails
 * OPEN, which is exactly A6. A required test pins the branch, and it only
 * catches the bug because its fixture carries an unrelated visible note; the
 * first version of that test passed the A6 mutant.
 *
 * ERASURE DOES NOT FOLLOW THIS RULE. `media.ts`'s delete gate is
 * uploader-or-owner, spelled out there rather than composed from this
 * function, so widening reads here did not hand every reader of a memory the
 * power to destroy its photographs. See that comment.
 *
 * THE RLS POLICY ON `public.media` CARRIES THIS SAME RULE, in SQL no
 * TypeScript reads. Two copies of one authorization rule drift unless
 * something asserts they do not, so a required test compares this predicate
 * against a real authenticated session for two callers over a fixture hitting
 * every branch. They move in the same unit or they do not move.
 *
 * RESIDUALS. R1 and R2 CLOSED in FM-068: the policy is no longer
 * membership-only, so a co-member can no longer enumerate every row's hash,
 * mime, size and uploader through PostgREST, and the timing difference closed
 * with it because the predicate is an indexed join on both branches. R4, R5
 * and R6 are gone with the derivation they described. R3 STANDS:
 * `POST /media` with bytes the archive already holds returns a uniform 201
 * carrying the EXISTING row's id, and `GET /media/:id` on that id answers 404
 * while a fresh upload's answers 200 -- a two-request confirmation for a
 * caller who already holds the bytes. Preimage-class, and it never came from
 * the derivation, so removing the derivation did not remove it.
 *
 * This block has now been wrong twice, in the same way both times: it
 * described a rule the code below no longer implemented. Reviewers caught it
 * both times. If you change `mediaVisibleSql`, change this paragraph in the
 * same commit.
 */
export function mediaVisibleSql(alias: string, archiveParam: string, userParam: string): string {
  return `(${alias}.created_by = ${userParam} or exists (
      select 1 from public.notes n
       where n.id = ${alias}.note_id
         and n.archive_id = ${archiveParam}
         and ${visibleSql('n', userParam)}
    ))`;
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
