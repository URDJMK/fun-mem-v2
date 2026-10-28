/**
 * What the interview coach does when a suggestion could not be had. The question bank always
 * stands in; how long it does depends on why. A project's coach answers one ask at a time
 * (server/api/src/interview-coach.ts), so "busy" means wait a moment, not that the AI is down.
 */
export interface CoachFailure {
  status: number;
  code: string | null;
  /** seconds, from a 429 */
  retryAfter: number | null;
}

/** `failure` is null when no answer came at all (the connection dropped). */
export function afterCoachFailure(
  failure: CoachFailure | null,
  attempt: number,
): { retryInMs: number } | { bankForMs: number } {
  if (failure?.status === 429) {
    if (attempt > 0) return { bankForMs: 0 };
    const s = failure.retryAfter ?? 2;
    return { retryInMs: Math.min(Math.max(s, 1), 5) * 1000 };
  }
  // no coach configured, or not this person's to use: asking again won't change that
  if (failure && (failure.status === 503 || (failure.status >= 400 && failure.status < 500)))
    return { bankForMs: Number.POSITIVE_INFINITY };
  return { bankForMs: 15_000 };
}
