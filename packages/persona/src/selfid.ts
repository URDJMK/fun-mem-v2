/**
 * FM-026 unit 6 — self-identification (spec §8.1, FR-085).
 *
 * Injected by CODE on caller-supplied turn state. Asking the model to volunteer
 * "I am an AI" makes the guarantee depend on the very thing it guards against,
 * and there is no session concept anywhere in this stack — so the turn index is
 * caller state, never hidden persona state.
 */
export const SELF_IDENTIFICATION =
  '저는 이 기록을 바탕으로 답하는 AI입니다. 제 답변은 기록이 아니며 증거로 저장되지 않습니다.';

export function selfIdentificationFor(turnIndex: number): string | null {
  return turnIndex === 0 ? SELF_IDENTIFICATION : null;
}
