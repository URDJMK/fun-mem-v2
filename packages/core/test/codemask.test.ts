import { describe, expect, it } from 'vitest';
import { extractWikilinks } from '../src/wikilink';

/**
 * FM-054 — `codeMask` marks regions where a `[[link]]` is inert markup rather
 * than a link. Six contexts were documented at `wikilinkParser.ts` as places
 * the editor's lezer parser masks and core does not, so core indexes a link the
 * editor correctly treats as code.
 *
 * The safe direction for grounding is under-linking, so each case asserts the
 * link is NOT extracted. Every fixture also carries a REAL link, so a mask that
 * swallows the whole document passes nothing.
 */
const targets = (body: string) => extractWikilinks(body).map((l) => l.target);

describe('FM-054 codeMask CommonMark contexts', () => {
  it('a multi-backtick code span is masked', () => {
    // `` `` `` delimits a span that may itself contain a backtick
    const body = 'Real [[Alpha]] and ``code [[NotALink]] here`` done.';
    expect(targets(body), 'a double-backtick span was indexed').toEqual(['Alpha']);

    // The closing run must match the opening run's LENGTH. A link after the
    // stray single backtick is what makes this discriminating: a scanner that
    // closes on any run ends the span early and exposes it.
    const uneven = 'Real [[Beta]] and ``still code ` [[NotALink]] more`` end.';
    expect(targets(uneven), 'a span closed on a shorter backtick run').toEqual(['Beta']);
  });

  it('a code span that spans a line break is masked', () => {
    const body = 'Real [[Gamma]] and `open\n[[NotALink]] still code` done.';
    expect(targets(body), 'a cross-line code span was indexed').toEqual(['Gamma']);
  });

  it('an html comment is masked', () => {
    const body = 'Real [[Delta]]\n\n<!-- [[HiddenLink]] -->\n\ndone.';
    expect(targets(body), 'a link inside an HTML comment was indexed').toEqual(['Delta']);

    // comments span lines too
    const multi = 'Real [[Epsilon]]\n\n<!--\n[[AlsoHidden]]\n-->\n\ndone.';
    expect(targets(multi)).toEqual(['Epsilon']);

    // AMENDMENT 1: the contract's kill-list named "closing the comment at the
    // first `>` rather than at `-->`" and no assertion ever checked it. The
    // behaviour was already right; the test simply did not look.
    const inner = 'Real [[Nu]]\n\n<!-- <b>x</b> [[NotAfterTheGt]] -->\n\ndone.';
    expect(targets(inner), 'the comment ended at the first > inside it').toEqual(['Nu']);
  });

  it('a fence inside a blockquote is masked', () => {
    const body = ['Real [[Zeta]]', '', '> ```', '> [[NotALink]]', '> ```', '', 'done.'].join('\n');
    expect(targets(body), 'a fence inside a blockquote did not mask').toEqual(['Zeta']);

    // TILDES, deliberately: a backtick fence in a quote is masked by the code
    // span scanner anyway (three backticks open, three close), so only a tilde
    // fence actually exercises the blockquote prefix in FENCE_RE.
    const tilde = ['Real [[Iota]]', '', '> ~~~', '> [[NorThis]]', '> ~~~', '', 'done.'].join('\n');
    expect(targets(tilde), 'a tilde fence inside a blockquote did not mask').toEqual(['Iota']);
  });

  it('an indented code block is masked', () => {
    const body = ['Real [[Eta]]', '', '    [[NotALink]] indented four spaces', '', 'done.'].join(
      '\n',
    );
    expect(targets(body), 'a four-space indented code block was indexed').toEqual(['Eta']);

    // EVERY line of the block, not just the first. A one-line fixture certifies
    // only that a block can OPEN; state that does not persist leaves line 2
    // onward unmasked, which is over-linking — the fabricated edge this whole
    // task exists to prevent. Found by review, not by the original fixture.
    const multi = [
      'Real [[Kappa]]',
      '',
      '    first line of the block',
      '    [[NotOnLineTwo]] still code',
      '    [[NorLineThree]] still code',
      '',
      'done.',
    ].join('\n');
    expect(targets(multi), 'only the first line of an indented block was masked').toEqual([
      'Kappa',
    ]);

    // a blank line does not END an indented block — the block ends at the first
    // non-blank line that is not indented
    const gapped = ['Real [[Lambda]]', '', '    code', '', '    [[NotAfterTheGap]]', '', 'x.'].join(
      '\n',
    );
    expect(targets(gapped), 'a blank line inside an indented block ended it').toEqual(['Lambda']);

    // an indented block may follow a heading with no blank line between: a
    // heading is not a paragraph, so there is no paragraph to interrupt
    const afterHeading = 'Real [[Mu]]\n\n# A heading\n    [[NotUnderTheHeading]] code\n';
    expect(targets(afterHeading), 'indented code after a heading was indexed').toEqual(['Mu']);

    // A list continuation is NOT an indented code block — it is prose. FOUR
    // spaces, so it actually reaches INDENTED_RE; a two-space fixture never
    // does and cannot catch a paragraph-interrupting regression.
    const list = '- item\n    [[StillALink]] deeper continuation';
    expect(targets(list), 'a list continuation was masked as code').toEqual(['StillALink']);
  });

  it('a tilde fence does not close a backtick fence', () => {
    // CommonMark: only the same character closes a fence. Treating `~~~` as a
    // closer re-opens the mask and leaves the rest of the note unmasked.
    const body = ['Real [[Theta]]', '```', '[[NotALink]]', '~~~', '[[AlsoNotALink]]', '```'].join(
      '\n',
    );
    expect(targets(body), 'a tilde run closed a backtick fence').toEqual(['Theta']);

    // AMENDMENT 1: the close test is a conjunction — same character AND at
    // least as long — and only the character half was covered. A four-backtick
    // fence is not closed by three, which is how a code sample containing a
    // fence is written in the first place.
    const shorter = ['Real [[Xi]]', '````', 'code', '```', '[[NotALink]]', '````'].join('\n');
    expect(targets(shorter), 'a shorter run closed a longer fence').toEqual(['Xi']);
  });

  /**
   * AMENDMENT 1 — found by running @lezer/markdown, the parser the editor
   * itself uses, as a differential oracle. Each of these was reproduced before
   * it was written down, and the six over-linking ones fabricate a graph edge.
   */
  it('a closing fence must be a fence line and nothing else', () => {
    // one stray character after the closing run and the fence never closes, so
    // core's idea of code/prose is inverted for the REST OF THE DOCUMENT
    const trailing = '```\ncode\n``` x\n\np [[Fabricated]]\n';
    expect(targets(trailing), 'a close carrying trailing content was accepted').toEqual([]);

    // ...but trailing WHITESPACE is a legal close, so a fix that simply
    // requires end-of-line breaks real notes. Negative control for the fix.
    const spaces = '```\ncode\n```   \n\np [[Real]]\n';
    expect(targets(spaces), 'a close with trailing spaces was rejected').toEqual(['Real']);

    // the blast radius, stated as a test: a later genuine fence is inverted too
    const radius = '```\nc\n``` x\n\np [[A]]\n\n```\n[[InsideCode]]\n```\n\nq [[B]]\n';
    expect(targets(radius), 'the de-sync propagated past the next fence').toEqual(['InsideCode']);
  });

  it('a backtick fence opener may not carry a backtick in its info string', () => {
    // CommonMark forbids a backtick anywhere in a BACKTICK fence's info string
    // [[Link]] is a real link because line 1 is a PARAGRAPH, not a fence. The
    // ``` on line 3 then opens a genuine fence that is never closed, so
    // [[Real]] really is code — confirmed against lezer, which reports
    // Paragraph[0,18] Link[11,17] FencedCode[19,35]. Asserting ['Link','Real']
    // here would encode my assumption rather than the parser's answer.
    const bad = '```js `x`\n[[Link]]\n```\n\np [[Real]]\n';
    expect(targets(bad), 'a backtick info string opened a fence').toEqual(['Link']);

    // the same info string IS legal on a tilde fence — a fix that bans it in
    // both places is wrong, so this is the negative control
    const tilde = '~~~js `x`\n[[NotALink]]\n~~~\n\np [[Real]]\n';
    expect(targets(tilde), 'a tilde fence rejected a legal backtick info string').toEqual(['Real']);
  });

  it('a fence closes only at its own blockquote depth', () => {
    const body = 'intro\n\n```\n[[InCode]]\n> ```\n[[Fabricated]]\n';
    expect(targets(body), 'a quoted run closed a top-level fence').toEqual([]);

    // control: a matching depth still closes
    const matched = '> ~~~\n> [[InCode]]\n> ~~~\n\np [[Real]]\n';
    expect(targets(matched), 'a matching-depth close was rejected').toEqual(['Real']);
  });

  it('a tab-indented run is code, not a fence', () => {
    // CommonMark counts COLUMNS: a tab is four, so `\t``` ` is indented code and
    // cannot close anything. FENCE_RE counted characters.
    const body = 'intro\n\n```\n[[InCode]]\n\t```\n[[Fabricated]]\n';
    expect(targets(body), 'a tab-indented run closed a fence').toEqual([]);

    // control: up to three SPACES is still a legal fence line
    const three = 'intro\n\n   ```\n[[InCode]]\n   ```\n\np [[Real]]\n';
    expect(targets(three), 'a three-space indented fence stopped working').toEqual(['Real']);
  });

  it('indented code may follow a setext heading or thematic break', () => {
    // a setext underline is a leaf block, not a paragraph — there is nothing to
    // interrupt, so the indented block is real code
    const setext = 'T\n===\n    [[Fabricated]]\n';
    expect(targets(setext), 'indented code after a setext heading was indexed').toEqual([]);

    const rule = 'para\n\n---\n    [[AlsoFabricated]]\n';
    expect(targets(rule), 'indented code after a thematic break was indexed').toEqual([]);

    // control, and the reason this cannot simply mask everything indented: a
    // list continuation is prose and its link is REAL
    expect(targets('- item\n    [[StillALink]] more'), 'a list continuation was masked').toEqual([
      'StillALink',
    ]);

    // a setext underline needs a PARAGRAPH above it to underline. With an
    // indented code block above instead, `===` is itself a paragraph, so the
    // tab-indented line below is a lazy continuation and its link is real.
    const noPara = '    code\n===\n\t[[StillALink]] x\n';
    expect(targets(noPara), 'a bare === was treated as a heading').toEqual(['StillALink']);
  });

  it('an html block is masked', () => {
    // type 1: <pre>/<script>/<style>/<textarea>, ends at the closing tag
    const pre = 'Real [[Omicron]]\n\n<pre>\n[[Fabricated]]\n</pre>\n\ndone.';
    expect(targets(pre), 'a link inside a <pre> block was indexed').toEqual(['Omicron']);

    // type 6: a known block tag, ends at a BLANK LINE — not at the closing tag.
    // A fix that ends it at </div> leaves anything after the tag unmasked.
    const div = 'Real [[Pi]]\n\n<div>\n[[Fabricated]]\n</div>\n[[AlsoFabricated]]\n\ndone [[Rho]].';
    expect(targets(div), 'a type-6 html block ended at the closing tag').toEqual(['Pi', 'Rho']);

    // control: inline html in a paragraph is NOT a block, and its link is real
    expect(targets('a <b>bold</b> [[Sigma]] here'), 'inline html masked a real link').toEqual([
      'Sigma',
    ]);

    // type 7: ANY complete tag alone on a line, not just the known block tags.
    // <span> is not on the type-6 list, and this was 92% of all over-linking
    // measured against lezer over 60k generated documents.
    const anyTag = 'Real [[Tau]]\n\n</span>\n[[Fabricated]]\n\ndone [[Ups]].';
    expect(targets(anyTag), 'a lone closing tag did not open an html block').toEqual([
      'Tau',
      'Ups',
    ]);

    // ...but type 7 alone CANNOT interrupt a paragraph, so here both are real
    const inPara = 'text [[Real]]\n</span>\n[[AlsoReal]]\n';
    expect(targets(inPara), 'a type-7 tag interrupted a paragraph').toEqual(['Real', 'AlsoReal']);

    // a block whose end condition is met on its own opening line closes there
    expect(targets('<pre>x</pre>\n[[AfterOneLiner]]\n'), 'a one-line block stayed open').toEqual([
      'AfterOneLiner',
    ]);

    // The three types are NOT interchangeable, and mutation testing showed the
    // fixtures above pass with any one of them deleted — type 7 covers for the
    // others. Each of these three distinguishes exactly one type.
    // Type 1 ends at its CLOSING TAG; types 6 and 7 run to a blank line, so
    // with type 1 gone this document masks to EOF.
    expect(targets('<pre>\ncode\n</pre>\n[[AfterClose]]\n'), 'type 1 ran past </pre>').toEqual([
      'AfterClose',
    ]);
    // Type 6 CAN interrupt a paragraph; type 7 cannot. With type 6 gone, <div>
    // after a prose line opens nothing and the link below is exposed.
    expect(targets('text [[Real]]\n<div>\n[[Fabricated]]\n'), 'type 6 did not interrupt').toEqual([
      'Real',
    ]);
    // Type 2 must be a BLOCK in pass 1, not merely masked in pass 2: an html
    // block is not a paragraph, so the indented line below it is code.
    expect(
      targets('<!-- c -->\n    [[Fabricated]] code\n'),
      'a comment line acted as prose',
    ).toEqual([]);
  });

  it('a comment marker inside code does not mask the rest of the note', () => {
    // pass 2 scanned the raw body and ignored the mask pass 1 had already
    // built, so documenting a comment inside a code sample ate the whole note
    const body = '```\n<!--\n```\n\np [[Real]] q\n\nmore [[AlsoReal]]\n';
    expect(targets(body), 'a <!-- inside a fence masked the rest of the note').toEqual([
      'Real',
      'AlsoReal',
    ]);
  });

  it('a code span cannot pair across a blank line', () => {
    // a code span is an inline: it lives inside one block and cannot cross a
    // blank line. One stray backtick used to swallow every link after it.
    const body = 'Don`t forget.\n\nSee [[Alpha]] for details.\n\nRun `npm test` now.\n';
    expect(targets(body), 'a stray backtick masked links in later blocks').toEqual(['Alpha']);

    // and a closer in a LATER BLOCK is not a closer — the prose-run bound does
    // this, not a mask check, which is why the mask check could be removed
    const intoFence = 'Type ` to start.\n\n[[Beta]] is next.\n\n```\nlet x = `hi`;\n```\n';
    expect(targets(intoFence), 'a span closed on a backtick inside a fence').toEqual(['Beta']);

    // ...but WITHIN a block, a code span binds tighter than inline raw HTML, so
    // a backtick inside what looks like a comment does close the span. Refusing
    // it made core extract a link lezer places in code.
    const viaComment = 'Type ` and [[NotALink]] <!-- ` --> end [[Real]].';
    expect(targets(viaComment), 'a span refused to close on a commented backtick').toEqual([
      'Real',
    ]);

    // control: a real single-line span still masks
    expect(
      targets('a `code [[NotThis]]` and [[Real]]'),
      'a real code span stopped masking',
    ).toEqual(['Real']);
  });

  it('a pathological code-span document does not go quadratic', () => {
    // Ascending backtick run lengths: every run goes unmatched, so a scanner
    // that rescans forward from each opener is O(n^2) in the body. Measured on
    // the previous implementation: 1.96MB took 4436ms and 7.8MB took 35
    // SECONDS. Note bodies are user-supplied, so that is a denial of service.
    //
    // The bound is deliberately loose — 1500ms is ~90x the ~16ms this now
    // takes, and still ~3x under the 4436ms the old scanner needed, so it
    // discriminates without being a flaky wall-clock assertion.
    let doc = '';
    for (let i = 1; i <= 2000; i++) doc += '`'.repeat(i) + ' x ';
    doc += '[[Real]]\n';
    expect(doc.length).toBeGreaterThan(1_000_000);

    const started = performance.now();
    const found = extractWikilinks(doc).map((l) => l.target);
    const elapsed = performance.now() - started;

    expect(
      elapsed,
      `codeMask took ${elapsed.toFixed(0)}ms on a ${doc.length} char body`,
    ).toBeLessThan(1500);
    // and it still has to be CORRECT, not just fast
    expect(found, 'the pathological body changed the result').toEqual(['Real']);
  });

  it('the existing masking still holds', () => {
    // a negative control for the whole file: the cases that already worked must
    // keep working, and a real link outside every construct must survive
    const body = [
      'Keep [[Alpha]].',
      '`inline [[NotThis]]`',
      '```',
      'fenced [[NorThis]]',
      '```',
      '\\[[Escaped]]',
      'Keep [[Omega]].',
    ].join('\n');
    expect(targets(body)).toEqual(['Alpha', 'Omega']);
  });
});
