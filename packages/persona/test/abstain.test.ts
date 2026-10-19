import { describe, expect, it } from 'vitest';
import { block } from './fixtures';
import { decideAbstention } from '../src/abstain';
import { budgetEvidence } from '../src/evidence';
import type { ValidationResult } from '../src/validate';
import type { Claim } from '../src/types';

const ok = (n: number): ValidationResult => ({
  accepted: Array.from({ length: n }, () => ({}) as Claim),
  rejected: [],
});
const none: ValidationResult = { accepted: [], rejected: [] };

describe('FM-026 abstention', () => {
  it('abstention triggers on leg composition, not on fused score alone', () => {
    // RRF gives a rank-1 hit WEIGHTS[leg]/(60+1) regardless of how good the
    // match actually was: a vector hit with cosine 0.15 scores identically to
    // one with 0.95, and to a title-substring hit. So a high fused score is not
    // evidence of anything, and thresholding on it is a magic number.

    // title-only and date-only hits are METADATA matches, not evidence. A note
    // titled "할머니" matches the word without containing a single fact.
    const titleOnly = [block({ legs: ['title'], ranks: { title: 1 }, score: 0.99 })];
    const d = decideAbstention(titleOnly, 1, 1, ok(1));
    expect(d.abstain, 'a title-only hit with a high score was treated as evidence').toBe(true);
    expect(d.reason).toMatch(/leg|composition|metadata/i);

    const dateOnly = [block({ legs: ['date'], ranks: { date: 1 }, score: 0.99 })];
    expect(decideAbstention(dateOnly, 1, 1, ok(1)).abstain).toBe(true);

    // POSITIVE CONTROL: a content leg with a LOWER score does not abstain. If
    // this also abstained, the assertion above would be satisfied by a function
    // that always abstains.
    const contentLeg = [block({ legs: ['ts'], ranks: { ts: 9 }, score: 0.01 })];
    expect(
      decideAbstention(contentLeg, 1, 1, ok(1)).abstain,
      'a genuine content hit was refused',
    ).toBe(false);

    // pgroonga and vector are content legs too
    for (const leg of ['pgroonga', 'vector'] as const) {
      expect(
        decideAbstention([block({ legs: [leg], ranks: { [leg]: 3 } })], 1, 1, ok(1)).abstain,
      ).toBe(false);
    }
    // a title hit that ALSO matched content is fine — composition, not exclusion
    expect(
      decideAbstention([block({ legs: ['title', 'ts'], ranks: { title: 1, ts: 2 } })], 1, 1, ok(1))
        .abstain,
    ).toBe(false);
  });

  it('weak evidence abstains even when retrieval is non-empty', () => {
    // The named shortcut is "abstain only on empty retrieval". Each case below
    // has NON-EMPTY, content-leg retrieval and must still abstain.

    // (a) budget fit: 12 chunks were relevant, 2 fitted. The answer would be
    // built on a sixth of what the question needed.
    const twelve = Array.from({ length: 12 }, () => block());
    expect(
      decideAbstention(twelve.slice(0, 2), 2, 12, ok(1)).abstain,
      'poor budget fit answered',
    ).toBe(true);

    // (b) validator survival: citations existed but none checked out.
    expect(decideAbstention([block()], 1, 1, none).abstain, 'zero surviving claims answered').toBe(
      true,
    );

    // (c) control: good fit and surviving claims -> answer
    expect(decideAbstention([block()], 1, 1, ok(2)).abstain).toBe(false);

    // (d) the ratio driven by the REAL budgeter, not by hand-passed numbers.
    // Raised in review: gate B was only ever exercised with literals, so
    // nothing proved budgetEvidence can actually produce a sub-threshold
    // ratio at a realistic budget — the endpoint's guarantee rested on gates
    // A and C alone. This wires the two together.
    const long = '가'.repeat(400);
    const many = Array.from({ length: 12 }, (_, i) =>
      block({
        chunkId: `${i}`.padStart(8, '0') + '-0000-0000-0000-000000000000',
        content: long,
      }),
    );
    const tight = budgetEvidence(many, 900);
    expect(
      tight.fitted.length,
      'the budgeter fitted everything, so gate B is untestable',
    ).toBeLessThan(many.length / 2);
    expect(
      decideAbstention(tight.fitted, tight.fitted.length, tight.relevant, ok(1)).abstain,
      'a budget-starved answer was not refused',
    ).toBe(true);

    // and with room, the same evidence answers
    const roomy = budgetEvidence(many, 100_000);
    expect(decideAbstention(roomy.fitted, roomy.fitted.length, roomy.relevant, ok(1)).abstain).toBe(
      false,
    );

    // empty retrieval is the trivial instance, never the definition
    expect(decideAbstention([], 0, 0, none).abstain).toBe(true);
  });

  it('an abstention offers the family-ask next step', () => {
    const d = decideAbstention([], 0, 0, none);
    expect(d.abstain).toBe(true);
    // FR-084 wants a USEFUL abstention. A bare refusal fails the DoD; the
    // actionable offer is what makes it useful per journey 6.4.
    expect(d.message, 'abstention produced no message').toBeTruthy();
    expect(d.message!.length).toBeGreaterThan(10);
    expect(d.message, 'the abstention does not offer a next step').toMatch(/가족|물어|ask|family/i);

    // and it must not pretend to know something
    expect(d.message).not.toMatch(/아마|probably|maybe|추측/i);
  });
});
