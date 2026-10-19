export interface BlockAnchor {
  id: string;
  /** 0-based line index in the body — always the anchor's OWN line. */
  line: number;
  /** The line's text without the anchor suffix; '' for the own-line form. */
  text: string;
  /**
   * True when the line contained nothing but the anchor. Such an anchor labels
   * the block ABOVE it, which is why the flag is explicit rather than inferred
   * from an empty `text` — a trailing-form anchor on a whitespace-only line
   * also yields ''.
   */
  ownLine: boolean;
}

/** ` ^id` as a suffix on a line that has other content. */
const ANCHOR_RE = /^(.*?) \^([A-Za-z0-9-]+)$/;
/**
 * FM-053: `^id` alone on its line, optionally indented and optionally inside a
 * blockquote. Obsidian permits this after a block that cannot carry a trailing
 * anchor — a code fence, a table, a list — and without it `noteUUID#^block`
 * citations into those blocks are impossible. `chunkNote` keys anchors by line
 * and the anchor falls in the same heading section as the block it labels, so
 * recognising it here is sufficient; the chunker needs no change.
 */
const OWN_LINE_ANCHOR_RE = /^[ \t>]*\^([A-Za-z0-9-]+)$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Anchors are literal `^id` markers — a ` ^id` suffix on a line with content, or
 * `^id` alone on its own line after a block that cannot carry one (fence,
 * table, list). Both forms are Obsidian-compatible and stable across unrelated
 * edits by construction: parsing never regenerates an id. A `^id` inside a code
 * fence is content, never an anchor.
 */
export function extractAnchors(body: string): BlockAnchor[] {
  const out: BlockAnchor[] = [];
  let inFence = false;
  body.split('\n').forEach((lineText, line) => {
    if (FENCE_RE.test(lineText)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    // The own-line form is tested FIRST: `> ^id` also matches the trailing
    // regex (with text '>'), and classifying it as a suffix would attach it to
    // the quote line instead of the block it labels.
    const solo = OWN_LINE_ANCHOR_RE.exec(lineText);
    if (solo) {
      out.push({ id: solo[1]!, line, text: '', ownLine: true });
      return;
    }
    const m = ANCHOR_RE.exec(lineText);
    if (m) out.push({ id: m[2]!, line, text: m[1]!, ownLine: false });
  });
  return out;
}

/**
 * Ids that appear on more than one anchored line, in first-appearance order.
 *
 * FM-037: a duplicated `^id` makes `noteUUID#^block` identify more than one
 * span, breaking FR-002's stable-anchor guarantee. This reports; `chunkNote`
 * enforces (first-wins suppression). Deliberately NOT a validator that rejects:
 * a throw from the chunker becomes an opaque 500 and aborts the rebuild
 * transaction, and re-minting would rewrite authored text (FR-060).
 */
export function findDuplicateAnchors(body: string): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const a of extractAnchors(body)) {
    if (seen.has(a.id)) {
      if (!dupes.includes(a.id)) dupes.push(a.id);
    } else {
      seen.add(a.id);
    }
  }
  return dupes;
}

/** Append an anchor to the given line if absent, avoiding id collisions. Idempotent. */
export function ensureAnchor(
  body: string,
  line: number,
  genId: () => string,
): { body: string; id: string } {
  const lines = body.split('\n');
  const target = lines[line];
  if (target === undefined) throw new Error(`line ${line} out of range`);
  const existing = ANCHOR_RE.exec(target);
  if (existing) return { body, id: existing[2]! };
  const taken = new Set(extractAnchors(body).map((a) => a.id));
  let id = genId();
  while (taken.has(id)) id = genId();
  lines[line] = `${target} ^${id}`;
  return { body: lines.join('\n'), id };
}
