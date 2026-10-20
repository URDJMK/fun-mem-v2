import { describe, expect, it } from 'vitest';
import { claimsOf } from '../src/ingest-save';

describe("what an import compares with the archive: the relative's words only", () => {
  it("a Short answers note offers the answers, never the interviewer's questions", () => {
    const body =
      "- Did you ever go back to Busan? — Yes. Very much.\n- What was your mother's name? — Her name was Sunja Kim.\n- Every day.\n\n> From “tape” · told by Grandma (0:03–2:10)";
    expect(claimsOf(body)).toEqual(['Yes.', 'Very much.', 'Her name was Sunja Kim.', 'Every day.']);
  });

  it('an ordinary memory is read as it is, footer excluded', () => {
    const body =
      'My father repaired boats. He had big hands.\n\n> Question: “Tell me about your father.”\n> From “tape” · told by Grandma (0:12–0:40)';
    expect(claimsOf(body)).toEqual(['My father repaired boats.', 'He had big hands.']);
  });

  it('a memory with one bullet among prose is not a Short answers note: nothing is cut', () => {
    const body =
      "We ate well that year.\n- apples — a favourite of my mother's\nThen the frost came.";
    expect(claimsOf(body).join(' ')).toContain('apples');
  });

  it('Short answers lines in another script are cut the same way', () => {
    const body =
      '- Где вы родились? — В Одессе.\n- А школа? — Да.\n\n> From “запись” · told by Grandma (0:03–1:10)';
    expect(claimsOf(body)).toEqual(['В Одессе.', 'Да.']);
  });
});
