import { describe, expect, it } from 'vitest';
import { chunkNote } from '../src/chunk';

describe('chunkNote', () => {
  it('core chunker splits at headings and blocks with stable anchors', () => {
    const body = [
      'Intro paragraph. ^intro', // block above any heading, authored anchor
      '',
      '# Childhood',
      '',
      'We lived by the sea.',
      '',
      'It was warm. ^warm',
      '',
      '## The Beach',
      '',
      '```',
      '# not a heading (fenced)',
      '',
      'still one block',
      '```',
      '',
      'Closing line.',
    ].join('\n');

    const chunks = chunkNote(body);

    // offsets are exact: every chunk slices back to its content
    for (const c of chunks) expect(body.slice(c.start, c.end)).toBe(c.content);
    // chunk_index is 0-based and contiguous
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));

    // block above the first heading keeps its authored anchor, empty heading
    const intro = chunks[0]!;
    expect(intro.content).toContain('Intro paragraph.');
    expect(intro.anchor).toBe('intro');
    expect(intro.heading).toBe('');

    // heading text and full path are captured
    const warm = chunks.find((c) => c.content.includes('It was warm'))!;
    expect(warm.heading).toBe('Childhood');
    expect(warm.headingPath).toEqual(['Childhood']);
    expect(warm.anchor).toBe('warm');

    // nested heading path
    const fenced = chunks.find((c) => c.content.includes('still one block'))!;
    expect(fenced.headingPath).toEqual(['Childhood', 'The Beach']);
    // the fence is ONE chunk — the '# not a heading' inside is not a split point
    expect(fenced.content).toContain('# not a heading (fenced)');
    expect(fenced.content).toContain('still one block');

    // a block with no authored anchor reports null (never a fabricated one)
    const closing = chunks.find((c) => c.content.includes('Closing line'))!;
    expect(closing.anchor).toBeNull();

    // empty / whitespace-only body yields no chunks
    expect(chunkNote('')).toEqual([]);
    expect(chunkNote('   \n\n  ')).toEqual([]);

    // deterministic: same body, byte-identical chunks
    expect(chunkNote(body)).toEqual(chunks);
  });

  it('keeps a heading anchor out of the heading text and cites it in the section', () => {
    // panel finding: `# Title ^h` must not leak ` ^h` into heading/headingPath,
    // and the heading's own anchor should still be citable
    const body = '# Origins ^h1\n\nThe first paragraph.\n\n## Later ^h2\n\nMore. ^m';
    const chunks = chunkNote(body);
    for (const c of chunks) expect(body.slice(c.start, c.end)).toBe(c.content);

    const first = chunks.find((c) => c.content.includes('first paragraph'))!;
    expect(first.heading).toBe('Origins'); // NOT 'Origins ^h1'
    expect(first.headingPath).toEqual(['Origins']);
    expect(first.anchor).toBe('h1'); // heading's anchor attributed to its section

    const later = chunks.find((c) => c.content.includes('More.'))!;
    expect(later.headingPath).toEqual(['Origins', 'Later']); // clean nested path
    // a chunk's OWN authored anchor wins over the heading's
    expect(later.anchor).toBe('m');
  });
});
