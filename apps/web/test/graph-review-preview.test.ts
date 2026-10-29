import { describe, expect, it } from 'vitest';
import type { EntitySummary, GraphProposal, ProposedEntity } from '../src/lib/api';
import {
  cleanRename,
  NO_CHOICES,
  previewStory,
  renameConflict,
  reviewedGraph,
  type GraphChoices,
} from '../src/lib/graph-review';
import { piecesOf } from '../src/lib/links';

const entity = (overrides: Partial<ProposedEntity> = {}): ProposedEntity => ({
  ref: 'e1',
  name: 'Sarah',
  type: 'person',
  match: { kind: 'new' },
  mentions: [{ story: 'm1', words: ['Sarah'], line: '' }],
  note: { kind: 'new' },
  ...overrides,
});
const graph = (...entities: ProposedEntity[]): GraphProposal => ({ entities, relationships: [] });
const choices = (overrides: Partial<GraphChoices> = {}): GraphChoices => ({
  ...NO_CHOICES,
  ...overrides,
});
const all = () => true;

describe('the graph review follows the save rules', () => {
  it('cleans names like the server, including title delimiters, control characters, spaces and the cap', () => {
    expect(cleanRename('  [Mina] #^|  Kim\n Park\u0000  ')).toBe('Mina Kim Park');
    expect(cleanRename('a'.repeat(250))).toHaveLength(200);
  });

  it('warns about and ignores a rename onto another kept type, but allows one left out or the same type', () => {
    const sarah = entity();
    const busan = entity({ ref: 'e2', name: 'Busan', type: 'place' });
    const p = graph(sarah, busan);
    const c = choices({ rename: { e1: ' The [Busan] ' } });
    expect(renameConflict(sarah, p, c, all)?.ref).toBe('e2');
    expect(reviewedGraph(p, c, all).entities[0]!.name).toBe('Sarah');
    const left = choices({ ...c, out: new Set(['e2']) });
    expect(renameConflict(sarah, p, left, all)).toBeUndefined();
    expect(reviewedGraph(p, left, all).entities[0]!.name).toBe('The Busan');
    expect(
      renameConflict(sarah, graph(sarah, { ...busan, type: 'person' }), c, all),
    ).toBeUndefined();
  });

  it('also rejects collisions with a different type’s requested rename', () => {
    const p = graph(entity(), entity({ ref: 'e2', name: 'Korea', type: 'place' }));
    const c = choices({ rename: { e1: 'Busan', e2: 'Busan' } });
    expect(reviewedGraph(p, c, all).entities.map((e) => e.name)).toEqual(['Sarah', 'Korea']);
  });

  it('keeps an import relationship after story skip but drops the old button relationship', () => {
    const p = graph(entity(), entity({ ref: 'e2', name: 'Tom' }));
    p.relationships = [{ ref: 'r1', a: 'e1', b: 'e2', description: 'Her brother', story: 'm1' }];
    expect(reviewedGraph(p, choices(), () => false).relationships[0]!.story).toBeNull();
    const old = { ...p, entities: p.entities.map((e) => ({ ...e, note: undefined })) };
    expect(reviewedGraph(old, choices(), () => false).relationships).toEqual([]);
  });
});

