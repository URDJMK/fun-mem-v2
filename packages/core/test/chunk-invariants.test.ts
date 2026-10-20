import { describe, expect, it } from 'vitest';
import { extractAnchors } from '../src/anchors';
import { chunkNote, type Chunk } from '../src/chunk';

/**
 * FM-031 — citation anchors must be trustworthy (audit §2.3).
 *
 * The oracle for "is this a real anchor, and where does it live" is
 * `extractAnchors` — a DIFFERENT module from the one under test — so the
 * chunker cannot pass these by agreeing with its own regex.
 */

/** Line index of every heading, so we can bound a chunk's section. */
function headingLines(body: string): number[] {
  const out: number[] = [];
  let inFence = false;
  body.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence && /^#{1,6}\s+\S/.test(line)) out.push(i);
  });
  return out;
}

/** Which line does this offset fall on? */
function lineOf(body: string, offset: number): number {
  return body.slice(0, offset).split('\n').length - 1;
}

/**
 * Seven invariants. Returns a list of human-readable violations (empty = good),
 * so a failure prints the counterexample instead of just "expected true".
 */
export function anchorViolations(body: string, chunks: Chunk[]): string[] {
  const out: string[] = [];
  const real = extractAnchors(body); // independent oracle
  const realIds = new Set(real.map((a) => a.id));
  // an id may legitimately repeat in an ill-formed body, so keep EVERY line it
  // occurs on — keying by id alone would make a duplicate look like an escape
  const anchorLines = new Map<string, number[]>();
  for (const a of real) anchorLines.set(a.id, [...(anchorLines.get(a.id) ?? []), a.line]);
  const heads = headingLines(body);

  chunks.forEach((c, i) => {
    // I1 — the chunker never rewrites the body
    if (body.slice(c.start, c.end) !== c.content) out.push(`I1 slice != content @${i}`);
    // I2 — contiguous, zero-based
    if (c.index !== i) out.push(`I2 index ${c.index} at position ${i}`);
    // I3 — ordered and non-overlapping
    if (i > 0 && c.start < chunks[i - 1]!.end) out.push(`I3 overlap @${i}`);
    // I4 — never a blank chunk
    if (c.content.trim() === '') out.push(`I4 blank chunk @${i}`);
    // I5 — heading agrees with the path it came from
    const tail = c.headingPath.length ? c.headingPath[c.headingPath.length - 1] : '';
    if (c.heading !== tail) out.push(`I5 heading '${c.heading}' != path tail '${tail}' @${i}`);

    // I8 — the heading breadcrumb must NEVER show a raw `^id` suffix. This is
    // FM-021 panel finding (a); it is persisted to chunks.heading/heading_path
    // and returned by /search, so a regression is user-visible. Without this
    // clause the mutant `if (am && am[2] === pendingAnchor)` -> `if (am)`
    // survives the whole suite (measured by the FM-031 panel).
    for (const t of [c.heading, ...c.headingPath]) {
      if (/\s\^[A-Za-z0-9-]+$/.test(t))
        out.push(`I8 heading text carries a raw anchor: '${t}' @${i}`);
    }

    if (c.anchor !== null) {
      // I6 — never invent an id the shared extractor denies
      if (!realIds.has(c.anchor)) out.push(`I6 FABRICATED anchor '${c.anchor}' @${i}`);
      else {
        // I7 — an anchor must belong to this chunk's own section: either it is
        // on one of the chunk's own lines, or it is on the heading line that
        // opens the section this chunk sits in.
        const lines = anchorLines.get(c.anchor)!;
        const first = lineOf(body, c.start);
        const last = lineOf(body, c.end);
        const openingHeading = [...heads].filter((h) => h < first).pop();
        // SOME occurrence of this id must be inside the chunk, or on the
        // heading line that opens the chunk's own section
        const ok = lines.some(
          (aLine) =>
            (aLine >= first && aLine <= last) ||
            (openingHeading !== undefined && aLine === openingHeading),
        );
        if (!ok) {
          out.push(
            `I7 anchor '${c.anchor}' (lines ${lines.join(',')}) escaped into section @${i} '${c.heading}'`,
          );
        }
      }
    }
  });
  return out;
}

const ADVERSARIAL: Array<[string, string]> = [
  ['the reported defect: empty sibling sections', '# A ^a1\n\n# B\n\n# C\n\n# D\n\nd text'],
  ['empty parent, nested child', '# A ^a1\n\n## B\n\nb text'],
  ['empty section then a fence', '# A ^a1\n\n# B\n\n```\ncode\n```'],
  ['level skip', '# A ^a1\n\n### C\n\nc text'],
  ['trailing spaces after the anchor', '# A ^a1   \n\ntext'],
  ['tab after the hashes', '#\tA ^a1\n\ntext'],
  ['two spaces before the caret', '# Origins  ^h1\n\ntext'],
  ['anchor-only heading', '# ^h1\n\ntext'],
  ['crlf with a nested heading', '# A ^a1\r\n\r\n## Later\r\n\r\nmore.\r\n'],
  ['crlf body', '# A ^a1\r\n\r\ntext\r\n'],
  ['blank run between sections', '# A ^a1\n\n\n\n\n# B\n\nb'],
  ['anchor inside a fence', '# A\n\n```\nnot an anchor ^x1\n```\n\ntext'],
  ['unclosed fence', '# A ^a1\n\n```\nunclosed'],
  ['heading only, no content at all', '# A ^a1'],
  ['duplicate anchor ids', '# A ^dup\n\none ^dup\n\n# B\n\ntwo ^dup'],
  ['no heading at all', 'just a paragraph ^p1'],
  ['empty body', ''],
  ['whitespace only', '   \n\n  \t \n'],
  [
    'memorial skeleton: nested headings and anchors',
    '# Grandma ^grandma\n\n## Childhood\n\n### The sea\n\nWe went to the sea. ^sea\n\n## Cooking\n\nShe baked bread every Sunday.',
  ],
];

