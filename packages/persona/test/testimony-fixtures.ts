/**
 * FM-027 — realistic family testimony, in English.
 *
 * The earlier fixtures were textbook prose: clean spacing, terminal punctuation
 * on every sentence, one register throughout. Real memory notes in this product
 * are transcribed speech from elderly relatives, and they differ in ways the
 * code actually has to survive:
 *
 *   - registers mixed inside one note ("she said" / "they say" / "mind you")
 *   - possessives and inflections fused to names and places (Grandma's, weddings)
 *   - dates in several forms: 1965, sixty-five, "the year the bridge opened"
 *   - inconsistent capitals and spacing, as a typist or a tool leaves them
 *   - dialect and filler ("aye", "mind you", "fine")
 *   - transcribed speech with NO terminal punctuation for whole paragraphs
 *
 * A pipeline tuned to the clean version can look correct and then fail on every
 * real note. These fixtures exist so the tests exercise what the product will
 * actually be handed.
 */

/** Two relatives, one wedding, materially different accounts. FR-083's fixture. */
export const WEDDING = {
  question: "When was Grandma's wedding?",
  /** Mother's account: told second-hand, no terminal punctuation, a spelled-out year. */
  mother: [
    'Told to me by Mom',
    '',
    "Grandma's wedding was in the spring of 1965 in Lisbon and Mom was still a student then",
    'all the cousins came and there was a feast that went on till morning she said',
    'there is one photo left and on the back somebody wrote spring of sixty-five',
  ].join('\n'),
  /**
   * Uncle's account — dialect, no capitals, different year AND place. He NAMES
   * the subject once ("Grandma's wedding"), because a transcript that only says
   * "that" is unretrievable by any content leg, and a fixture nothing can
   * retrieve tests nothing.
   */
  uncle: [
    'Uncle Joe talking',
    '',
    "oh Grandma's wedding that was 1967 in Porto aye not in Lisbon at all",
    'i was at the village school then and we went down on the train i remember it fine',
    'it was autumn not spring the apples were heavy on the trees mind you',
  ].join('\n'),
};

/** A note that answers what it is asked, for positive controls. */
export const BIRTH = {
  question: 'Where was Grandma born?',
  body: [
    'Grandma biography',
    '',
    'Grandma was born in Lisbon in 1943 and as a small girl she lived near the docks',
    'she played on the beach a lot they said there were five children and Grandma was the third',
  ].join('\n'),
};

/**
 * Gap-questions against REALISTIC evidence: the note is genuinely about the
 * right person and richly detailed, and simply does not contain the answer.
 * This is what makes a gap-question dangerous — every earlier gate is satisfied.
 *
 * `missing` is what the refusal has to name: the words the question needs that
 * the evidence never says.
 */
export const GAPS: Array<{ question: string; body: string; missing: string[] }> = [
  {
    question: 'When did Grandma learn to swim?',
    body: [
      'Grandma was born in Lisbon in 1943 and lived near the docks as a girl',
      'she did tell stories about her childhood all the time there were five children',
    ].join('\n'),
    missing: ['learn', 'swim'],
  },
  {
    question: "Where was Grandpa's first job?",
    body: [
      'Grandpa was born in Cork in 1940 and married in 1965',
      'he served in the army for two years and had four children',
    ].join('\n'),
    missing: ['first', 'job'],
  },
  {
    question: "What was Mother's favourite colour?",
    body: [
      'Mother was at university in Dublin and walked every morning',
      'she liked plain food and pickled her own cabbage',
    ].join('\n'),
    missing: ['favourite', 'colour'],
  },
];

/** A long note, built from realistic prose rather than a repeated word. */
export function verboseTestimony(paragraphs: number): string {
  const lines = [
    "Grandma's wedding was in the spring of 1965 in Lisbon",
    'it rained from early morning they said but it cleared by the afternoon',
    'the cousins all came and the neighbours came to watch as well',
    'there was soup and bread and a big cake',
    'Grandpa borrowed a suit and wore it all day',
  ];
  return Array.from(
    { length: paragraphs },
    (_, i) => `## Memory ${i + 1}\n\n${lines.join(' ')} ${lines.join(' ')}`,
  ).join('\n\n');
}
