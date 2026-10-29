import { matchKey, normalizeTitle } from '@funmem/core';
import type { PoolClient } from 'pg';
import { UUID_RE } from '../membership';
import { appendParagraph, type NewNoteInput } from '../notes';
import { relink } from './marks';
import { addAliases } from './note-entity';
import { NOT_IN_TITLE } from './shared';
import { entityVisibleSql, sharedNoteSql } from './store';
import {
  NOTE_TYPE,
  type DescriptionSentence,
  type EntityType,
  type GraphPatch,
  type GraphProposal,
  type GraphSource,
  type NoteRef,
  type ProposedEntity,
} from './types';

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

/** one entity per name: of this type and key, or the one this is an alias of */
async function entityIdByName(
  client: PoolClient,
  archiveId: string,
  type: EntityType,
  key: string,
): Promise<string | null> {
  const r = await client.query(
    `select id from public.graph_entities
      where archive_id = $1 and type = $2 and match_key = $3
     union all
     select g.entity_id from public.graph_aliases g
      where g.archive_id = $1 and g.match_key = $3
     limit 1`,
    [archiveId, type, key],
  );
  return (r.rows[0] as { id: string } | undefined)?.id ?? null;
}

/**
 * The entity a proposed one is: the one chosen or matched, when the member can see it; else one
 * of the same name or alias, made since the preview.
 */
async function entityIdOf(
  client: PoolClient,
  o: { archiveId: string; userId: string },
  e: ProposedEntity,
  key: string,
): Promise<string | null> {
  if (e.match.kind === 'existing') {
    const r = await client.query(
      `select e.id from public.graph_entities e
        where e.id = $1 and e.archive_id = $2 and ${entityVisibleSql('e', '$3')}`,
      [e.match.entityId, o.archiveId, o.userId],
    );
    const id = (r.rows[0] as { id: string } | undefined)?.id;
    if (id) return id;
  }
  return entityIdByName(client, o.archiveId, e.type, key);
}

/** a note to make, with the entity it is for (when there is one) and its name and type */
export type MakeNote = { kind: 'make'; entityId: string | null; name: string; type: EntityType };

/**
 * What each of an import's entities gets at save, decided again now: the project may have changed
 * since the preview (entity design 7.2). A note to make; the note it has, for a paragraph and the
 * links; or none, for the protagonist and for an entity whose note not every member may read (as
 * `sharedTitles` decides what a story may link to: the stories are read by every member).
 */
export type NoteChoice =
  MakeNote | ({ kind: 'existing'; entityId: string } & NoteRef) | { kind: 'none' };

const NONE: NoteChoice = { kind: 'none' };

/**
 * Each import entity's note, read from the project as it is now (the preview's `note` may be
 * stale, and is null for a note the member cannot see). Refs that end as one entity, or with one
 * name and type, share one choice: they get one note. The button's entities (no `note`) get none.
 */
export async function notePlan(
  client: PoolClient,
  archiveId: string,
  userId: string,
  p: GraphProposal | undefined,
): Promise<Map<string, NoteChoice>> {
  const out = new Map<string, NoteChoice>();
  if (!p || p.pending) return out;
  const shared = new Map<string, NoteChoice>();
  const once = (k: string, c: NoteChoice): NoteChoice => {
    if (!shared.has(k)) shared.set(k, c);
    return shared.get(k)!;
  };
  for (const e of p.entities) {
    if (!e.note) continue;
    const key = matchKey(e.name);
    if (e.subject || !key) {
      out.set(e.ref, NONE);
      continue;
    }
    const id = await entityIdOf(client, { archiveId, userId }, e, key);
    const r = id
      ? await client.query(
          `select e.name, e.type::text as type, e.note_id, n.title,
                  coalesce(e.note_id = a.subject_note_id, false) as subject,
                  (n.id is not null and ${sharedNoteSql('n')}) as shared
             from public.graph_entities e
             join public.archives a on a.id = e.archive_id
             left join public.notes n on n.id = e.note_id
            where e.id = $1 and e.archive_id = $2`,
          [id, archiveId],
        )
      : null;
    const row = r?.rows[0] as
      | {
          name: string;
          type: EntityType;
          note_id: string | null;
          title: string | null;
          subject: boolean;
          shared: boolean;
        }
      | undefined;
    // found by an alias of something of another type: not it
    const chosen = e.match.kind === 'existing' && e.match.entityId === id;
    if (!row || (row.type !== e.type && !chosen)) {
      const make: MakeNote = { kind: 'make', entityId: null, name: e.name, type: e.type };
      out.set(e.ref, once(`${e.type}:${key}`, make));
    } else if (row.subject) {
      out.set(e.ref, NONE);
    } else if (!row.note_id) {
      // its note is called by the entity's name, which `same` may have made another
      const make: MakeNote = { kind: 'make', entityId: id, name: row.name, type: row.type };
      out.set(e.ref, once(`id:${id}`, make));
    } else if (row.shared) {
      out.set(e.ref, { kind: 'existing', entityId: id!, noteId: row.note_id, title: row.title! });
    } else {
      // a note not every member may read (even the importer's own): the stories every member
      // reads do not link to it, and no paragraph or second note is made
      out.set(e.ref, NONE);
    }
  }
  return out;
}

