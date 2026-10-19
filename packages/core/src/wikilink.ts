export interface Wikilink {
  /** Full source token including `!` for embeds. */
  raw: string;
  /** Link target title as authored, trimmed. Empty string for self-references ([[#Heading]]). */
  target: string;
  /** Heading path after the first `#`, kept whole (nested `H1#H2` preserved). */
  heading?: string;
  /** Block id after `#^` (charset [A-Za-z0-9-]+, identical to anchors.ts). */
  blockId?: string;
  /** Display alias after the first unescaped `|` (raw; may be an embed size param). */
  alias?: string;
  embed: boolean;
  /** JS string indices (UTF-16 code units) into the body: body.slice(start, end) === raw. */
  start: number;
  end: number;
}

const BLOCK_ID_RE = /^[A-Za-z0-9-]+$/; // identical charset to anchors.ts
/** Four spaces (or a tab) of indent opens a code block — but only outside a paragraph. */
const INDENTED_RE = /^(?: {4}|\t)/;
/** An ATX heading is a leaf block, so indented code may follow it with no blank line. */
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|\r?\n?$)/;
/**
 * A thematic break is a leaf block wherever it appears. A setext underline is
 * one only when there is a paragraph above it to underline — with nothing
 * above, `===` is itself an ordinary paragraph, and treating it as a heading
 * masked the indented line that followed.
 */
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})\r?\n?$/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*\r?\n?$/;
// lines keep their trailing newline (the split is a lookbehind), so the blank
// test has to allow it — `/^[ \t]*$/` never matches "\n" without the m flag
const BLANK_RE = /^[ \t]*\r?\n?$/;

/** Type 1 — raw-text elements. Runs to its closing tag, which may sit on the opening line. */
const HTML_RAWTEXT_RE = /^ {0,3}<(?:pre|script|style|textarea)(?:[ \t>]|\r?\n?$)/i;
const HTML_RAWTEXT_END_RE = /<\/(?:pre|script|style|textarea)>/i;
/**
 * Type 6 — the known block-level tags. Runs to the next BLANK LINE, not to the
 * closing tag: `</div>` followed by more text keeps the block open.
 */
const HTML_BLOCK_RE =
  /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/?>|\r?\n?$)/i;
/** Type 7 — any single complete tag alone on its line. Cannot interrupt a paragraph. */
const HTML_ANYTAG_RE =
  /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*\r?\n?$/;

/**
 * CommonMark's HTML block start conditions, minus the ones that need container
 * context. Returns the block's END condition: a RegExp the closing line must
 * match, `null` for "ends at the next blank line", or undefined for "this line
 * does not start an HTML block".
 *
 * This lives in pass 1 rather than pass 2 because an HTML block is a BLOCK: it
 * is not a paragraph, so indented code may follow it directly. Handling
 * comments only in pass 2 left the comment's line looking like prose, and the
 * indented line after it was then left unmasked.
 */
function htmlBlockEnd(line: string, inParagraph: boolean): RegExp | null | undefined {
  if (HTML_RAWTEXT_RE.test(line)) return HTML_RAWTEXT_END_RE; // 1
  if (/^ {0,3}<!--/.test(line)) return /-->/; // 2
  if (/^ {0,3}<\?/.test(line)) return /\?>/; // 3
  if (/^ {0,3}<!\[CDATA\[/.test(line)) return /\]\]>/; // 5
  if (/^ {0,3}<![A-Za-z]/.test(line)) return />/; // 4
  if (HTML_BLOCK_RE.test(line)) return null; // 6
  if (!inParagraph && HTML_ANYTAG_RE.test(line)) return null; // 7
  return undefined;
}

interface FenceLine {
  /** How many `>` markers precede the run. A fence closes only at its own depth. */
  depth: number;
  /** The literal run — its character and length both decide what may close it. */
  run: string;
  /** Everything after the run: an info string when opening, whitespace when closing. */
  rest: string;
}

/**
 * Parse a line as a possible fence line, or null when it is not one.
 *
 * A scan rather than a regex because CommonMark measures indent in COLUMNS and
 * a tab is four of them. The previous `[ \t]{0,3}` counted characters, so
 * `\t``` ` read as a fence when it is really indented code — and since that
 * line then CLOSED an open fence, everything after it was unmasked.
 */
function fenceLine(line: string): FenceLine | null {
  let i = 0;
  let depth = 0;
  for (;;) {
    let j = i;
    let cols = 0;
    while (line[j] === ' ' || line[j] === '\t') {
      cols += line[j] === '\t' ? 4 - (cols % 4) : 1;
      j++;
    }
    if (cols < 4 && line[j] === '>') {
      i = j + 1;
      if (line[i] === ' ') i++;
      depth++;
      continue;
    }
    break;
  }
  let cols = 0;
  while (line[i] === ' ' || line[i] === '\t') {
    cols += line[i] === '\t' ? 4 - (cols % 4) : 1;
    i++;
  }
  if (cols > 3) return null; // four columns in is indented code, never a fence
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  const start = i;
  while (line[i] === ch) i++;
  if (i - start < 3) return null;
  return { depth, run: line.slice(start, i), rest: line.slice(i) };
}

