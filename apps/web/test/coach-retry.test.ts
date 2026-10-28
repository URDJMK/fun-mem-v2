import { describe, expect, it } from 'vitest';
import { afterCoachFailure } from '../src/lib/coach-retry';

/**
 * When a suggestion can't be had, the question bank stands in. How long it stands in depends on
 * why: a project's coach answers one ask at a time, so "busy" means wait a moment, not "down".
 */
describe('after asking the coach failed', () => {
  it('busy: asks again once, when the server says to, without giving up on the AI', () => {
    expect(afterCoachFailure({ status: 429, code: 'busy', retryAfter: 2 }, 0)).toEqual({
      retryInMs: 2000,
    });
    // a missing or silly wait is kept to a few seconds
    expect(afterCoachFailure({ status: 429, code: 'busy', retryAfter: null }, 0)).toEqual({
      retryInMs: 2000,
    });
    expect(afterCoachFailure({ status: 429, code: 'busy', retryAfter: 600 }, 0)).toEqual({
      retryInMs: 5000,
    });
  });

  it('busy twice: the bank answers this once, and the next ask goes to the AI again', () => {
    expect(afterCoachFailure({ status: 429, code: 'busy', retryAfter: 2 }, 1)).toEqual({
      bankForMs: 0,
    });
  });

  it('the model failed or the connection dropped: the bank stands in for a short while', () => {
    expect(afterCoachFailure({ status: 502, code: 'unavailable', retryAfter: null }, 0)).toEqual({
      bankForMs: 15_000,
    });
    expect(afterCoachFailure(null, 0)).toEqual({ bankForMs: 15_000 });
  });

  it('no coach here, or not allowed: the bank stands in for the rest of the interview', () => {
    for (const f of [
      { status: 503, code: 'not_configured', retryAfter: null },
      { status: 403, code: 'forbidden', retryAfter: null },
      { status: 404, code: null, retryAfter: null },
    ]) {
      expect(afterCoachFailure(f, 0)).toEqual({ bankForMs: Number.POSITIVE_INFINITY });
    }
  });
});