/** a sentence as part of a paragraph: one line */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** a description sentence may not hold a real link, and never reads as a marker or source line */
const cleanSentence = (s: string): string =>
  oneLine(s)
    .replace(/[[\]]/g, '')
    .replace(/^(?:>+\s*)+/, '');

/** a note made with an import holds at most this many sentences, the same cap as the Entity step */
const MAX_SENTENCES = 4;

/** sentences as one paragraph */
const asParagraph = (said: readonly DescriptionSentence[]): string =>
  said.map((s) => cleanSentence(s.text)).join(' ');

/** sentences with words, each once, capped as a note's description is */
const sentencesOf = (all: readonly DescriptionSentence[]): DescriptionSentence[] => {
  const seen = new Set<string>();
  const out: DescriptionSentence[] = [];
  for (const s of all) {
    const k = oneLine(s.text);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= MAX_SENTENCES) break;
  }
  return out;
};

/** where each sentence comes from, as a note's `extra.sources` holds it */
const sourcesFor = (said: readonly DescriptionSentence[], interviewId: string | null) =>
  said.map((s) => ({
    sentence: cleanSentence(s.text),
    sources: withInterview(s.sources, interviewId),
  }));

/**
 * The notes to make with the stories (entity design 5.1): one per choice, its text the
 * description as one paragraph. `refs` are the entities it is for; `hint` tells it from a note of
 * the same title ("Busan (place)"). Grouped by an explicit key — the entity it already is, or its
 * type and name — never by object identity: a `plan` built another way must still merge correctly.
 */
export function entityNoteInputs(
  p: GraphProposal,
  plan: ReadonlyMap<string, NoteChoice>,
  interviewId: string | null,
): Array<{ refs: string[]; hint: string; input: NewNoteInput }> {
  const notes = new Map<
    string,
    { type: EntityType; name: string; refs: string[]; said: DescriptionSentence[] }
  >();
  for (const e of p.entities) {
    const c = plan.get(e.ref);
    if (c?.kind !== 'make') continue;
    const key = c.entityId ?? `${c.type}:${matchKey(c.name)}`;
    const x = notes.get(key) ?? { type: c.type, name: c.name, refs: [], said: [] };
    x.refs.push(e.ref);
    x.said.push(...(e.description ?? []));
    notes.set(key, x);
  }
  return [...notes.values()].map((x) => {
    const said = sentencesOf(x.said);
    return {
      refs: x.refs,
      hint: x.type,
      input: {
        title: cleanName(x.name),
        type: NOTE_TYPE[x.type],
        body: asParagraph(said),
        entity: false,
        extra: { sources: sourcesFor(said, interviewId) },
      },
    };
  });
}

/** `_..._` would otherwise be read as emphasis, and break on a name the family actually uses */
const escapeEmphasis = (s: string): string => s.replace(/[_*]/g, '\\$&');

/**
 * A paragraph for a note already here (entity design 5.2): the interview, then what it says. One
 * line, so no line of it reads as a source line ("> Told by").
 */
export const paragraphText = (interviewName: string, said: readonly DescriptionSentence[]) =>
  `_From “${escapeEmphasis(oneLine(interviewName))}”:_ ${asParagraph(said)}`;

/**
 * The stories' links to people, places and things, pointed at their notes' final titles (`made`,
 * by ref, for the notes made with them); a link to one with no note every member may read becomes
 * its words. The protagonist's are left as they are. `linked` holds the title each name's links
 * carry now, so a save tried again moves them again.
 */
export function linkStories(
  memories: Array<{ body: string }>,
  p: GraphProposal | undefined,
  plan: ReadonlyMap<string, NoteChoice>,
  made: ReadonlyMap<string, string>,
  linked: Map<string, string>,
): void {
  const unlink = new Set<string>();
  const to = new Map<string, string>();
  const moved = new Map<string, string>();
  for (const e of p?.entities ?? []) {
    const c = plan.get(e.ref);
    if (!c || e.subject) continue;
    const name = normalizeTitle(e.name);
    const now = normalizeTitle(linked.get(name) ?? e.name);
    const title = c.kind === 'existing' ? c.title : c.kind === 'make' ? made.get(e.ref) : undefined;
    if (c.kind === 'none') unlink.add(now);
    // two entities of different types can share one name ("Busan" the place and a person called
    // it too); the first proposed keeps that name's links, so a later one never steals them
    else if (title !== undefined && !to.has(now)) {
      to.set(now, title);
      moved.set(name, title);
    }
  }
  for (const k of to.keys()) unlink.delete(k);
  if (unlink.size === 0 && to.size === 0) return;
  for (const m of memories) m.body = relink(m.body, unlink, to);
  for (const [name, title] of moved) linked.set(name, title);
}

