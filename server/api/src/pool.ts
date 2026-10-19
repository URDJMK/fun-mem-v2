/**
 * Run `fn` over `items`, at most `limit` at a time, results in the order of `items`.
 *
 * Each worker takes the next item the moment it is free. A batch-by-batch version (take
 * three, wait for all three) lets one slow model call hold up two idle slots; this does not.
 *
 * A failure stops new items from being started and is thrown once the ones already running
 * have settled. `before` runs ahead of every item, so a caller can refuse to start more work
 * (cancelled, out of time) by throwing from it.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  before?: () => void,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let error: unknown;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        before?.();
        out[i] = await fn(items[i]!, i);
      } catch (e) {
        if (!failed) {
          failed = true;
          error = e;
        }
        return;
      }
    }
  };

  // a limit that is not a number still runs everything, one at a time (Math.max(1, NaN) is NaN,
  // and Array.from({ length: NaN }) starts no worker at all: every result would be missing)
  const workers = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker));
  if (failed) throw error;
  return out;
}
