import type { Turn } from '../transcript';

/**
 * The transcript as the story workflow shows it to the AI: numbered lines (L1, L2, …), each
 * with who said it. A story cites its lines by these numbers, and every check reads the cited
 * lines back through `textOf`. Numbers start at 1 and follow the turns as the roles left them
 * (an interviewer's "mm-hm" folded into the answer it interrupted).
 */
export interface Line {
  n: number;
  speaker: string;
  /** the name to show: the narrator's name where one is known, else the speaker label */
  name: string;
  /** one of the people whose memories these are */
  teller: boolean;
  start: number | null;
  end: number | null;
  text: string;
}

/** Lines `from` to `to`, both included. */
export interface Range {
  from: number;
  to: number;
}

export function linesOf(
  turns: readonly Turn[],
  tellers: readonly string[],
  names: ReadonlyArray<readonly [string, string]>,
): Line[] {
  const nameOf = (speaker: string) => names.find(([id]) => id === speaker)?.[1] ?? speaker;
  return turns.map((t, i) => ({
    n: i + 1,
    speaker: t.speaker,
    name: nameOf(t.speaker),
    teller: tellers.includes(t.speaker),
    start: t.start,
    // a transcript with only start times ("[00:28] Sunja: …"): a line ends where the next begins
    end: t.end ?? turns[i + 1]?.start ?? null,
    text: t.text,
  }));
}

/** "L2 Sunja: …"; anyone who is not telling is marked as asking. */
export function renderLines(lines: readonly Line[]): string {
  return lines.map((l) => `L${l.n} ${l.name}${l.teller ? '' : ' (asking)'}: ${l.text}`).join('\n');
}

const CITE = /^\s*l?(\d+)\s*(?:[-–—]|to)\s*l?(\d+)\s*$|^\s*l?(\d+)\s*$/i;

/** "L12", "L12-L15", "L12–15", "12-15" or `{from, to}`; null for anything else. */
export function parseCite(v: unknown): Range | null {
  if (v && typeof v === 'object') {
    const { from, to } = v as { from?: unknown; to?: unknown };
    if (Number.isInteger(from) && Number.isInteger(to)) {
      return valid({ from: from as number, to: to as number });
    }
    return null;
  }
  if (typeof v !== 'string') return null;
  const m = CITE.exec(v);
  if (!m) return null;
  const from = Number(m[1] ?? m[3]);
  const to = Number(m[2] ?? m[3]);
  return valid({ from, to });
}

const valid = (r: Range): Range | null => (r.from >= 1 && r.to >= r.from ? r : null);

/** The cited lines, each once, in transcript order, as "Name: text". */
export function textOf(lines: readonly Line[], ranges: readonly Range[]): string {
  return lines
    .filter((l) => ranges.some((r) => l.n >= r.from && l.n <= r.to))
    .map((l) => `${l.name}: ${l.text}`)
    .join('\n');
}

/** A rough count, four characters to a token: enough to size the parts of a long interview. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The lines in parts the AI reads one at a time (PRD D1). A part ends only after one of the
 * narrator's lines, so an answer is never cut from its question; a single line longer than the
 * budget is a part of its own.
 */
export function partsOf(lines: readonly Line[], maxTokens: number): Line[][] {
  const parts: Line[][] = [];
  let cur: Line[] = [];
  let size = 0;
  for (const l of lines) {
    cur.push(l);
    size += estimateTokens(renderLines([l])) + 1;
    if (size >= maxTokens && l.teller) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}

/** 63.2 → "1:03"; 3725 → "1:02:05". */
export function clock(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec)) return null;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
