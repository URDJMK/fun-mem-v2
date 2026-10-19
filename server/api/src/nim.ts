/**
 * The AI client for ingestion and conflict judging: NVIDIA NIM, which speaks the
 * OpenAI chat-completions dialect, so this is plain `fetch` with no SDK to pin.
 *
 * WHY IT IS MORE THAN A fetch. A model service fails in ordinary ways (a rate
 * limit, a cold start, a 30-second stall) and, before this client, any one of
 * them silently turned a whole section of an interview into plain, untidied text
 * while the user saw nothing wrong. So:
 *
 *   - every failure is a typed `ModelError` (never a response body: an error body
 *     can echo the prompt, i.e. family testimony)
 *   - transient failures (429, 5xx, timeouts, a dropped connection) are retried with
 *     exponential backoff and jitter; a `Retry-After` may lengthen the wait, and may
 *     shorten it at most to half the computed backoff (a `Retry-After: 0` storm is
 *     not a reason to hammer the service)
 *   - permanent ones (a rejected key, a request the service refuses) are NOT
 *     retried, and a rejected key is reported as such so the person is told, not
 *     left with quietly degraded output
 *   - one global limit on concurrent requests, so a long interview cannot turn
 *     into a rate-limit storm. It keeps one slot for 'high' calls (the disagreement
 *     judge a person may be waiting on), which are also served first
 *   - a caller's AbortSignal cancels everything in flight (cancel / deadline), at
 *     once: a cancelled call rejects as `cancelled`, never as the retryable error it
 *     happened to be handling, and never after sleeping out a backoff
 *   - output cut off by the token limit is detected, so the caller can split the
 *     work instead of trying to parse half a JSON object
 *
 * Returns null without a key: ingestion then runs with no AI rewrite (the speaker's
 * own words) rather than refusing to boot.
 */

export type Priority = 'normal' | 'high';

export interface CompleteOptions {
  signal?: AbortSignal;
  /** 0 for a yes/no judgement that should come out the same every time; default 0.2 */
  temperature?: number;
  /**
   * 'high' is served before every waiting 'normal' call and may use the slot the limiter
   * keeps for it, so a disagreement check never queues behind a whole interview. Default
   * 'normal'.
   */
  priority?: Priority;
  /**
   * Give up once the call has RUN this long, counted from when its first request is
   * actually sent (a slot was free), not while it waits for one. Covers every attempt and
   * the backoff between them. Rejects as `timeout`.
   */
  timeoutMs?: number;
  /** Called once, when the call's first request is actually sent. */
  onStart?: () => void;
  /**
   * A duplicate sent beside a call that is already running: take a slot only if one is free
   * NOW, else reject at once as `busy` with nothing sent. Queued behind the very call it was
   * meant to rescue, it went out only when that call was cut off: a wasted request at the
   * deadline (review round 3, F14b). A model that does not queue ignores it.
   */
  noWait?: boolean;
}

export interface ChatModel {
  readonly id: string;
  /**
   * True when a call may first WAIT for a free slot (this client). Such a model calls
   * `onStart` when its first request is sent and applies `timeoutMs` from then, so a caller
   * must not count the wait against it. A model without the flag is taken to start at once.
   */
  readonly queued?: boolean;
  complete(system: string, user: string, opts?: CompleteOptions): Promise<string>;
}

export type ModelErrorKind =
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'bad_request'
  | 'truncated'
  | 'bad_output'
  | 'cancelled'
  /** `noWait` was asked and no slot was free: nothing was sent */
  | 'busy';

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: ModelErrorKind,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Anything thrown while calling a model, as a ModelError. */
export function asModelError(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  return new ModelError(`model call failed: ${String(e).slice(0, 80)}`, 'unavailable', false);
}

const cancelled = (): ModelError => new ModelError('cancelled', 'cancelled', false);
const timedOut = (retryable: boolean): ModelError =>
  new ModelError('the AI service did not answer in time', 'timeout', retryable);

/**
 * A number from the environment, or `fallback` when it is missing, not a number, or below
 * `min`. `Number('four')` is NaN, and `Math.max(1, NaN)` is NaN: a limiter built from that
 * never hands out a slot, and every model call in the process waits forever.
 */
export function readEnvNumber(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * NIM_HEDGE_MS: when to send a duplicate of a slow call. 0, a negative number, or "off" (also
 * "false", "no", "none") turn duplicates off; anything else that is not a number keeps the
 * default. "-1" used to fall back to the default and so LEFT THEM ON (review, round 2).
 */
export function readHedgeMs(raw: string | undefined, fallback = 40_000): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (/^\s*(?:off|false|no|none|disabled?)\s*$/i.test(raw)) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n > 0 ? n : 0;
}

/* ── a small FIFO semaphore with two priorities ─────────────────────── */

