import { describe, expect, it } from 'vitest';
import { ANSWERS, UNKNOWN, applyRoles, parseTranscript } from '../src/transcript';

/**
 * Speaker labels. Each case here once went wrong in a way a family would not notice: a label
 * the reader could not see glued one person's words onto the other's turn, and the role guess
 * then called the result a confident monologue.
 */

const who = (input: unknown) => parseTranscript(input).turns.map((t) => t.speaker);
const said = (input: unknown, speaker: string) =>
  parseTranscript(input)
    .turns.filter((t) => t.speaker === speaker)
    .map((t) => t.text)
    .join(' ');
const codes = (input: unknown) => parseTranscript(input).warnings.map((w) => w.code);

describe('labels the reader used to miss', () => {
  it('names with accents, or in any script, are labels', () => {
    const zoe =
      'Interviewer: Where were you born, Grandma?\nZoë: I was born in Busan, in a small house by the harbour.\n' +
      'Interviewer: Tell me about your father.\nZoë: He repaired boats. He had big hands.';
    expect(who(zoe)).toEqual(['Interviewer', 'Zoë', 'Interviewer', 'Zoë']);
    expect(said(zoe, 'Interviewer')).not.toMatch(/Busan|boats/);
    expect(applyRoles(parseTranscript(zoe)).roles.interviewees).toEqual(['Zoë']);
    // the interviewer's words are never filed as Grandma's
    const jose =
      'José: Where were you born?\nGrandma: I was born in Busan.\n' +
      'José: Tell me about your father, he went out every day before dawn, I heard.\nGrandma: He repaired boats.';
    expect(said(jose, 'Grandma')).toBe('I was born in Busan. He repaired boats.');
    expect(who('Renée Kim: Hello there.\nŁukasz: Good morning.\nRenée Kim: How are you?')).toEqual([
      'Renée Kim',
      'Łukasz',
      'Renée Kim',
    ]);
  });

  it('"Name (note):", "Last, First:", four-word names and a time between name and colon', () => {
    expect(
      who(
        'Interviewer (Noah): Tell me about your father.\nGrandma (Sunja Kim): He repaired boats.\n' +
          'Interviewer (Noah): What did he sing?\nGrandma (Sunja Kim): Arirang, mostly.',
      ),
    ).toEqual([
      'Interviewer (Noah)',
      'Grandma (Sunja Kim)',
      'Interviewer (Noah)',
      'Grandma (Sunja Kim)',
    ]);
    expect(
      who('Kim, Noah: Tell me about him.\nKim, Sunja: He repaired boats.\nKim, Noah: And?'),
    ).toEqual(['Kim, Noah', 'Kim, Sunja', 'Kim, Noah']);
    expect(who('Mary Ann de Souza: hello.\nInterviewer: hi?\nMary Ann de Souza: yes.')).toEqual([
      'Mary Ann de Souza',
      'Interviewer',
      'Mary Ann de Souza',
    ]);
    const t = parseTranscript('Speaker 1 00:05: Where were you born?\nSpeaker 2 00:09: In Busan.');
    expect(t.turns.map((x) => [x.speaker, x.start, x.text])).toEqual([
      ['Speaker 1', 5, 'Where were you born?'],
      ['Speaker 2', 9, 'In Busan.'],
    ]);
    // a time in brackets after the name is still a time, not a note
    expect(
      parseTranscript('Grandma (00:09): We left.\nInterviewer (00:12): Why?').turns[0],
    ).toMatchObject({
      speaker: 'Grandma',
      start: 9,
    });
  });

  it('"Q." / "A." (and "Q)" / "A)") are labels when both recur, and the roles read them', () => {
    const qa =
      'Q. Tell me about your father.\nA. He repaired boats. He had big hands.\nQ. I remember you said he sang.\n' +
      'A. He did. Every morning.\nQ) What did he sing?\nA) Arirang, mostly.';
    expect(who(qa)).toEqual(['Q', 'A', 'Q', 'A', 'Q', 'A']);
    expect(said(qa, 'A')).not.toMatch(/^A\./);
    const r = applyRoles(parseTranscript(qa)).roles;
    expect(r).toMatchObject({ interviewees: ['A'], confidence: 'high', needsConfirmation: false });
    // one "A." is a sentence ("A. Lincoln was…"), not a label
    expect(
      parseTranscript('A. Lincoln was a president.\nWe read about him in school.').format,
    ).toBe('plain-text');
  });

  it('NFD Hangul, zero-width characters, a BOM mid-file, NBSP, full-width brackets and colon, CR and U+2028', () => {
    const ko =
      '질문자: 어디서 태어나셨어요?\n할머니: 부산에서 태어났어요. 바닷가 작은 집이었지요.\n질문자: 아버지는요?\n할머니: 배를 고치셨어요.';
    expect(who(ko.normalize('NFD'))).toEqual(['질문자', '할머니', '질문자', '할머니']);
    const en =
      'Interviewer: Where were you born?\nGrandma: I was born in Busan.\nInterviewer: And your father?\nGrandma: He repaired boats.';
    const expected = ['Interviewer', 'Grandma', 'Interviewer', 'Grandma'];
    expect(who(en.replace(/\nGrandma/g, '\n​Grandma'))).toEqual(expected);
    expect(who(en.replace('\nInterviewer', '\n﻿Interviewer'))).toEqual(expected);
    expect(who(en.replace(/: /g, ' : '))).toEqual(expected);
    expect(who(en.replace(/\n/g, '\r'))).toEqual(expected);
    expect(who(en.replace(/\n/g, ' '))).toEqual(expected);
    expect(who(en.replace(/: /g, '： '))).toEqual(expected);
    expect(
      who(
        '［화자1］ 어디서 태어나셨어요?\n［화자2］ 부산에서 태어났어요.\n［화자1］ 아버지는요?\n［화자2］ 배를 고치셨어요.',
      ),
    ).toEqual(['화자1', '화자2', '화자1', '화자2']);
  });

  it('"[할머니] text": a bracketed name with no colon, when a few names start most lines', () => {
    const t = parseTranscript(
      '[할머니] 부산에서 태어났어요.\n[손녀] 아버지는요?\n[할머니] 배를 고치셨어요.\n[손녀] 어머니는요?',
    );
    expect(t.turns.map((x) => [x.speaker, x.text])).toEqual([
      ['할머니', '부산에서 태어났어요.'],
      ['손녀', '아버지는요?'],
      ['할머니', '배를 고치셨어요.'],
      ['손녀', '어머니는요?'],
    ]);
    // a clarification in brackets is never taken for a speaker
    const clar = parseTranscript(
      'Interviewer: Where did you live?\nGrandma: We moved to [Busan] in 1950.\nInterviewer: And then?\nGrandma: [Busan] was where my father worked.',
    );
    expect(clar.turns.map((x) => x.speaker)).toEqual([
      'Interviewer',
      'Grandma',
      'Interviewer',
      'Grandma',
    ]);
    expect(clar.turns[1]!.text).toBe('We moved to [Busan] in 1950.');
  });

  it('a paste that lost its line breaks is split back into turns (the labels are never stripped as sound notes)', () => {
    const one =
      'Interviewer: Where were you born? Grandma: In Busan, by the sea. Interviewer: Tell me about your father. Grandma: He repaired boats.';
    expect(parseTranscript(one).turns.map((x) => [x.speaker, x.text])).toEqual([
      ['Interviewer', 'Where were you born?'],
      ['Grandma', 'In Busan, by the sea.'],
      ['Interviewer', 'Tell me about your father.'],
      ['Grandma', 'He repaired boats.'],
    ]);
    const wx =
      '[SPEAKER_01]: Where were you born? [SPEAKER_00]: In Busan, by the sea. [SPEAKER_01]: Tell me about your father. [SPEAKER_00]: He repaired boats.';
    expect(who(wx)).toEqual(['SPEAKER_01', 'SPEAKER_00', 'SPEAKER_01', 'SPEAKER_00']);
    expect(codes(wx)).not.toContain('annotations_removed');
    const ko =
      '[화자1] 어디서 태어나셨어요? [화자2] 부산이요. 바닷가였지요.\n[화자1] 아버지는요? [화자2] 배를 고치셨어요.';
    expect(said(ko, '화자2')).toBe('부산이요. 바닷가였지요. 배를 고치셨어요.');
    // one colon in a sentence never splits it
    expect(parseTranscript('He said: no. She said: yes. We left the next day.').turns).toHaveLength(
      1,
    );
  });

  it('only the interviewer labelled: the unlabelled lines are the ANSWERS, not more of the question', () => {
    const t = parseTranscript(
      'Q: Where were you born?\nIn Busan, in a small house by the harbour.\nQ: Tell me about your father.\nHe repaired boats.\nHe had big hands.',
    );
    expect(t.turns.map((x) => [x.speaker, x.text])).toEqual([
      ['Q', 'Where were you born?'],
      [ANSWERS, 'In Busan, in a small house by the harbour.'],
      ['Q', 'Tell me about your father.'],
      [ANSWERS, 'He repaired boats. He had big hands.'],
    ]);
    const r = applyRoles(t).roles;
    expect(r).toMatchObject({ interviewees: [ANSWERS], confidence: 'high' });
    expect(r.reasons).toContain('label_says_interviewer');
    // a question wrapped onto a second line is still the question
    const wrapped = parseTranscript(
      'Interviewer: Tell me about the house where you\ngrew up, and who lived there?\nIt was small.\nInterviewer: And your father?\nHe repaired boats.',
    );
    expect(wrapped.turns[0]!.text).toBe(
      'Tell me about the house where you grew up, and who lived there?',
    );
    expect(wrapped.turns[1]).toMatchObject({ speaker: ANSWERS, text: 'It was small.' });
  });

  it('lines that look labelled but cannot be read: every word is kept, labels_unclear is raised, and the roles ask', () => {
    const odd =
      'Grandma (Sunja Kim, 88, at home in Busan, interviewed by her granddaughter): I was born in Busan.\n' +
      'Noah (granddaughter, who did the recording and typed this up afterwards): Where exactly?\n' +
      'Grandma (Sunja Kim, 88, at home in Busan, interviewed by her granddaughter): By the harbour.';
    const t = parseTranscript(odd);
    expect(t.warnings.map((w) => w.code)).toContain('labels_unclear');
    expect(t.turns.map((x) => x.text).join(' ')).toContain('By the harbour.');
    const r = applyRoles(t).roles;
    expect(r).toMatchObject({ confidence: 'low', needsConfirmation: true });
    expect(r.reasons).toContain('labels_unclear');
    // one labelled voice with unlabelled lines between its turns: whose are they? ask.
    const half = parseTranscript(
      'Grandma: I was born in Busan.\nWhere exactly, Grandma?\nGrandma: By the harbour.\nAnd your father?\nGrandma: He repaired boats.',
    );
    expect(half.warnings.map((w) => w.code)).toContain('labels_unclear');
    expect(applyRoles(half).roles.needsConfirmation).toBe(true);
  });
});

