import { extractAnchors } from './anchors';

/**
 * Block-level chunker (FM-021, spec §4.7): splits a note body at ATX headings
 * and blank-line-separated blocks, fence-aware (a fenced code block is one
 * chunk, never split). Every chunk carries the authored `^block-id` anchor of
 * a line it contains when one exists (citation-grade, stable across rebuilds),
 * else null — the chunker NEVER mutates the body to invent an anchor (that
 * byte-rewrite is the forbidden shortcut; the editor owns anchor insertion).
 * Pure and deterministic: the same body always yields the same chunks, which is
 * what makes "rebuild regenerates the index identically" true by construction.
 */
export interface Chunk {
  index: number;
  /** the nearest enclosing heading text, or '' above the first heading */
  heading: string;
  /** heading titles from document root to this chunk's section */
  headingPath: string[];
  /** authored ^block-id on a line of this chunk, else null */
  anchor: string | null;
  /** UTF-16 offsets; body.slice(start, end) === content */
  start: number;
  end: number;
  content: string;
}

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
// a ` ^id` block anchor may sit on a heading line; keep it out of the heading
// text and attribute it to the section's first content chunk instead
const TRAILING_ANCHOR_RE = /^(.*\S) \^([A-Za-z0-9-]+)$/;

export function chunkNote(body: string): Chunk[] {
  const lines = body.split('\n');
  const lineStart: number[] = [];
  {
    let pos = 0;
    for (const l of lines) {
      lineStart.push(pos);
      pos += l.length + 1; // + '\n'
    }
  }
  // authored anchors, keyed by line — already fence-aware in core
  const anchorAt = new Map<number, string>();
  // FM-053: an own-line anchor labels the block ABOVE it, and a fenced block is
  // flushed on its closing fence — so the anchor line is never inside that
  // chunk's line set. Kept separate and applied to the last emitted chunk.
  const ownLineAnchorAt = new Map<number, string>();
  for (const a of extractAnchors(body)) {
    if (a.ownLine) ownLineAnchorAt.set(a.line, a.id);
    else anchorAt.set(a.line, a.id);
  }
  // FM-037: ids already carried by an emitted chunk. Insertion-ordered by
  // construction (chunks are emitted in document order), so suppression is
  // deterministic and a rebuild reproduces the index exactly.
  const claimed = new Set<string>();

  const chunks: Chunk[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let block: number[] = [];
  let inFence = false;
  // a heading's own anchor, waiting to be attached to its first content chunk
  let pendingAnchor: string | null = null;
  // an own-line anchor seen while the block it labels is still open
  let soloForBlock: string | null = null;

  const flush = () => {
    if (block.length === 0) return;
    const first = block[0]!;
    const last = block[block.length - 1]!;
    const start = lineStart[first]!;
    const end = lineStart[last]! + lines[last]!.length;
    const content = body.slice(start, end);
    if (content.trim() === '') {
      block = [];
      return;
    }
    let anchor: string | null = null;
    for (const ln of block) {
      const id = anchorAt.get(ln);
      // FM-037 first-wins: an id already carried by an earlier chunk is skipped,
      // never re-minted (the body is not ours to rewrite) and never thrown on
      // (a throw here is an opaque 500 and aborts the rebuild transaction). The
      // duplicate keeps its chunk; it is simply not addressable by that id.
      if (id !== undefined && !claimed.has(id)) {
        anchor = id;
        break;
      }
    }
    // a chunk with no anchor of its own inherits its heading's anchor (once).
    // The claimed-check applies HERE TOO: a heading anchor can collide with a
    // body anchor, so guarding only the direct path above leaves that open.
    if (anchor === null && soloForBlock !== null && !claimed.has(soloForBlock)) {
      anchor = soloForBlock;
    }
    if (anchor === null && pendingAnchor !== null && !claimed.has(pendingAnchor)) {
      anchor = pendingAnchor;
    }
    if (anchor !== null) claimed.add(anchor);
    pendingAnchor = null;
    soloForBlock = null;
    chunks.push({
      index: chunks.length,
      heading: stack.length ? stack[stack.length - 1]!.text : '',
      headingPath: stack.map((s) => s.text),
      anchor,
      start,
      end,
      content,
    });
    block = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (FENCE_RE.test(text)) {
      if (!inFence) {
        flush(); // close any preceding block before the fence
        inFence = true;
        block.push(i);
      } else {
        block.push(i);
        inFence = false;
        flush(); // the fenced block is one complete chunk
      }
      continue;
    }
    if (inFence) {
      block.push(i);
      continue;
    }
    // FM-053: an own-line anchor with no block open labels the chunk just
    // emitted. Same FM-037 first-wins guard as every other path — an id already
    // carried by an earlier chunk is skipped, never re-minted, never thrown on.
    const solo = ownLineAnchorAt.get(i);
    if (solo !== undefined) {
      if (block.length === 0) {
        // the labelled block already closed — a fence flushes on its closing
        // line, so its anchor arrives with nothing open
        const prev = chunks[chunks.length - 1];
        if (prev && prev.anchor === null && !claimed.has(solo)) {
          prev.anchor = solo;
          claimed.add(solo);
        }
        continue;
      }
      // a table or list is still OPEN when its anchor arrives; the anchor
      // labels the block being built, and flush() applies it. The line stays in
      // the block so content and offsets are unchanged.
      soloForBlock = solo;
    }
    const h = HEADING_RE.exec(text);
    if (h) {
      flush(); // a heading is a split point, not content
      const level = h[1]!.length;
      let headingText = h[2]!;
      // FM-031: source the pending anchor from the SAME extractAnchors-derived
      // map the rest of this function uses, and assign it UNCONDITIONALLY.
      // Previously it came from a parallel regex and was cleared only inside
      // flush() — which early-returns on an empty section — so a heading anchor
      // could survive intervening empty sections and land on a later section's
      // chunk, citing text it does not belong to. Unconditional assignment also
      // makes `chunk.anchor ∈ ids(extractAnchors(body))` true by construction,
      // so the chunker can no longer stamp an id the shared extractor denies.
      pendingAnchor = anchorAt.get(i) ?? null;
      // Two SEPARATE decisions, deliberately decoupled (FM-031 panel):
      //   (1) is the id citable?  -> only if the shared extractor says so
      //   (2) does the caret show in the heading? -> NEVER (FM-021 finding (a))
      // Coupling them regressed (2) for any heading line with trailing
      // whitespace — and `\r` is trailing whitespace on EVERY line of a CRLF
      // note, so one imported file would show raw carets in every breadcrumb.
      const am = TRAILING_ANCHOR_RE.exec(headingText);
      if (am) headingText = am[1]!;
      else if (pendingAnchor !== null) {
        // the extractor saw an anchor our stricter pattern missed (e.g. two
        // spaces before the caret) — still strip it from the display text
        headingText = headingText.replace(/\s*\^[A-Za-z0-9-]+$/, '').trimEnd();
      }
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: headingText });
      continue;
    }
    if (text.trim() === '') {
      flush();
      continue;
    }
    block.push(i);
  }
  flush();
  return chunks;
}