type Waiter = { go: () => void; since: number; timer?: ReturnType<typeof setTimeout> };

export class Semaphore {
  readonly size: number;
  /** an ordinary waiter held back this long by 'high' calls goes next (no starving) */
  private readonly ageMs: number;
  private readonly used: Record<Priority, number> = { high: 0, normal: 0 };
  private readonly waiting: Record<Priority, Waiter[]> = { high: [], normal: [] };

  constructor(size: number, opts: { ageMs?: number } = {}) {
    this.size = Number.isFinite(size) && size >= 1 ? Math.floor(size) : 1;
    this.ageMs = opts.ageMs !== undefined && Number.isFinite(opts.ageMs) ? opts.ageMs : 3_000;
  }

  private get inUse(): number {
    return this.used.high + this.used.normal;
  }

  /** 'normal' calls may use every slot but one when there are at least two: the last is kept for 'high' */
  private capFor(p: Priority): number {
    return p === 'high' || this.size < 2 ? this.size : this.size - 1;
  }

  /**
   * The oldest ordinary waiter is STARVED: it has waited `ageMs` while ordinary calls were below
   * their share, so 'high' calls are what hold it back. It goes next, into any slot. A waiter
   * that only waits behind other ordinary calls at their full share is not starved: it waits
   * its turn, and the kept slot stays free for the judge. (Round 2 aged every waiter, so a
   * second import's queued drafting took the judge's slot, and the judge waited while a slot
   * stood idle: review round 3, F7.)
   */
  private starved(): boolean {
    const first = this.waiting.normal[0];
    return (
      first !== undefined &&
      Date.now() - first.since >= this.ageMs &&
      this.used.normal < this.capFor('normal')
    );
  }

  /** Slots not in use right now. */
  get free(): number {
    return this.size - this.inUse;
  }

  /**
   * A slot right now, or null. Never waits, and never jumps a queue: a newcomer does not
   * take a slot that someone of its own (or a higher) priority is already waiting for, nor
   * one a starved ordinary call is owed. A 'high' call is never refused a free slot otherwise.
   */
  tryAcquire(priority: Priority = 'normal'): (() => void) | null {
    if (this.inUse >= this.capFor(priority)) return null;
    if (this.waiting.high.length > 0 || this.starved()) return null;
    if (priority === 'normal' && this.waiting.normal.length > 0) return null;
    this.used[priority]++;
    return this.releaser(priority);
  }

  async acquire(signal?: AbortSignal, priority: Priority = 'normal'): Promise<() => void> {
    // an already-cancelled caller does not queue for a slot it will never use
    if (signal?.aborted) throw cancelled();
    const now = this.tryAcquire(priority);
    if (now) return now;
    const queue = this.waiting[priority];
    // which priority's count the slot it gets is charged to (a starved ordinary call may be
    // handed the kept slot; it is still an ordinary call)
    await new Promise<void>((resolve, reject) => {
      const me: Waiter = {
        since: Date.now(),
        go: () => {
          clearTimeout(me.timer);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        clearTimeout(me.timer);
        const i = queue.indexOf(me);
        if (i >= 0) queue.splice(i, 1);
        reject(cancelled());
      };
      queue.push(me);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (priority === 'normal') {
        // when it has waited long enough, look again: a starved waiter must not leave a slot idle
        me.timer = setTimeout(() => this.dispatch(), this.ageMs + 1);
        me.timer.unref?.();
      }
    });
    return this.releaser(priority);
  }

  private releaser(priority: Priority): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used[priority]--;
      this.dispatch();
    };
  }

  /** Hand free slots to waiters: a starved ordinary one first, then 'high', each queue in order. */
  private dispatch(): void {
    for (;;) {
      if (this.starved() && this.inUse < this.size) {
        this.used.normal++;
        this.waiting.normal.shift()!.go();
      } else if (this.waiting.high.length > 0 && this.inUse < this.capFor('high')) {
        this.used.high++;
        this.waiting.high.shift()!.go();
      } else if (this.waiting.normal.length > 0 && this.inUse < this.capFor('normal')) {
        this.used.normal++;
        this.waiting.normal.shift()!.go();
      } else {
        return;
      }
    }
  }
}

/** Shared by every NIM client in the process. */
const GLOBAL_LIMIT = new Semaphore(Math.floor(readEnvNumber(process.env.NIM_CONCURRENCY, 4, 1)));

/* ── the client ──────────────────────────────────────────────────────── */

const NIM_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_MODEL_DEFAULT = 'nvidia/nemotron-3-ultra-550b-a55b';

/** a duplicate may be sent for at most this share of a client's recent attempts */
const MAX_HEDGE_SHARE = 0.25;
/** how many recent attempts that share is counted over */
const HEDGE_WINDOW = 20;