describe('things that look like labels and are not', () => {
  it('a time of day at the start of a paragraph is Grandma still talking', () => {
    const t = parseTranscript(
      'Interviewer: What was a normal day like?\nGrandma: We got up before dawn.\nAt 5:30 we walked to the market with the fish.\nInterviewer: And then?\nGrandma: We sold it all by noon.',
    );
    expect(t.turns.map((x) => x.speaker)).toEqual([
      'Interviewer',
      'Grandma',
      'Interviewer',
      'Grandma',
    ]);
    expect(t.turns[1]!.text).toBe(
      'We got up before dawn. At 5:30 we walked to the market with the fish.',
    );
  });

  it('"My father:", "Rule one:" inside an answer are part of the answer', () => {
    const t = parseTranscript(
      'Interviewer: Who was in the house?\nGrandma: There were five of us.\nMy father: he repaired boats and was gone all day.\n' +
        'Rule one: never waste rice.\nInterviewer: And you?\nGrandma: I looked after my brothers.\nInterviewer: Thank you.',
    );
    expect(new Set(t.turns.map((x) => x.speaker))).toEqual(new Set(['Interviewer', 'Grandma']));
    expect(t.turns[1]!.text).toBe(
      'There were five of us. My father: he repaired boats and was gone all day. Rule one: never waste rice.',
    );
  });

  it('prose with a speaking verb is not a label: "Grandma said: eat first."', () => {
    const t = parseTranscript(
      'Interviewer: What did she always say?\nMom: She said one thing.\nGrandma said: eat first, talk later.\nInterviewer: Did you listen?\nMom: Never.',
    );
    expect(t.turns.map((x) => x.speaker)).not.toContain('Grandma said');
    expect(t.turns[1]!.text).toContain('Grandma said: eat first, talk later.');
  });

  it("a transcriber's note on its own line is dropped, never filed as testimony", () => {
    const t = parseTranscript(
      'Interviewer: Where did you go after the war?\nGrandma: We left Busan in the spring of 1953.\n' +
        'Note: the recording was paused here for ten minutes because Grandma was tired.\n' +
        "Transcriber's note: some words were unclear.\nInterviewer: And then?\nGrandma: My brother found work.",
    );
    expect(t.turns.map((x) => x.text).join(' ')).not.toMatch(/paused|unclear/);
    expect(t.turns[1]!.text).toBe('We left Busan in the spring of 1953.');
  });

  it('a real speaker who speaks once is kept, and a one-exchange transcript keeps both labels', () => {
    const t = parseTranscript(
      'Interviewer: Tell me about the farm.\nGrandma: We had forty cows.\nInterviewer: And your husband?\n' +
        'Grandma: He milked them.\nGrandpa: Every morning at four!\nInterviewer: Really?\nGrandma: Every morning.',
    );
    expect(t.turns.map((x) => x.speaker)).toContain('Grandpa');
    expect(who('Interviewer: Where were you born?\nGrandma: In Busan.')).toEqual([
      'Interviewer',
      'Grandma',
    ]);
  });
});

