import type { StoriesPendingReason } from '../ingest-pipeline';

/**
 * The people, places and things graph (docs/superpowers/specs/2026-10-28-people-places-graph-design.md):
 * entities apart from notes, what each story says about them, and the relationships told.
 */
export type EntityType = 'person' | 'place' | 'thing';

export const ENTITY_TYPES: readonly EntityType[] = ['person', 'place', 'thing'];

/** the note written about an entity has this type */
export const NOTE_TYPE: Record<EntityType, 'person' | 'place' | 'object'> = {
  person: 'person',
  place: 'place',
  thing: 'object',
};

/** a note of this type is about an entity of that type */
export const ENTITY_OF_NOTE: Readonly<Record<string, EntityType | undefined>> = {
  person: 'person',
  place: 'place',
  object: 'thing',
};

/** where a line comes from: interview lines, or one of a story's own sentences */
export type GraphSource =
  { interviewId: string | null; from: number; to: number } | { noteId: string; sentence: number };

export interface ProposedMention {
  /** the story: a memory id ("m1") in an import, a note id in a graph-only run */
  story: string;
  words: string[];
  line: string;
  sources: GraphSource[];
}

export type EntityMatch =
  | { kind: 'new' }
  | { kind: 'existing'; entityId: string; name: string }
  | { kind: 'ask'; candidates: Array<{ entityId: string; name: string }> };

export interface ProposedEntity {
  /** "e1", "e2": how relationships and the reviewer's choices name it */
  ref: string;
  name: string;
  type: EntityType;
  match: EntityMatch;
  mentions: ProposedMention[];
}

export interface ProposedRelationship {
  /** "r1", "r2" */
  ref: string;
  /** entity refs */
  a: string;
  b: string;
  description: string;
  story: string;
  sources: GraphSource[];
}

export interface GraphProposal {
  entities: ProposedEntity[];
  relationships: ProposedRelationship[];
  /** the Graph step could not run (yet); the stories are unaffected */
  pending?: { reason: StoriesPendingReason };
  stats?: { calls: number; proposed: number; dropped: number };
}

/** the reviewer's choices: the save body's `graph` */
export interface GraphPatch {
  /** entity or relationship refs left out */
  leave?: string[];
  /** entity ref → its new name */
  rename?: Record<string, string>;
  /** entity ref → the existing entity it is */
  same?: Record<string, string>;
}
