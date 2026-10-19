import { describe, expect, it } from 'vitest';
import { ensureAnchor, extractAnchors } from '../src/anchors';

const BODY = 'First memory. ^b1\n\n## School\n\nSecond thing. ^b2\n\n```\ncode ^not-real\n```\n';

describe('block anchors', () => {
  it('block anchors are stable across unrelated edits', () => {
    const before = extractAnchors(BODY);
    expect(before.map((a) => a.id)).toEqual(['b1', 'b2']); // code fences are not anchors
    const edited = BODY.replace('First memory.', 'First memory, retold at length in 2026.');
    const after = extractAnchors(edited);
    // ids survive because they are literal text in the body — never regenerated on parse
    expect(after.map((a) => a.id)).toEqual(['b1', 'b2']);
    expect(after[0]!.text).toContain('retold');
    expect(after[1]).toEqual(before[1]);
  });

  it('ensureAnchor is idempotent and collision-safe', () => {
    let n = 0;
    const gen = () => ['b1', 'b1', 'fresh'][n++]!; // first two collide with an existing id
    const { body, id } = ensureAnchor(BODY, 2, gen); // "## School" line
    expect(id).toBe('fresh');
    expect(body.split('\n')[2]).toBe('## School ^fresh');
    const again = ensureAnchor(body, 2, gen);
    expect(again).toEqual({ body, id: 'fresh' }); // already anchored: unchanged
  });
});