describe('the words above the first label', () => {
  it('a title block of up to six short lines is dropped, and is never a speaker who could win', () => {
    const t = parseTranscript(
      'Interview with Grandma Sunja Kim\nRecorded at her home in Busan on March 3rd, 2024\nTranscribed by her granddaughter Noah\n\n' +
        'Interviewer: Where were you born?\nGrandma: In Busan.\nInterviewer: And your father?\nGrandma: He repaired boats.',
    );
    expect(t.turns.map((x) => x.speaker)).not.toContain(UNKNOWN);
    expect(applyRoles(t).roles.interviewees).toEqual(['Grandma']);
  });

  it('a recording that starts mid-sentence keeps its first words', () => {
    const t = parseTranscript(
      'and so my father sent me to live with my aunt in the city, which I did not want at all\nQ: How old were you?\n' +
        'I was eleven or twelve, I am not sure.\nQ: Did you like it there?\nNo. I cried every night for a month.',
    );
    // the reader keeps the words with no speaker; the roles give them to the answers
    expect(t.turns[0]).toMatchObject({ speaker: UNKNOWN });
    expect(t.turns[0]!.text).toMatch(/my father sent me to live with my aunt/);
    expect(applyRoles(t).turns[0]).toMatchObject({ speaker: ANSWERS });
    const labelled = parseTranscript(
      '...and that is how we ended up in Daegu.\nInterviewer: How long did you stay there?\nGrandma: Nine years.\nInterviewer: And then?\nGrandma: Seoul.',
    );
    expect(labelled.turns[0]).toMatchObject({
      speaker: UNKNOWN,
      text: '...and that is how we ended up in Daegu.',
    });
  });

  it('a long unlabelled opening is kept as UNKNOWN, which is never picked silently', () => {
    const opening =
      'My mother was born in Tongyeong in a house by the water, and her father built boats there. '.repeat(
        4,
      );
    const t = parseTranscript(
      `${opening}\nInterviewer: Where were you born?\nGrandma: In Busan.\nInterviewer: And your father?\nGrandma: He repaired boats.`,
    );
    expect(t.turns[0]).toMatchObject({ speaker: UNKNOWN });
    const r = applyRoles(t).roles;
    expect(r.interviewees).not.toContain(UNKNOWN);
    expect(r).toMatchObject({ confidence: 'low', needsConfirmation: true });
    expect(r.reasons).toContain('others_may_tell');
  });
});

