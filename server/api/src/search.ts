import type { App, AppDeps } from './app';
import { isMember } from './membership';
import { visibleSql } from './views';

/**
 * Hybrid search endpoint (FM-022, spec §4.7, FR-080/081). ACL is resolved
 * BEFORE any ranking: a materialized visible-note CTE (the FM-020 visibleSql
 * predicate) bounds every leg — pgvector HNSW post-filters subqueries
 * (pgvector#776), so the pre-resolved id set is the only leak-safe shape.
 * Counts and snippets come from the fused post-ACL set only.
 *
 * Legs (each ranked inside `allowed`, top-50, RRF k=60, per-leg weights
 * defaulting to 1.0 — the escape hatch Elastic/OpenSearch grew, shipped
 * without behavior change): tsvector (`simple`), pgroonga (Korean bigrams),
 * pgvector (model_version-pinned — cross-model cosine is meaningless), note
 * TITLE (person + alias classes), and `occurred` date prefix for date-shaped
 * queries. Quoted queries are the FR-080 "exact" class: keyword legs switch
 * to phrase operators and the ORDER-BLIND vector leg sits out (a bag-of-words
 * embedding would resurface a reversed phrase the user explicitly excluded).
 */

const RRF_K = 60;
const LEG_LIMIT = 50;
const DEFAULT_K = 20;
const MAX_K = 100;
/** pure-noise floor: cosine below this never enters the vector leg */
const MIN_VECTOR_SIM = 0.1;
const WEIGHTS = { ts: 1.0, pgroonga: 1.0, vector: 1.0, title: 1.0, date: 1.0 };
const SNIPPET_LEN = 200;

interface ParsedQuery {
  /** raw query, NFC-normalized and trimmed */
  q: string;
  /** inner text when the whole query is "quoted" (exact class) */
  phrase: string | null;
  /** YYYY[-MM[-DD]] when the query IS a date (date class) */
  datePrefix: string | null;
}

export function parseQuery(raw: string): ParsedQuery {
  const q = raw.normalize('NFC').trim();
  const quoted = /^"(.+)"$/s.exec(q);
  const date = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?년?$/.exec(q);
  return {
    q,
    phrase: quoted ? quoted[1]!.trim() : null,
    datePrefix: date
      ? [date[1], date[2], date[3]].filter((p): p is string => p !== undefined).join('-')
      : null,
  };
}

/** tiny query-embedding LRU (normalized query + model version) */
const embedCache = new Map<string, number[]>();
const EMBED_CACHE_MAX = 500;

async function queryVector(deps: AppDeps, text: string): Promise<string | null> {
  const provider = deps.embeddings;
  if (!provider) return null;
  const key = `${provider.modelVersion}\n${text}`;
  const hit = embedCache.get(key);
  if (hit) return `[${hit.join(',')}]`;
  const [vec] = await provider.embed([text]);
  if (!vec) return null;
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) embedCache.delete(oldest);
  }
  embedCache.set(key, vec);
  return `[${vec.join(',')}]`;
}

/**
 * FM-026: ONE hybrid query, two projections.
 *
 * Extracted so the grounded-Q&A path cannot grow a second retrieval — and
 * therefore cannot grow a second ACL. FM-027's named shortcut is "strip
 * restricted citations post-generation instead of pre-retrieval"; the only
 * durable defence against that is for there to be exactly one place where
 * visibility is resolved. `grounding` differs from `search` in its final SELECT
 * alone: full chunk content instead of a 200-char snippet (a validator cannot
 * prove a quote past character 200), plus chunk_index and attribution.
 */
