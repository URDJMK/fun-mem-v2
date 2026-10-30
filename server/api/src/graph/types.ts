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

/** one checked sentence about an entity, with the interview lines it comes from */
export interface DescriptionSentence {
  text: string;
  sources: GraphSource[];
}

/** a note, as an entity points to it */
export type NoteRef = { noteId: string; title: string };

/** the note an entity gets, as the preview saw it; decided again at save (notePlan) */
export type EntityNote = { kind: 'new' } | ({ kind: 'existing' } & NoteRef);

export interface ProposedEntity {
  /** "e1", "e2": how relationships and the reviewer's choices name it */
  ref: string;
  name: string;
  type: EntityType;
  match: EntityMatch;
  mentions: ProposedMention[];
  /** other names it goes by: the name it had before the reviewer renamed it */
  aliases?: string[];
  /** how the stories may call it, from the protagonist's side ("his mother", "Mom"); never aliases */
  ways?: string[];
  /** checked sentences about it from this interview: a new note's text, or a paragraph */
  description?: DescriptionSentence[];
  /** absent on the button's proposals (graph/step.ts): those make no notes */
  note?: EntityNote;
  /** the person the project is about: never linked, no paragraph */
  subject?: boolean;
}

export interface ProposedRelationship {
  /** "r1", "r2" */
  ref: string;
  /** entity refs */
  a: string;
  b: string;
  description: string;
  /** the story whose lines tell it; null when no story uses them (tied to a note at save) */
  story: string | null;
  sources: GraphSource[];
}

export interface GraphProposal {
  entities: ProposedEntity[];
  relationships: ProposedRelationship[];
  /** the Graph step could not run (yet); the stories are unaffected */
  pending?: { reason: StoriesPendingReason };
  stats?: {
    calls: number;
    proposed: number;
    dropped: number;
    /** what was left out and why (at most 30): where the prompt needs work */
    left?: Array<{ what: string; why: string }>;
  };
}

/** the reviewer's choices: the save body's `graph` */
export interface GraphPatch {
  /** entity or relationship refs left out */
  leave?: string[];
  /** entity ref → its new name */
  rename?: Record<string, string>;
  /** entity ref → the existing entity it is */
  same?: Record<string, string>;
  /** entity refs whose paragraph for an existing note is left out (their links stay) */
  leaveParagraph?: string[];
}
