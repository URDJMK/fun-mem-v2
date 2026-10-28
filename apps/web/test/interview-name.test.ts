import { describe, expect, it } from 'vitest';
import { interviewName } from '../src/lib/interview-name';

/** A live interview's default name: its date and topics, never the first thing said ("Hi."). */
describe('interviewName', () => {
  const at = '2026-10-26T09:00:00.000Z';

  it('is the date when no topic was chosen', () => {
    expect(interviewName(at, [])).toBe('Interview, 26 Oct 2026');
  });

  it('adds the topics chosen at the start, by their names', () => {
    expect(interviewName(at, ['childhood', 'work'])).toBe(
      'Interview, 26 Oct 2026 · Childhood, Work',
    );
  });

  it('names at most two topics', () => {
    expect(interviewName(at, ['childhood', 'family', 'work'])).toBe(
      'Interview, 26 Oct 2026 · Childhood, Family',
    );
  });

  it('skips a topic it does not know', () => {
    expect(interviewName(at, ['nonsense', 'work'])).toBe('Interview, 26 Oct 2026 · Work');
  });
});