export async function hybridQuery(
  deps: AppDeps,
  archiveId: string,
  userId: string,
  rawQuery: string,
  k: number,
  projection: 'search' | 'grounding',
): Promise<Array<Record<string, unknown>>> {
  const parsed = parseQuery(rawQuery);

  // exact class (quoted): phrase keyword matching only — the order-blind
  // vector leg would resurface reversed/reordered phrases
  const qvec = parsed.phrase !== null ? null : await queryVector(deps, parsed.q).catch(() => null);
  const keyword = parsed.phrase ?? parsed.q;
  // ILIKE metacharacters in user text are literals, not wildcards
  const titlePattern = keyword.replace(/[\\%_]/g, '\\$&');
  const tsQueryFn = parsed.phrase !== null ? 'phraseto_tsquery' : 'websearch_to_tsquery';
  // pgroonga query syntax: escape user text; quoted class becomes a phrase
  // parenthesized: || and &@~ share precedence and associate left — an
  // unwrapped concat would parse as ((content &@~ '"') || ...)
  const pgroongaQuery =
    parsed.phrase !== null
      ? `('"' || pgroonga_query_escape($3) || '"')`
      : `pgroonga_query_escape($3)`;

  const sql = `
      with allowed as materialized (
        -- FM-026 added created_by/revised to the PROJECTION for citation
        -- attribution. The PREDICATE is byte-identical and deliberately so:
        -- this CTE is the single ACL resolution point every leg joins, and
        -- FM-027 extends it. A second visibility predicate is how those drift.
        select n.id, n.title, n.occurred, n.created_by, n.revised
          from public.notes n
         where n.archive_id = $1 and ${visibleSql('n', '$2')}
      ),
      cand as (
        select c.id, c.note_id, c.heading, c.heading_path, c.anchor, c.content, c.fts,
               c.content_hash, c.chunk_index
          from public.chunks c
          join allowed a on a.id = c.note_id
         where c.archive_id = $1
      ),
      ts_leg as (
        select id, row_number() over (
                 order by ts_rank(fts, ${tsQueryFn}('simple', $3)) desc, id) as rnk
          from cand
         where fts @@ ${tsQueryFn}('simple', $3)
         order by rnk limit ${LEG_LIMIT}
      ),
      pgroonga_leg as (
        -- pgroonga_score is plan-dependent (0 under a seq scan — ordering then
        -- degrades to the id tie-break); the pgroonga index makes this the
        -- chosen plan at any realistic table size
        select c.id, row_number() over (
                 order by pgroonga_score(c.tableoid, c.ctid) desc, c.id) as rnk
          from public.chunks c
          join allowed a on a.id = c.note_id
         where c.archive_id = $1 and c.content &@~ ${pgroongaQuery}
         order by rnk limit ${LEG_LIMIT}
      ),
      vector_leg as (
        select c.id, row_number() over (
                 order by e.embedding <#> $4::extensions.vector asc, c.id) as rnk
          from cand c
          join public.chunk_embeddings e
            on e.note_id = c.note_id and e.content_hash = c.content_hash
         where $4::extensions.vector is not null and e.model_version = $5
           and (e.embedding <#> $4::extensions.vector) <= ${-MIN_VECTOR_SIM}
         order by rnk limit ${LEG_LIMIT}
      ),
      title_leg as (
        -- note-level: a chunk-less stub (empty body) is still findable by
        -- title; its own note id stands in when no chunk 0 exists
        select coalesce(c.id, a.id) as id,
               row_number() over (order by length(a.title) asc, coalesce(c.id, a.id)) as rnk
          from allowed a
          left join cand c on c.note_id = a.id and c.chunk_index = 0
         where a.title ilike '%' || $6 || '%'
         order by rnk limit ${LEG_LIMIT}
      ),
      date_leg as (
        select coalesce(c.id, a.id) as id,
               row_number() over (order by a.occurred asc, coalesce(c.id, a.id)) as rnk
          from allowed a
          left join cand c on c.note_id = a.id and c.chunk_index = 0
         where $7::text is not null and a.occurred like $7 || '%'
         order by rnk limit ${LEG_LIMIT}
      ),
      -- FM-026 / hardening req 2: each row carries WHICH leg found it. A single
      -- fused score cannot support an abstention threshold, and that is
      -- arithmetic rather than preference: RRF contributes weight/(60+rnk), so
      -- a vector hit at rank 1 scores identically whether its cosine was 0.95
      -- or 0.15, and identically to a title-substring hit at rank 1. The raw
      -- per-leg similarity never leaves this query, so any threshold on the
      -- fused score is a magic number. Abstention reads the leg set instead.
      scores as (
        select id, 'ts' as leg, rnk, ${WEIGHTS.ts}::float8 / (${RRF_K} + rnk) as s from ts_leg
        union all
        select id, 'pgroonga', rnk, ${WEIGHTS.pgroonga}::float8 / (${RRF_K} + rnk) from pgroonga_leg
        union all
        select id, 'vector', rnk, ${WEIGHTS.vector}::float8 / (${RRF_K} + rnk) from vector_leg
        union all
        select id, 'title', rnk, ${WEIGHTS.title}::float8 / (${RRF_K} + rnk) from title_leg
        union all
        select id, 'date', rnk, ${WEIGHTS.date}::float8 / (${RRF_K} + rnk) from date_leg
      ),
      fused as (
        select id, sum(s) as score,
               array_agg(leg order by leg) as legs,
               jsonb_object_agg(leg, rnk) as ranks
          from scores group by id
      )
      select n.id as note_id, c.id as chunk_id, c.anchor,
             coalesce(c.heading, '') as heading,
             coalesce(c.heading_path, '{}') as heading_path,
             n.title, n.occurred, n.created_by, n.revised,
             coalesce(c.chunk_index, 0) as chunk_index,
             ${
               projection === 'grounding'
                 ? 'normalize(coalesce(c.content, n.title), NFC) as content'
                 : `left(normalize(coalesce(c.content, n.title), NFC), ${SNIPPET_LEN}) as snippet`
             },
             f.score, f.legs, f.ranks, count(*) over () as total
        from fused f
        left join cand c on c.id = f.id
        -- FM-044: resolve every fused id back to its note for title/date. A leg
        -- id is either a chunk id (cand matches) or, for the note-level title
        -- and date legs on a body-less stub, the note id itself. INNER join on
        -- ALLOWED, not on notes: anything that somehow failed to resolve inside
        -- the ACL set is dropped rather than rendered.
        join allowed n on n.id = coalesce(c.note_id, f.id)
       order by f.score desc, f.id
       limit ${k}`;

  const res = await deps.pool.query(sql, [
    archiveId,
    userId,
    keyword,
    qvec,
    deps.embeddings?.modelVersion ?? '',
    titlePattern,
    parsed.datePrefix,
  ]);
  return res.rows;
}

