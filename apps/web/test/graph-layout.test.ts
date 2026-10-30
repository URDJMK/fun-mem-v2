import { describe, expect, it } from 'vitest';
import { layout } from '../src/lib/graph-layout';
import type { GraphView } from '../src/lib/api';

/** Where Home's graph puts each node (graph design 6.1): the same every time, inside the frame. */
const VIEW: GraphView = {
  nodes: [
    { id: 'noah', name: 'Noah Kim', type: 'person', stories: 3, subject: true, noteId: 'n' },
    { id: 'sarah', name: 'Sarah Lee', type: 'person', stories: 2, subject: false, noteId: null },
    { id: 'tom', name: 'Tom Lee', type: 'person', stories: 1, subject: false, noteId: null },
    { id: 'busan', name: 'Busan', type: 'place', stories: 1, subject: false, noteId: null },
    { id: 'mina', name: 'Mina', type: 'person', stories: 1, subject: false, noteId: null },
  ],
  told: [
    { a: 'noah', b: 'sarah', lines: [] },
    { a: 'sarah', b: 'tom', lines: [] },
  ],
  together: [{ a: 'sarah', b: 'busan', stories: 1 }],
  more: 0,
};

describe('layout', () => {
  it('places every node inside the frame, the protagonist in the middle', () => {
    const at = layout(VIEW, { width: 600, height: 400 });
    expect(at.size).toBe(5);
    for (const p of at.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(600);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(400);
    }
    expect(at.get('noah')).toEqual({ x: 300, y: 200 });
  });

  it('is the same every time', () => {
    expect([...layout(VIEW, { width: 600, height: 400 })]).toEqual([
      ...layout(VIEW, { width: 600, height: 400 }),
    ]);
  });

  it('keeps a node with no lines further out than those joined to the middle', () => {
    const at = layout(VIEW, { width: 600, height: 400 });
    const far = (id: string) => Math.hypot(at.get(id)!.x - 300, at.get(id)!.y - 200);
    expect(far('mina')).toBeGreaterThan(far('sarah'));
  });
});
