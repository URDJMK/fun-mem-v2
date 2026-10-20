import { describe, expect, it } from 'vitest';
import { contentTerms, decideAbstention } from '../src/abstain';
import { BIRTH, GAPS, WEDDING } from './testimony-fixtures';
import { block, OTHER_SCRIPT } from './fixtures';
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
    for (const { question, body, missing } of GAPS) {
      const ev = [block({ content: body, legs: ['ts'], ranks: { ts: 1 }, score: 0.9 })];
      const d = decideAbstention(ev, 1, 1, ok(3), question);
      expect(d.abstain, `answered a gap-question: ${question}`).toBe(true);
      expect(d.message, 'a gap refusal carried no message').toBeTruthy();
      // and it refuses for the RIGHT reason: it names what the evidence lacks,
      // not some filler word that happened to be missing
      for (const word of missing) {
        expect(d.reason, `the refusal does not name '${word}'`).toContain(`'${word}'`);
      }
    }

    // POSITIVE CONTROL. Without this, "gap-questions refuse" is satisfied by a
    // gate that refuses everything — which would make the whole feature useless
    // while passing the test.
    // Three positive controls, all on REALISTIC testimony — transcribed speech
    // with mixed registers, fused possessives, a spelled-out year and
    // inconsistent capitals. A gate tuned to textbook prose passes the synthetic
    // version and refuses everything a real family would actually write.
    for (const c of [
      { q: BIRTH.question, body: BIRTH.body },
      { q: WEDDING.question, body: WEDDING.mother },
      { q: WEDDING.question, body: WEDDING.uncle },
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
        content: 'Grandpa was born in Cork in 1940 and married in 1965 and had four children',
        legs: ['ts'],
        ranks: { ts: 1 },
      }),
    ];
    const gap = "Where was Grandpa's first job?";
    const hit = 'Where was Grandpa born?';

    // identical evidence, identical counts, identical validation — ONLY the
    // question differs. A gate that ignores the question cannot separate these.
    const a = decideAbstention(ev, 1, 1, ok(2), gap);
    const b = decideAbstention(ev, 1, 1, ok(2), hit);
    expect(a.abstain, 'the gap-question was answered').toBe(true);
    expect(b.abstain, 'the answerable question was refused').toBe(false);
    expect(a.reason).not.toBe(b.reason);
  });

  it('the gate survives the shapes a real English question actually takes', () => {
    const ev = (content: string) => [block({ content, legs: ['ts'], ranks: { ts: 1 } })];

    // The question's own subject is a content term, whatever it looks like. The
    // gate drops a word only for being a question word or for being filler, so a
    // short or unusual subject must come through; if it did not, the question
    // would stop requiring the very person it is about.
    for (const w of ['Grandfather', 'Mom', 'Uncle']) {
      expect(contentTerms(`Where was ${w} born?`), `${w} was eaten as filler`).toContain(w);
    }

    // A question word is never a content term, in any case and with any ending.
    // One that survived would be a term no evidence can contain, which buys the
    // gate a free miss on the commonest question there is.
    for (const w of ['Who', 'WHO', 'Whose', 'Whom', 'What', 'When', 'Whenever', 'Where', 'Why']) {
      expect(contentTerms(`${w} came to the wedding?`), `${w} was kept as a term`).not.toContain(w);
    }
    expect(contentTerms('Who came to the wedding?')).toEqual(['came', 'the', 'wedding']);
    // ...while a word that merely CONTAINS one stays: only a prefix is a question word
    expect(contentTerms('Was Grandma somewhat happy?')).toContain('somewhat');

    // English inflects: `swimming` in the question finds `swimmer` in the
    // evidence through its short stem, or every inflected question would miss.
    expect(
      decideAbstention(
        ev('Grandma was a keen swimmer and loved the sea'),
        1,
        1,
        ok(2),
        'Where was Grandma swimming?',
      ).abstain,
      'an inflected word in the question missed its stem in the evidence',
    ).toBe(false);

    // An NFD question against NFC evidence made every accented term uncoverable,
    // turning a useful refusal into a blanket one. (`Zoë` is the case a stem
    // cannot rescue: decomposed, its first three letters are not in `Zoë`.)
    const evidence = ev('Zo\u{EB} did her homework at the kitchen table every evening');
    const composed = 'What did Zo\u{EB} do?';
    const decomposed = composed.normalize('NFD');
    expect(decomposed, 'the fixture is not actually decomposed').not.toBe(composed);
    const withComposed = decideAbstention(evidence, 1, 1, ok(2), composed);
    expect(withComposed.abstain, 'the composed control was refused').toBe(false);
    expect(decideAbstention(evidence, 1, 1, ok(2), decomposed).abstain).toBe(withComposed.abstain);

    // A question with nothing checkable is REFUSED, not waved through. Skipping
    // the gate answered the least-specified input of all with cited claims.
    for (const q of ['Why?', 'Who is it?', '?!', '']) {
      const empty = decideAbstention(ev(BIRTH.body), 1, 1, ok(2), q);
      expect(empty.abstain, `a question with no content terms was answered: '${q}'`).toBe(true);
      expect(empty.reason).toMatch(/no checkable content terms/);
    }
  });

  it('text in a script the English rules do not cover is checked exactly, never skipped', () => {
    const ev = (content: string) => [block({ content, legs: ['ts'], ranks: { ts: 1 } })];
    const { cyrillic, cyrillicOtherCase, cyrillicQuestion, han } = OTHER_SCRIPT;

    // KEPT. In these scripts one or two characters are a whole word, and the
    // three-letter floor that drops English filler (`is`, `of`) would silently
    // drop the word from the check.
    expect(contentTerms(`Where is ${han}?`)).toContain(han);
    expect(contentTerms('Was он home?')).toContain('он');
    expect(contentTerms('Where is it?'), 'the floor stopped dropping English filler').toEqual([]);

    // A whole question in another script is not special-cased: every word of it
    // is a term the evidence has to contain.
    expect(contentTerms(cyrillicQuestion)).toEqual(['где', 'жила', 'бабушка']);
    const foreign = decideAbstention(ev(BIRTH.body), 1, 1, ok(2), 'бабушка родилась');
    expect(foreign.abstain, 'a question in another script was waved through').toBe(true);
    expect(foreign.reason).toContain("'бабушка'");

    // POSITIVE CONTROL: the same question against evidence that has the words
    // answers, so the refusals above are not a gate that refuses everything.
    expect(decideAbstention(ev(cyrillic), 1, 1, ok(2), 'бабушка родилась').abstain).toBe(false);

    // EXACT. English matches `swimming` to `swimmer` by a three-letter stem; that
    // is a rule about English endings and must not reach other scripts. Here the
    // evidence holds the same word in another case, so the stem WOULD match; an
    // exact comparison refuses, which is the strict direction.
    expect(cyrillicOtherCase, 'the fixture lost its shared stem').toContain('бабушка'.slice(0, 3));
    const other = decideAbstention(ev(cyrillicOtherCase), 1, 1, ok(2), 'бабушка');
    expect(other.abstain, 'a loose English stem match was applied to another script').toBe(true);
    expect(other.reason).toContain("'бабушка'");
  });

  it('a short word in another script is required, but can neither carry a question nor pad one', () => {
    const ev = (content: string) => [block({ content, legs: ['ts'], ranks: { ts: 1 } })];
    const { cyrillic, han } = OTHER_SCRIPT;

    // It cannot CARRY a question. A one- or two-character word is often a letter
    // or a particle that any text of its language contains, so finding it proves
    // nothing, and a question of nothing else is as unverifiable as an empty one:
    // refused even though the evidence holds the very words.
    const tiny = decideAbstention(ev('он и в на'), 1, 1, ok(2), 'он и?');
    expect(tiny.abstain, 'a question of tiny foreign words was answered').toBe(true);
    expect(tiny.reason).toMatch(/no checkable content terms/);
    const ideographs = decideAbstention(ev(`Visit ${han} now`), 1, 1, ok(2), `Where is ${han}?`);
    expect(ideographs.abstain, 'a question of two characters was answered').toBe(true);

    // It is still REQUIRED beside real words: kept, never dropped, and with no
    // tolerance. The evidence here is English and has no `и`. Four English terms
    // would normally tolerate one miss; the foreign word may not use it.
    const asked = (q: string) => decideAbstention(ev(BIRTH.body), 1, 1, ok(2), q);
    expect(asked('was Grandma born Lisbon').abstain, 'the English control was refused').toBe(false);
    const withTiny = asked('was Grandma born Lisbon и');
    expect(withTiny.abstain, 'a short foreign word was dropped from the check').toBe(true);
    expect(withTiny.reason).toContain("'и'");

    // It cannot PAD a question. English tolerates one missed word in four, since
    // phrasing differs. A short foreign word that the evidence DOES hold must not
    // lift the count to four and buy that miss for the words that matter.
    const swimming = (extra: string, evidence: string) =>
      decideAbstention(ev(evidence), 1, 1, ok(2), `was Grandma swimming ${extra}`);
    expect(
      swimming('born', 'Grandma was born in Lisbon').abstain,
      'an English fourth word no longer buys its one tolerated miss',
    ).toBe(false);
    expect(
      swimming('и', 'Grandma was born in Lisbon и').abstain,
      'a short foreign word bought a miss',
    ).toBe(true);
    expect(
      decideAbstention(ev(cyrillic), 1, 1, ok(2), 'бабушка родилась вчера и').abstain,
      'padding bought a miss in a question in another script',
    ).toBe(true);
  });
});
