import { describe, expect, it } from 'vitest';
import { chunkNote } from '../src/chunk';
import { extractAnchors, findDuplicateAnchors } from '../src/anchors';

/**
 * FM-037 — anchor uniqueness (defect D2).
 *
 * A duplicated `^id` made `noteUUID#^block` identify more than one span, breaking
 * FR-002's stable-anchor guarantee and FM-026's citation contract before FM-026
 * exists. Policy is FIRST-WINS SUPPRESSION inside the chunker: rejecting is
 * impossible in-fence (a throw from chunkNote becomes an opaque 500 and aborts
 * the rebuild transaction) and auto-reminting would violate the chunker's stated
 * no-mutation invariant and FR-060.
 */
describe('FM-037 anchor uniqueness', () => {
  it('no anchor id is carried by more than one chunk', () => {
    // `dup` appears FIRST on a heading (the inherited pendingAnchor path) and
    // again on an ordinary line (the direct anchorAt path). A fix that guards
    // only one of those two paths reds here.
    const body = [
      '# Wedding ^dup',
      '',
      'The ceremony was long.',
      '',
      '## Later',
      '',
      'We danced. ^dup',
      '',
      'A distinct line. ^solo',
    ].join('\n');

    const chunks = chunkNote(body);
    const carriers = chunks.filter((c) => c.anchor === 'dup');
    expect(carriers).toHaveLength(1);

    // WHICH one survives matters: last-wins would also satisfy a bare count
    const firstClaimant = chunks.find((c) => c.anchor === 'dup')!;
    const laterDup = chunks.find((c) => c.content.includes('We danced.'))!;
    expect(firstClaimant.index).toBeLessThan(laterDup.index);
    expect(laterDup.anchor).not.toBe('dup');

    // a legitimately distinct anchor must still survive — this is suppression of
    // duplicates, not global de-duplication of the anchor set
    expect(chunks.filter((c) => c.anchor === 'solo')).toHaveLength(1);

    // REVERSE ORDER, and this is the case that pins the inherited path: the id
    // is claimed FIRST by an ordinary line, then a later HEADING carries it and
    // its section would inherit. Guarding only `anchorAt.get(ln)` leaves this
    // open — the suppression must also apply where pendingAnchor is consumed.
    const reversed = chunkNote(['Alpha. ^dup', '', '# Later ^dup', '', 'Beta content.'].join('\n'));
    expect(reversed.filter((c) => c.anchor === 'dup')).toHaveLength(1);
    expect(reversed.find((c) => c.content.includes('Alpha.'))!.anchor).toBe('dup');
    expect(reversed.find((c) => c.content.includes('Beta content.'))!.anchor).toBeNull();
  });

  it('findDuplicateAnchors names every repeated id in first-appearance order', () => {
    const body = [
      'One. ^beta',
      '',
      'Two. ^alpha',
      '',
      'Three. ^beta',
      '',
      'Four. ^once',
      '',
      'Five. ^alpha',
    ].join('\n');

    // two DIFFERENT repeated ids, so reporting only the first one reds;
    // ordered by first appearance, so `beta` precedes `alpha`
    expect(findDuplicateAnchors(body)).toEqual(['beta', 'alpha']);
    expect(findDuplicateAnchors('Only. ^once')).toEqual([]);
  });

  it('suppression never mutates the body and stays deterministic', () => {
    const body = [
      '# Head ^same',
      '',
      'Alpha block. ^same',
      '',
      '```',
      'fenced ^same',
      '```',
      '',
      'Omega block. ^same',
    ].join('\n');

    const a = chunkNote(body);
    const b = chunkNote(body);
    expect(a).toEqual(b); // no Set/Map iteration-order dependence

    // the chunker must not have rewritten a single byte
    for (const c of a) expect(body.slice(c.start, c.end)).toBe(c.content);

    // every surviving anchor is still one the extractor actually found
    const authored = new Set(extractAnchors(body).map((x) => x.id));
    for (const c of a) if (c.anchor !== null) expect(authored.has(c.anchor)).toBe(true);

    expect(a.filter((c) => c.anchor === 'same')).toHaveLength(1);
  });
});
