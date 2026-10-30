import { matchKey } from '@funmem/core';
import type { Pool, PoolClient } from 'pg';
import { visibleSql } from '../views';
import { entityVisibleSql } from './store';
import type { EntityType } from './types';

type Db = Pool | PoolClient;

/**
 * The graph as one member may see it (graph design 6.1): nodes, the relationships told (solid
 * lines), and being in the same story (faint lines). The protagonist and a story's tellers are
 * in every story they tell, so they are left out of its faint lines; a pair already joined by
 * a told relationship gets no faint line as well.
 */
export interface GraphNode {
  id: string;
  name: string;
  type: EntityType;
  /** how many stories it is in */
  stories: number;
  subject: boolean;
  noteId: string | null;
}

export interface GraphView {
  nodes: GraphNode[];
  told: Array<{
    a: string;
    b: string;
    lines: Array<{ id: string; description: string; storyId: string; storyTitle: string }>;
  }>;
  together: Array<{ a: string; b: string; stories: number }>;
  /** nodes left out over the limit */
  more: number;
}

export const GRAPH_LIMIT = 80;

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export async function graphFor(
  db: Db,
  archiveId: string,
  userId: string,
  opts: { limit?: number; around?: string } = {},
): Promise<GraphView> {
  const ents = (
    await db.query(
      `select e.id, e.name, e.type::text as type, e.note_id,
              coalesce(e.note_id = a.subject_note_id, false) as subject,
              coalesce((select array_agg(g.match_key) from public.graph_aliases g
                         where g.entity_id = e.id), '{}') as alias_keys, e.match_key
         from public.graph_entities e join public.archives a on a.id = e.archive_id
        where e.archive_id = $1 and ${entityVisibleSql('e', '$2')}`,
      [archiveId, userId],
    )
  ).rows as Array<{
    id: string;
    name: string;
    type: EntityType;
    note_id: string | null;
    subject: boolean;
    alias_keys: string[];
    match_key: string;
  }>;
  const visible = new Set(ents.map((e) => e.id));
  const mentions = (
    await db.query(
      `select m.entity_id, m.note_id, s.contributors
         from public.graph_mentions m join public.notes s on s.id = m.note_id
        where m.archive_id = $1 and ${visibleSql('s', '$2')}`,
      [archiveId, userId],
    )
  ).rows as Array<{ entity_id: string; note_id: string; contributors: string[] | null }>;
  const rels = (
    await db.query(
      `select r.id, r.a_id, r.b_id, r.description, r.note_id, s.title
         from public.graph_relationships r join public.notes s on s.id = r.note_id
        where r.archive_id = $1 and ${visibleSql('s', '$2')}
        order by r.created_at, r.id`,
      [archiveId, userId],
    )
  ).rows as Array<{
    id: string;
    a_id: string;
    b_id: string;
    description: string;
    note_id: string;
    title: string;
  }>;

  // stories per entity: those that mention it or tell one of its relationships
  const storiesOf = new Map<string, Set<string>>();
  const add = (e: string, s: string) => {
    if (!visible.has(e)) return;
    const set = storiesOf.get(e) ?? new Set<string>();
    set.add(s);
    storiesOf.set(e, set);
  };
  for (const m of mentions) add(m.entity_id, m.note_id);
  for (const r of rels) {
    add(r.a_id, r.note_id);
    add(r.b_id, r.note_id);
  }

  const told = new Map<string, GraphView['told'][number]>();
  for (const r of rels) {
    if (!visible.has(r.a_id) || !visible.has(r.b_id)) continue;
    const k = pairKey(r.a_id, r.b_id);
    const t = told.get(k) ?? { a: r.a_id, b: r.b_id, lines: [] };
    t.lines.push({ id: r.id, description: r.description, storyId: r.note_id, storyTitle: r.title });
    told.set(k, t);
  }

  // faint lines: the entities of each story, less the protagonist and that story's tellers
  const byKey = new Map<string, string>();
  for (const e of ents) for (const k of [e.match_key, ...e.alias_keys]) byKey.set(k, e.id);
  const subject = ents.find((e) => e.subject)?.id;
  const inStory = new Map<string, { entities: Set<string>; tellers: Set<string> }>();
  for (const m of mentions) {
    if (!visible.has(m.entity_id)) continue;
    const s = inStory.get(m.note_id) ?? {
      entities: new Set<string>(),
      tellers: new Set(
        (m.contributors ?? []).map((c) => byKey.get(matchKey(c))).filter((x): x is string => !!x),
      ),
    };
    s.entities.add(m.entity_id);
    inStory.set(m.note_id, s);
  }
  const together = new Map<string, { a: string; b: string; stories: number }>();
  for (const s of inStory.values()) {
    const ids = [...s.entities].filter((e) => e !== subject && !s.tellers.has(e)).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = pairKey(ids[i]!, ids[j]!);
        if (told.has(k)) continue;
        const t = together.get(k) ?? { a: ids[i]!, b: ids[j]!, stories: 0 };
        t.stories++;
        together.set(k, t);
      }
    }
  }

  let nodes: GraphNode[] = ents.map((e) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    stories: storiesOf.get(e.id)?.size ?? 0,
    subject: e.subject,
    noteId: e.note_id,
  }));
  let toldLines = [...told.values()];
  let togetherLines = [...together.values()];

  if (opts.around) {
    const center = opts.around;
    const near = new Set<string>([center]);
    for (const l of [...toldLines, ...togetherLines]) {
      if (l.a === center) near.add(l.b);
      if (l.b === center) near.add(l.a);
    }
    nodes = nodes.filter((n) => near.has(n.id));
    toldLines = toldLines.filter((l) => l.a === center || l.b === center);
    togetherLines = togetherLines.filter((l) => l.a === center || l.b === center);
  }

  nodes.sort(
    (x, y) =>
      Number(y.subject) - Number(x.subject) ||
      y.stories - x.stories ||
      x.name.localeCompare(y.name),
  );
  const limit = Math.max(1, Math.min(opts.limit ?? GRAPH_LIMIT, 500));
  const shown = nodes.slice(0, limit);
  const kept = new Set(shown.map((n) => n.id));
  const within = (l: { a: string; b: string }) => kept.has(l.a) && kept.has(l.b);
  return {
    nodes: shown,
    told: toldLines.filter(within),
    together: togetherLines.filter(within),
    more: nodes.length - shown.length,
  };
}
