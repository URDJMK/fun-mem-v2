import { describe, expect, it } from 'vitest';
import {
  checkMark,
  linkSentences,
  marksOf,
  plainOf,
  relink,
  unmarked,
  type Listed,
} from '../src/graph/marks';
import { findIn, placeIn } from '../src/graph/shared';

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
  it('allows a word of a name when it has 2 letters or more and is not filler', () => {
    const ed: Listed = { ref: 'e5', name: 'Ed Park of J. Seoul', aliases: [], ways: [] };
    const l = new Map([[ed.ref, ed]]);
    expect(checkMark('Park came.', { e: 'e5', words: 'Park' }, l)).toBe('Park');
    expect(checkMark('Ed came.', { e: 'e5', words: 'Ed' }, l)).toBe('Ed');
    expect(checkMark('Seoul was far.', { e: 'e5', words: 'Seoul' }, l)).toBe('Seoul');
    expect(checkMark('He was of Seoul.', { e: 'e5', words: 'of' }, l)).toBeNull();
    expect(checkMark('J came.', { e: 'e5', words: 'J' }, l)).toBeNull();
  });
  it('allows a two-letter Korean given name written apart from the family name', () => {
    const mina: Listed = { ref: 'e6', name: '김 민아', aliases: [], ways: ['이모'] };
    const l = new Map([[mina.ref, mina]]);
    expect(checkMark('어제 민아 왔다.', { e: 'e6', words: '민아' }, l)).toBe('민아');
    expect(checkMark('어제 김 민아 왔다.', { e: 'e6', words: '김 민아' }, l)).toBe('김 민아');
    expect(checkMark('어제 이모 왔다.', { e: 'e6', words: '이모' }, l)).toBe('이모');
    expect(checkMark('어제 민수 왔다.', { e: 'e6', words: '민수' }, l)).toBeNull();
  });
  it('does not take a title for a word of the name', () => {
    const lee: Listed = { ref: 'e5', name: 'Dr. Lee Jr.', aliases: [], ways: [] };
    const l = new Map([[lee.ref, lee]]);
    expect(checkMark('Lee came.', { e: 'e5', words: 'Lee' }, l)).toBe('Lee');
    expect(checkMark('Dr. Lee Jr. came.', { e: 'e5', words: 'Dr. Lee Jr.' }, l)).toBe(
      'Dr. Lee Jr.',
    );
    expect(checkMark('Dr came.', { e: 'e5', words: 'Dr' }, l)).toBeNull();
    expect(checkMark('Jr came.', { e: 'e5', words: 'Jr' }, l)).toBeNull();
  });
  it('still tells whole words apart after a letter whose lowercase is longer', () => {
    expect(checkMark('İzmir. Minato came.', { e: 'e4', words: 'Mina' }, list)).toBeNull();
    expect(checkMark('İzmir. Mina came.', { e: 'e4', words: 'Mina' }, list)).toBe('Mina');
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
  it('finds nothing in no sentences', () => {
    expect(unmarked([], [...list.values()], new Set())).toEqual([]);
  });
  it('takes the first sentence that names it, in the words the sentence writes', () => {
    const found = unmarked(['Nothing here.', 'BUSAN again.', 'Busan last.'], [BUSAN], new Set());
    expect(found).toEqual([{ sentence: 1, mark: { e: 'e7', words: 'BUSAN' } }]);
  });
});

