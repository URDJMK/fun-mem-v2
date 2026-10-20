/**
 * English is the only language this package has rules for.
 *
 * Text in any other script (Cyrillic, Arabic, Han, ...) is OPAQUE: the English rules do not
 * understand it, so the checks keep it, compare it exactly, and never let a rule written for English
 * words (a length floor, a word stem) drop it or loosen the comparison. Opaque text can only make a
 * check stricter, never blind it.
 *
 * "Not English" is decided by script, not by a list of languages. A character belongs to the English
 * rules when its script extensions are Latin, Common (digits, punctuation, symbols, emoji) or
 * Inherited (combining marks and joiners). Script extensions rather than the plain script, so that
 * punctuation shared by other scripts, such as the ideographic full stop, is not taken for Common.
 */
const OPAQUE = /[^\p{scx=Latin}\p{scx=Common}\p{scx=Inherited}]/u;

/** True when the text holds at least one character the English rules do not cover. */
export function hasOpaqueText(s: string): boolean {
  return OPAQUE.test(s);
}
