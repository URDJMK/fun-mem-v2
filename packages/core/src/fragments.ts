import { extractAnchors } from './anchors';
import { normalizeTitle } from './validate';
import type { Wikilink } from './wikilink';

/**
 * FM-052 — fragment integrity.
 *
 * A resolved link's FRAGMENT was never validated: `[[Mom#Childhood]]` against a
 * note with no such heading was indistinguishable from a working link, and a
 * renamed `^block-id` silently broke every citation to it.
 *
 * REPAIR IS REFUSED, deliberately. Fixing a renamed anchor requires pairing a
 * disappeared id with an appeared one, and that pairing is unsound: one
 * debounce-coalesced save yields `disappeared={x1}`, `appeared={x3}` from two
 * causally unrelated edits, and any heuristic would repoint citations in OTHER
 * members' notes at the wrong block — a silent false positive that rewrites
 * bodies the editing note does not own. This module only ever REPORTS,
 * following `findDuplicateAnchors`' precedent: re-minting rewrites authored
 * text (FR-060), and the server sees two snapshots, never authorial intent.
 */

// same shapes the chunker uses, so headings are recognised identically
const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;

/**
 * One root-to-node path per ATX heading, fence-aware.
 *
 * A sibling of `chunkNote`, not a query over its output: a heading with no
 * content beneath it produces no chunk, so matching a fragment against chunks
 * would falsely report `[[N#Day 1]]` broken.
 */
export function extractHeadingPaths(body: string): string[][] {
  const out: string[][] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_RE.exec(line);
    if (!m) continue;
    const level = m[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, text: m[2]! });
    out.push(stack.map((s) => s.text));
  }
  return out;
}

/**
 * Does this link's fragment still resolve in the target's body?
 *
 * `undefined` when the link carries no fragment — "no fragment" and "fine" are
 * different answers, and a caller must be able to tell them apart.
 */
export function checkFragment(targetBody: string, link: Wikilink): 'ok' | 'broken' | undefined {
  if (link.blockId !== undefined) {
    // EXACT, case-sensitive: block ids are machine-minted [A-Za-z0-9-] tokens,
    // not prose, so `^Abc` is a different id from `^abc`.
    const ids = new Set(extractAnchors(targetBody).map((a) => a.id));
    return ids.has(link.blockId) ? 'ok' : 'broken';
  }
  if (link.heading === undefined) return undefined;

  // Prose folds case, consistent with normalizeTitle (FM-050). Recorded as a
  // HOUSE DECISION, not Obsidian parity: every candidate Obsidian page was
  // fetched and is silent on heading-fragment case-sensitivity.
  const want = link.heading.split('#').map((s) => normalizeTitle(s));
  if (want.length === 0 || want[want.length - 1] === '') return 'broken';

  for (const path of extractHeadingPaths(targetBody)) {
    const have = path.map((s) => normalizeTitle(s));
    if (have[have.length - 1] !== want[want.length - 1]) continue;
    // the preceding segments must appear among this heading's ancestors IN
    // ORDER, though not necessarily contiguously — `[[N#Day 1#Coffee]]` may
    // skip an intervening H2. Errs permissive; the output is an accusation.
    const ancestors = have.slice(0, -1);
    let i = 0;
    for (const seg of ancestors) {
      if (i < want.length - 1 && seg === want[i]) i++;
    }
    if (i === want.length - 1) return 'ok';
  }
  return 'broken';
}