describe('marksOf', () => {
  const cast = { listed: [MOTHER, MINA, BUSAN, NOAH], byRef: list };
  it('keeps the marks that hold, counts those that do not, and adds the names not marked', () => {
    const out = marksOf(
      [
        {
          text: 'His mother took Noah to Busan.',
          names: [
            { e: 'e3', words: 'His mother' },
            { e: 'e7', words: 'the city' },
          ],
        },
        { text: 'Mina came too.' },
        { text: 'Busan was cold.' },
      ],
      cast,
    );
    expect(out.marks).toEqual([
      [
        { e: 'e3', words: 'His mother' },
        { e: 'e7', words: 'Busan' },
      ],
      [{ e: 'e4', words: 'Mina' }],
      [],
    ]);
    expect(out.wrong).toBe(1);
  });
  it('drops a mark of the person it is about without counting it: they are never linked', () => {
    const out = marksOf([{ text: 'Noah came.', names: [{ e: 'e1', words: 'Noah' }] }], cast);
    expect(out).toEqual({ marks: [[]], wrong: 0 });
  });
  it('marks nothing without a list: the writer was given none', () => {
    const out = marksOf([{ text: 'Busan.', names: [{ e: 'e7', words: 'Busan' }] }], {
      listed: [],
      byRef: new Map(),
    });
    expect(out).toEqual({ marks: [[]], wrong: 0 });
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
  it('counts a link already in the story as the first mention', () => {
    const marks = [[{ e: 'e7', words: 'Busan' }], [{ e: 'e7', words: 'Busan' }]];
    expect(linkSentences(['[[Busan]] is far.', 'Busan again.'], marks, titleOf)).toEqual([
      '[[Busan]] is far.',
      'Busan again.',
    ]);
    // the sentence that holds the link need not carry a mark
    expect(
      linkSentences(['[[busan|the port]] is far.', 'Busan again.'], [[], marks[1]!], titleOf),
    ).toEqual(['[[busan|the port]] is far.', 'Busan again.']);
    // in the same sentence too, wherever the link stands
    expect(linkSentences(['Busan and [[Busan]].'], [marks[0]!], titleOf)).toEqual([
      'Busan and [[Busan]].',
    ]);
  });
  it('does not count an embed, or a link to another note, as a mention', () => {
    const out = linkSentences(
      ['![[Busan]] is far.', 'Mina left [[Tom]].', 'Busan again.'],
      [[], [{ e: 'e4', words: 'Mina' }], [{ e: 'e7', words: 'Busan' }]],
      titleOf,
    );
    expect(out).toEqual([
      '![[Busan]] is far.',
      '[[Mina Kim|Mina]] left [[Tom]].',
      '[[Busan]] again.',
    ]);
  });
  it('does not link words inside a link to another note, and links them later', () => {
    const kim: Listed = { ref: 'e8', name: 'Kim', aliases: [], ways: [] };
    const out = linkSentences(
      ['[[Kim Market]] opened.', 'Then Kim left.'],
      [[{ e: 'e8', words: 'Kim' }], [{ e: 'e8', words: 'Kim' }]],
      () => kim.name,
    );
    expect(out).toEqual(['[[Kim Market]] opened.', 'Then [[Kim]] left.']);
  });
  it('lets the first of two equal-length overlapping marks win, the other linking later', () => {
    const leeKim: Listed = { ref: 'e8', name: 'Lee Kim', aliases: [], ways: [] };
    const ann: Listed = { ref: 'e9', name: 'Ann Lee', aliases: [], ways: [] };
    const l = new Map([leeKim, ann].map((e) => [e.ref, e]));
    const marks = [
      [
        { e: 'e9', words: 'Ann Lee' },
        { e: 'e8', words: 'Lee Kim' },
      ],
      [{ e: 'e8', words: 'Lee Kim' }],
    ];
    expect(
      linkSentences(['Ann Lee Kim came.', 'Lee Kim left.'], marks, (ref) => l.get(ref)!.name),
    ).toEqual(['[[Ann Lee]] Kim came.', '[[Lee Kim]] left.']);
    // the writer's order decides, not the order of the names
    expect(
      linkSentences(
        ['Ann Lee Kim came.'],
        [[marks[0]![1]!, marks[0]![0]!]],
        (ref) => l.get(ref)!.name,
      ),
    ).toEqual(['Ann [[Lee Kim]] came.']);
  });
  it('ignores a mark with empty words', () => {
    const out = linkSentences(
      ['Busan is big.', 'Busan again.'],
      [
        [
          { e: 'e7', words: '' },
          { e: 'e4', words: '   ' },
        ],
        [{ e: 'e7', words: 'Busan' }],
      ],
      titleOf,
    );
    expect(out).toEqual(['Busan is big.', '[[Busan]] again.']);
  });
  it('handles no sentences and a stray [[', () => {
    expect(linkSentences([], [], titleOf)).toEqual([]);
    expect(linkSentences(['Busan [[ is far.'], [[{ e: 'e7', words: 'Busan' }]], titleOf)).toEqual([
      '[[Busan]] [[ is far.',
    ]);
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
  it('handles an empty body and a stray [[', () => {
    expect(relink('', new Set(['tom']), new Map())).toBe('');
    expect(plainOf('')).toBe('');
    expect(relink('A [[ b\n[[Tom]].', new Set(['tom']), new Map())).toBe('A [[ b\nTom.');
    expect(plainOf('A [[ b')).toBe('A [[ b');
  });
  it('plainOf reads links as the words they show and leaves embeds', () => {
    expect(
      plainOf('[[Tom]] met [[Mina Kim|Mina]], ![[pic.png]] and [[Busan#Port|the port]].'),
    ).toBe('Tom met Mina, ![[pic.png]] and the port.');
    expect(plainOf('No links.')).toBe('No links.');
  });
});

describe('placeIn and findIn', () => {
  it('place whole words, ignoring case and which apostrophe, outside the taken spans', () => {
    expect(placeIn('Noah’s mother and Mina.', "noah's MOTHER")).toBe(0);
    expect(placeIn('Mina and Mina.', 'Mina', [[0, 4]])).toBe(9);
    expect(placeIn('Minato and Mina.', 'Mina')).toBe(11);
    expect(placeIn('Mina.', 'Mina', [[0, 4]])).toBe(-1);
    expect(placeIn('Mina.', 'Busan')).toBe(-1);
  });
  it('find nothing for empty words', () => {
    expect(placeIn('Mina.', '')).toBe(-1);
    expect(placeIn('Mina.', '  ')).toBe(-1);
    expect(findIn('Mina.', '')).toBeNull();
  });
  it('give the text as written, trimmed of the words asked for', () => {
    expect(findIn('Then NOAH’S mother came.', " noah's mother ")).toBe('NOAH’S mother');
    expect(findIn('Minato came.', 'Mina')).toBeNull();
  });
  it('keep their places after a letter whose lowercase is longer', () => {
    expect(placeIn('İzmir and Istanbul.', 'Istanbul')).toBe(10);
    expect(findIn('İzmir and Istanbul.', 'istanbul')).toBe('Istanbul');
    expect(findIn('İzmir. Minato came.', 'Mina')).toBeNull();
  });
});
