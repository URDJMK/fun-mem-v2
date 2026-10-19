import { describe, expect, it } from 'vitest';
import { block, unanchored } from './fixtures';
import { validateDraft } from '../src/validate';
import type { AnswerDraft, Claim } from '../src/types';

const claim = (over: Partial<Claim> = {}): Claim => ({
  text: '할머니는 1943년에 부산에서 태어나셨다.',
  kind: 'quote',
  citation: {
    noteId: '22222222-2222-2222-2222-222222222222',
    anchor: 'abc-1',
    grain: 'block',
    chunkId: '11111111-1111-1111-1111-111111111111',
  },
  ...over,
});

const draft = (claims: Claim[]): AnswerDraft => ({
  selfIdentification: 'AI',
  claims,
  abstained: false,
});

describe('FM-026 response validator', () => {
  it('a citation to a chunk that was never retrieved is rejected', () => {
    const evidence = [block()];

    // POSITIVE CONTROL FIRST. If nothing validates, "the forgery is rejected"
    // is satisfied by a validator that rejects everything.
    expect(
      validateDraft(draft([claim()]), evidence).accepted,
      'nothing validates at all',
    ).toHaveLength(1);

    // A syntactically perfect citation to a chunk that exists in the database
    // but was NOT in this turn's evidence. This is the whole defect: validating
    // against the DB, or against "is this a real uuid", passes it.
    const forged = claim({
      citation: {
        noteId: '99999999-9999-9999-9999-999999999999',
        anchor: 'real-looking',
        grain: 'block',
        chunkId: '88888888-8888-8888-8888-888888888888',
      },
    });
    const r = validateDraft(draft([forged]), evidence);
    expect(r.accepted, 'a citation outside this turn evidence was accepted').toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/evidence|membership|retriev/i);

    // subtler: the right note, but a chunk id from a different turn
    const wrongChunk = claim({
      citation: { ...claim().citation, chunkId: '77777777-7777-7777-7777-777777777777' },
    });
    expect(validateDraft(draft([wrongChunk]), evidence).accepted).toHaveLength(0);

    // ...and the mirror, which mutation showed nothing covered: a REAL chunk
    // from this turn paired with someone else's note id. Accepting it would
    // attribute this family's words to a different note entirely.
    const wrongNote = claim({
      citation: { ...claim().citation, noteId: '66666666-6666-6666-6666-666666666666' },
    });
    const wn = validateDraft(draft([wrongNote]), evidence);
    expect(wn.accepted, 'a chunk was citable under the wrong note').toHaveLength(0);
    expect(wn.rejected[0]!.reason).toMatch(/note/i);
  });

  it('a claim with no citation is rejected', () => {
    const evidence = [block()];
    // a provider that returns prose with no citation at all
    const naked = { ...claim(), citation: undefined } as unknown as Claim;
    const r = validateDraft(draft([naked]), evidence);
    expect(r.accepted, 'an uncited claim was accepted').toHaveLength(0);
    expect(r.rejected).toHaveLength(1);

    // and a claim whose citation is present but empty
    const empty = claim({
      citation: { noteId: '', anchor: null, grain: 'chunk', chunkId: '' },
    });
    expect(validateDraft(draft([empty]), evidence).accepted).toHaveLength(0);
  });

  it('a quote claim is proved against the source text or demoted', () => {
    const evidence = [block()];

    // an exact substring is a quote
    expect(validateDraft(draft([claim()]), evidence).accepted[0]!.kind).toBe('quote');

    // NFC on BOTH sides. Note bodies are never normalised on write — FM-050
    // normalised titles only — so a decomposed body against a composed quote
    // must still prove. This fixture is the same text in NFD.
    const nfd = block({ content: block().content.normalize('NFD') });
    expect(
      validateDraft(draft([claim()]), [nfd]).accepted[0]!.kind,
      'NFD source defeated an NFC quote',
    ).toBe('quote');

    // A PARTICLE SWAP IS NOT A QUOTE. 할머니는 -> 할머니가 is exactly the
    // quote/paraphrase boundary in Korean; a validator that strips particles or
    // collapses whitespace to be "helpful" erases the distinction DoD 4 exists
    // to draw. It must be DEMOTED, not rejected — the citation is still good.
    const swapped = claim({ text: '할머니가 1943년에 부산에서 태어나셨다.' });
    const r = validateDraft(draft([swapped]), evidence);
    expect(r.accepted, 'a near-quote was dropped instead of demoted').toHaveLength(1);
    expect(r.accepted[0]!.kind, 'a particle swap passed as a verbatim quote').not.toBe('quote');

    // text absent from the source entirely cannot be a quote either
    const invented = claim({ text: '할머니는 1943년에 서울에서 태어나셨다.' });
    expect(validateDraft(draft([invented]), evidence).accepted[0]?.kind).not.toBe('quote');
  });

  it('a claim citing block grain without an anchor is rejected', () => {
    // D-46: grain is DECLARED, so it must also be checked. Claiming `block`
    // grain on a chunk with no authored anchor is the query-time anchor
    // fabrication the decision forbids.
    const lying = claim({
      text: '아버지는 농부였어요',
      citation: {
        noteId: unanchored.noteId,
        anchor: 'invented',
        grain: 'block',
        chunkId: unanchored.chunkId,
      },
    });
    const r = validateDraft(draft([lying]), [unanchored]);
    expect(r.accepted, 'a fabricated anchor was accepted').toHaveLength(0);
    expect(r.rejected[0]!.reason).toMatch(/anchor|grain/i);

    // the honest form of the same claim, at chunk grain, IS accepted — the
    // fallback must actually work or the archive is uncitable
    const honest = claim({
      text: '아버지는 농부였어요',
      citation: {
        noteId: unanchored.noteId,
        anchor: null,
        grain: 'chunk',
        chunkId: unanchored.chunkId,
        chunkIndex: 0,
      },
    });
    expect(
      validateDraft(draft([honest]), [unanchored]).accepted,
      'chunk grain was unusable',
    ).toHaveLength(1);
  });
});
