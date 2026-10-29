import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  GraphReview,
  keptCount,
  NO_CHOICES,
  patchOf,
  type GraphChoices,
} from '../src/components/GraphReview';
import type { EntitySummary, GraphProposal, ProposedEntity } from '../src/lib/api';

const entity = (overrides: Partial<ProposedEntity> = {}): ProposedEntity => ({
  ref: 'e1',
  name: 'Sarah',
  type: 'person',
  match: { kind: 'new' },
  mentions: [{ story: 'm1', words: ['Sarah'], line: 'Sarah came.' }],
  note: { kind: 'new' },
  description: [
    { text: 'Sarah came to school.', sources: [{ interviewId: null, from: 2, to: 3 }] },
  ],
  ...overrides,
});
const graph = (...entities: ProposedEntity[]): GraphProposal => ({ entities, relationships: [] });
const choices = (overrides: Partial<GraphChoices> = {}): GraphChoices => ({
  ...NO_CHOICES,
  paragraphOut: new Set(),
  ...overrides,
});
const markup = (proposal: GraphProposal, selected = choices(), kept = () => true) =>
  renderToStaticMarkup(
    createElement(GraphReview, {
      archiveId: 'a1',
      graph: proposal,
      choices: selected,
      onChange: () => {},
      storyTitle: (id) => {
        expect(id).not.toBeNull();
        return 'School days';
      },
      storyKept: (id) => {
        expect(id).not.toBeNull();
        return kept();
      },
    }),
  );

describe('graph review choices', () => {
  it('sends paragraph choices without leaving the entity or its links out', () => {
    expect(patchOf(choices({ paragraphOut: new Set(['e1']) }))).toEqual({
      leaveParagraph: ['e1'],
    });
    expect(patchOf(NO_CHOICES)).toEqual({});
  });

  it('keeps import entities after their last story is left out, excludes the subject and old button entities', () => {
    const p = graph(
      entity(),
      entity({ ref: 'subject', name: 'Noah', subject: true }),
      entity({ ref: 'button', note: undefined }),
    );
    expect(keptCount(p, choices(), () => false)).toBe(1);
    expect(keptCount(p, choices({ out: new Set(['e1']) }), () => false)).toBe(0);
    expect(keptCount(p, choices(), () => true)).toBe(2);
  });
});

describe('reading the proposed notes', () => {
  it('hides the protagonist and shows checked description sentences with new-note badges', () => {
    const html = markup(graph(entity(), entity({ ref: 'subject', name: 'Noah', subject: true })));
    expect(html).toContain('Sarah came to school.');
    expect(html).toContain('New note');
    expect(html).not.toContain('<strong>Noah</strong>');
  });

  it('lets an existing note keep its links without the added paragraph', () => {
    const p = graph(entity({ note: { kind: 'existing', noteId: 'n1', title: 'Sarah Lee' } }));
    expect(markup(p)).toContain('Adds to “Sarah Lee”');
    expect(markup(p)).toContain('Leave the paragraph out');
    const left = markup(p, choices({ paragraphOut: new Set(['e1']) }));
    expect(left).toContain('Links to “Sarah Lee”');
    expect(left).toContain('Keep the paragraph');
  });

  it('explains how links read after a new note is left out', () => {
    expect(markup(graph(entity()), choices({ out: new Set(['e1']) }))).toContain(
      'Its links in the stories become plain words',
    );
  });

  it('warns about an ignored rename and keeps the original name in the row', () => {
    const html = markup(
      graph(entity(), entity({ ref: 'e2', name: 'Busan', type: 'place' })),
      choices({ rename: { e1: 'Busan' } }),
    );
    expect(html).toContain('<strong>Sarah</strong>');
    expect(html).toContain('This rename will be ignored.');
    expect(html).toContain('kept place');
  });

  it('offers the paragraph choice for Same as an entity whose note already exists', () => {
    const known: EntitySummary = {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Sarah Lee',
      type: 'person',
      noteId: 'n1',
      subject: false,
      aliases: [],
      stories: 1,
    };
    const html = renderToStaticMarkup(
      createElement(GraphReview, {
        archiveId: 'a1',
        graph: graph(entity()),
        choices: choices({ same: { e1: known.id } }),
        onChange: () => {},
        storyTitle: () => 'School days',
        storyKept: () => true,
        knownEntities: [known],
        noteTitles: new Map([['n1', 'Sarah at school']]),
      }),
    );
    expect(html).toContain('Adds to “Sarah at school”');
    expect(html).toContain('Leave the paragraph out');
  });

  it('shows interview relationships safely and keeps import relationships after story skip', () => {
    const p = graph(entity(), entity({ ref: 'e2', name: 'Tom' }));
    p.relationships = [
      { ref: 'r1', a: 'e1', b: 'e2', description: 'Sarah’s brother', story: null },
      { ref: 'r2', a: 'e1', b: 'e2', description: 'Her school friend', story: 'm1' },
    ];
    const html = markup(p, choices(), () => false);
    expect(html).toContain('from the interview');
    expect(html).not.toContain('gr-gone');
  });
});
