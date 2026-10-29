import { extractWikilinks, matchKey, normalizeTitle } from '@funmem/core';
import type { EntitySummary, GraphPatch, GraphProposal, ProposedEntity } from './api';

export interface GraphChoices {
  out: Set<string>;
  rename: Record<string, string>;
  same: Record<string, string>;
  paragraphOut: Set<string>;
}

export const NO_CHOICES: GraphChoices = {
  out: new Set(),
  rename: {},
  same: {},
  paragraphOut: new Set(),
};

export const patchOf = (c: GraphChoices): GraphPatch => ({
  ...(c.out.size ? { leave: [...c.out] } : {}),
  ...(Object.keys(c.rename).length ? { rename: c.rename } : {}),
  ...(Object.keys(c.same).length ? { same: c.same } : {}),
  ...(c.paragraphOut.size ? { leaveParagraph: [...c.paragraphOut] } : {}),
});

type StoryKept = (story: string) => boolean;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keep these name and selection rules in step with graph/save.ts: applyGraphPatch. */
export const cleanRename = (raw: string | undefined): string =>
  (raw ?? '')
    .replace(/[[\]#^|\p{Cc}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

export const entityKept = (e: ProposedEntity, c: GraphChoices, storyKept: StoryKept): boolean =>
  !c.out.has(e.ref) && (!!e.note || e.mentions.some((m) => storyKept(m.story)));

export function keptCount(graph: GraphProposal, c: GraphChoices, storyKept: StoryKept): number {
  return graph.entities.filter((e) => !e.subject && entityKept(e, c, storyKept)).length;
}

/** A requested rename may collide with another type's original or requested name. */
export function renameConflict(
  e: ProposedEntity,
  graph: GraphProposal,
  c: GraphChoices,
  storyKept: StoryKept,
  raw = c.rename[e.ref],
): ProposedEntity | undefined {
  const name = cleanRename(raw);
  if (!name || name === e.name || !matchKey(name) || !entityKept(e, c, storyKept)) return undefined;
  return graph.entities.find(
    (o) =>
      o.ref !== e.ref &&
      o.type !== e.type &&
      entityKept(o, c, storyKept) &&
      [o.name, cleanRename(c.rename[o.ref])].some((n) => n && matchKey(n) === matchKey(name)),
  );
}

/** The effective graph, including ignored renames and relationships whose story was left out. */
export function reviewedGraph(
  p: GraphProposal,
  c: GraphChoices,
  storyKept: StoryKept,
): GraphProposal {
  const entities = p.entities
    .filter((e) => entityKept(e, c, storyKept))
    .map((e) => {
      const next = { ...e, mentions: e.mentions.filter((m) => storyKept(m.story)) };
      const name = cleanRename(c.rename[e.ref]);
      if (name && matchKey(name) && name !== e.name && !renameConflict(e, p, c, storyKept)) {
        next.name = name;
        next.aliases = [...(e.aliases ?? []), e.name];
      }
      const same = c.same[e.ref];
      const isSame = !!same && UUID.test(same);
      if (c.paragraphOut.has(e.ref) && e.note && (e.note.kind === 'existing' || isSame))
        next.description = [];
      if (isSame) {
        next.match = { kind: 'existing', entityId: same, name: '' };
        if (e.note) next.note = { kind: 'new' };
      }
      return next;
    });
  const live = new Map(entities.map((e) => [e.ref, e]));
  return {
    ...p,
    entities,
    relationships: p.relationships.flatMap((r) => {
      const a = live.get(r.a);
      if (c.out.has(r.ref) || !a || !live.has(r.b)) return [];
      if (r.story === null || storyKept(r.story)) return [r];
      return a.note ? [{ ...r, story: null }] : [];
    }),
  };
}

/** graph/marks.ts: relink — preserve labels, embeds, fragments and every > marker line. */
function relink(
  body: string,
  unlink: ReadonlySet<string>,
  to: ReadonlyMap<string, string>,
): string {
  let out = '';
  let at = 0;
  for (const l of extractWikilinks(body)) {
    if (l.embed || l.heading || l.blockId || body[body.lastIndexOf('\n', l.start - 1) + 1] === '>')
      continue;
    const key = normalizeTitle(l.target);
    const next = to.get(key);
    if (!unlink.has(key) && next === undefined) continue;
    const shown = l.alias?.trim() || l.target;
    const replacement = unlink.has(key)
      ? shown
      : shown === next
        ? `[[${next}]]`
        : `[[${next}|${shown}]]`;
    out += body.slice(at, l.start) + replacement;
    at = l.end;
  }
  return out + body.slice(at);
}

/**
 * graph/save.ts: relinkMemories, then the preview's known note choices (linkStories).
 * Shared names retain a still-named entity's links; the first kept entity owns a title.
 * Save resolves note titles again, including any collisions that arose after this preview.
 */
export function previewStory(
  body: string,
  before: GraphProposal,
  c: GraphChoices,
  storyKept: StoryKept,
  known: readonly EntitySummary[] = [],
  notes: ReadonlyArray<{ id: string; title: string }> = [],
): { body: string; proposed: ReadonlyMap<string, boolean> } {
  const after = reviewedGraph(before, c, storyKept);
  const kept = new Map(after.entities.map((e) => [e.ref, e]));
  const keptBefore = before.entities.filter((e) => kept.has(e.ref));
  const keptNames = new Set(keptBefore.map((e) => normalizeTitle(e.name)));
  const still = new Map<string, string[]>();
  for (const e of keptBefore) {
    const key = normalizeTitle(e.name);
    if (normalizeTitle(kept.get(e.ref)!.name) === key)
      still.set(key, [...(still.get(key) ?? []), e.ref]);
  }
  const unlink = new Set<string>();
  const to = new Map<string, string>();
  const proposed = new Map<string, boolean>();
  for (const e of before.entities) {
    if (e.subject) continue;
    const key = normalizeTitle(e.name);
    const now = kept.get(e.ref);
    if (!now) {
      if (!keptNames.has(key)) {
        unlink.add(key);
        proposed.set(key, false);
      }
    } else if (now.name !== e.name && !(still.get(key) ?? []).some((r) => r !== e.ref))
      to.set(key, now.name);
  }
  let shown = relink(body, unlink, to);
  const noteUnlink = new Set<string>();
  const targets = new Map<string, string>();
  for (const e of after.entities) {
    if (!e.note || e.subject) continue;
    const key = normalizeTitle(e.name);
    if (targets.has(key)) continue;
    const same = c.same[e.ref];
    const selected = same && UUID.test(same) ? known.find((k) => k.id === same) : undefined;
    if (selected?.subject) {
      noteUnlink.add(key);
      proposed.set(key, false);
      continue;
    }
    const title = selected
      ? ((selected.noteId ? notes.find((n) => n.id === selected.noteId)?.title : undefined) ??
        selected.name)
      : e.note.kind === 'existing'
        ? e.note.title
        : e.name;
    targets.set(key, title);
    const titleKey = normalizeTitle(title);
    if (!selected?.noteId && e.note.kind === 'new') proposed.set(titleKey, true);
    else proposed.delete(titleKey);
  }
  for (const key of targets.keys()) noteUnlink.delete(key);
  shown = relink(shown, noteUnlink, targets);
  return { body: shown, proposed };
}