/**
 * Mark regions where a `[[link]]` is inert markup rather than a link: fenced
 * code, indented code, HTML blocks and comments, and inline code spans.
 *
 * FM-054 widened this from a per-line scan that knew only single-backtick spans
 * and a fence toggle blind to which marker opened it. The editor's lezer parser
 * already masked these contexts, so core indexed links the editor correctly
 * treated as code — a fabricated graph edge, which is the grounding failure
 * this exists to prevent. Under-linking is the safe direction, so every
 * ambiguity resolves toward masking.
 *
 * Amendment 1 rebuilt the fence rules against `@lezer/markdown` run as a
 * differential oracle rather than against a hand-listed set of contexts. The
 * corrections that mattered were all in the CLOSING test: a close must be a
 * fence line and nothing else, at the opener's own blockquote depth, and
 * measured in columns rather than characters. Each of those, when wrong, did
 * not merely mis-handle one construct — it inverted code and prose for the
 * whole rest of the document.
 *
 * Deliberately NOT a CommonMark implementation — core takes no markdown
 * dependency. What it still cannot see is container structure: a fence opened
 * inside a blockquote or a list item never closes when its container ends. That
 * over-masks, which loses links rather than inventing them.
 *
 * O(n) in the body: three linear passes, no per-character allocation.
 */
function codeMask(body: string): Uint8Array {
  const mask = new Uint8Array(body.length);

  // 1. block constructs, line by line. This pass also records which lines are
  //    ordinary prose, because an inline lives inside ONE leaf block: pass 3
  //    may only pair backticks within a single run of prose lines.
  const lines = body.split(/(?<=\n)/);
  const prose: Array<[number, number]> = [];
  let proseStart = -1;
  let offset = 0;
  let fence: { char: string; len: number; depth: number } | null = null;
  // undefined: not in an HTML block. null: a type-6 block, ends at a blank
  // line. A RegExp: a type-1 block, ends at the line matching it.
  let htmlEnd: RegExp | null | undefined;
  let inParagraph = false;

  for (const line of lines) {
    const f = fenceLine(line);
    const blank = BLANK_RE.test(line);
    const he = htmlBlockEnd(line, inParagraph);
    let isProse = false;

    if (fence !== null) {
      mask.fill(1, offset, offset + line.length);
      // Same character, at least as long, at the SAME blockquote depth, with
      // nothing after the run but whitespace. Every one of those four is
      // load-bearing: drop any and some ordinary line closes the fence early.
      if (
        f &&
        f.run[0] === fence.char &&
        f.run.length >= fence.len &&
        f.depth === fence.depth &&
        BLANK_RE.test(f.rest)
      ) {
        fence = null;
      }
      inParagraph = false;
    } else if (htmlEnd !== undefined) {
      if (htmlEnd === null && blank) {
        htmlEnd = undefined; // the blank line ends it and is not part of it
        inParagraph = false;
      } else {
        mask.fill(1, offset, offset + line.length);
        if (htmlEnd !== null && htmlEnd.test(line)) htmlEnd = undefined;
      }
    } else if (f && (f.run[0] === '~' || !f.rest.includes('`'))) {
      // a BACKTICK fence may not carry a backtick in its info string; a tilde
      // fence may. Getting this wrong opens a fence a line early and inverts
      // the parity of every construct that follows.
      fence = { char: f.run[0]!, len: f.run.length, depth: f.depth };
      mask.fill(1, offset, offset + line.length);
      inParagraph = false;
    } else if (he !== undefined) {
      mask.fill(1, offset, offset + line.length);
      // a block whose end condition is already satisfied on its opening line
      // (`<pre>x</pre>`, `<!-- c -->`) closes immediately
      htmlEnd = he !== null && he.test(line) ? undefined : he;
      inParagraph = false;
    } else if (blank) {
      // a blank line closes a paragraph. It does NOT close an indented block,
      // and it does not need to: nothing reopens a paragraph until a prose
      // line does, and a prose line ends the indented block anyway.
      inParagraph = false;
    } else if (INDENTED_RE.test(line) && !inParagraph) {
      mask.fill(1, offset, offset + line.length);
    } else {
      // any other non-blank line: a paragraph, heading, list item, table row.
      // A heading, a setext underline and a thematic break are leaf blocks, not
      // paragraphs, so indented code may follow them with no blank line. A LIST
      // ITEM deliberately counts as a paragraph: its four-space continuation is
      // prose, and masking it would drop a link the author really did write.
      isProse = true;
      const setext: boolean = inParagraph && SETEXT_UNDERLINE_RE.test(line);
      inParagraph = !ATX_HEADING_RE.test(line) && !setext && !THEMATIC_BREAK_RE.test(line);
    }

    if (isProse) {
      if (proseStart < 0) proseStart = offset;
    } else if (proseStart >= 0) {
      prose.push([proseStart, offset]);
      proseStart = -1;
    }
    offset += line.length;
  }
  if (proseStart >= 0) prose.push([proseStart, offset]);

  // 2. HTML comments, which span lines. A `<!--` that pass 1 already masked is
  //    a comment being DOCUMENTED inside a code sample, not one being opened —
  //    honouring it masked everything to the end of the note.
  for (const m of body.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
    if (mask[m.index] === 1) continue;
    mask.fill(1, m.index, m.index + m[0].length);
  }

  // 3. inline code spans, within one prose run each. A span opens with a run of
  //    N backticks and closes with a run of EXACTLY N — `` `` `` may contain a
  //    single backtick. Confining it to a prose run is what stops one stray
  //    backtick in a sentence from swallowing every link after it.
  //
  // Collect the runs ONCE and link each to the next run of the same length,
  // rather than rescanning forward from every opener. Rescanning is quadratic
  // whenever runs go unmatched — with ascending run lengths, quadrupling the
  // body cost 7.6x the time, and a 7.8MB body took 35 SECONDS. Note bodies are
  // user-supplied, so that is a denial of service, not just a slow path.
  for (const [from, to] of prose) {
    const runStart: number[] = [];
    const runLen: number[] = [];
    for (let i = from; i < to;) {
      if (body[i] !== '`') {
        i++;
        continue;
      }
      const s = i;
      while (i < to && body[i] === '`') i++;
      runStart.push(s);
      runLen.push(i - s);
    }
    // next[k]: the first run after k with the SAME length, or -1
    const next = new Int32Array(runStart.length).fill(-1);
    const lastOfLen = new Map<number, number>();
    for (let k = runStart.length - 1; k >= 0; k--) {
      const seen = lastOfLen.get(runLen[k]!);
      if (seen !== undefined) next[k] = seen;
      lastOfLen.set(runLen[k]!, k);
    }
    for (let k = 0; k < runStart.length;) {
      // Purely structural — no `mask[...] === 1` check at either end. Pass 3
      // only ever walks PROSE lines, which pass 1 never masks, so the only mask
      // it could see is a pass-2 inline comment; and a code span binds tighter
      // than inline raw HTML, so a backtick inside what looked like a comment
      // really does delimit the span. Guarding on the mask was measurably wrong
      // at the closing end (120 over-links across an exhaustive 32,768-document
      // enumeration, 0 without it) and provably inert at the opening end — a
      // mutant deleting it could not be killed by any document.
      const close = next[k]!;
      if (close === -1) {
        // an unclosed run is literal text, not a span: mask nothing, move on
        k++;
        continue;
      }
      mask.fill(1, runStart[k]!, runStart[close]! + runLen[close]!);
      k = close + 1;
    }
  }
  return mask;
}