export interface NimOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** per attempt */
  timeoutMs?: number;
  /**
   * A call that has been running this long gets ONE duplicate sent beside it; the first
   * answer wins and the other is cancelled. The provider's speed varies several-fold from
   * minute to minute (11 s, then 47 s, once 133 s for the same request), and a duplicate
   * usually lands on a faster replica. 0 turns it off.
   *
   * A duplicate is only sent into a slot that is FREE at that moment (it never queues, so
   * it never delays anyone's first request), and only while at most a quarter of this
   * client's last 20 attempts were duplicated: when the provider is slow for everyone,
   * duplicating everything doubles the load and wins nothing.
   */
  hedgeMs?: number;
  /** attempts in total, first included */
  attempts?: number;
  fetchImpl?: typeof fetch;
  limiter?: Semaphore;
  /** backoff in tests: pass a function that does not wait (it is given the call's signal) */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 0..1, injected in tests */
  random?: () => number;
}

/** Wait, unless cancelled: then reject at once, also when the signal was ALREADY aborted. */
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(cancelled());
    };
    const t = setTimeout(() => {
      // a long-lived signal (one import's) must not collect a listener per backoff
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0), 20) * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 20_000) : null;
}

function classify(status: number): ModelError {
  const msg = `the AI service answered HTTP ${status}`;
  if (status === 401 || status === 403) return new ModelError(msg, 'auth', false, status);
  if (status === 429) return new ModelError(msg, 'rate_limited', true, status);
  if (status === 408 || status === 504) return new ModelError(msg, 'timeout', true, status);
  if (status >= 500 || status === 425) return new ModelError(msg, 'unavailable', true, status);
  return new ModelError(msg, 'bad_request', false, status);
}

