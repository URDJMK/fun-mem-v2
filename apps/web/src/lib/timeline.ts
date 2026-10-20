/**
 * Notes placed in time by their `occurred` text ("1987", "1987-03", "~1948"). An undated note
 * has no place here, and none is made up for it.
 */
export function yearOf(occurred: string | null): number | null {
  if (!occurred) return null;
  const m = /^~?(\d{4})/.exec(occurred);
  return m ? Number(m[1]) : null;
}

export interface Decade<T> {
  start: number;
  items: T[];
}

/**
 * Every decade from the first dated note to the last, the empty ones included: a decade with
 * nothing in it is a gap worth seeing, not something to leave out.
 */
export function byDecade<T extends { occurred: string | null }>(notes: readonly T[]): Decade<T>[] {
  const dated = notes
    .map((n) => ({ n, y: yearOf(n.occurred) }))
    .filter((x): x is { n: T; y: number } => x.y !== null)
    .sort((a, b) => a.y - b.y || (a.n.occurred ?? '').localeCompare(b.n.occurred ?? ''));
  if (dated.length === 0) return [];
  const first = Math.floor(dated[0]!.y / 10) * 10;
  const last = Math.floor(dated[dated.length - 1]!.y / 10) * 10;
  const out: Decade<T>[] = [];
  for (let d = first; d <= last; d += 10) out.push({ start: d, items: [] });
  for (const { n, y } of dated) out[(Math.floor(y / 10) * 10 - first) / 10]!.items.push(n);
  return out;
}