export function registerSearchRoutes(app: App, deps: AppDeps): void {
  app.get('/v1/archives/:archiveId/search', async (c) => {
    const archiveId = c.req.param('archiveId');
    const userId = c.get('userId');
    if (!archiveId || !(await isMember(deps.pool, userId, archiveId))) {
      return c.json({ error: 'not found' }, 404);
    }
    const parsed = parseQuery(c.req.query('q') ?? '');
    if (parsed.q === '' || parsed.phrase === '') return c.json({ error: 'q is required' }, 400);
    const k = Math.min(MAX_K, Math.max(1, Number(c.req.query('k')) || DEFAULT_K));
    const rows = await hybridQuery(deps, archiveId, userId, parsed.q, k, 'search');
    return c.json({
      results: rows.map((r) => ({
        noteId: r.note_id as string,
        chunkId: (r.chunk_id as string) ?? null,
        anchor: (r.anchor as string) ?? null,
        heading: r.heading as string,
        headingPath: r.heading_path as string[],
        title: r.title as string,
        occurred: (r.occurred as string) ?? null,
        snippet: r.snippet as string,
        score: Number(r.score),
        legs: r.legs as string[],
        ranks: r.ranks as Record<string, number>,
      })),
      // NOT a match count: this is count(*) over () on the FUSED set, so it
      // saturates at 5 legs x LEG_LIMIT = 250 however large the archive gets.
      // Cheap (nowhere near the bottleneck) but it is a CANDIDATE count, and no
      // caller may render it as "N results found".
      total: rows.length > 0 ? Number(rows[0]!.total) : 0,
    });
  });
}
