import { describe, expect, it } from 'vitest';
import { isBackchannel, looksLikeAsking } from '../src/question-cues';

/**
 * Speech-to-text may leave the "?" out, so a question must be recognised by its words as well.
 * Before round 2, an interview transcribed without "?" could read as two people telling and had
 * to be confirmed by the family. The cues read English; any other script is plain text to them.
 */

describe('questions without a question mark', () => {
  it.each([
    'Where were you born',
    'Tell me about your father',
    'And your mother',
    'What was the house like',
    'Describe the house you grew up in',
    'Talk about that winter',
    'And then',
    'What about school',
    'How did you feel when you left',
    'Did you go to school',
    'Can you describe the village',
    'Do you remember the first time you saw the sea',
    'Who was your best friend',
    'Would you say it was a happy house',
    'Go on',
    'Keep going',
    'Say more about your uncle',
    'Your brothers',
  ])('%s', (q) => expect(looksLikeAsking(q)).toBe(true));
});

describe('statements that only look like questions stay statements', () => {
  it.each([
    'He repaired boats',
    'In Busan',
    'Yes',
    'We had one stove for six people',
    'My mother sold fish at the market',
    'Where my father was born I never found out',
    'What he did for a living nobody ever told us',
    'Who the man was I could not say',
    'How we got through that winter I will never know',
    'When the war ended we went home',
    'Which was the hardest winter we ever had',
    'The old house by the river',
    'Mm-hm',
    'My brother',
  ])('%s', (s) => expect(looksLikeAsking(s)).toBe(false));
});

describe('the other cues are as before', () => {
  it('a question mark, and English prompts', () => {
    expect(looksLikeAsking('Where were you born?')).toBe(true);
    expect(looksLikeAsking('Tell me about your father.')).toBe(true);
    expect(looksLikeAsking('That is lovely. Tell me more about him.')).toBe(true);
    expect(looksLikeAsking('He repaired boats.')).toBe(false);
    expect(looksLikeAsking('The old house?')).toBe(true);
  });

  it('only the end of a long turn decides: the invitation is its last sentence', () => {
    expect(
      looksLikeAsking(
        'I remember when I was little we used to visit you every summer and I loved it. Tell me about the house',
      ),
    ).toBe(true);
    expect(
      looksLikeAsking(
        'My father came from Ulsan, I am told, and why he left I do not know. He fixed boats all his life',
      ),
    ).toBe(false);
  });

  it('is linear: 400,000 characters of anything answer at once', () => {
    for (const text of [
      'a'.repeat(400_000),
      'where '.repeat(66_000),
      '?'.repeat(400_000),
      'yes '.repeat(100_000),
      `${'n'.repeat(399_996)} you`,
      '.'.repeat(400_000),
      'я'.repeat(400_000),
      '我出生在釜山。'.repeat(50_000),
    ]) {
      const t0 = performance.now();
      looksLikeAsking(text);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });
});

describe('round 3: run-on prompts, reported questions, English ASR', () => {
  it.each([
    'so where were you born',
    'and your mother',
    'okay and then',
    'what was the house like',
    'well tell me about the school',
    'um so what about your brothers',
    'alright and where did you go after that',
  ])('asks: %s', (q) => expect(looksLikeAsking(q)).toBe(true));

  it.each([
    'When I was young we lived in a little house in Busan, right by the harbour.',
    'and then we walked all the way to Busan with my brother on my back',
    'How we survived that winter I will never know, my mother said.',
    'what my uncle did for the railway I cannot tell you, it was long ago',
    'and then the war came and we had to leave everything behind in the house',
  ])('tells: %s', (s) => expect(looksLikeAsking(s)).toBe(false));
});

describe('words in another script are plain text to the cues', () => {
  it.each(['Где вы родились', 'Расскажите об отце', '你在哪里出生', 'أين ولدت', 'Πού γεννηθήκατε'])(
    'no question mark, no question: %s',
    (s) => expect(looksLikeAsking(s)).toBe(false),
  );

  it('an ASCII question mark still asks, in any script', () => {
    expect(looksLikeAsking('Где вы родились?')).toBe(true);
    expect(looksLikeAsking('你在哪里出生?')).toBe(true);
  });

  it('a full-width question mark is not a question mark', () => {
    expect(looksLikeAsking('你在哪里出生？')).toBe(false);
  });
});

describe('isBackchannel: only a sound of listening or agreeing', () => {
  it.each([
    'Mm-hm.',
    'Uh-huh.',
    'Yeah.',
    'Okay.',
    'I see.',
    'Oh',
    'Wow!',
    'Really?',
    'Mhm',
    'Right',
  ])('is one: %s', (s) => expect(isBackchannel(s)).toBe(true));

  it.each([
    'Yes, we left in May.',
    'Mm-hm, and then we moved to Busan.',
    'I see what you mean about the house.',
    'Да.',
    '是的。',
    '',
    `Okay ${'okay '.repeat(20)}`,
  ])('is not one: %s', (s) => expect(isBackchannel(s)).toBe(false));
});
