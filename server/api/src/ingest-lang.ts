import { stripInvisible } from '@funmem/persona';
import { validateNoteTitle } from '@funmem/core';
import { shownText } from './grounding-ko';
import { checkTitleFacts } from './title-check';
import { formatClock } from './clock';

/**
 * Everything in ingestion that depends on the language the interview was
 * spoken in: which words the reviewer is shown, what the saved-note footer says,
 * and what counts as an acceptable title.
 *
 * The rule is one sentence: THE OUTPUT IS IN THE SPEAKER'S LANGUAGE, decided per
 * memory from that memory's own words. A Korean answer yields a Korean note with a
 * Korean footer even inside an interview that is mostly English, and the other way
 * round. The footer is written into the saved note, so a wrong-language footer is
 * not a display glitch, it is a permanent foreign sentence in someone's archive.
 */

export type Lang = 'ko' | 'en';

/**
 * Already respectful, or a word that cannot take 님: "김순자 할머니" is not made
 * "김순자 할머니님", and "큰언니" is not made "큰언니님". "김 선생" is NOT here: it is
 * made "김 선생님".
 */
const RESPECTFUL_END = new RegExp(
  `(?:${[
    '님',
    '씨',
    '어르신',
    '할머니',
    '할아버지',
    '할매',
    '할배',
    '어머니',
    '아버지',
    '엄마',
    '아빠',
    '언니',
    '오빠',
    '누나',
    '이모',
    '고모',
    '삼촌',
    '숙모',
    '이모부',
    '고모부',
    '동생',
    '아들',
    '남편',
    '아내',
    '손자',
    '손녀',
    '조카',
    '사촌',
    '며느리',
    '사위',
    '형부',
    '매형',
    '올케',
    '형수',
    // dialect and household words, which take no 님 either
    '어무이',
    '엄니',
    '어매',
    '아부지',
    '아배',
    '할무이',
    '할부지',
    '아재',
    '아지매',
    '아줌마',
    '아주머니',
    '막내',
    '맏이',
    '첫째',
    '둘째',
    '셋째',
    '넷째',
  ].join('|')})$`,
);

/**
 * One-syllable kinship words end many given names too (박준형 is a person, not a brother), so
 * they count only as the whole word or after an ordinal ("형", "큰형", "막내 형", "둘째 딸").
 */
const KIN_ONE = /(?:^|\s)(?:큰|작은|둘째|셋째|넷째|막내|맏|사촌|친)?\s?(?:형|딸)$/;

/** A Korean name as it is spoken of: with 님 unless it already carries a title. Total: a non-string is ''. */
export const honorific = (name: unknown): string => {
  if (typeof name !== 'string') return '';
  const t = name.trim();
  if (t === '') return '';
  // "김순자 (할머니)": judge the words, not the closing bracket
  const words = t.replace(/[\s)\]}.,]+$/, '');
  // a name written in Latin letters ("Grandma", "Aunt Mae", "Sunja Kim") takes no Korean 님
  if (/[A-Za-z]$/.test(words) || !/[가-힣]/.test(words)) return t;
  return RESPECTFUL_END.test(words) || KIN_ONE.test(words) ? t : `${t}님`;
};

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/g;
const LATIN = /[A-Za-z]/g;
/** one Hangul syllable carries about as much as two and a half Latin letters */
const HANGUL_WEIGHT = 2.5;

/**
 * Hangul-dominant -> Korean; Latin-dominant -> English; a text with neither (digits, a
 * year alone) -> `fallback`. Counts letters, weighting a Hangul syllable as the 2.5
 * letters it is worth, so "We came to LA 1975년에" is not called Korean and "나는 LA에서
 * 살았어요" is not called English.
 */
export function detectLang(text: string, fallback: Lang = 'en'): Lang {
  const ko = (text.match(HANGUL)?.length ?? 0) * HANGUL_WEIGHT;
  const en = text.match(LATIN)?.length ?? 0;
  if (ko === 0 && en === 0) return fallback;
  return ko > en ? 'ko' : 'en';
}

/**
 * The language of ONE memory, which its footer, notes and title follow together. Korean-first:
 * a memory that code-switches ("1975년에 LA로 갔어요. … We lived on Western Avenue.") is
 * Korean as soon as Hangul carries two fifths of its letters (weighted as `detectLang` does),
 * so a Korean-speaking grandmother's mixed answer is not given an English footer under a
 * Korean title. An English memory with a Korean name or dish in it stays English.
 */
