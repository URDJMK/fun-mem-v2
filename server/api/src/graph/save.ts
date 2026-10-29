import { matchKey, normalizeTitle } from '@funmem/core';
import type { PoolClient } from 'pg';
import { UUID_RE } from '../membership';
import { relink } from './marks';
import { addAliases } from './note-entity';
import { NOT_IN_TITLE } from './shared';
import { entityVisibleSql } from './store';
import type { GraphPatch, GraphProposal, GraphSource, ProposedEntity } from './types';

/**
 * Saving an import's graph as the reviewer chose, in the same transaction as its stories, and
 * taking it back with them (graph design 5.1–5.3).
 */

const MAX_NAME = 200;

/** a name the reviewer typed, as a note title may hold it (validateNoteTitle) */
const cleanName = (raw: string | undefined): string =>
  (raw ?? '').replace(NOT_IN_TITLE, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

/**
 * The proposal as the reviewer left it: entities and relationships left out, renamed, or the same
 * as one already here, from the stories kept (`keptStories`). An import's entity has a note to
 * make or add to (`note`, entity design 7.1): it comes from the transcript, so it stays when its
 * stories are left out, and a relationship from a story left out is tied to a note instead. The
 * button's entities (no `note`) go with their last story, and their relationships with theirs.
 * A new name another kept entity of another type answers to is not taken: the two would be one
 * title, and one link. Of the same type they are one, and saving joins them.
 */
export function applyGraphPatch(
  p: GraphProposal,
  patch: GraphPatch,
  keptStories: ReadonlySet<string>,
): GraphProposal {
  const leave = new Set(patch.leave ?? []);
  const noParagraph = new Set(patch.leaveParagraph ?? []);
  const kept = p.entities.filter(
    (e) => !leave.has(e.ref) && (!!e.note || e.mentions.some((m) => keptStories.has(m.story))),
  );
  /** another kept entity, of another type, answers to this name: as named, or as renamed */
  const elsewhere = (e: ProposedEntity, name: string) =>
    kept.some(
      (o) =>
        o.ref !== e.ref &&
        o.type !== e.type &&
        [o.name, cleanName(patch.rename?.[o.ref])].some((n) => n && matchKey(n) === matchKey(name)),
    );
  const entities: ProposedEntity[] = [];
  for (const e of kept) {
    const mentions = e.mentions.filter((m) => keptStories.has(m.story));
    const next: ProposedEntity = { ...e, mentions };
    const name = cleanName(patch.rename?.[e.ref]);
    if (name && matchKey(name) && name !== e.name && !elsewhere(e, name)) {
      next.aliases = [...(e.aliases ?? []), e.name];
      next.name = name;
    }
    const same = patch.same?.[e.ref];
    const isSame = !!same && UUID_RE.test(same);
    // a paragraph for a note already here, or for the note of the entity it is the same as
    if (noParagraph.has(e.ref) && e.note && (e.note.kind === 'existing' || isSame))
      next.description = [];
    if (isSame) {
      next.match = { kind: 'existing', entityId: same, name: '' };
      // the note that entity has is looked up at save (notePlan)
      if (e.note) next.note = { kind: 'new' };
    }
    entities.push(next);
  }
  const live = new Map(entities.map((e) => [e.ref, e]));
  const relationships = p.relationships.flatMap((r) => {
    const a = live.get(r.a);
    if (leave.has(r.ref) || !a || !live.has(r.b)) return [];
    if (r.story === null || keptStories.has(r.story)) return [r];
    // an import's relationship outlives its story: saving ties one with no story to its first
    // entity's note (entity design 7.2). The button's entities have no note to tie it to.
    return a.note ? [{ ...r, story: null }] : [];
  });
  return { ...p, entities, relationships };
}

/**
 * The stories' links as the reviewer left the proposal: a link to an entity left out becomes the
 * words it shows, and one to an entity renamed follows its new name. The preview links each by
 * its name (stories/workflow.ts), so a link to a name another kept entity still answers to is
 * left as it is: it may be that one's.
 */
export function relinkMemories(
  memories: Array<{ body: string }>,
  before: GraphProposal,
  after: GraphProposal,
): void {
  const kept = new Map(after.entities.map((e) => [e.ref, e]));
  const keptBefore = before.entities.filter((e) => kept.has(e.ref));
  const keptNames = new Set(keptBefore.map((e) => normalizeTitle(e.name)));
  // the kept entities still called by the name they were linked by, by that name
  const still = new Map<string, string[]>();
  for (const e of keptBefore) {
    const key = normalizeTitle(e.name);
    if (normalizeTitle(kept.get(e.ref)!.name) === key)
      still.set(key, [...(still.get(key) ?? []), e.ref]);
  }
  const unlink = new Set<string>();
  const to = new Map<string, string>();
  for (const e of before.entities) {
    const key = normalizeTitle(e.name);
    const now = kept.get(e.ref);
    if (!now) {
      if (!keptNames.has(key)) unlink.add(key);
    } else if (now.name !== e.name && !(still.get(key) ?? []).some((r) => r !== e.ref)) {
      to.set(key, now.name);
    }
  }
  if (unlink.size === 0 && to.size === 0) return;
  for (const m of memories) m.body = relink(m.body, unlink, to);
}

/** the stories a proposal's mentions and relationships name, each once */
export const storiesOf = (p: GraphProposal): string[] => [
  ...new Set([
    ...p.entities.flatMap((e) => e.mentions.map((m) => m.story)),
    ...p.relationships.flatMap((r) => (r.story === null ? [] : [r.story])),
  ]),
];

/** what each line came from, with the interview it was in once that is known */
const withInterview = (sources: GraphSource[], interviewId: string | null): GraphSource[] =>
  sources.map((s) => ('interviewId' in s && s.interviewId === null ? { ...s, interviewId } : s));

/**
 * Write a proposal: each entity resolved to one already here (chosen, matched, or of the same
 * name or alias by now) or made new with this run's id; then its mentions on the saved stories,
 * the relationships between them, and the descriptions of every entity touched.
 */
export async function saveGraph(
  client: PoolClient,
  o: {
    archiveId: string;
    userId: string;
    runId: string;
    proposal: GraphProposal | undefined;
    /** a memory id ("m1") or note id → the saved story's note id */
    storyNote: ReadonlyMap<string, string>;
    interviewId: string | null;
  },
): Promise<{ entities: number; relationships: number }> {
  const p = o.proposal;
  if (!p || p.pending || p.entities.length === 0) return { entities: 0, relationships: 0 };
  const idOf = new Map<string, string>();
  const touched = new Set<string>();
  for (const e of p.entities) {
    const key = matchKey(e.name);
    if (!key) continue;
    let id: string | null = null;
    if (e.match.kind === 'existing') {
      const r = await client.query(
        `select e.id from public.graph_entities e
          where e.id = $1 and e.archive_id = $2 and ${entityVisibleSql('e', '$3')}`,
        [e.match.entityId, o.archiveId, o.userId],
      );
      id = (r.rows[0] as { id: string } | undefined)?.id ?? null;
    }
    // one name, one entity: a name or alias of the same key, made since the preview, is it
    id ??=
      (
        (
          await client.query(
            `select id from public.graph_entities
              where archive_id = $1 and type = $2 and match_key = $3
             union all
             select g.entity_id from public.graph_aliases g
              where g.archive_id = $1 and g.match_key = $3
             limit 1`,
            [o.archiveId, e.type, key],
          )
        ).rows[0] as { id: string } | undefined
      )?.id ?? null;
    if (!id) {
      const made = await client.query(
        `insert into public.graph_entities (archive_id, type, name, match_key, created_by, run_id)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (archive_id, type, match_key) do update set updated_at = now()
         returning id`,
        [o.archiveId, e.type, e.name, key, o.userId, o.runId],
      );
      id = (made.rows[0] as { id: string }).id;
    }
    idOf.set(e.ref, id);
    touched.add(id);
    // the name it was proposed by, and a name it had before the reviewer renamed it
    await addAliases(client, o.archiveId, id, [e.name, ...(e.aliases ?? [])]);
    for (const m of e.mentions) {
      const note = o.storyNote.get(m.story);
      if (!note) continue;
      await client.query(
        `insert into public.graph_mentions (archive_id, entity_id, note_id, words, line, sources, run_id)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)
         on conflict (entity_id, note_id) do nothing`,
        [
          o.archiveId,
          id,
          note,
          m.words,
          m.line,
          JSON.stringify(withInterview(m.sources, o.interviewId)),
          o.runId,
        ],
      );
    }
  }
  let relationships = 0;
  for (const r of p.relationships) {
    const a = idOf.get(r.a);
    const b = idOf.get(r.b);
    // a relationship no story tells has no story note to hang on (yet)
    const note = r.story === null ? undefined : o.storyNote.get(r.story);
    if (!a || !b || a === b || !note) continue;
    const made = await client.query(
      `insert into public.graph_relationships
         (archive_id, a_id, b_id, description, note_id, sources, run_id, created_by)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       on conflict do nothing`,
      [
        o.archiveId,
        a,
        b,
        r.description,
        note,
        JSON.stringify(withInterview(r.sources, o.interviewId)),
        o.runId,
        o.userId,
      ],
    );
    relationships += made.rowCount ?? 0;
  }
  await rebuildDescriptions(client, o.archiveId, [...touched]);
  return { entities: touched.size, relationships };
}

/**
 * An entity's description: its lines, from the stories every member can see, oldest first
 * (graph design 3.1). A private story's lines are never in it.
 */
export async function rebuildDescriptions(
  client: PoolClient,
  archiveId: string,
  ids: readonly string[] | null,
): Promise<void> {
  await client.query(
    `update public.graph_entities e
        set description = coalesce((
              select left(string_agg(m.line, ' ' order by s.occurred nulls last, s.created_at), 1000)
                from public.graph_mentions m join public.notes s on s.id = m.note_id
               where m.entity_id = e.id and m.line <> ''
                 and coalesce((select a.kind from public.audiences a where a.note_id = s.id),
                              'archive-members') <> 'private-to-author'), ''),
            updated_at = now()
      where e.archive_id = $1 and ($2::uuid[] is null or e.id = any($2::uuid[]))`,
    [archiveId, ids],
  );
}

/**
 * Take a run's graph back (graph design 5.3). An import's own stories are erased by its undo,
 * and their mentions and relationships with them; a graph-only run (`everything`) has its rows
 * deleted here. Then the entities the run made go, unless someone has worked on them since:
 * changed them by hand, written a note about them, or another import names them.
 */
export async function undoGraph(
  client: PoolClient,
  archiveId: string,
  runId: string,
  opts: { everything?: boolean } = {},
): Promise<void> {
  if (opts.everything) {
    await client.query(`delete from public.graph_mentions where run_id = $1 and archive_id = $2`, [
      runId,
      archiveId,
    ]);
    await client.query(
      `delete from public.graph_relationships where run_id = $1 and archive_id = $2`,
      [runId, archiveId],
    );
  }
  await client.query(
    `delete from public.graph_entities e
      where e.run_id = $1 and e.archive_id = $2 and e.note_id is null
        and not exists (select 1 from public.graph_changes c where c.entity_id = e.id)
        and not exists (select 1 from public.graph_mentions m where m.entity_id = e.id)
        and not exists (select 1 from public.graph_relationships r
                         where r.a_id = e.id or r.b_id = e.id)`,
    [runId, archiveId],
  );
  await rebuildDescriptions(client, archiveId, null);
}
