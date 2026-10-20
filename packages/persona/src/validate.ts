import { stripInvisible } from './sanitize';
import type { AnswerDraft, Claim, ClaimKind, EvidenceBlock } from './types';

/**
 * FM-026 unit 4 — the response validator. This is the DoD-1 deliverable and the
 * single thing standing between the product and a fabricated memory.
 *
 * The named shortcut is "decorative citations never checked against retrieved
 * chunks". The check that kills it is CLOSED-WORLD MEMBERSHIP: the cited chunk
 * must be in the exact set passed into THIS turn's prompt. Not "exists in the
 * database", not "is visible to this user" — both of those pass for a
 * syntactically valid id the model never saw, and both are the kind of check
 * that looks rigorous in review while verifying nothing that matters.
 *
 * Repo precedent for the shape: `chunk.ts`'s FM-037 `claimed` set, and
 * `search.ts` resolving the `allowed` CTE BEFORE ranking rather than filtering
 * results afterwards.
 */

export interface ValidationResult {
  accepted: Claim[];
  rejected: Array<{ claim: Claim; reason: string }>;
}

/**
 * Normalise for quote comparison — composition only.
 *
 * NFC on BOTH sides is required, not optional: FM-050 normalised titles, never
 * bodies, so a note written on macOS can sit in the database decomposed while
 * the model quotes it composed. Comparing raw would fail a perfectly honest
 * quote.
 *
 * What this deliberately does NOT do is fold case, collapse whitespace or strip
 * word endings. `was born` vs `were born` is precisely the quote/paraphrase
 * boundary; a "helpful" normaliser that erased it would make DoD 4
 * unenforceable in the permissive direction — every near-quote would pass as
 * verbatim. Text in a script the English rules do not cover (opaque.ts) is
 * compared the same way: exactly.
 */
function forQuote(s: string): string {
  // FM-027: strip smuggled codepoints BEFORE normalising. NFC does not touch
  // Cf/Cs/Co, so without this a Tag-block payload proves as a verbatim quote
  // precisely because it is invisible — measured, not theorised.
  return stripInvisible(s).normalize('NFC');
}

/** Longest common substring length, used only to separate paraphrase from inference. */
function overlap(a: string, b: string): number {
  const s = forQuote(a);
  const t = forQuote(b);
  let best = 0;
  let prev = new Uint16Array(t.length + 1);
  for (let i = 1; i <= s.length; i++) {
    const cur = new Uint16Array(t.length + 1);
    for (let j = 1; j <= t.length; j++) {
      if (s[i - 1] === t[j - 1]) {
        cur[j] = (prev[j - 1] ?? 0) + 1;
        if (cur[j]! > best) best = cur[j]!;
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * The label is assigned by MECHANISM where mechanism exists, never taken from
 * the provider's say-so.
 *
 * `quote` is provable: an NFC substring of the source. Nothing else is provable
 * in pure code, so the honest split is by lexical overlap — substantial shared
 * text is a paraphrase of this source, little shared text is an inference drawn
 * from it. A claim the provider labelled `quote` that fails the substring proof
 * is DEMOTED rather than rejected: the citation is still good, only the
 * epistemic claim was too strong.
 */
function labelFor(claim: Claim, source: string): ClaimKind {
  const text = forQuote(claim.text);
  if (text.length > 0 && forQuote(source).includes(text)) return 'quote';
  const share = overlap(claim.text, source) / Math.max(text.length, 1);
  return share >= 0.5 ? 'paraphrase' : 'inference';
}

export function validateDraft(draft: AnswerDraft, evidence: EvidenceBlock[]): ValidationResult {
  // The closed world. Built once per turn from the blocks actually sent.
  const byChunk = new Map(evidence.map((b) => [b.chunkId, b]));

  const accepted: Claim[] = [];
  const rejected: Array<{ claim: Claim; reason: string }> = [];

  for (const claim of draft.claims) {
    const c = claim?.citation;
    if (!c || !c.chunkId || !c.noteId) {
      rejected.push({ claim, reason: 'no citation' });
      continue;
    }

    const block = byChunk.get(c.chunkId);
    if (!block) {
      // The load-bearing rejection: a well-formed citation to something that
      // was never in this turn's evidence. Covers both an invented id and a
      // prior answer trying to launder itself in as testimony.
      rejected.push({ claim, reason: 'citation is not a member of this turn evidence' });
      continue;
    }
    if (block.noteId !== c.noteId) {
      rejected.push({ claim, reason: 'citation note does not match the cited chunk' });
      continue;
    }

    // Grain is DECLARED, so it is also checked. Claiming `block` grain on a
    // chunk with no authored anchor is exactly the query-time anchor
    // fabrication D-46 forbids, and it is how a weak citation would dress
    // itself up as a precise one.
    if (c.grain === 'block') {
      if (!block.anchor || c.anchor !== block.anchor) {
        rejected.push({ claim, reason: 'block grain claimed but the chunk has no such anchor' });
        continue;
      }
    } else if (c.anchor !== null && c.anchor !== block.anchor) {
      rejected.push({ claim, reason: 'anchor does not match the cited chunk' });
      continue;
    }

    // The accepted claim carries SANITISED text. Proving the quote against a
    // cleaned source while returning the hostile original would move the
    // payload one step downstream rather than remove it.
    // A claim whose text is ENTIRELY smuggled codepoints sanitises to '' and was
    // being accepted: it satisfied gate C, suppressed abstention, and inflated
    // the distinct-source count with nothing at all. `labelFor`'s `length > 0`
    // guard even labelled it an inference rather than rejecting it.
    const text = stripInvisible(claim.text).trim();
    if (text === '') {
      rejected.push({ claim, reason: 'claim text is empty after sanitisation' });
      continue;
    }
    accepted.push({ ...claim, text, kind: labelFor({ ...claim, text }, block.content) });
  }

  return { accepted, rejected };
}