describe('previewing a story’s links', () => {
  it('renames link targets, retaining visible words and every line that starts with >', () => {
    const p = graph(entity());
    const body =
      '[[Sarah]] met [[Sarah|her friend]].\n>[[Sarah]]\n>> [[Sarah]]\n> source [[Sarah|S]].\n![[Sarah]] [[Sarah#School]] [[Sarah^block]]';
    const result = previewStory(body, p, choices({ rename: { e1: ' Mina [Kim] ' } }), all);
    expect(result.body).toBe(
      '[[Mina Kim|Sarah]] met [[Mina Kim|her friend]].\n>[[Sarah]]\n>> [[Sarah]]\n> source [[Sarah|S]].\n![[Sarah]] [[Sarah#School]] [[Sarah^block]]',
    );
    expect(result.proposed.get('mina kim')).toBe(true);
    expect(p.entities[0]!.name).toBe('Sarah');
  });

  it('previews an ignored cross-type rename with its original target', () => {
    const p = graph(entity(), entity({ ref: 'e2', name: 'Busan', type: 'place' }));
    const result = previewStory(
      '[[Sarah|his friend]]',
      p,
      choices({ rename: { e1: 'Busan' } }),
      all,
    );
    expect(result.body).toBe('[[Sarah|his friend]]');
    expect(piecesOf(result.body, [], { proposed: result.proposed })).toEqual([
      { kind: 'proposed', label: 'his friend' },
    ]);
  });

  it('removes left-out links but never changes their marker lines', () => {
    const result = previewStory(
      '[[Sarah|his friend]] came.\n> [[Sarah]]',
      graph(entity()),
      choices({ out: new Set(['e1']) }),
      all,
    );
    expect(result.body).toBe('his friend came.\n> [[Sarah]]');
    expect(result.proposed.get('sarah')).toBe(false);
  });

  it('can rename a kept note onto a left-out name without unlinking its renamed links', () => {
    const p = graph(entity(), entity({ ref: 'e2', name: 'Tom' }));
    const result = previewStory(
      '[[Sarah]] and [[Tom]].',
      p,
      choices({ out: new Set(['e2']), rename: { e1: 'Tom' } }),
      all,
    );
    expect(result.body).toBe('[[Tom|Sarah]] and Tom.');
    expect(result.proposed.get('tom')).toBe(true);
  });

  it('keeps a saved destination usable even when a left-out proposal had that title', () => {
    const p = graph(
      entity({ note: { kind: 'existing', noteId: 'n1', title: 'Tom' } }),
      entity({ ref: 'e2', name: 'Tom' }),
    );
    const result = previewStory(
      '[[Sarah]] and [[Tom]].',
      p,
      choices({ out: new Set(['e2']) }),
      all,
    );
    expect(result.body).toBe('[[Tom|Sarah]] and Tom.');
    expect(
      piecesOf(result.body, [{ id: 'n1', title: 'Tom' }], { proposed: result.proposed }),
    ).toEqual([
      { kind: 'link', label: 'Sarah', noteId: 'n1' },
      { kind: 'text', text: ' and Tom.' },
    ]);
  });

  it('lets the first kept entity of a shared name keep its links', () => {
    const first = entity({ name: 'Busan', type: 'place' });
    const second = entity({
      ref: 'e2',
      name: 'Busan',
      note: { kind: 'existing', noteId: 'n1', title: 'Busan Kim' },
    });
    const p = graph(first, second);
    const both = previewStory('[[Busan]]', p, choices(), all);
    expect(both.body).toBe('[[Busan]]');
    expect(both.proposed.get('busan')).toBe(true);
    const onlySecond = previewStory('[[Busan]]', p, choices({ out: new Set(['e1']) }), all);
    expect(onlySecond.body).toBe('[[Busan Kim|Busan]]');
    expect(onlySecond.proposed.has('busan kim')).toBe(false);
    // A remaining entity still called Busan owns these links when the other is renamed.
    const renamed = previewStory('[[Busan]]', p, choices({ rename: { e1: 'Seoul' } }), all);
    expect(renamed.body).toBe('[[Busan Kim|Busan]]');
  });

  it('keeps existing note links usable, including the note selected with Same as', () => {
    const known: EntitySummary[] = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Sarah Lee',
        type: 'person',
        noteId: 'n1',
        subject: false,
        aliases: [],
        stories: 1,
      },
    ];
    const notes = [{ id: 'n1', title: 'Sarah at school' }];
    const result = previewStory(
      '[[Sarah|his friend]]',
      graph(entity()),
      choices({ same: { e1: known[0]!.id } }),
      all,
      known,
      notes,
    );
    expect(result.body).toBe('[[Sarah at school|his friend]]');
    expect(piecesOf(result.body, notes, { proposed: result.proposed })).toEqual([
      { kind: 'link', label: 'his friend', noteId: 'n1' },
    ]);
  });

  it('uses the selected entity’s name for the new note when Same as has no note yet', () => {
    const known: EntitySummary[] = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Sarah Lee',
        type: 'person',
        noteId: null,
        subject: false,
        aliases: [],
        stories: 1,
      },
    ];
    const result = previewStory(
      '[[Sarah|his friend]]',
      graph(entity()),
      choices({ same: { e1: known[0]!.id } }),
      all,
      known,
    );
    expect(result.body).toBe('[[Sarah Lee|his friend]]');
    expect(result.proposed.get('sarah lee')).toBe(true);
  });
});
