import { describe, expect, it } from 'vitest';
import { hasOpaqueText } from '../src/opaque';
import { OTHER_SCRIPT } from './fixtures';

/**
 * English is the only language this package has rules for. These tests pin where
 * "English" ends: by script, not by a list of languages, so that nothing in a
 * script the rules cannot read is ever taken for something they can.
 */
describe('opaque text', () => {
  it('English text, and everything that travels with it, is not opaque', () => {
    for (const s of [
      '',
      'Grandma was born in Lisbon in 1943.',
      '1943-05-17 14:30 (UTC+1) #3 100% $5 \u{20AC}5 \u{A3}5',
      'caf\u{E9}', // precomposed
      'cafe\u{301}', // decomposed: a combining accent is not another script
      'Z\u{FC}rich \u{DF} \u{E5}ngstr\u{F6}m \u{141}\u{F3}d\u{17A}', // other European Latin letters
      '\u{201C}quoted\u{201D} \u{2014} dash \u{2026} \u{2022} bullet',
      '\u{1F600} \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} \u{2764}\u{FE0F}', // emoji, joiners, selectors
      '\u{3000}', // an ideographic space is only whitespace
    ]) {
      expect(hasOpaqueText(s), JSON.stringify(s)).toBe(false);
    }
  });

  it('a letter of any other script makes the text opaque, wherever it sits', () => {
    for (const s of [
      OTHER_SCRIPT.cyrillic,
      OTHER_SCRIPT.greek,
      OTHER_SCRIPT.han,
      '\u{627}\u{644}\u{62C}\u{62F}\u{629}', // Arabic
      '\u{5E1}\u{5D1}\u{5D0}', // Hebrew
      '\u{E01}\u{E32}', // Thai
      '\u{915}\u{93E}', // Devanagari
      '\u{3042}\u{30A2}', // Hiragana and Katakana
    ]) {
      expect(hasOpaqueText(s), JSON.stringify(s)).toBe(true);
    }
    expect(hasOpaqueText('Grandma was born in \u{41B}\u{438}\u{441}\u{431}\u{43E}\u{43D}')).toBe(
      true,
    );
    expect(hasOpaqueText('Hello \u{43F}')).toBe(true);
  });

  it('punctuation that belongs to other scripts is opaque too, not English', () => {
    expect(hasOpaqueText('\u{3002}')).toBe(true); // ideographic full stop
    expect(hasOpaqueText('\u{300C}x\u{300D}')).toBe(true); // corner brackets
  });

  it('a character no script owns is opaque rather than assumed to be English', () => {
    expect(hasOpaqueText('\u{D800}')).toBe(true); // a lone surrogate
    expect(hasOpaqueText('\u{E000}')).toBe(true); // private use
  });
});