describe('a voice the tool could not name is a speaker, not a stray colon', () => {
  it('"Voice 3:" and friends keep a third person\'s words OUT of the relative\'s turn', () => {
    const t = parseTranscript(
      [
        'Interviewer: So tell me about the farm.',
        'Grandpa Min: The farm was forty acres, mostly rice. My brothers and I worked it from sunrise.',
        'Interviewer: That sounds hard.',
        'Grandpa Min: It was. We ate at noon under the persimmon tree.',
        "Voice 3: Dad, the kettle's boiling!",
        'Grandpa Min: One moment. And in the evenings my father read to us from an old almanac.',
      ].join('\n'),
    );
    expect(t.turns.map((x) => x.speaker)).toEqual([
      'Interviewer',
      'Grandpa Min',
      'Interviewer',
      'Grandpa Min',
      'Voice 3',
      'Grandpa Min',
    ]);
    for (const label of ['Person 2', 'Participant 4', 'GUEST 1', 'voice_5']) {
      const u = parseTranscript(
        `Interviewer: Where were you born?\nGrandma: In Busan, by the sea.\n${label}: Mum, dinner is ready!\nGrandma: Coming. We moved to Daegu when I was nine.\nInterviewer: Why?\nGrandma: My uncle found work there.`,
      );
      expect(
        u.turns.some(
          (x) =>
            x.speaker.toLowerCase().replace(/[_ ]/g, '') ===
            label.toLowerCase().replace(/[_ ]/g, ''),
        ),
      ).toBe(true);
      expect(
        u.turns
          .filter((x) => x.speaker === 'Grandma')
          .map((x) => x.text)
          .join(' '),
      ).not.toMatch(/dinner is ready/);
    }
  });
});