export function languageOf(text: string, fallback: Lang = 'en'): Lang {
  const ko = (text.match(HANGUL)?.length ?? 0) * HANGUL_WEIGHT;
  const en = text.match(LATIN)?.length ?? 0;
  if (ko === 0 && en === 0) return fallback;
  return ko >= 0.4 * (ko + en) ? 'ko' : 'en';
}

/* ── speaker labels ──────────────────────────────────────────────────── */

/**
 * Labels that name a ROLE or a voice, never a person: what a transcription tool or a
 * hand-typed transcript calls someone it does not know. Anything else ("Grandpa Tae",
 * "김순자", "Mom") is the name the family used, and is written as who told the memory.
 */
const GENERIC_LABEL = new RegExp(
  String.raw`^(?:speaker|spk|spkr|voice|person|participant|interviewee|interviewer|respondent|narrator|subject|guest|host|moderator|unknown(?:\s*speaker)?|questions?|answers?|caller|user|q|a|b|c|d|s|p|화자|참석자|발화자|면접자|면접관|면담자|질문자|질문|응답자|답변자|답변|인터뷰어|인터뷰이|진행자|사회자|미상|알\s?수\s?없음)(?:[\s_\-#.:]*(?:\d+|[a-z]))?$`,
  'i',
);

/**
 * A speaker id as a person would read it: the transcript reader renames an id that collides
 * with one it assigns itself or with an object property ("constructor" -> "constructor
 * (speaker)"); the name is still the part before that.
 */
export const labelOf = (id: unknown): string =>
  typeof id === 'string' ? id.replace(/ \(speaker\)$/, '') : '';

/** Is this speaker label a person's name (as opposed to "SPEAKER_01", "Speaker 2", "Q", "화자 1")? */
export function isPersonLabel(label: unknown): boolean {
  const t = cleanLabel(labelOf(label));
  if (t === '' || !/\p{L}/u.test(t)) return false;
  if (/^\p{L}$/u.test(t)) return false;
  return !GENERIC_LABEL.test(t);
}

/* ── strings ─────────────────────────────────────────────────────────── */

export interface Strings {
  kept: string;
  keptCaveat: string;
  dateFound: (d: string) => string;
  noDate: string;
  linked: string;
  /** the AI used another household word for someone ("엄마" written as "어머니") */
  swapped: (words: string[]) => string;
  /** why the AI's rewrite was not used, one sentence per kind of problem (each without the tail) */
  rejectedInvention: (words: string[]) => string;
  rejectedLoss: string;
  rejectedNegation: string;
  rejectedHedge: string;
  rejectedPerson: string;
  rejectedSentence: string;
  /** the AI put a whole stretch of the interview into one note */
  rejectedTooBig: string;
  /** what the reviewer sees instead: "Showing what was said, as spoken." */
  rejectedShown: string;
  notTidied: string;
  /** the note that gathers one-line replies */
  shortTitle: string;
  shortNote: string;
  /** shown to the reviewer: this memory may disagree with a note that already exists */
  conflict: (title: string, existing: string) => string;
  /** the source line saved into the note, with the interviewer's question when there was one */
  footer: (
    start: number | null,
    end: number | null,
    question?: string | null,
    /** where it came from: the file or interview's own name, and who told it */
    from?: { source?: string | null; teller?: string | null },
  ) => string;
}

const when = (start: number | null, end: number | null): string =>
  start === null
    ? ''
    : end === null
      ? ` (${formatClock(start)})`
      : ` (${formatClock(start)}–${formatClock(end)})`;

/**
 * The interviewer's question, quoted, ABOVE the source line. An answer like
 * "Small. We had it at the church" is a fragment on its own; the question is what
 * makes it a memory. It is labelled as the question (the interviewer's words,
 * never testimony) and sits in the footer, outside the part the grounding check
 * vouches for.
 */
const asked = (q: string | null | undefined, label: string): string => {
  const t = (typeof q === 'string' ? q : '').replace(/\s+/g, ' ').trim();
  // the pipeline decides WHICH turn is the question; a short one ("When?") is still the question
  if (t === '') return '';
  return `> ${label}: “${t.length > 240 ? `${t.slice(0, 237).trimEnd()}…` : t}”\n`;
};