/**
 * Single-pass Obsidian-compatible wikilink scanner (rule-set: docs/plans/scouts/FM-011-findings.md).
 * Pure and deterministic; titles returned as authored (resolution is TitleResolver's job).
 */
export function extractWikilinks(body: string): Wikilink[] {
  const mask = codeMask(body);
  const out: Wikilink[] = [];
  let i = 0;
  while (i < body.length - 1) {
    if (body[i] !== '[' || body[i + 1] !== '[' || mask[i] || body[i - 1] === '\\') {
      i++;
      continue;
    }
    const embed = i > 0 && body[i - 1] === '!' && body[i - 2] !== '\\';
    const nl = body.indexOf('\n', i);
    const lineEnd = nl === -1 ? body.length : nl;
    const close = body.indexOf(']]', i + 2);
    if (close === -1 || close > lineEnd) {
      i += 2;
      continue;
    }
    const inner = body.slice(i + 2, close);

    let aliasIdx = -1;
    for (let k = 0; k < inner.length; k++) {
      if (inner[k] === '|' && inner[k - 1] !== '\\') {
        aliasIdx = k;
        break;
      }
    }
    const targetAnchor = aliasIdx === -1 ? inner : inner.slice(0, aliasIdx);
    const alias = aliasIdx === -1 ? undefined : inner.slice(aliasIdx + 1);

    const hashIdx = targetAnchor.indexOf('#');
    const anchor = hashIdx === -1 ? undefined : targetAnchor.slice(hashIdx + 1);
    const target = (hashIdx === -1 ? targetAnchor : targetAnchor.slice(0, hashIdx)).trim();

    const tokenStart = embed ? i - 1 : i;
    const link: Wikilink = {
      raw: body.slice(tokenStart, close + 2),
      target,
      embed,
      start: tokenStart,
      end: close + 2,
    };
    if (anchor !== undefined) {
      if (anchor.startsWith('^') && BLOCK_ID_RE.test(anchor.slice(1)))
        link.blockId = anchor.slice(1);
      else link.heading = anchor;
    }
    if (alias !== undefined) link.alias = alias;
    out.push(link);
    i = close + 2;
  }
  return out;
}
