import { describe, expect, it } from 'vitest';
import { contentTerms, decideAbstention } from '../src/abstain';
import { BIRTH, GAPS, WEDDING } from './korean-fixtures';
import { block } from './fixtures';
import type { Claim } from '../src/types';

const ok = (n: number): { accepted: Claim[]; rejected: [] } => ({
  accepted: Array.from({ length: n }, () => ({}) as Claim),
  rejected: [],
});

describe('FM-027 gap-questions', () => {
  it('a gap-question refuses even when evidence is strong and on-topic', () => {
    // NOT the FM-026 weak-evidence case. Here retrieval SUCCEEDS: the evidence
    // is about the right person, arrives on a content leg, fits the budget, and
    // its citations validate. It simply does not contain the answer. Verified
    // against the shipped pipeline before this test existed: it returned three
    // accepted quote claims and abstain=false.
    for (const { question, body } of GAPS) {
      const ev = [block({ content: body, legs: ['ts'], ranks: { ts: 1 }, score: 0.9 })];
      const d = decideAbstention(ev, 1, 1, ok(3), question);
      expect(d.abstain, `answered a gap-question: ${question}`).toBe(true);
      expect(d.message, 'a gap refusal carried no message').toBeTruthy();
    }

    // POSITIVE CONTROL. Without this, "gap-questions refuse" is satisfied by a
    // gate that refuses everything — which would make the whole feature useless
    // while passing the test.
    // Two positive controls, both on REALISTIC testimony — transcribed speech
    // with mixed speech levels, fused 조사, 한자 place names and inconsistent
    // spacing. A gate tuned to textbook Korean passes the synthetic version and
    // refuses everything a real family would actually write.
    for (const c of [
      { q: BIRTH.question, body: BIRTH.body },
      { q: WEDDING.question, body: WEDDING.mother },
    ]) {
      const ev = [block({ content: c.body, legs: ['ts'], ranks: { ts: 1 }, score: 0.9 })];
      const d = decideAbstention(ev, 1, 1, ok(2), c.q);
      expect(d.abstain, `refused an answerable question: ${c.q}`).toBe(false);
    }
  });

  it('the topical gate reads the question, not the candidate count', () => {
    // `relevant` in evidence.ts is a RAW CANDIDATE COUNT. Nothing in the
    // FM-026 pipeline meant "topically relevant to this question", and reusing
    // that number as if it did is the tempting shortcut here.
    const ev = [
      block({
        content: '할아버지는 1940년 대구 출생이시고 결혼은 1965년에 하셨다 자식은 넷을 두셨어요',
        legs: ['ts'],
        ranks: { ts: 1 },
      }),
    ];
    const gap = '할아버지 첫 직장은 어디였어요?';
    const hit = '할아버지는 어디서 태어나셨어요?';

    // identical evidence, identical counts, identical validation — ONLY the
    // question differs. A gate that ignores the question cannot separate these.
    const a = decideAbstention(ev, 1, 1, ok(2), gap);
    const b = decideAbstention(ev, 1, 1, ok(2), hit);
    expect(a.abstain, 'the gap-question was answered').toBe(true);
    expect(b.abstain, 'the answerable question was refused').toBe(false);
    expect(a.reason).not.toBe(b.reason);
  });

  it('the gate survives the shapes a real Korean question actually takes', () => {
    const ev = (content: string) => [block({ content, legs: ['ts'], ranks: { ts: 1 } })];

    // 아버지 / 할아버지 / 누나 all END in a "predicate" syllable. Testing every
    // token for a conjugated tail exempted the question's own subject, which
    // made the gate vacuous for a large class of family questions. Only the
    // FINAL token may be the predicate — Korean is SOV.
    for (const w of ['아버지', '할아버지', '누나']) {
      expect(
        contentTerms(`${w}는 어디서 태어나셨어요?`),
        `${w} was eaten as a predicate`,
      ).toContain(w);
    }

    // 누가 ends in the subject particle 가. Stripping particles BEFORE the
    // interrogative test left `누`, a junk term no evidence can contain, which
    // bought the gate a free miss on the commonest Korean "who" question.
    expect(contentTerms('누가 결혼식에 왔어요?')).not.toContain('누');

    // 한자 is normal in older Korean records. A Latin length floor applied to
    // CJK ideographs emptied the term list, and an empty list disabled the gate.
    expect(contentTerms('釜山 어디에서 사셨어요?')).toContain('釜山');

    // An NFD question against NFC evidence made every term uncoverable, turning
    // a useful refusal into a blanket one.
    const q = '할머니는 어디서 태어나셨어요?';
    expect(decideAbstention(ev(BIRTH.body), 1, 1, ok(2), q.normalize('NFD')).abstain).toBe(
      decideAbstention(ev(BIRTH.body), 1, 1, ok(2), q).abstain,
    );

    // A question with nothing checkable is REFUSED, not waved through. Skipping
    // the gate answered the least-specified input of all with cited claims.
    const empty = decideAbstention(ev(BIRTH.body), 1, 1, ok(2), '왜?');
    expect(empty.abstain, 'a question with no content terms was answered').toBe(true);
  });
});