describe('titled names ("Ms. Lee", "Dr. Park") are names, not sentence ends', () => {
  const body = (stamp: (t: string, k: number) => string) =>
    [
      'Ms. Lee: Where were you born?',
      'Dr. Park: My brother Jaesung kept a little bird in a box under his bed.',
      'Ms. Lee: So tell me about your father?',
      'Dr. Park: He repaired boats and he did not talk much at all.',
    ]
      .map(stamp)
      .join('\n');

  it('with a bracketed timestamp in front of every line, the title stays with the name', () => {
    const t = parseTranscript(body((l, k) => `[${String(k).padStart(2, '0')}:00] ${l}`));
    expect(t.turns.map((x) => x.speaker)).toEqual(['Ms. Lee', 'Dr. Park', 'Ms. Lee', 'Dr. Park']);
    // no phantom speaker, no "Ms." left stuck on the end of the previous turn
    expect(t.turns.every((x) => !/\b(?:Ms|Dr)\.?$/.test(x.text))).toBe(true);
    expect(t.warnings.map((w) => w.code)).not.toContain('unlabelled_filled');
  });

  it('without timestamps, and with them in parentheses, as before', () => {
    for (const make of [(l: string) => l, (l: string, k = 0) => l.replace(':', ` (0${k}:00):`)]) {
      const t = parseTranscript(body((l, k) => make(l, k)));
      expect(t.turns.map((x) => x.speaker)).toEqual(['Ms. Lee', 'Dr. Park', 'Ms. Lee', 'Dr. Park']);
    }
  });

  it('a paste that LOST its line breaks is still put back together', () => {
    const t = parseTranscript(
      'Interviewer: Where were you born? Grandma: In Busan. Interviewer: Tell me about your father. Grandma: He repaired boats.',
    );
    expect(t.turns.map((x) => x.speaker)).toEqual([
      'Interviewer',
      'Grandma',
      'Interviewer',
      'Grandma',
    ]);
    // and so is one with titles in the names
    const titled = parseTranscript(
      'Ms. Lee: Where were you born? Dr. Park: In Busan, by the sea. Ms. Lee: And your father? Dr. Park: He repaired boats.',
    );
    expect(titled.turns.map((x) => x.speaker)).toEqual([
      'Ms. Lee',
      'Dr. Park',
      'Ms. Lee',
      'Dr. Park',
    ]);
  });
});
