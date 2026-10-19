import { describe, expect, it } from 'vitest';
import { extractAnchors, findDuplicateAnchors } from '../src/anchors';
import { chunkNote } from '../src/chunk';

/**
 * FM-053 — Obsidian permits `^id` on its own line after a block that cannot
 * carry a trailing anchor. `ANCHOR_RE` required a space before the caret, so
 * such a line never matched and `noteUUID#^block` citations into a code block,
 * table or list were impossible.
 */
describe('FM-053 own-line block anchors', () => {
  it('an anchor alone on its line is parsed after a fence, table or list', () => {
    const cases: Array<[string, string, string]> = [
      ['code fence', '```\nconst x = 1;\n```\n^mycode', 'mycode'],
      ['table', '| a | b |\n| - | - |\n| 1 | 2 |\n^mytable', 'mytable'],
      ['list', '- item one\n- item two\n^mylist', 'mylist'],
      // Obsidian tolerates one blank line between the block and its anchor
      ['blank line', 'A paragraph.\n\n^afterblank', 'afterblank'],
      ['indented', '- item\n  ^indented', 'indented'],
    ];
    for (const [name, body, id] of cases) {
      const got = extractAnchors(body).map((a) => a.id);
      expect(got, `${name}: own-line anchor not parsed`).toContain(id);
    }

    // the anchor is attributed to ITS OWN line, and carries no text of its own
    const one = extractAnchors('```\ncode\n```\n^solo');
    expect(one).toHaveLength(1);
    expect(one[0]!.line, 'the anchor was attributed to the wrong line').toBe(3);
    expect(one[0]!.text).toBe('');

    // and the existing trailing form is untouched
    expect(extractAnchors('A normal line ^works').map((a) => a.id)).toEqual(['works']);
    const quoted = extractAnchors('> quoted line\n> ^inquote');
    expect(quoted.map((a) => a.id)).toEqual(['inquote']);
    // `> ^id` is the own-line form inside a quote, not a suffix on the `>` line
    expect(quoted[0]!.ownLine, 'a quoted own-line anchor was classed as a suffix').toBe(true);
    expect(quoted[0]!.text).toBe('');
  });

  it('an own-line anchor makes its block citable through chunkNote', () => {
    // All three block kinds, because they reach the anchor line in DIFFERENT
    // chunker states: a fence flushes on its closing line (block already
    // closed), while a table or list is still open. Testing only the fence
    // hides a fix that handles only the fence.
    const cases: Array<[string, string, string, string]> = [
      ['fence', '# H\n\n```\nconst x = 1;\n```\n^mycode', 'const x = 1;', 'mycode'],
      ['table', '# H\n\n| a | b |\n| - | - |\n| 1 | 2 |\n^mytable', '| 1 | 2 |', 'mytable'],
      ['list', '# H\n\n- item one\n- item two\n^mylist', '- item two', 'mylist'],
      ['paragraph', '# H\n\nA plain paragraph.\n^myparagraph', 'A plain paragraph.', 'myparagraph'],
    ];
    for (const [name, body, needle, id] of cases) {
      const chunks = chunkNote(body);
      const owner = chunks.find((c) => c.content.includes(needle));
      expect(owner, `${name}: produced no chunk`).toBeDefined();
      expect(owner!.anchor, `${name}: block is not citable`).toBe(id);
    }

    // and the anchor does not leak onto an unrelated chunk
    const chunks = chunkNote('# H\n\n```\ncode\n```\n^mycode\n\n# Other\n\nUnrelated prose.');
    const other = chunks.find((c) => c.content.includes('Unrelated prose.'));
    expect(other!.anchor).not.toBe('mycode');
  });

  it('an anchor inside a code fence is still not an anchor', () => {
    // the example text inside a fence must stay content, or documentation that
    // happens to show anchor syntax becomes citable by accident
    const body = '```\nHere is how anchors look:\n^notreal\n```\n^real';
    const ids = extractAnchors(body).map((a) => a.id);
    expect(ids, 'a fenced line became an anchor').not.toContain('notreal');
    expect(ids, 'the real anchor after the fence was lost').toContain('real');
  });

  it('a duplicated own-line anchor is reported and suppressed, not thrown', () => {
    const body = '```\na\n```\n^dup\n\n```\nb\n```\n^dup';
    expect(() => extractAnchors(body)).not.toThrow();
    expect(findDuplicateAnchors(body), 'the duplicate was not reported').toContain('dup');
    // FM-037: first wins, and the id never labels two spans
    const chunks = chunkNote(body);
    const withDup = chunks.filter((c) => c.anchor === 'dup');
    // exactly one, not "at most one": <= 1 also passes when the anchor attaches
    // to nothing at all, which is a regression, not the intended suppression
    expect(withDup, 'first-wins suppression did not keep exactly one').toHaveLength(1);
    expect(withDup[0]!.content, 'the SECOND block won instead of the first').toContain('a');
    const second = chunks.find((c) => c.content.includes('b'));
    expect(second!.anchor, 'the duplicate kept its chunk but must not be addressable').toBeNull();
  });
});
