import { describe, expect, it } from 'vitest';
import { looksLikeAsking } from '../src/question-cues';
import { cleanSpeech, readEnglishDate, spokenYearsToDigits } from '../src/speech';
import { TranscriptError, applyRoles, parseTranscript, prepareText } from '../src/transcript';
import { splitRunOnLabels } from '../src/transcript-formats';

/**
 * Every pattern that reads a transcript must be linear: a paste or a file of 400,000
 * characters of anything finishes in a moment. (Two shapes once took 81 s and 58 s: a name
 * followed by a long run of spaces, and a subtitle cue full of "<". The parse runs inside the
 * request, so the whole server waited.) Each case is timed three times and the fastest counts,
 * so a busy machine does not fail the test; a quadratic pattern would take seconds every time.
 */

const N = 400_000;
const big = (s: string, n = N) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const cue2 = '\n\n2\n00:00:02,000 --> 00:00:03,000\nhi\n';

function fastest(f: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    try {
      f();
    } catch (e) {
      if (!(e instanceof TranscriptError)) throw e;
    }
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}
const read = (text: string) => () => applyRoles(parseTranscript(text));

describe('the two shapes that once froze the server', () => {
  it('a name followed by 400,000 spaces and no colon (was 81 s)', () => {
    expect(
      fastest(read(`Interviewer: hi\nGrandma${' '.repeat(N)}x\nInterviewer: ok`)),
    ).toBeLessThan(100);
  });
  it("a subtitle cue of 400,000 '<' (was 58 s)", () => {
    expect(fastest(read(`1\n00:00:01,000 --> 00:00:02,000\n${'<'.repeat(N)}${cue2}`))).toBeLessThan(
      100,
    );
  });
});

describe('every reader, 400,000 characters of the worst thing for it', () => {
  const cases: Record<string, string> = {
    // labelled text
    'labelled: name + tabs': `Interviewer: hi\nGrandma${'\t'.repeat(N)}x\nInterviewer: ok`,
    'labelled: name + no-break spaces': `Interviewer: hi\nGrandma${' 　'.repeat(N / 2)}x\nok: x`,
    'labelled: many labels': big('A: hi there\nB: yo man ok\n'),
    'labelled: labels without colons': big('Grandma hello there\n'),
    'labelled: name-like words with dots': big('a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p:'),
    'labelled: long qualifier': big(
      'Grandma (a b c d e f g h i j k l m n o p q r s t u v w x y z) ',
    ),
    'labelled: Q. A. lines': big('Q. where?\nA. here.\n'),
    'labelled: bracket names': big('[Grandma] In Busan\n[Granddaughter] And your father?\n'),
    'labelled: one-line paste': big(
      'Interviewer: Where were you born? Grandma: In Busan by the sea. ',
    ),
    'labelled: colons': big(':'),
    'labelled: brackets': big('['),
    'labelled: parentheses': big('(a'),
    // header text
    'header: Otter headers': big('Speaker 1  0:05\nhi\n'),
    'header: name, spaces, digit': `Speaker 1${' '.repeat(N)}1x\nSpeaker 1  0:05\nhi\nSpeaker 2  0:06\nho\nSpeaker 1  0:07\nha`,
    // subtitles
    "subtitles: '<v ' without '>'": `1\n00:00:01,000 --> 00:00:02,000\n${big('<v a ')}${cue2}`,
    "subtitles: '{\\' without '}'": `1\n00:00:01,000 --> 00:00:02,000\n${big('{\\a')}${cue2}`,
    'subtitles: <v and spaces': `WEBVTT\n\n00:00.000 --> 00:01.000\n<v${' '.repeat(N)}x\n\n00:01.000 --> 00:02.000\nhi\n`,
    'subtitles: labels in one cue': `1\n00:00:01,000 --> 00:00:02,000\n${big('[SPEAKER_00]: x ')}${cue2}`,
    'subtitles: many cues': big('1\n00:00:01,000 --> 00:00:02,000\nhi there\n\n'),
    // timestamped text
    'timestamped: stamp + spaces': `[00:12]${' '.repeat(N)}x\n[00:13] a\n[00:14] b\n[00:15] c`,
    'timestamped: stamp + dashes': `00:12${big(' -')}x\nA: b\nB: c`,
    'timestamped: many stamps': big('[00:12] '),
    // plain text
    'plain: digits': big('1234567890'),
    'plain: digits and colons': big('12:34:'),
    'plain: newlines': `${big('\n')}x`,
    'plain: spaces': `${' '.repeat(N)}x`,
    "plain: '{' (not JSON)": `x${big('{')}`,
    "plain: '>' quoted lines": big('> a\n'),
    'plain: headings': big('# a\n'),
    'plain: fences': big('```\n'),
    'plain: all-capital tags': big('[MUSIC PLAYING] '),
    'plain: unclosed capitals': big('[AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    'plain: music notes': `♪${big(' la')}`,
    'plain: fillers': big('um, uh, mm-hm, '),
    'plain: fillers mixed with words': big('um well uh, you know, I, I mean '),
    'plain: Cyrillic text': big('Мы жили у моря. Отец чинил лодки. '),
    'plain: Han text without spaces': big('我出生在釜山，父亲是修船的。'),
    'plain: stammers': big('so so, the the, I I, '),
    'plain: spoken years': big(
      'in nineteen sixty six and two thousand and twenty one paid nineteen fifty ',
    ),
    'plain: zero-width characters': big('​G​r​a: hi\n'),
    'plain: control characters': big('\u0000\u0001a'),
    // JSON text
    'JSON: a big valid file': JSON.stringify({
      segments: Array.from({ length: 6000 }, (_, i) => ({
        start: i,
        end: i + 1,
        text: 'hello there my friend '.repeat(3),
        speaker: i % 2 ? 'A' : 'B',
      })),
    }),
    'JSON: broken, 1.5 MB': `{"segments": [${big('{"text": "oops" ', 1_500_000)}`,
    'JSON: words with spaces': JSON.stringify({
      word_segments: Array.from({ length: 50_000 }, () => ({ word: `a${' '.repeat(8)}b` })),
    }),
  };
  for (const [name, text] of Object.entries(cases)) {
    it(name, () => expect(fastest(read(text))).toBeLessThan(1000));
  }
});

describe('the helpers, alone, on 400,000 characters', () => {
  const inputs = [
    ' '.repeat(N),
    big('a. '),
    big('?'),
    big('.'),
    big('Could you tell me more? '),
    big('Tell me. '),
    big('in nineteen sixty six '),
    big('May. 1951 '),
    big('two thousand and '),
    big('Interviewer: hi? Grandma: yes. '),
  ];
  for (const [name, f] of Object.entries({
    prepareText,
    splitRunOnLabels,
    cleanSpeech: (s: string) => cleanSpeech(s),
    spokenYearsToDigits,
    readEnglishDate,
    looksLikeAsking,
  })) {
    it(name, () => {
      for (const s of inputs) expect(fastest(() => f(s))).toBeLessThan(1000);
    });
  }
});
