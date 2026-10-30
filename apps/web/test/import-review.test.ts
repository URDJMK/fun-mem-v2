import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { Review, Saved } from '../src/components/ImportRun';
import { Linked } from '../src/components/NoteText';
import type { ImportOutcome } from '../src/lib/api';

const outcome = (overrides: Partial<ImportOutcome> = {}): ImportOutcome => ({
  status: 'previewed',
  format: 'stories',
  memories: [],
  interviewees: [],
  speakers: [],
  degraded: { windows: 0 },
  graph: {
    entities: [
      {
        ref: 'e1',
        name: 'Sarah',
        type: 'person',
        match: { kind: 'new' },
        note: { kind: 'new' },
        mentions: [{ story: 'm1', words: ['Sarah'], line: '' }],
      },
    ],
    relationships: [],
  },
  ...overrides,
});
const renderReview = (value: ImportOutcome) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(Review, {
        archiveId: 'a1',
        jobId: 'j1',
        outcome: value,
        name: 'Noah',
        onSaved: () => {},
      }),
    ),
  );
const renderSaved = (value: ImportOutcome) =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(Saved, { archiveId: 'a1', outcome: value })),
  );

describe('the import review', () => {
  it('identifies graph-only review and completion by format, not an empty memories array', () => {
    expect(renderReview(outcome())).toContain('No stories in this one');
    expect(renderReview(outcome())).not.toContain('import-save');
    expect(renderReview(outcome({ format: 'graph' }))).toContain('Save them');
    expect(renderSaved(outcome())).toContain('Added to the project');
    expect(renderSaved(outcome({ format: 'graph' }))).toContain('Added to the graph');
  });

  it('passes proposed notes through the story preview so their visible words are dashed', () => {
    const html = renderReview(
      outcome({
        memories: [
          {
            id: 'm1',
            title: 'School days',
            type: 'event',
            occurred: null,
            body: '[[Sarah|his friend]] came.',
            notes: [],
            method: 'story',
            speaker: '',
          },
        ],
      }),
    );
    expect(html).toContain(
      '<span class="proposed-link" title="A new note, made when you save">his friend</span>',
    );
    expect(html).not.toContain('[[Sarah');
  });

  it('renders saved note links as usable links alongside proposed spans and plain left-out names', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(Linked, {
          text: '[[Sarah]] and [[Tom]] met [[Mother|Mom]].',
          archiveId: 'a1',
          notes: [{ id: 'n1', title: 'Mother', type: 'person', occurred: null, revised: null }],
          proposed: new Map([
            ['sarah', true],
            ['tom', false],
          ]),
        }),
      ),
    );
    expect(html).toContain('class="proposed-link"');
    expect(html).toContain('Sarah</span> and Tom met <a');
    expect(html).toContain('data-testid="note-link"');
    expect(html).toContain('>Mom</a>');
  });
});
