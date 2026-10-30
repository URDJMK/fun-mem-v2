import { describe, expect, it } from 'vitest';
import { noteAndLinkChecks } from '../scripts/graph-eval-checks';
import type { GraphProposal } from '../src/graph/types';

const graph: GraphProposal = {
  entities: [
    {
      ref: 'e1',
      name: 'Noah Kim',
      type: 'person',
      match: { kind: 'new' },
      subject: true,
      mentions: [],
    },
    {
      ref: 'e2',
      name: 'Seaweed soup',
      type: 'thing',
      match: { kind: 'new' },
      note: { kind: 'new' },
      mentions: [],
    },
  ],
  relationships: [],
};

describe('the real-model eval checks, without calling a model', () => {
  it('fails when no story survived the model checks', () => {
    expect(noteAndLinkChecks(graph, [], ['Noah Kim'])).toContainEqual({
      label: 'at least one story',
      ok: false,
    });
  });
  it('accepts notes for non-subject entities and real prose links in every story', () => {
    expect(
      noteAndLinkChecks(
        graph,
        [{ title: 'Birthdays', body: 'His mother made [[Seaweed soup|soup]].' }],
        ['Noah Kim', 'Noah'],
      ).every((c) => c.ok),
    ).toBe(true);
  });

  it('reports entities with no note, stories without prose links, and aliased subject links', () => {
    const missing: GraphProposal = {
      ...graph,
      entities: graph.entities.map((e) => ({ ...e, note: undefined })),
    };
    const checks = noteAndLinkChecks(
      missing,
      [
        { title: 'Only a marker', body: 'Soup.\n> ⚠ May disagree with [[Other story]].' },
        { title: 'Subject', body: '[[NOAH KIM|He]] ate soup.' },
        { title: 'Nickname', body: '[[Noah]] ate soup.' },
      ],
      ['Noah Kim', 'Noah'],
    );
    expect(checks.filter((c) => !c.ok).map((c) => c.label)).toEqual([
      'a note for Seaweed soup',
      'prose links in “Only a marker”',
      'no protagonist link in “Subject”',
      'no protagonist link in “Nickname”',
    ]);
  });
});
