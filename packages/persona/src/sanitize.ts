/**
 * FM-027 unit 2 — invisible-codepoint defence.
 *
 * This exists because of a defect measured in FM-026's shipped code, not a
 * hypothetical: a Tag-block payload appended to genuine testimony rode
 * into an ACCEPTED, validator-approved `quote` claim — sixteen invisible
 * codepoints inside an approved citation. The quote proof normalises NFC and
 * nothing else, and NFC does not touch `Cf`/`Cs`/`Co`, so the payload survived
 * the proof *because* it was invisible.
 *
 * BY CATEGORY, NEVER BY LIST. The frozen requirement names `\p{Cf}\p{Cs}\p{Co}`
 * and the reason is hermes: it hardcoded seventeen codepoints while its
 * documentation claimed to block invisible Unicode, and the entire Tag block
 * U+E0000-E007F — the canonical LLM ASCII-smuggling range — walked straight
 * through, as did LRM/RLM/ALM and the soft hyphen. A list is a promise to have
 * thought of everything.
 */

/**
 * Format, surrogate and private-use characters. Every one of these can carry a
 * payload no reader will see.
 */
const INVISIBLE_RE = /[\p{Cf}\p{Cs}\p{Co}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

/**
 * U+200D ZERO WIDTH JOINER is `\p{Cf}`, and it is also what holds 👨‍👩‍👧
 * together. A blanket category strip shatters the family emoji into three
 * glyphs — in a family-memory product, that corrupts precisely the
 * messages people care most about. So the pardon is CONTEXTUAL: a ZWJ is
 * legitimate only when it actually joins two pictographic characters.
 *
 * VARIATION SELECTORS ARE INCLUDED, and the earlier note here was wrong. They
 * are `Mn`, not `Cf`, so the frozen requirement's three categories miss them —
 * but U+FE00-FE0F and the U+E0100-E01EF supplement are just as invisible and
 * just as capable of carrying a payload, and a sweep rode one into an accepted
 * claim exactly as the Tag block had. Category membership is not the test;
 * invisibility is. They are pardoned inside an emoji cluster by the same
 * contextual rule that pardons the joiner.
 */
const EMOJI_ADJACENT = /\p{Extended_Pictographic}/u;

/**
 * Characters that sit INSIDE an emoji cluster without being the pictograph:
 * variation selectors (`Mn`) and skin-tone modifiers (`Sk`).
 *
 * Looking only at the immediately adjacent character was wrong, and wrong in a
 * way a hand-picked fixture hides. `U+FE0F` is `Mn` and `U+1F3FB..U+1F3FF` are
 * `Sk` — NEITHER is `Extended_Pictographic` — so 👩🏻‍🦰, 👨‍❤️‍👨, 🏳️‍🌈 and a
 * skin-toned family all failed the pardon and were shattered as smuggling.
 * Measured: 75 of 90 enumerated person-tone-role sequences.
 *
 * The rule was always "a ZWJ that actually joins two pictographs". The
 * positional lookup was a naive approximation of it, and the required test
 * passed only because its single fixture happened to carry neither a variation
 * selector nor a tone.
 */
const CLUSTER_FILLER = /[\p{Mn}\p{Sk}]/u;
/** Bounded so a long run of combining marks cannot make this quadratic. */
const MAX_FILLER_SKIP = 4;

function pictographAt(chars: string[], from: number, step: -1 | 1): boolean {
  for (let n = 0, j = from; n <= MAX_FILLER_SKIP && j >= 0 && j < chars.length; n++, j += step) {
    const ch = chars[j];
    if (ch === undefined) return false;
    if (CLUSTER_FILLER.test(ch)) continue;
    return EMOJI_ADJACENT.test(ch);
  }
  return false;
}

const VARIATION_SELECTOR = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

/**
 * Is this invisible character a legitimate part of an emoji cluster?
 *
 * Two shapes are pardoned, and only in context:
 *  - a ZWJ that actually joins two pictographs (👨‍👩‍👧)
 *  - a variation selector that follows one (❤️ — VS16 is what makes it emoji
 *    rather than the dingbat ❤)
 *
 * Everything else invisible is payload. A VS with no pictograph before it, or
 * a ZWJ that joins a letter to anything, is smuggling.
 */
function isClusterMember(chars: string[], i: number): boolean {
  const ch = chars[i];
  if (ch === '‍') return pictographAt(chars, i - 1, -1) && pictographAt(chars, i + 1, 1);
  if (ch !== undefined && VARIATION_SELECTOR.test(ch)) {
    // IMMEDIATELY after a pictograph — no filler-skip chain. Allowing the
    // backward scan to hop over other selectors let a RUN of them ride in, and
    // the U+E0100-E01EF supplement has 240 values to carry, repeating per
    // emoji and so unbounded in aggregate. A legitimate cluster never needs
    // more than one selector per pictograph.
    const before = chars[i - 1];
    return before !== undefined && EMOJI_ADJACENT.test(before);
  }
  return false;
}

/** True when the string carries at least one codepoint a reader cannot see. */
export function hasSmuggledCodepoints(s: string): boolean {
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    if (!INVISIBLE_RE.test(chars[i]!)) continue;
    if (isClusterMember(chars, i)) continue;
    return true;
  }
  return false;
}

/**
 * Remove smuggled codepoints, preserving legitimate joiners.
 *
 * Removal rather than rejection is deliberate. Refusing a note outright would
 * let one hostile character make a family's testimony unciteable, which hands
 * an attacker a denial of service against the archive itself. Stripping keeps
 * the evidence usable and the payload gone.
 */
export function stripInvisible(s: string): string {
  const chars = [...s];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (INVISIBLE_RE.test(ch) && !isClusterMember(chars, i)) continue;
    out += ch;
  }
  return out;
}
