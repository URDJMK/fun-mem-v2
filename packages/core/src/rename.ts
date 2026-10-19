import { extractWikilinks } from './wikilink';
import { normalizeTitle } from './validate';

/**
 * Rename-time link-text rewrite (FM-016, FR-022 / spec §4.5).
 * Splices ONLY the target substring inside each real wikilink occurrence —
 * embed `!`, padding, escapes, `#heading`/`#^block` fragments, and `|alias`
 * display text are byte-preserved. A global string replace is the forbidden
 * shortcut: it would corrupt code blocks; re-extraction inherits the parser's
 * fence/inline-code/escape masking by construction.
 */
export function renameLinkTargets(body: string, oldTitle: string, newTitle: string): string {
  const oldNorm = normalizeTitle(oldTitle);
  if (oldNorm === '') return body;
  const matches = extractWikilinks(body).filter((l) => normalizeTitle(l.target) === oldNorm);
  if (matches.length === 0) return body;
  // single pass, ascending, all offsets read against the ORIGINAL body — O(len):
  // repeated whole-string splicing is quadratic and runs under the archive lock
  const parts: string[] = [];
  let cursor = 0;
  for (const link of matches) {
    const innerStart = link.start + (link.embed ? 3 : 2); // skip "!" + "[["
    const innerEnd = link.end - 2; // drop "]]"
    // the target segment ends at the first "#" (fragment) or unescaped "|" (alias)
    let segEnd = innerEnd;
    for (let i = innerStart; i < innerEnd; i++) {
      const ch = body[i];
      if (ch === '#' || (ch === '|' && body[i - 1] !== '\\')) {
        segEnd = i;
        break;
      }
    }
    // swap only the trimmed target core, preserving surrounding padding bytes
    let from = innerStart;
    while (from < segEnd && /\s/.test(body[from]!)) from++;
    let to = segEnd;
    while (to > from && /\s/.test(body[to - 1]!)) to--;
    if (from === to) continue; // empty/self target ([[#...]]) — never rewritten
    parts.push(body.slice(cursor, from), newTitle);
    cursor = to;
  }
  parts.push(body.slice(cursor));
  return parts.join('');
}

// titles are spliced verbatim into referrer link text on rename — link syntax in a
// title would forge or corrupt links in OTHER members' bodies (panel finding)
const TITLE_FORBIDDEN = new RegExp('[\\[\\]#^|\\u0000-\\u001f\\u007f]');

/** Returns an error message, or null when the title is safe to store and splice. */
export function validateNoteTitle(title: string): string | null {
  if (title.trim() === '') return 'title must be non-empty';
  if (TITLE_FORBIDDEN.test(title)) {
    return 'title must not contain [ ] # ^ | or control characters';
  }
  return null;
}