/** an import's notes for its people, places and things (persistImport) */
export interface EntityNotes {
  plan: ReadonlyMap<string, NoteChoice>;
  /** an entity ref → the note made for it with the stories */
  made: ReadonlyMap<string, string>;
  /** what a paragraph says it is from */
  interviewName: string;
  changeId: string;
}

/**
 * The entity a proposed one is saved as: for an import's, the one its note was planned with (made
 * now, or given the note made for it); else the one chosen, matched or of the same name, or made
 * new with this run's id.
 */
async function entityFor(
  client: PoolClient,
  o: { archiveId: string; userId: string; runId: string; notes?: EntityNotes },
  e: ProposedEntity,
  key: string,
): Promise<string> {
  const c = o.notes?.plan.get(e.ref);
  const made = o.notes?.made.get(e.ref);
  if (c?.kind === 'existing') return c.entityId;
  if (c?.kind === 'make' && made && c.entityId) {
    // Refs that share one choice attach the same note more than once. A different note means
    // another writer won: fail rather than leaving the new note without its entity.
    const r = await client.query(
      `update public.graph_entities set note_id = $2, updated_at = now()
        where id = $1 and (note_id is null or note_id = $2)
        returning note_id`,
      [c.entityId, made],
    );
    if ((r.rows[0] as { note_id: string } | undefined)?.note_id !== made) {
      throw new Error(`entityFor: entity ${c.entityId} already has a note; cannot attach ${made}`);
    }
    return c.entityId;
  }
  const make = c?.kind === 'make' && made ? c : null;
  const id = make ? null : await entityIdOf(client, o, e, key);
  if (id) return id;
  const r = await client.query(
    `insert into public.graph_entities (archive_id, type, name, match_key, note_id, created_by, run_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (archive_id, type, match_key) do update
        set note_id = coalesce(public.graph_entities.note_id, excluded.note_id), updated_at = now()
     returning id, note_id`,
    make
      ? [o.archiveId, make.type, make.name, matchKey(make.name), made, o.userId, o.runId]
      : [o.archiveId, e.type, e.name, key, null, o.userId, o.runId],
  );
  const row = r.rows[0] as { id: string; note_id: string | null };
  if (make && row.note_id !== made) {
    throw new Error(`entityFor: entity ${row.id} already has a note; cannot attach ${made}`);
  }
  return row.id;
}

/**
 * Write a proposal: each entity resolved to one already here (chosen, matched, or of the same
 * name or alias by now) or made new with this run's id, and an import's tied to its note; the
 * paragraphs for notes already here; then its mentions on the saved stories, the relationships
 * between them, and the descriptions of every entity touched.
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
    /** an import's: what each entity gets, and the notes made for them; the button's have none */
    notes?: EntityNotes;
  },
): Promise<{ entities: number; relationships: number }> {
  const p = o.proposal;
  if (!p || p.pending || p.entities.length === 0) return { entities: 0, relationships: 0 };
  const idOf = new Map<string, string>();
  /** an entity ref → its note: what a relationship no story tells hangs on */
  const noteOf = new Map<string, string>();
  /** a note already here → what this interview adds to it */
  const paragraphs = new Map<string, DescriptionSentence[]>();
  const touched = new Set<string>();
  for (const e of p.entities) {
    const key = matchKey(e.name);
    if (!key) continue;
    const id = await entityFor(client, o, e, key);
    idOf.set(e.ref, id);
    touched.add(id);
    const c = o.notes?.plan.get(e.ref);
    const made = o.notes?.made.get(e.ref);
    if (made) noteOf.set(e.ref, made);
    else if (c?.kind === 'existing') {
      noteOf.set(e.ref, c.noteId);
      paragraphs.set(c.noteId, [...(paragraphs.get(c.noteId) ?? []), ...(e.description ?? [])]);
    }
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
  // one paragraph per note, in note order: the order every writer locks notes in
  if (o.notes) {
    for (const noteId of [...paragraphs.keys()].sort()) {
      const said = sentencesOf(paragraphs.get(noteId)!);
      if (said.length === 0) continue;
      const added = await appendParagraph(client, {
        archiveId: o.archiveId,
        noteId,
        userId: o.userId,
        text: paragraphText(o.notes.interviewName, said),
        sources: sourcesFor(said, o.interviewId),
        runId: o.runId,
        changeId: o.notes.changeId,
      });
      // too long for the note, or it vanished mid-save: nothing else in this run depends on it
      if (!added) console.error(`[graph] paragraph refused for note ${noteId} (run ${o.runId})`);
    }
  }
  let relationships = 0;
  for (const r of p.relationships) {
    const a = idOf.get(r.a);
    const b = idOf.get(r.b);
    // told in a story, it hangs on that story; told in none, on its first entity's note
    const note = r.story === null ? (noteOf.get(r.a) ?? noteOf.get(r.b)) : o.storyNote.get(r.story);
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
