import { describe, expect, it } from 'vitest';
import {
  checkMark,
  linkSentences,
  plainOf,
  relink,
  unmarked,
  type Listed,
} from '../src/graph/marks';

const MOTHER: Listed = {
  ref: 'e3',
  name: "Noah's mother",
  aliases: [],
  ways: ['his mother', 'Mom'],
};
const MINA: Listed = { ref: 'e4', name: 'Mina Kim', aliases: ['Mina'], ways: ['his aunt'] };
const BUSAN: Listed = { ref: 'e7', name: 'Busan', aliases: [], ways: [] };
const NOAH: Listed = { ref: 'e1', name: 'Noah Kim', aliases: ['Noah'], ways: [], subject: true };
const list = new Map([MOTHER, MINA, BUSAN, NOAH].map((e) => [e.ref, e]));

describe('checkMark', () => {
  it('keeps words that are in the sentence and are a way to call it', () => {
    expect(checkMark('His mother made soup.', { e: 'e3', words: 'his mother' }, list)).toBe(
      'His mother',
    );
    expect(checkMark('Mina came.', { e: 'e4', words: 'Mina' }, list)).toBe('Mina');
    expect(checkMark("Kim's house was big.", { e: 'e4', words: "Kim's" }, list)).toBe("Kim's");
  });
  it('drops words not in the sentence, not its ways, or the protagonist', () => {
    expect(checkMark('His father came.', { e: 'e3', words: 'his father' }, list)).toBeNull();
    expect(checkMark('His mother came.', { e: 'e3', words: 'mother came' }, list)).toBeNull();
    expect(checkMark('Noah came.', { e: 'e1', words: 'Noah' }, list)).toBeNull();
    expect(checkMark('Mina came.', { e: 'e9', words: 'Mina' }, list)).toBeNull();
    expect(checkMark('Minato came.', { e: 'e4', words: 'Mina' }, list)).toBeNull();
  });
  it('returns the words as the sentence writes them, whichever apostrophe it uses', () => {
    expect(checkMark('Noah’s mother came.', { e: 'e3', words: "Noah's mother" }, list)).toBe(
      'Noah’s mother',
    );
    expect(checkMark('Kim’s house was big.', { e: 'e4', words: 'kim’s' }, list)).toBe('Kim’s');
  });
  it('allows a word of a name only when it has 3 letters and is not filler', () => {
    const jo: Listed = { ref: 'e5', name: 'Jo Lee of Seoul', aliases: [], ways: [] };
    const l = new Map([[jo.ref, jo]]);
    expect(checkMark('Lee came.', { e: 'e5', words: 'Lee' }, l)).toBe('Lee');
    expect(checkMark('Seoul was far.', { e: 'e5', words: 'Seoul' }, l)).toBe('Seoul');
    expect(checkMark('Jo came.', { e: 'e5', words: 'Jo' }, l)).toBeNull();
    expect(checkMark('He was of Seoul.', { e: 'e5', words: 'of' }, l)).toBeNull();
  });
  it('drops a mark with empty words', () => {
    expect(checkMark('Mina came.', { e: 'e4', words: '  ' }, list)).toBeNull();
  });
});

describe('unmarked', () => {
  it('finds a name or alias the writer left unmarked, never a way', () => {
    const found = unmarked(
      ['They lived in Busan.', 'His mother cooked.', 'Mina visited.'],
      [...list.values()],
      new Set(),
    );
    expect(found).toEqual([
      { sentence: 2, mark: { e: 'e4', words: 'Mina' } },
      { sentence: 0, mark: { e: 'e7', words: 'Busan' } },
    ]);
  });
  it('skips what the writer marked and the protagonist', () => {
    const found = unmarked(
      ['Noah went to Busan.', 'Mina Kim visited.'],
      [...list.values()],
      new Set(['e7']),
    );
    expect(found).toEqual([{ sentence: 1, mark: { e: 'e4', words: 'Mina Kim' } }]);
  });
  it('takes the first sentence that names it, in the words the sentence writes', () => {
    const found = unmarked(['Nothing here.', 'BUSAN again.', 'Busan last.'], [BUSAN], new Set());
    expect(found).toEqual([{ sentence: 1, mark: { e: 'e7', words: 'BUSAN' } }]);
  });
});