const either = (a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined =>
  a && b ? AbortSignal.any([a, b]) : (a ?? b);

const positive = (n: number | undefined, fallback: number): number =>
  n !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;

type Answer = { text: string; wait: number | null };

export function createNimChat(opts?: NimOptions): ChatModel | null {
  const apiKey = opts?.apiKey ?? process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;
  const base = opts?.baseUrl ?? process.env.NIM_BASE_URL ?? NIM_BASE;
  const model = opts?.model ?? process.env.NIM_MODEL ?? NIM_MODEL_DEFAULT;
  const timeoutMs = positive(opts?.timeoutMs, 90_000);
  const hedgeMs =
    opts?.hedgeMs !== undefined
      ? Number.isFinite(opts.hedgeMs) && opts.hedgeMs > 0
        ? opts.hedgeMs
        : 0
      : readHedgeMs(process.env.NIM_HEDGE_MS);
  const attempts =
    opts?.attempts !== undefined && Number.isFinite(opts.attempts)
      ? Math.max(1, Math.floor(opts.attempts))
      : 3;
  const doFetch = opts?.fetchImpl ?? fetch;
  const limiter = opts?.limiter ?? GLOBAL_LIMIT;
  const random = opts?.random ?? Math.random;
  const sleep = opts?.sleep ?? realSleep;

  /** the hedge budget: which of this client's recent attempts were duplicated */
  const recent: Array<{ hedged: boolean }> = [];
  const noteAttempt = () => {
    const entry = { hedged: false };
    recent.push(entry);
    if (recent.length > HEDGE_WINDOW) recent.shift();
    return {
      mayHedge: () =>
        (recent.filter((r) => r.hedged).length + 1) / Math.max(recent.length, 4) <= MAX_HEDGE_SHARE,
      hedged: () => {
        entry.hedged = true;
      },
    };
  };

  /**
   * One request. `held` is a slot the caller already has (a duplicate, which must never
   * queue); otherwise one is waited for. `onStart` runs once the slot is ours.
   */
  const attempt = async (
    system: string,
    user: string,
    signal: AbortSignal | undefined,
    temperature: number,
    priority: Priority,
    onStart?: () => void,
    held?: () => void,
    noWait = false,
  ): Promise<Answer> => {
    const release =
      held ?? (noWait ? limiter.tryAcquire(priority) : await limiter.acquire(signal, priority));
    if (!release) throw new ModelError('no free slot for a duplicate', 'busy', false);
    try {
      onStart?.();
      if (signal?.aborted) throw cancelled();
      const timeout = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await doFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature,
            top_p: 0.9,
            max_tokens: 8192,
            // extraction with a hard JSON contract, not reasoning: thinking only adds latency
            chat_template_kwargs: { enable_thinking: false },
            stream: false,
          }),
        });
      } catch (e) {
        if (signal?.aborted) throw cancelled();
        const name = (e as { name?: string }).name;
        if (timeout.aborted || name === 'TimeoutError' || name === 'AbortError') {
          throw timedOut(true);
        }
        throw new ModelError('could not reach the AI service', 'unavailable', true);
      }
      // status only: the body of an error can echo the prompt (it is discarded unread)
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        const err = classify(res.status);
        (err as { wait?: number | null }).wait = retryAfterMs(res);
        throw err;
      }
      let json: { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> };
      try {
        json = (await res.json()) as typeof json;
      } catch {
        // the answer stopped arriving because WE stopped it: that is a cancel, not an outage
        if (signal?.aborted) throw cancelled();
        if (timeout.aborted) throw timedOut(true);
        throw new ModelError('the AI service sent an unreadable answer', 'unavailable', true);
      }
      const choice = json.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string') {
        throw new ModelError('the AI service sent no content', 'bad_output', true);
      }
      if (choice?.finish_reason === 'length') {
        throw new ModelError('the answer was cut off', 'truncated', false);
      }
      return { text: content.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), wait: null };
    } finally {
      release();
    }
  };

  /**
   * One attempt, with a duplicate sent beside it if it runs long (see `hedgeMs`). Settles
   * exactly once: with the first answer, or when both requests have failed (with the first
   * failure, or `cancelled` if the caller cancelled).
   */
  const hedgedAttempt = (
    system: string,
    user: string,
    signal: AbortSignal | undefined,
    temperature: number,
    priority: Priority,
    onFirstStart: () => void,
    noWait: boolean,
  ): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const loser = new AbortController();
      const both = signal ? AbortSignal.any([signal, loser.signal]) : loser.signal;
      const budget = noteAttempt();
      let open = 0;
      let done = false;
      let firstError: unknown;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        loser.abort(); // whichever is still running is no longer wanted
        settle();
      };
      const launch = (held?: () => void) => {
        open++;
        attempt(
          system,
          user,
          both,
          temperature,
          priority,
          held ? undefined : started,
          held,
          noWait,
        ).then(
          (v) => finish(() => resolve(v)),
          (e) => {
            firstError ??= e;
            if (--open === 0) finish(() => reject(signal?.aborted ? cancelled() : firstError));
          },
        );
      };
      const started = () => {
        onFirstStart();
        if (hedgeMs > 0) {
          timer = setTimeout(duplicate, hedgeMs);
          timer.unref?.();
        }
      };
      const duplicate = () => {
        if (done || both.aborted || !budget.mayHedge()) return;
        const slot = limiter.tryAcquire(priority); // a duplicate never waits for a slot
        if (!slot) return;
        budget.hedged();
        launch(slot);
      };
      launch();
    });

  return {
    id: `nim:${model}`,
    queued: true,
    /**
     * WORST CASE, one call: `attempts` requests plus at most one duplicate each, i.e.
     * 2 x attempts = 6 HTTP requests with the defaults. Duplicates only go into a slot that
     * is free at that moment and to at most a quarter of recent attempts, so in a slowdown
     * the average is about attempts x 1.25.
     */
    async complete(system, user, o) {
      const runFor = o?.timeoutMs !== undefined ? positive(o.timeoutMs, 0) : 0;
      const ran = runFor > 0 ? new AbortController() : undefined;
      const signal = either(o?.signal, ran?.signal);
      let runTimer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      const onFirstStart = () => {
        if (started) return;
        started = true;
        if (ran) {
          runTimer = setTimeout(() => ran.abort(), runFor);
          runTimer.unref?.();
        }
        try {
          o?.onStart?.();
        } catch {
          // a caller's hook cannot break the call
        }
      };
      // Stopped from outside. By the caller: `cancelled`, unless what fired was a TIMEOUT signal
      // (a deadline passed as `AbortSignal.timeout(...)`), which is `timeout`, so a caller can
      // tell "the person cancelled" from "out of time". By its own run limit: `timeout`.
      const stopped = (): ModelError =>
        o?.signal?.aborted
          ? (o.signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError'
            ? timedOut(false)
            : cancelled()
          : timedOut(false);
      try {
        let last: ModelError | null = null;
        for (let i = 0; i < attempts; i++) {
          if (signal?.aborted) throw stopped();
          try {
            return (
              await hedgedAttempt(
                system,
                user,
                signal,
                o?.temperature ?? 0.2,
                o?.priority ?? 'normal',
                onFirstStart,
                o?.noWait === true,
              )
            ).text;
          } catch (e) {
            if (signal?.aborted) throw stopped();
            const err = asModelError(e);
            if (!err.retryable || i === attempts - 1) throw err;
            last = err;
            const backoff = 1000 * 3 ** i * (0.75 + random() * 0.5);
            const hinted = (err as { wait?: number | null }).wait ?? null;
            const ms = Math.round(hinted === null ? backoff : Math.max(hinted, backoff * 0.5));
            try {
              await sleep(ms, signal);
            } catch {
              throw stopped();
            }
          }
        }
        throw last ?? new ModelError('the AI service failed', 'unavailable', false);
      } finally {
        clearTimeout(runTimer);
      }
    },
  };
}
