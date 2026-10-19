export const ENTITY_TYPES = ['person', 'place', 'event', 'period', 'object', 'source'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export interface FuzzyDate {
  /** Original text, preserved byte-for-byte: '1994' | '1994-07' | '1994-07-15' | '~1948' | 'unknown' */
  raw: string;
  kind: 'exact' | 'month' | 'year' | 'approx' | 'unknown';
  year?: number;
  month?: number;
  day?: number;
}

export interface NoteMeta {
  type: EntityType;
  /** When the remembered thing happened (fuzzy — memories are like that). */
  occurred?: FuzzyDate;
  /** When it was told/captured (ISO datetime). */
  recorded?: string;
  /** Last revision time (ISO datetime). */
  revised?: string;
  contributors?: string[];
  /** Unknown frontmatter keys, preserved losslessly — humans edit these files. */
  extra: Record<string, unknown>;
}

export interface Note {
  /** Immutable UUID; never derived from the title (spec §4.4/§4.5). */
  readonly id: string;
  title: string;
  meta: NoteMeta;
  body: string;
}