describe('linkSentences', () => {
  const titleOf = (ref: string) => list.get(ref)!.name;

  it('links the first time each is named, the longer words first, and only there', () => {
    const out = linkSentences(
      ['His mother lived in Busan.', 'His mother loved Busan.'],
      [
        [
          { e: 'e3', words: 'His mother' },
          { e: 'e7', words: 'Busan' },
        ],
        [{ e: 'e3', words: 'His mother' }],
      ],
      titleOf,
    );
    expect(out).toEqual([
      "[[Noah's mother|His mother]] lived in [[Busan]].",
      'His mother loved Busan.',
    ]);
  });
  it('links an entity the writer marked again later only if the first sentence could not hold it', () => {
    const out = linkSentences(
      ['Busan was far.', 'Mina left Busan.'],
      [
        [{ e: 'e4', words: 'Mina' }],
        [
          { e: 'e4', words: 'Mina' },
          { e: 'e7', words: 'Busan' },
        ],
      ],
      titleOf,
    );
    // sentence 0 does not hold "Mina", so the first link is the one in sentence 1
    expect(out).toEqual(['Busan was far.', '[[Mina Kim|Mina]] left [[Busan]].']);
  });
  it('places the longer words first so a shorter mark never lands inside them', () => {
    const kim: Listed = { ref: 'e8', name: 'Kim', aliases: [], ways: [] };
    const l = new Map([...list, [kim.ref, kim]]);
    const out = linkSentences(
      ['Mina Kim came.', 'Then Kim left.'],
      [
        [
          { e: 'e8', words: 'Kim' },
          { e: 'e4', words: 'Mina Kim' },
        ],
        [{ e: 'e8', words: 'Kim' }],
      ],
      (ref) => l.get(ref)!.name,
    );
    // "Kim" has no place of its own in sentence 0, so it is linked in sentence 1
    expect(out).toEqual(['[[Mina Kim]] came.', 'Then [[Kim]] left.']);
  });
  it('keeps the words as the sentence writes them, including the apostrophe', () => {
    const out = linkSentences(
      ['Noah’s mother came.'],
      [[{ e: 'e3', words: "Noah's mother" }]],
      titleOf,
    );
    expect(out).toEqual(["[[Noah's mother|Noah’s mother]] came."]);
  });
  it('writes the plain form when the words are the title', () => {
    const out = linkSentences(['Busan is big.'], [[{ e: 'e7', words: 'Busan' }]], titleOf);
    expect(out).toEqual(['[[Busan]] is big.']);
  });
  it('does not link inside words, or inside a link already there', () => {
    const out = linkSentences(
      ['Busanese food. [[Busan]] again.', 'Busan last.'],
      [[{ e: 'e7', words: 'Busan' }], []],
      titleOf,
    );
    expect(out).toEqual(['Busanese food. [[Busan]] again.', 'Busan last.']);
  });
  it('links the first free place when an earlier one is inside a link already there', () => {
    const out = linkSentences(['[[Busan]] and Busan.'], [[{ e: 'e7', words: 'Busan' }]], titleOf);
    expect(out).toEqual(['[[Busan]] and [[Busan]].']);
  });
  it('leaves a sentence with no marks, or marks that do not fit, as it is', () => {
    const out = linkSentences(
      ['Nothing here.', 'Still nothing.', 'No marks at all.'],
      [[], [{ e: 'e7', words: 'Busan' }]],
      titleOf,
    );
    expect(out).toEqual(['Nothing here.', 'Still nothing.', 'No marks at all.']);
  });
  it("keeps the places right when lowercasing changes a letter's length", () => {
    const istanbul: Listed = { ref: 'e6', name: 'Istanbul', aliases: [], ways: [] };
    const out = linkSentences(
      ['İzmir and Istanbul.'],
      [[{ e: 'e6', words: 'Istanbul' }]],
      () => istanbul.name,
    );
    expect(out).toEqual(['İzmir and [[Istanbul]].']);
  });
});

describe('relink and plainOf', () => {
  it('unlinks the left out, retargets the renamed, keeps the words shown', () => {
    const body = "[[Noah's mother|His mother]] lived in [[Busan]]. [[Tom]] came.";
    const out = relink(
      body,
      new Set(['tom']),
      new Map([
        ["noah's mother", 'Mina Kim'],
        ['busan', 'Busan (place)'],
      ]),
    );
    expect(out).toBe('[[Mina Kim|His mother]] lived in [[Busan (place)|Busan]]. Tom came.');
    expect(plainOf(out)).toBe('His mother lived in Busan. Tom came.');
  });
  it('matches the title whatever its case, and unlinks a link that shows other words', () => {
    const out = relink(
      '[[BUSAN]] and [[tom|Tommy]].',
      new Set(['tom']),
      new Map([['busan', 'Pusan']]),
    );
    expect(out).toBe('[[Pusan|BUSAN]] and Tommy.');
  });
  it('leaves embeds and heading and block links alone', () => {
    const body = '![[Tom]] and [[Tom#Early life]] and [[Busan#^b1|port]] and [[Tom]].';
    const out = relink(body, new Set(['tom']), new Map([['busan', 'Pusan']]));
    expect(out).toBe('![[Tom]] and [[Tom#Early life]] and [[Busan#^b1|port]] and Tom.');
  });
  it('leaves links in code alone and everything else byte for byte', () => {
    const body = 'A  `[[Tom]]`  and\n\n  [[Other]]\t[[Tom]].\n';
    expect(relink(body, new Set(['tom']), new Map())).toBe(
      'A  `[[Tom]]`  and\n\n  [[Other]]\tTom.\n',
    );
  });
  it('returns a body with no links, or nothing to change, as it is', () => {
    expect(relink('Just words.', new Set(['tom']), new Map())).toBe('Just words.');
    const body = '[[Other|them]] came.';
    expect(relink(body, new Set(['tom']), new Map([['busan', 'Pusan']]))).toBe(body);
  });
  it('plainOf reads links as the words they show and leaves embeds', () => {
    expect(
      plainOf('[[Tom]] met [[Mina Kim|Mina]], ![[pic.png]] and [[Busan#Port|the port]].'),
    ).toBe('Tom met Mina, ![[pic.png]] and the port.');
    expect(plainOf('No links.')).toBe('No links.');
  });
});