/**
 * A name or file name that is safe to write into a note: one line, no links, no markdown quote.
 * Total: anything that is not a string (a speaker id that collided with `Object.prototype`, a
 * number) is ''.
 */
export const cleanLabel = (s: unknown, max = 80): string => {
  if (typeof s !== 'string') return '';
  const t = s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\[\[|\]\]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/^[\s>#]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

const list = (ws: string[]): string => (ws.length <= 6 ? ws : [...ws.slice(0, 6), '…']).join(', ');

export const STRINGS: Record<Lang, Strings> = {
  ko: {
    kept: 'AI 도우미가 적어 주신 글을 다듬었습니다. 말씀에 없는 내용은 넣지 않았는지 기계가 한 번 더 확인했습니다.',
    keptCaveat: '그래도 사실이 맞는지 꼭 읽어 보고 고쳐 주세요. 저장은 확인하신 뒤에 됩니다.',
    dateFound: (d) => `말씀에서 날짜를 찾았습니다: ${d}`,
    noDate: '날짜는 비워 두었습니다. 기억나지 않아도 괜찮습니다.',
    linked: '이미 있는 기록과 연결했습니다.',
    swapped: (ws) =>
      `부르시는 말을 이렇게 옮겼습니다: ${list(ws)}. 원래 쓰시던 말이 더 좋으시면 되돌려 주세요.`,
    rejectedInvention: (ws) =>
      `AI가 다듬은 글에 말씀에 없던 말이 있어서 쓰지 않았습니다: ${list(ws)}.`,
    rejectedLoss: 'AI가 다듬은 글이 말씀하신 내용의 일부를 빠뜨려서 쓰지 않았습니다.',
    rejectedNegation:
      "AI가 다듬은 글에서 '안·못·없다·아니다' 같은 말이 빠지거나 더해져서, 뜻이 거꾸로 될 수 있어 쓰지 않았습니다.",
    rejectedHedge:
      "AI가 다듬은 글에서 '아마·쯤·-면·만' 같은 말이나 때(했다·한다)가 바뀌어서 쓰지 않았습니다. 확실하지 않다고 하신 것은 그대로 남깁니다.",
    rejectedPerson: 'AI가 다듬은 글에서 사람을 가리키는 말이 말씀하신 것과 달라서 쓰지 않았습니다.',
    rejectedSentence:
      'AI가 다듬은 글에 말씀 어디에도 그렇게 나오지 않는 문장이 있어서 쓰지 않았습니다.',
    rejectedTooBig: 'AI가 너무 많은 이야기를 노트 하나에 모아서 쓰지 않았습니다.',
    rejectedShown: '말씀하신 그대로 옮겼습니다.',
    notTidied: 'AI가 정리하지 않은 부분이라, 말씀하신 그대로 옮겼습니다.',
    shortTitle: '짧은 답변',
    shortNote:
      '짧게 하신 대답은 하나도 빠뜨리지 않도록, 받으신 질문과 함께 이 노트 한곳에 모았습니다.',
    conflict: (title, existing) =>
      `이미 있는 「${title}」 노트와 다를 수 있습니다. 그 노트에는 “${existing}”라고 되어 있습니다. 둘 다 남겼고, 노트에 서로 다른 기억이라고 표시했습니다.`,
    footer: (s, e, q, from) => {
      const src = cleanLabel(from?.source);
      const who = cleanLabel(from?.teller, 60);
      return `${asked(q, '질문')}> ${src ? `“${src}”` : '인터뷰 녹취'}에서 옮김${who ? ` · ${honorific(who)} 말씀` : ''}${when(s, e)}`;
    },
  },
  en: {
    kept: 'Tidied by the AI, then checked by a program to make sure nothing was added that was not said.',
    keptCaveat:
      'Please still read it and correct anything that is wrong. Nothing is saved until you save it.',
    dateFound: (d) => `Found a date in what was said: ${d}`,
    noDate: 'No date given. It is fine if it is not remembered.',
    linked: 'Linked to notes that already exist.',
    swapped: (ws) =>
      `Some words for people were written another way: ${list(ws)}. Change them back if the speaker's own word is better.`,
    rejectedInvention: (ws) =>
      `The AI's rewrite contained words that were not said, so it was not used: ${list(ws)}.`,
    rejectedLoss: "The AI's rewrite left out part of what was said, so it was not used.",
    rejectedNegation:
      'The AI\'s rewrite left out or added a "not" or a "never", which could reverse the meaning, so it was not used.',
    rejectedHedge:
      'The AI\'s rewrite changed the speaker\'s doubt, tense or condition ("maybe", "could", "if", "was"), so it was not used.',
    rejectedPerson:
      "The AI's rewrite named a person differently from the speaker, so it was not used.",
    rejectedSentence:
      "The AI's rewrite had a sentence the speaker did not say in any one place, so it was not used.",
    rejectedTooBig: 'The AI put too much into one note, so it was not used.',
    rejectedShown: 'Showing what was said, as spoken.',
    notTidied: 'The AI did not tidy this part, so it is shown as spoken.',
    shortTitle: 'Short answers',
    shortNote:
      'Short replies are gathered in this one note, each with the question it answered, so that none is lost.',
    conflict: (title, existing) =>
      `This may disagree with the existing note "${title}", which says: “${existing}”. Both are kept, and the note marks the disagreement.`,
    footer: (s, e, q, from) => {
      const src = cleanLabel(from?.source);
      const who = cleanLabel(from?.teller, 60);
      return `${asked(q, 'Question')}> From ${src ? `“${src}”` : 'the interview transcript'}${who ? ` · told by ${who}` : ''}${when(s, e)}`;
    },
  },
};

/* ── titles ──────────────────────────────────────────────────────────── */

export const TITLE_MAX = 60;
/** a Korean title is cut by syllables: 28 is about as long as a Korean label reads well */
const TITLE_MAX_KO = 28;

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
const tokens = (s: string): string[] => s.match(TOKEN) ?? [];

/** words after which an English phrase cannot stop ("…fishing town on the") */
const DANGLING = new Set(
  (
    'the a an of on in at to and or but with for by from that my his her our their your its he she it they we i you ' +
    'did do does was were is are had has have not so as if when because which who would could will can how what ' +
    'where why whom whose than then there here about after before until through into onto over under between ' +
    'around during without within while though although since nor behind beside beyond toward ' +
    'towards across along among against near past more less most every each some any both very ' +
    'such too also just even really quite rather whose ' +
    // other languages in Latin letters: a title never ends on "de", "la", "und" either
    'de del la el los las en y e o al con por para que se un una le les du des et ou au aux pour ' +
    'dans sur der die das und oder mit von zu im am ein eine di il lo gli ed per su com do da os um uma ' +
    // a title or place word that needs the name after it ("…moved to St", "…met Mr")
    'mr mrs ms dr st mt prof capt sgt rev fr gen col lt'
  ).split(' '),
);
/** a complete label may end on these ("I miss her", "The house we lived in", "Life after") */
const MAY_END = new Set(
  'her it you in on about over there here after before since around then under more too'.split(' '),
);

/** Does an English phrase end on a word that needs a follower? */
function endsDangling(t: string, label: boolean): boolean {
  const last = tokens(t).at(-1)?.toLowerCase();
  if (last === undefined) return false;
  return DANGLING.has(last) && !(label && MAY_END.has(last));
}

/** An injected instruction is never a memory's name. */
const INSTRUCTION =
  /\b(?:ignore|disregard)\b[\s\S]*\b(?:rules?|instructions?|above|previous|prompt|system)\b|\bsystem prompt\b|\bas an ai\b/i;

/**
 * A model-written title, or null.
 *
 * TITLES MAY BE NEW WORDS. The body is held to "provable from what was said"
 * because it is the record; a title is a label that names it, and a label that
 * only reuses the speaker's own words ("I was born in 1941 in a small fishing
 * town on the south") is a sentence, not a name. But a title may not state a new
 * FACT, so beside SHAPE and LANGUAGE it is checked by `checkTitleFacts` against the
 * speaker's words (`source`): no number, name, relative or heavy fact ("prison",
 * "murdered", "secret") the speaker did not say.
 *
 *   - in the memory's script (Korean memory -> Hangul title; English -> Latin, no
 *     Hangul), so a title can never come back translated;
 *   - a plain phrase: no link syntax, no markup, no invisible characters, no
 *     trailing full stop, not ending mid-phrase ("Sundays at the"), within
 *     `TITLE_MAX`, and acceptable to `validateNoteTitle` (titles are spliced into
 *     other notes by rename cascades, so that validator is the law).
 *
 * `source` is optional for old callers; the pipeline always passes it.
 */
export function acceptTitle(raw: unknown, lang: Lang, source?: string): string | null {
  if (typeof raw !== 'string') return null;
  const t = stripInvisible(raw)
    .normalize('NFC')
    .replace(/[[\]#^|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim()
    // "Yes My father played the flute": an answer word glued to the real start
    .replace(/^(?:[Yy]es|[Yy]eah|[Ww]ell|[Ss]o|[Oo]h|[Oo]kay|[Rr]ight)[,.!]?\s+(?=\p{Lu})/u, '')
    .trim();
  if (t === '' || t.length > TITLE_MAX) return null;
  // a label, never an address: nobody's memory is titled with a link
  if (/https?:|www\.|\w@\w|\.(?:com|org|net|kr|io)\b/i.test(t)) return null;
  if (/[<>`*_~]/.test(t) || INSTRUCTION.test(t)) return null;
  const hangul = /[가-힣]/.test(t);
  if (lang === 'ko' ? !hangul : hangul || !/[A-Za-z]/.test(t)) return null;
  if (lang === 'en' && endsDangling(t, true)) return null;
  if (source !== undefined && !checkTitleFacts(t, source).ok) return null;
  return validateNoteTitle(t) === null ? t : null;
}

const LEAD_FILLER: Record<Lang, RegExp> = {
  en: /^(?:(?:um+|uh+|er+|ah+|hmm+|well|so|and|but|you know what|you know|like i said|as i said|i mean|the thing is|okay|oh)[,.]?\s+)+/i,
  ko: /^(?:(?:어+|음+|그|뭐|뭐냐|그\s뭐냐|아|아이고|저|저기|이제|그니까|그러니까|있잖아|근데)[,.…]?\s+)+/,
};

/** sentence-opening answer words: "Yes." "Well." "네." on their own say nothing to name a memory by */
const ACK = new Set(
  (
    'yes yeah yep yup no nope nah right well okay ok so oh sure mm mmm hmm uh um ah alright true exactly indeed ' +
    '네 예 응 어 음 아 아니요 아니오 아뇨 그렇죠 그럼요 그럼 그래요 그래 맞아요 맞아 그랬죠 그렇지 글쎄요 글쎄'
  ).split(' '),
);

/**
 * A period that does not end a sentence: "Mrs.", "St. Louis", "Ford Motor Co.", "the U.S. Army",
 * "5 a.m. every day" (a single Latin letter), and "No." before a number ("Room No. 12"; alone it
 * is the answer "No."). Read on the last characters of a piece only.
 */
const ABBREV_END =
  /(?:^|[^\p{L}])(?:mr|mrs|ms|dr|st|jr|sr|mt|vs|etc|co|inc|ltd|ave|rd|blvd|prof|gen|col|capt|lt|sgt|rev|fr|ft|[a-z])\.["”’')\]]*$/iu;

/** split into sentences, keeping each one's own punctuation; an abbreviation does not split */
const sentencesOf = (t: string): string[] => {
  const pieces = t.split(/(?<=[.!?。…]["”’')\]]*)\s+/);
  const out: string[] = [];
  let cur = '';
  pieces.forEach((piece, i) => {
    cur = cur === '' ? piece : `${cur} ${piece}`;
    const tail = piece.slice(-10);
    const next = pieces[i + 1];
    const goesOn =
      next !== undefined &&
      (ABBREV_END.test(tail) || (/(?:^|[^\p{L}])no\.$/iu.test(tail) && /^\d/.test(next)));
    if (!goesOn) {
      if (cur.trim() !== '') out.push(cur.trim());
      cur = '';
    }
  });
  return out;
};

/** sentences about the conversation, not the memory: "That is right." "Let me think." "사진 좀 줘 봐." */
const TALK_EN =
  /^(?:that(?:'s| is| was) (?:right|true|it|so|correct)|that is how it was|i remember(?: that| it)?|i (?:don't|do not|can't|cannot) (?:know|remember|recall|say)|i (?:don't |do not )?(?:think|guess|suppose|believe) so|i'm not sure|i am not sure|not that i (?:remember|recall|know of)|let me (?:think|see|remember)|let's see|where (?:do|shall|should|can) i (?:start|begin)|how (?:can|do|should|shall) i (?:explain|say|put) (?:it|this|that)|what can i say|you know what|who knows)$/i;
const TALK_KO =
  /^(?:맞아요|맞아|그렇죠|그렇지|기억나요|기억나|글쎄요|글쎄|뭐랄까|그러니까요|그러게요|그게요|저기요|있잖아요|있잖아|어디 보자|생각해 보니)$/;
/** a request to someone in the room ("그 사진 좀 줘 봐", "Pass me the photo") */
const REQUEST_IN_ROOM = /(?:줘|줘 ?봐|봐|봐요|주세요|줄래|줄래요)$|^(?:pass|hand|give|get) me\b/i;

/** a sentence of nothing but these says only "yes" or "no": "No, not at all." "아니요, 전혀요." */
const ANSWER_ONLY = new Set(
  (
    'yes yeah yep yup no nope nah not never at all really of course sure absolutely definitely ' +
    'certainly exactly indeed right okay ok well so oh maybe perhaps quite totally ever ' +
    '네 예 응 아니요 아니오 아뇨 아니 아니에요 아니예요 아닙니다 아니죠 전혀 전혀요 절대 절대로 절대요 ' +
    '물론 물론이죠 그럼 그럼요 당연하죠 당연히 정말 정말요 진짜 진짜요 아마 아마도 글쎄 글쎄요'
  ).split(' '),
);

const isAck = (sentence: string): boolean => {
  const ws = tokens(sentence);
  if (ws.length === 0) return false;
  if (ws.length <= 3 && ACK.has(ws[0]!.toLowerCase())) return true;
  // "No, not at all." is the answer, not what the memory is about (the title was «Not at all»)
  if (ws.length <= 5 && ws.every((w) => ANSWER_ONLY.has(w.toLowerCase()))) return true;
  const plain = sentence
    .replace(/[^\p{L}\p{N}'’\s]+/gu, ' ')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (TALK_EN.test(plain) || TALK_KO.test(plain)) return true;
  return ws.length <= 6 && REQUEST_IN_ROOM.test(plain);
};

/** Korean clause boundaries an eojeol can end on: 연결어미 or a comma (never the particle 에서) */
const KO_CLAUSE = /(?:는데|지만|니까|면서|며|고|(?<!에)서)[,.…]?$|,$/;
/** a word a Korean title may not stop on */
const KO_STRAY =
  /^(?:그|이|저|그런|이런|저런|그냥|좀|막|아주|너무|정말|참|또|그리고|그래서|그런데)$/;

/**
 * The title when the model offered none we can use, from the speaker's own words:
 *
 *   - leading fillers out, and leading answer words ("Yes." "Well." "네.") skipped when
 *     more follows;
 *   - the first sentence that says something (3+ words, 2+ in Korean), preferring a
 *     statement to a question, cut at its own end;
 *   - too long: cut at the last clause boundary that still leaves 4 words (a comma,
 *     "and", "but", "because"; in Korean a connective ending within 28 syllables),
 *     else at the last word boundary;
 *   - a CUT title never ends on a word that needs a follower ("…fishing town on the"),
 *     but a sentence that ended by itself is left whole ("I miss her").
 */
export function fallbackTitle(raw: unknown, lang: Lang): string {
  if (typeof raw !== 'string') return lang === 'ko' ? '기억' : 'A memory';
  // a link reads as its words ([[Title|words]] is "words"), as a reader sees it
  const text = shownText(raw.normalize('NFC'))
    .replace(/[[\]#^|<>`*_~]/g, ' ')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEAD_FILLER[lang], '');
  const all = sentencesOf(text);
  let i = 0;
  while (i < all.length - 1 && isAck(all[i]!)) i++;
  const rest = all.slice(i);
  const enough = (x: string): boolean =>
    lang === 'ko' ? tokens(x).filter((w) => /[가-힣]/.test(w)).length >= 2 : tokens(x).length >= 3;
  const isQuestion = (x: string): boolean => /\?["”’')\]]*$/.test(x);
  // a sentence in the memory's own language first: an English note is not titled in Korean
  const own = (x: string): boolean => (lang === 'ko' ? /[가-힣]/.test(x) : !/[가-힣]/.test(x));
  let t =
    rest.find((x) => enough(x) && own(x) && !isQuestion(x)) ??
    rest.find((x) => enough(x) && !isQuestion(x)) ??
    rest.find(enough) ??
    rest[0] ??
    text;
  // the sentence's own opening fillers and answer words ("And in the evenings…", "Right, I…")
  t = t.replace(LEAD_FILLER[lang], '');
  if (lang === 'en') {
    // ("No. 12 was our house" keeps its "No.": before a number it is a number sign)
    t = t.replace(
      /^(?:yes|yeah|no(?!\.\s*\d)|well|so|oh|okay|ok|right|sure)[,.!]?\s+(?=(?:\S+\s+){2}\S)/i,
      '',
    );
  }
  t = t.replace(/[\s.!?。…,;:'"’”)\]-]+$/, '').trim();

  let cut = false;
  if (lang === 'ko') {
    const words = t.split(' ');
    let syllables = 0;
    let lastWord = -1;
    let lastClause = -1;
    const weight = (w: string): number =>
      (w.match(/[가-힣]/g)?.length ?? 0) + (w.match(/[A-Za-z0-9]/g)?.length ?? 0) / HANGUL_WEIGHT;
    for (let k = 0; k < words.length; k++) {
      syllables += weight(words[k]!);
      if (syllables > TITLE_MAX_KO) break;
      lastWord = k;
      if (k >= 1 && KO_CLAUSE.test(words[k]!)) lastClause = k;
    }
    if (lastWord < words.length - 1) {
      cut = true;
      let kept = words.slice(0, (lastClause >= 1 ? lastClause : Math.max(lastWord, 0)) + 1);
      while (kept.length > 1 && KO_STRAY.test(kept.at(-1)!)) kept = kept.slice(0, -1);
      t = kept.join(' ');
    }
  } else if (t.length > TITLE_MAX) {
    cut = true;
    // a long sentence reads best cut where a clause ends ("My mother sold fish at the market"),
    // not wherever the character limit falls ("… and she came home after")
    const clause =
      /,|;|\s(?:and|but|so|because|when|while|after|before|until|which|where|though|although|since|y|e|o|pero|porque|et|mais|und|aber|ma|perché|mas)\s/gi;
    let best = -1;
    for (let m = clause.exec(t); m && m.index <= TITLE_MAX; m = clause.exec(t)) {
      if (tokens(t.slice(0, m.index)).length >= 4) best = m.index;
    }
    if (best > 0) {
      t = t.slice(0, best);
    } else {
      const slice = t.slice(0, TITLE_MAX + 1);
      const sp = slice.lastIndexOf(' ');
      t = sp > 12 ? slice.slice(0, sp) : t.slice(0, TITLE_MAX);
      // a cut that ends on a word needing a follower ("…to school every") is trimmed below and
      // reads whole; one that ends on a content word may be mid-phrase ("…town on the south",
      // "…every morning to carry"), and is cut back to before that phrase
      const prep = endsDangling(t, false)
        ? -1
        : t.search(
            /\s(?:in|on|at|of|from|with|for|by|to|behind|beside|near|under|over|into|through|than|de|en|con|para|à|dans|mit|von)\s[^\s]+(?:\s[^\s]+){0,2}$/i,
          );
      if (prep > 20) t = t.slice(0, prep);
    }
  }
  t = t.replace(/[\s,;:\-–—.]+$/, '').trim();
  // a cut phrase never ends on a word that needs a follower ("…fishing town on the")
  if (cut && lang === 'en') {
    while (tokens(t).length > 1 && endsDangling(t, false)) {
      t = t.replace(/\s*\S+$/, '').replace(/[\s,;:\-–—]+$/, '');
    }
  }
  if (lang === 'en' && t !== '') t = t[0]!.toUpperCase() + t.slice(1);
  if (t.length > TITLE_MAX) t = t.slice(0, TITLE_MAX).trimEnd();
  if (/[\p{L}\p{N}]/u.test(t) && validateNoteTitle(t) === null) return t;
  // never an empty title (nor one of punctuation or an invisible character): the text's own first
  // words, and a plain label when it has none
  const words = (text.match(TOKEN) ?? []).slice(0, 8).join(' ').slice(0, TITLE_MAX).trim();
  if (words !== '' && validateNoteTitle(words) === null) {
    return lang === 'en' ? words[0]!.toUpperCase() + words.slice(1) : words;
  }
  return lang === 'ko' ? '기억' : 'A memory';
}
