import { matchKey } from '@funmem/core';
import type { Range } from '../stories/lines';
import type { FindResult } from './find';
import type { Listed, Mark } from './marks';
import { findIn, sourcesOf } from './shared';
import type { KnownEntity } from './store';
import type { GraphProposal, GraphSource, ProposedEntity, ProposedMention } from './types';

/**
 * What an import's stories are written with, from what the Entity step found, and the proposal
 * for review once they are written (entity design 6): who each story names, and which story tells
 * each relationship. Pure: no AI, no database.
 */

/** what the stories are written with */
export interface Cast {
  /** every entity found, the protagonist too: what the marks are checked against */
  listed: Listed[];
  byRef: Map<string, Listed>;
  /** for the writer, one per line: `ref  Name (type): ways` */
  forWriter: string;
  /** for the planner, one per line: `Name (type)` */
  forPlanner: string;
  /**
   * names, aliases and note titles (matchKey) never linked by title: those found, which the marks
   * link once, and the protagonist's, who is never linked
   */
  taken: Set<string>;
}

/** a story as written: the lines it was planned from, its sentences as kept, and their marks */
export interface Made {
  ranges: readonly Range[];
  sentences: ReadonlyArray<{ text: string; cites: readonly Range[] }>;
  marks: ReadonlyArray<ReadonlyArray<Mark>>;
}

/** the protagonist's names: the name, those they go by, and their note's title */
const subjectNames = (known: readonly KnownEntity[]): string[] =>
  known
    .filter((k) => k.subject)
    .flatMap((k) => [k.name, ...k.aliases, ...(k.note ? [k.note.title] : [])]);

/**
 * The list the planner and the writer are given (never the protagonist), and what the marks are
 * checked against. Without a find (`null`) it lists no one; the protagonist, known from the
 * project's graph, is still never linked by title.
 */
export function castOf(found: FindResult | null, known: readonly KnownEntity[] = []): Cast {
  const entities = found?.entities ?? [];
  const listed: Listed[] = entities.map((e) => ({
    ref: e.ref,
    name: e.name,
    aliases: e.aliases ?? [],
    ways: e.ways ?? [],
    ...(e.subject ? { subject: true } : {}),
  }));
  const others = entities.filter((e) => !e.subject);
  return {
    listed,
    byRef: new Map(listed.map((l) => [l.ref, l])),
    forWriter: others
      .map(
        (e) => `${e.ref}  ${e.name} (${e.type})${e.ways?.length ? `: ${e.ways.join(', ')}` : ''}`,
      )
      .join('\n'),
    forPlanner: others.map((e) => `${e.name} (${e.type})`).join('\n'),
    taken: new Set(
      [
        ...entities.flatMap((e) => [
          e.name,
          ...(e.aliases ?? []),
          ...(e.note?.kind === 'existing' ? [e.note.title] : []),
        ]),
        ...subjectNames(known),
      ]
        .map(matchKey)
        .filter(Boolean),
    ),
  };
}

/**
 * Where a story (`story`, its memory id) names an entity: one mention, with every distinct word it
 * uses, and the first sentence naming it as the line. The protagonist is never marked: they are
 * found by any of their names (`names`), so Home still counts the stories they are in.
 */
export function mentionIn(
  e: ProposedEntity,
  m: Made,
  story: string,
  names: readonly string[] = [],
): ProposedMention[] {
  const called = [...new Set([e.name, ...(e.aliases ?? []), ...names])].sort(
    (a, b) => b.length - a.length,
  );
  const words = m.sentences.map((s, i) =>
    e.subject
      ? called
          .map((n) => findIn(s.text, n))
          .filter((w): w is string => w !== null)
          .slice(0, 1)
      : (m.marks[i] ?? []).filter((k) => k.e === e.ref).map((k) => k.words),
  );
  const first = words.findIndex((w) => w.length > 0);
  if (first < 0) return [];
  return [
    {
      story,
      words: [...new Set(words.flat())],
      line: m.sentences[first]!.text,
      sources: sourcesOf(m.sentences[first]!.cites),
    },
  ];
}

/**
 * The story (by `ids`, one per story) whose planned lines hold the first interview line `sources`
 * cite: the first such story; null when no story uses that line.
 */
export function storyOf(
  sources: readonly GraphSource[],
  made: readonly Made[],
  ids: readonly string[],
): string | null {
  const lines = sources.flatMap((s) => ('from' in s && s.from > 0 ? [s.from] : []));
  if (lines.length === 0) return null;
  const line = Math.min(...lines);
  const at = made.findIndex((m) => m.ranges.some((r) => line >= r.from && line <= r.to));
  return at < 0 ? null : (ids[at] ?? null);
}

/**
 * The proposal for review: each entity found with its mentions in the stories as written (`made`,
 * named by `ids`), and each relationship tied to the story telling it, or to none. A protagonist
 * the find left out is added when the stories name them.
 */
export function withStories(
  found: FindResult,
  made: readonly Made[],
  o: { ids: readonly string[]; known?: readonly KnownEntity[] },
): GraphProposal {
  const known = o.known ?? [];
  const also = subjectNames(known);
  const mentions = (e: ProposedEntity) =>
    made.flatMap((m, i) => mentionIn(e, m, o.ids[i]!, e.subject ? also : []));
  const entities = found.entities.map((e) => ({ ...e, mentions: mentions(e) }));
  let next = Math.max(0, ...entities.map((e) => Number(e.ref.slice(1)) || 0));
  for (const k of known.filter((x) => x.subject)) {
    const listed = entities.some(
      (e) => e.subject || (e.match.kind === 'existing' && e.match.entityId === k.id),
    );
    if (listed) continue;
    const e: ProposedEntity = {
      ref: `e${++next}`,
      name: k.name,
      type: k.type,
      match: { kind: 'existing', entityId: k.id, name: k.name },
      mentions: [],
      aliases: [...k.aliases],
      ways: [],
      description: [],
      note: k.note ? { kind: 'existing', ...k.note } : { kind: 'new' },
      subject: true,
    };
    e.mentions = mentions(e);
    if (e.mentions.length) entities.push(e);
  }
  return {
    entities,
    relationships: found.relationships.map((r) => ({
      ...r,
      story: storyOf(r.sources, made, o.ids),
    })),
    stats: found.stats,
  };
}