/** Deterministic LCG so a failure is reproducible from its seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function generateBody(seed: number): string {
  const rand = lcg(seed);
  const lines: string[] = [];
  const n = 3 + Math.floor(rand() * 14);
  for (let i = 0; i < n; i++) {
    const kind = Math.floor(rand() * 12);
    const id = `x${i}`;
    if (kind === 0) lines.push(`# H${i}`);
    else if (kind === 1) lines.push(`## H${i}`);
    else if (kind === 2) lines.push(`### H${i}`);
    else if (kind === 3) lines.push(`# H${i} ^${id}`);
    else if (kind === 4) lines.push('');
    else if (kind === 5) lines.push(`body ${i}`);
    else if (kind === 6) lines.push(`body ${i} ^${id}`);
    else if (kind === 7) lines.push('```');
    else if (kind === 8) lines.push('We went to the sea');
    else if (kind === 9)
      lines.push(`# H${i} ^${id}   `); // trailing spaces
    else if (kind === 10) lines.push('\t');
    else lines.push(`## H${i} ^${id}`);
  }
  return lines.join('\n');
}

describe('FM-031 chunk anchor integrity', () => {
  it('a heading anchor never escapes its own section', () => {
    // THE DEFECT: pendingAnchor survives empty sections and lands in a later one.
    const leak = chunkNote('# A ^a1\n\n# B\n\n# C\n\n# D\n\nd text');
    expect(leak.length).toBe(1);
    expect(leak[0]!.heading).toBe('D');
    expect(leak[0]!.anchor).toBeNull(); // today: 'a1' — a citation to the wrong section

    // POSITIVE CONTROL: deleting pendingAnchor outright would "fix" the line
    // above while destroying the feature. A heading's anchor must still reach
    // its OWN section's first content chunk, and only that one.
    const kept = chunkNote('# A ^a1\n\nthe first paragraph.\n\n# B\n\nb text');
    expect(kept[0]!.heading).toBe('A');
    expect(kept[0]!.anchor).toBe('a1');
    expect(kept[1]!.heading).toBe('B');
    expect(kept[1]!.anchor).toBeNull();

    // and it attaches to the FIRST chunk of the section, not a later one
    const multi = chunkNote('# A ^a1\n\nfirst para.\n\nsecond para.');
    expect(multi[0]!.anchor).toBe('a1');
    expect(multi[1]!.anchor).toBeNull();

    // a chunk's OWN authored anchor still wins over the heading's
    const own = chunkNote('# A ^a1\n\nhas its own. ^mine');
    expect(own[0]!.anchor).toBe('mine');

    // THE DECLARED BEHAVIOUR CHANGE, asserted rather than merely documented:
    // trailing whitespace means the shared extractor sees no anchor, so the id
    // is not citable — but the heading text must STILL be clean. Both halves.
    for (const body of ['# A ^a1   \n\ntext', '# A ^a1\r\n\r\ntext\r\n', '# A ^a1\t\n\ntext']) {
      const ws = chunkNote(body);
      expect(ws[0]!.anchor, JSON.stringify(body)).toBeNull();
      expect(ws[0]!.heading, JSON.stringify(body)).toBe('A');
      expect(ws[0]!.headingPath, JSON.stringify(body)).toEqual(['A']);
    }
    // and the mirror case: the extractor sees an anchor our stricter pattern
    // misses (two spaces) — citable id AND clean heading
    const wide = chunkNote('# Origins  ^h1\n\ntext');
    expect(wide[0]!.anchor).toBe('h1');
    expect(wide[0]!.heading).toBe('Origins');
  });

  it('chunk invariants hold across adversarial and generated bodies', () => {
    for (const [name, body] of ADVERSARIAL) {
      expect(anchorViolations(body, chunkNote(body)), `adversarial: ${name}`).toEqual([]);
    }

    const failures: string[] = [];
    for (let seed = 1; seed <= 500; seed++) {
      const body = generateBody(seed);
      const v = anchorViolations(body, chunkNote(body));
      if (v.length) failures.push(`seed ${seed}: ${JSON.stringify(body)}\n  ${v.join('\n  ')}`);
    }
    // print the counterexample, not just a count
    expect(failures.slice(0, 3).join('\n---\n')).toBe('');
  });
});
