import { describe, expect, it } from 'vitest';
import type { FindResult } from '../src/graph/find';
import { castOf, withStories, type Made } from '../src/graph/proposal';
import type { KnownEntity } from '../src/graph/store';
import type { ProposedEntity } from '../src/graph/types';

/**
 * What the stories are written with, and the proposal for review once they are written (entity
 * design 6): who is listed for the writer and the planner, which titles are left to the marks,
 * and where each story names each one. Pure: no AI, no database.
 */
const SUNJA: KnownEntity = {
  id: 'k-sunja',
  name: 'Sunja Kim',
  type: 'person',
  aliases: ['Sunja'],
  subject: true,
  note: { noteId: 'n-sunja', title: 'Grandma Sunja' },
};
const entity = (ref: string, name: string, more: Partial<ProposedEntity> = {}): ProposedEntity => ({
  ref,
  name,
  type: 'person',
  match: { kind: 'new' },
  mentions: [],
  ways: [],
  description: [],
  note: { kind: 'new' },
  ...more,
});
const SUNJA_FOUND = entity('e1', 'Sunja Kim', {
  match: { kind: 'existing', entityId: 'k-sunja', name: 'Sunja Kim' },
  note: { kind: 'existing', noteId: 'n-sunja', title: 'Grandma Sunja' },
  aliases: ['Sunja'],
  subject: true,
});
const MINHO = entity('e2', 'Minho', { ways: ['her husband'] });
const BUSAN = entity('e3', 'Busan', {
  type: 'place',
  aliases: ['Pusan'],
  match: { kind: 'existing', entityId: 'k-busan', name: 'Busan' },
  note: { kind: 'existing', noteId: 'n-busan', title: 'Busan (place)' },
});
const line = (from: number) => ({ interviewId: null, from, to: from });
const told = (ref: string, a: string, b: string, description: string, lines: number[]) => ({
  ref,
  a,
  b,
  description,
  story: null,
  sources: lines.map(line),
});
const found = (entities: ProposedEntity[]): FindResult => ({
  entities,
  relationships: [
    told('r1', 'e2', 'e1', 'Minho — her husband', [8]),
    // its first line is the one that counts, whatever order it is cited in
    told('r2', 'e3', 'e1', 'Busan — where she was born', [6, 4]),
    told('r3', 'e2', 'e3', 'Minho — visited Busan', [2]),
  ],
  stats: { calls: 3, proposed: 6, dropped: 0, left: [] },
});
const cite = (from: number) => ({ from, to: from });
const HARBOUR: Made = {
  ranges: [{ from: 3, to: 6 }],
  sentences: [
    // the profile (P) is never a source
    { text: 'Grandma Sunja was born in Busan.', cites: [cite(0), cite(4)] },
    { text: 'Busan was by the sea.', cites: [cite(6)] },
  ],
  marks: [[{ e: 'e3', words: 'Busan' }], [{ e: 'e3', words: 'Busan' }]],
};
const GRAVY: Made = {
  ranges: [{ from: 7, to: 8 }],
  sentences: [
    { text: 'Sunja met Minho at a church supper.', cites: [cite(8)] },
    { text: 'Her husband spilled gravy.', cites: [cite(8)] },
  ],
  marks: [[{ e: 'e2', words: 'Minho' }], [{ e: 'e2', words: 'Her husband' }]],
};

describe('castOf', () => {
  it('lists who is in it for the writer and the planner, without the person it is about', () => {
    const cast = castOf(found([SUNJA_FOUND, MINHO, BUSAN]), [SUNJA]);
    expect(cast.forWriter).toBe('e2  Minho (person): her husband\ne3  Busan (place)');
    expect(cast.forPlanner).toBe('Minho (person)\nBusan (place)');
    expect(cast.listed.map((l) => [l.ref, l.subject ?? false])).toEqual([
      ['e1', true],
      ['e2', false],
      ['e3', false],
    ]);
    expect(cast.byRef.get('e3')!.aliases).toEqual(['Pusan']);
  });

  it('leaves to the marks every name, alias and note title found', () => {
    const cast = castOf(found([MINHO, BUSAN]), []);
    expect([...cast.taken].sort()).toEqual(['busan', 'busan place', 'minho', 'pusan']);
  });

  it('never links the person it is about by title, though the find left them out or failed', () => {
    for (const cast of [castOf(found([MINHO, BUSAN]), [SUNJA]), castOf(null, [SUNJA])]) {
      expect(cast.taken).toContain('sunja kim');
      expect(cast.taken).toContain('sunja');
      expect(cast.taken).toContain('grandma sunja');
    }
    const none = castOf(null, [SUNJA]);
    expect([none.listed, none.forWriter, none.forPlanner]).toEqual([[], '', '']);
    expect(castOf(null).taken.size).toBe(0);
  });
});

describe('withStories', () => {
  const ids = ['m7', 'm9'];

  it('gives each story naming an entity one mention, with every word it used, by the ids given', () => {
    const g = withStories(found([SUNJA_FOUND, MINHO, BUSAN]), [HARBOUR, GRAVY], {
      ids,
      known: [SUNJA],
    });
    const of = (name: string) => g.entities.find((e) => e.name === name)!.mentions;
    expect(of('Busan')).toEqual([
      {
        story: 'm7',
        words: ['Busan'],
        line: 'Grandma Sunja was born in Busan.',
        sources: [line(4)],
      },
    ]);
    expect(of('Minho')).toEqual([
      {
        story: 'm9',
        words: ['Minho', 'Her husband'],
        line: 'Sunja met Minho at a church supper.',
        sources: [line(8)],
      },
    ]);
    expect(g.stats).toEqual({ calls: 3, proposed: 6, dropped: 0, left: [] });
  });

  it('finds the person it is about by any name they go by, the title of their note too', () => {
    const g = withStories(found([SUNJA_FOUND, MINHO, BUSAN]), [HARBOUR, GRAVY], {
      ids,
      known: [SUNJA],
    });
    expect(g.entities[0]!.mentions.map((m) => [m.story, m.words, m.line])).toEqual([
      ['m7', ['Grandma Sunja'], 'Grandma Sunja was born in Busan.'],
      ['m9', ['Sunja'], 'Sunja met Minho at a church supper.'],
    ]);
  });

  it('adds the person it is about when the find left them out, with where the stories name them', () => {
    const g = withStories(found([MINHO, BUSAN]), [HARBOUR, GRAVY], { ids, known: [SUNJA] });
    expect(g.entities.map((e) => e.ref)).toEqual(['e2', 'e3', 'e4']);
    expect(g.entities[2]).toMatchObject({
      name: 'Sunja Kim',
      type: 'person',
      match: { kind: 'existing', entityId: 'k-sunja' },
      note: { kind: 'existing', noteId: 'n-sunja', title: 'Grandma Sunja' },
      aliases: ['Sunja'],
      subject: true,
    });
    expect(g.entities[2]!.mentions.map((m) => m.story)).toEqual(['m7', 'm9']);
    // nobody the stories do not name
    const quiet = withStories(found([MINHO, BUSAN]), [], { ids: [], known: [SUNJA] });
    expect(quiet.entities).toHaveLength(2);
  });

  it('ties a relationship to the first story whose lines hold the first line it cites, or to none', () => {
    const g = withStories(found([SUNJA_FOUND, MINHO, BUSAN]), [HARBOUR, GRAVY], {
      ids,
      known: [SUNJA],
    });
    expect(g.relationships.map((r) => [r.ref, r.story])).toEqual([
      ['r1', 'm9'],
      ['r2', 'm7'],
      ['r3', null],
    ]);
  });
});
