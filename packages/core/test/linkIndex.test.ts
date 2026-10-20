import { describe, expect, it } from 'vitest';
import { LinkIndex } from '../src/linkIndex';
import type { Note } from '../src/types';

const note = (id: string, title: string, body: string): Note => ({
  id,
  title,
  meta: { type: 'event', extra: {} },
  body,
});

const ZOE = note('u-zoe', 'Zo\u{EB}', '# About Zo\u{EB}\n');
const BEACH = note(
  'u-beach',
  'Beach Trip',
  'We went with [[Zo\u{EB}]] to the sea. ^b1\n\nAlso [[Uncle Joe|joe]] came, twice: [[Uncle Joe]].\n',
);

describe('link index', () => {
  it('indexes occurrences with source target position and snippet', () => {
    const idx = new LinkIndex();
    idx.upsert(ZOE);
    idx.upsert(BEACH);
    const rows = idx.snapshot();
    expect(rows).toHaveLength(3); // one row PER occurrence — Uncle Joe twice
    const zoeRow = rows.find((r) => r.target === 'Zo\u{EB}')!;
    expect(zoeRow).toMatchObject({ sourceId: 'u-beach', resolvedId: 'u-zoe', embed: false });
    expect(BEACH.body.slice(zoeRow.start, zoeRow.end)).toBe('[[Zo\u{EB}]]');
    expect(zoeRow.snippet).toBe('We went with [[Zo\u{EB}]] to the sea. ^b1');
  });

  it('resolves case-insensitively and enumerates unresolved deterministically', () => {
    const idx = new LinkIndex();
    idx.upsert(note('u-a', 'A', 'link [[beach trip]] before target exists; [[Zed]] and [[aunt]].'));
    // unresolved groups sorted by normalized title; occurrences by (sourceId, start)
    expect(idx.unresolved().map((g) => g.title)).toEqual(['aunt', 'beach trip', 'zed']);
    idx.upsert(note('u-bt', 'BEACH TRIP', 'the trip note'));
    expect(idx.unresolved().map((g) => g.title)).toEqual(['aunt', 'zed']);
    expect(idx.backlinks('u-bt')).toHaveLength(1);
    // removing the target demotes its backlinks to unresolved again
    idx.remove('u-bt');
    expect(idx.backlinks('u-bt')).toEqual([]);
    expect(idx.unresolved().map((g) => g.title)).toEqual(['aunt', 'beach trip', 'zed']);
  });

  it('incremental updates equal a full rebuild', () => {
    const a = note('u-a', 'Alpha', 'see [[Beta]] and [[Gamma]]');
    const b = note('u-b', 'Beta', 'back to [[Alpha]]');
    const idx = new LinkIndex();
    idx.upsert(a);
    idx.upsert(b);
    const g = note('u-g', 'Gamma', 'new note mentioning [[beta|B]]');
    idx.upsert(g);
    const a2 = note('u-a', 'Alpha', 'edited: now only [[Gamma#^b1]]'); // edit drops the Beta link
    idx.upsert(a2);
    idx.upsert(note('u-b', 'Beta Renamed', 'back to [[Alpha]]')); // title change: [[beta]] must demote
    idx.remove('u-g');
    const rebuilt = LinkIndex.rebuild([a2, note('u-b', 'Beta Renamed', 'back to [[Alpha]]')]);
    // content equality of canonical snapshots — never row counts
    expect(idx.snapshot()).toEqual(rebuilt.snapshot());
    expect(idx.unresolved()).toEqual(rebuilt.unresolved());
  });

  it('backlinks are queryable per target with snippets', () => {
    const idx = new LinkIndex();
    idx.upsert(ZOE);
    idx.upsert(BEACH);
    idx.upsert(note('u-k', 'Kitchen', '[[Zo\u{EB}]] cooked here.\n'));
    const back = idx.backlinks('u-zoe');
    expect(back.map((r) => r.sourceId).sort()).toEqual(['u-beach', 'u-k']);
    expect(back.find((r) => r.sourceId === 'u-k')!.snippet).toBe('[[Zo\u{EB}]] cooked here.');
    // derived, not truth: re-upserting a source replaces its rows exactly
    idx.upsert(note('u-k', 'Kitchen', 'no links now.\n'));
    expect(idx.backlinks('u-zoe').map((r) => r.sourceId)).toEqual(['u-beach']);
  });
});
