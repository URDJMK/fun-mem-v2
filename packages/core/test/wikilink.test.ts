import { describe, expect, it } from 'vitest';
import { extractWikilinks } from '../src/wikilink';

describe('wikilink parser', () => {
  it('extracts links aliases and positions', () => {
    const body = 'We visited [[Grandma Kim]] and [[Beach Trip|the trip]] together.';
    const [a, b] = extractWikilinks(body);
    expect(a).toMatchObject({ target: 'Grandma Kim', embed: false });
    expect(a!.alias).toBeUndefined();
    expect(body.slice(a!.start, a!.end)).toBe('[[Grandma Kim]]');
    expect(b).toMatchObject({ target: 'Beach Trip', alias: 'the trip' });
    expect(body.slice(b!.start, b!.end)).toBe('[[Beach Trip|the trip]]');
    // Obsidian trims whitespace around the target
    expect(extractWikilinks('[[ Padded Title ]]')[0]!.target).toBe('Padded Title');
    // \| is a literal pipe (table rule), not an alias separator
    const esc = extractWikilinks('[[Basic formatting\\|Markdown]]')[0]!;
    expect(esc.target).toBe('Basic formatting\\|Markdown');
    expect(esc.alias).toBeUndefined();
    // links never span lines
    expect(extractWikilinks('[[Broken\nLink]]')).toEqual([]);
    // unterminated
    expect(extractWikilinks('[[Never closed')).toEqual([]);
  });

  it('ignores code fences inline code and escaped brackets', () => {
    const body = [
      'Real: [[Alpha]]',
      '`inline [[NotALink]] code`',
      '```',
      'fenced [[AlsoNot]]',
      '```',
      'Escaped: \\[[Nope]]',
      'After: [[Omega]]',
    ].join('\n');
    expect(extractWikilinks(body).map((l) => l.target)).toEqual(['Alpha', 'Omega']);
  });

  it('parses embeds heading paths and block refs', () => {
    const links = extractWikilinks(
      '![[grandma-1994.jpg|100x145]] then [[Trip#Day 1#Morning]] and [[Trip#^b15695|that moment]] plus [[#^local-1]]',
    );
    expect(links[0]).toMatchObject({
      target: 'grandma-1994.jpg',
      embed: true,
      alias: '100x145',
    });
    expect(links[0]!.raw.startsWith('![[')).toBe(true);
    expect(links[1]).toMatchObject({ target: 'Trip', heading: 'Day 1#Morning', embed: false });
    expect(links[2]).toMatchObject({ target: 'Trip', blockId: 'b15695', alias: 'that moment' });
    expect(links[3]).toMatchObject({ target: '', blockId: 'local-1' }); // self-reference
    // block ids share the anchors.ts charset; invalid chars mean it is a heading, not a block id
    expect(extractWikilinks('[[N#^bad_id]]')[0]!.blockId).toBeUndefined();
    // ! separated by a space is a plain link, not an embed
    const spaced = extractWikilinks('! [[Photo.png]]')[0]!;
    expect(spaced.embed).toBe(false);
  });

  it('is deterministic and handles accented titles and astral characters', () => {
    // the emoji is two UTF-16 code units, so a parser that counted code points
    // would put every position after it off by one
    const body =
      '\u{1F600} I went with [[Zo\u{EB}]] and [[Caf\u{E9} Royal#Day One|that trip]] and remember it. ![[photo.jpg]]';
    const first = extractWikilinks(body);
    expect(first.map((l) => l.target)).toEqual(['Zo\u{EB}', 'Caf\u{E9} Royal', 'photo.jpg']);
    expect(first[1]).toMatchObject({ heading: 'Day One', alias: 'that trip' });
    // positions are UTF-16 code-unit indices — slicing must reproduce the raw token exactly
    for (const l of first) expect(body.slice(l.start, l.end)).toBe(l.raw);
    // determinism: identical input, identical output (deep equality across repeated runs)
    for (let i = 0; i < 5; i++) expect(extractWikilinks(body)).toEqual(first);
  });
});
