import { toSeconds } from './clock';
import { ANSWERS, ASKER_LABEL, baseLabel, safeSpeakerId } from './speaker-ids';
import { TranscriptError } from './transcript-error';

/**
 * Raw readers: one function per transcript FORMAT, each turning text or JSON into
 * the same loose list of segments. Nothing here cleans, merges or judges. That is
 * `transcript.ts`'s job, so a new format is one function here and one test.
 *
 * The formats that actually arrive from a speech-to-text box:
 *
 *   JSON      WhisperX, faster-whisper, OpenAI `verbose_json` (`segments`),
 *             whisper.cpp (`transcription` with ms offsets), HF pipelines (`chunks`),
 *             AssemblyAI / Deepgram style (`utterances`, `words`), Rev.ai (`monologues`),
 *             Speechmatics (`results` of words)
 *   SRT/VTT   WhisperX writes `[SPEAKER_00]: text` inside each cue; `<v Name>` voice tags
 *   labelled  `Interviewer: …`, `[SPEAKER_01]: …`, `[화자1] …`, `Speaker 1 (0:05): …`,
 *             `Zoë (Noah's grandma): …`, `Kim, Sunja: …`, `Q. …` / `A. …`, `[할머니] …`
 *   headers   Otter / Rev / Teams `Speaker 1  0:05`, Zoom `[Speaker 1] 00:00:05`: a line, then the words
 *   stamped   `[00:12] text` with no speakers
 *   plain     one turn per line
 *
 * Text arrives here already PREPARED (`prepareText` in transcript.ts): one kind of line
 * break, no control or invisible characters, NFC, ASCII brackets and colons, and runs of
 * blanks squeezed to one space. So the patterns below can use a single optional space where
 * a raw reader would need `\s*`, which is what keeps every one of them linear: no pattern
 * here has two unbounded quantifiers that can share characters.
 */

export type RawFormat =
  | 'segments-json'
  | 'subtitles'
  | 'labelled-text'
  | 'header-text'
  | 'timestamped-text'
  | 'plain-text';

export interface RawSeg {
  /** null = the source did not say who spoke */
  speaker: string | null;
  start: number | null;
  end: number | null;
  text: string;
}

/** What a reader did that the person should hear about. Counts only, never words. */
export interface ReaderNotices {
  /** lines of speech before the first speaker label, kept with no speaker (UNKNOWN) */
  unlabelledStart?: number;
  /**
   * lines left out: above the first speaker turn, a title, header fields (Date:, 제목:, From:),
   * an e-mail's attribution, a date or duration line, Otter's summary blocks; anywhere, a
   * transcriber's "Note: …"; text before the first cue; Otter's closing "Transcribed by" line
   */
  linesDropped?: number;
}

export interface RawParse {
  format: RawFormat;
  segs: RawSeg[];
  /** speaker id the SENDER says is the interviewee (a JSON file's "interviewee") */
  interviewee?: string;
  /**
   * The speaker a header above the turns names as the interviewee ("Interviewee: Sunja Kim"),
   * as written in the turns: a hint for the roles, not the sender's choice.
   */
  intervieweeHint?: string;
  /** the reader saw labels it could not make sense of: the role guess must ask */
  labelsUnclear?: boolean;
  notices?: ReaderNotices;
}

/* ── speaker labels ──────────────────────────────────────────────────── */

const TS = String.raw`\d{1,2}(?::\d{2}){1,2}(?:[.,]\d{1,3})?`;
const TSRANGE = String.raw`(${TS})(?: ?(?:-->|->|–|—|-|to) ?(${TS}))?`;
const TS_FULL = new RegExp(String.raw`^${TS}$`);

// Labels we trust even without a colon after them (inside brackets).
const STRICT =
  String.raw`(?:SPEAKER[_ -]?\d{1,3}|Speaker[_ -]?\d{1,3}|speaker[_ -]?\d{1,3}|SPK[_ -]?\d{1,3}|` +
  // how transcription tools name a voice they could not identify: "Voice 3", "Person 2", "Participant 4"
  String.raw`(?:[Vv]oice|VOICE|[Pp]erson|PERSON|[Pp]articipant|PARTICIPANT|[Gg]uest|GUEST)[_ -]?\d{1,3}|` +
  String.raw`화자 ?\d{1,3}|발화자 ?\d{1,3}|참석자 ?\d{1,3}|Interviewer|Interviewee|Host|Guest|Moderator|` +
  String.raw`Narrator|면접관|인터뷰어|인터뷰이|진행자|질문자|응답자|Q|A)`;
const STRICT_FULL = new RegExp(`^${STRICT}$`);
/** the same, in any case: "[INTERVIEWER]" is a speaker, never a sound note */
export const STRICT_LABEL_ANY_CASE = new RegExp(`^${STRICT}$`, 'i');

// A word of a name, in any script: letters, marks (accents), digits, ' ’ . - _
const W = String.raw`[\p{L}\p{M}\p{N}_'’.\-]`;
// A name or a role of up to four words ("Grandma", "Zoë Park", "김 선생님", "Mary Ann de Souza")
const NAME = String.raw`\p{L}${W}{0,23}(?: ${W}{1,24}){0,3}`;
// "Kim, Sunja": family name, comma, given name, both capitalised (or in a script without case)
const COMMA_NAME = String.raw`[\p{Lu}\p{Lt}\p{Lo}]${W}{0,23}, [\p{Lu}\p{Lt}\p{Lo}]${W}{0,23}`;
// "Interviewer (Noah)", "Anna Lee (she/her)": a short note in brackets after the name, never
// a time ("Grandma (00:09):" is Grandma at nine seconds)
const QUALIFIER = String.raw` \((?!\d)[^()\n]{1,40}\)`;
const NAME_FULL = new RegExp(`^(?:${NAME}|${COMMA_NAME})(?:${QUALIFIER})?$`, 'u');

/** Sounds a recogniser writes in brackets: never a speaker, and removed from the words. */
export const ANNOTATION_WORDS =
  'music|music playing|soft music|applause|laughter|laughs?|laughing|chuckles?|chuckling|giggles?|' +
  'noise|background noise|static|silence|long pause|pauses?|inaudible|unintelligible|indistinct|' +
  'unclear|crosstalk|cross talk|overlapping(?: speech)?|cough(?:s|ing)?|sigh(?:s|ing)?|sniff(?:s|ing)?|' +
  'breathing|crying|cries|sobbing|sobs|singing|clapping|beep|ringing|phone ringing|blank[_ ]audio|' +
  'no speech|no audio|background[^)\\]\\n]{0,20}|foreign language|speaking (?:in )?(?:korean|english)';
export const KOREAN_SOUND_WORDS =
  '웃음|웃음소리|박수|음악|기침|한숨|침묵|잡음|울음|흐느낌|정적|소음|알아들을 수 없음|불명확';
const SOUND_NOTE = new RegExp(`^(?:${ANNOTATION_WORDS}|${KOREAN_SOUND_WORDS})$`, 'i');

// A sentence that merely contains a colon ("He said: no.", "My father: he…") is not a speaker label.
const STOP_FIRST =
  /^(?:I|He|She|We|They|It|You|The|This|That|There|These|Those|And|But|So|Then|When|What|Why|How|Where|Who|Which|If|As|Or|Because|Well|Yes|No|Okay|OK|Oh|My|Our|His|Her|Their|Your|Its|At|In|On|By|For|From|To|With|After|Before|Once|Now|Later|Also|First|Second|Third|Next|Last|Finally|Anyway|Note|NB|Date|Time|Title|Re|Subject|Location|Place|Topic|PS|P\.S\.)$/i;
// "Grandma said: eat first." is prose
const SAYS =
  / (?:said|says|asked|asks|told|tells|replied|replies|answered|wrote|writes|shouted|yelled|whispered|added|explained|thought|remembered|recalled|used to say|would say|always said)$/i;
const SAYS_KO =
  /(?:말했다|말했어요|말씀하셨다|말씀하셨어요|하셨다|했다|그랬다|그러셨다|물었다|대답했다|외쳤다)$/u;

/** a transcriber's or editor's note on its own line: dropped, never attached to testimony */
const NOTE_LINE =
  /^[[(]?(?:note|nb|n\.b\.|editor'?s note|transcriber'?s note|translator'?s note|interviewer'?s note|편집자 ?주|녹취자 ?주|역자 ?주) ?:/i;

export interface Labelled {
  label: string;
  start: number | null;
  end: number | null;
  text: string;
  /** a speaker id format we trust anywhere (SPEAKER_00, 화자1, Interviewer, Q…) */
  strict: boolean;
}

/** Document-level reading modes, decided by `parseLabelled` before it reads any line. */
export interface LabelModes {
  /** "Q. …" / "A. …" lines: only when both recur */
  qa?: boolean;
  /** "[할머니] …" with no colon: only when a few such names start many lines */
  bracket?: boolean;
  /** header keys this document uses as speaker labels ("subject"), lower-cased */
  allow?: Set<string>;
}

const tidyLabel = (s: string): string => s.trim().replace(/\s+/g, ' ');
/** a label as an id: tidy, and never one of our own ids or an Object.prototype name */
const asId = (s: string): string => safeSpeakerId(tidyLabel(s));

function notALabel(label: string): boolean {
  const words = baseLabel(label).split(' ');
  return (
    STOP_FIRST.test(words[0]!) && (words.length === 1 || /^[\p{Ll}\p{N}]/u.test(words[1] ?? ''))
  );
}

/** Would this name-like text be a speaker label, given the words after the colon? */
function nameLabelOk(label: string, after: string): boolean {
  if (label.length > 40 || !NAME_FULL.test(label)) return false;
  if (notALabel(label) || SOUND_NOTE.test(label)) return false;
  const base = baseLabel(label);
  if (SAYS.test(base) || SAYS_KO.test(base)) return false;
  // "At 5:30 we walked": a time of day, not "At 5" speaking
  if (/\p{N}$/u.test(base) && /^\p{N}/u.test(after)) return false;
  // "https://…"
  return !after.startsWith('//');
}

/** Does this label look like a person's name or role, rather than the start of a sentence? */
function looksLikeName(label: string): boolean {
  const base = baseLabel(label);
  // "Rule 1", "Step 2" are not names; "Mom2", "P1" (one word) are
  if (/\p{N}$/u.test(base) && !DIGIT_NAME.test(base)) return false;
  const words = base.split(' ');
  // "Rule one", "my father"; but "Mary Ann de Souza", "Ludwig van Beethoven"
  const last = words.length - 1;
  if (words.some((w, i) => /^\p{Ll}/u.test(w) && !(i > 0 && i < last && PARTICLE.test(w)))) {
    return false;
  }
  // A script without capitals: a name is one or two words, a phrase is longer. A word without
  // capitals among capitalised ones counts too ("ZQ12 어디서 태어나셨어요 김" is a sentence).
  return isCased(base) || words.length <= 2;
}

/** a one-word name that ends in a number: "Mom2", "P1" */
const DIGIT_NAME = /^\p{Lu}\p{L}{0,15}\p{N}{1,2}$/u;
/** the small words inside a family name */
const PARTICLE =
  /^(?:de|da|das|do|dos|du|del|della|der|den|des|di|van|von|la|le|bin|binti|ibn|al|el|ten|ter|zu|y)$/;

/** every word of the label is written in a script with capitals ("Noah Kim", not "할머니") */
const isCased = (label: string): boolean =>
  label.split(' ').every((w) => /[\p{Lu}\p{Ll}]/u.test(w));

// a time before the label: "[00:12] Grandma:", "[00:12]Grandma:", "00:12 Grandma:"
const LEAD_TS = new RegExp(String.raw`^(?:[[(] ?${TSRANGE} ?[\])] ?|${TSRANGE} )`);
// "[Zoë (Noah's grandma)] …": a name in square brackets may carry its own note in round ones
const BRACKET_SQUARE = /^\[ ?([^[\]\n]{1,60}?) ?\]( ?:)? ?(.*)$/;
const BRACKET_ROUND = /^\( ?([^()\n]{1,40}?) ?\)( ?:)? ?(.*)$/;
const ZOOM_TS = new RegExp(String.raw`^(${TS})(?: (.*))?$`);
const QA = /^(Q|A|문|답)[.)] (.*)$/;
const BARE_STRICT = new RegExp(String.raw`^(${STRICT})(?: ?[[(] ?${TSRANGE} ?[\])])? ?: ?(.*)$`);
const BARE_TIMED = new RegExp(String.raw`^(${NAME}) (${TS}) ?: ?(.*)$`, 'u');
const BARE_NAME = new RegExp(
  String.raw`^((?:${NAME}|${COMMA_NAME})(?:${QUALIFIER})?)(?: ?[[(] ?${TSRANGE} ?[\])])? ?: ?(.*)$`,
  'u',
);

/**
 * If a line starts with a speaker label, split it off:
 *   `[SPEAKER_01]: text`   `SPEAKER_00 [01:02 - 01:10]: text`   `[00:12] 김순자: text`
 *   `[화자1] text`         `Speaker 1 (0:05): text`             `00:05 Grandma: text`
 *   `Zoë (grandma): text`  `Kim, Sunja: text`                   `Speaker 1 00:05: text`
 * plus, in the modes a whole document switched on, `Q. text` and `[할머니] text`.
 * The line must already be prepared (see the file comment).
 */
export function splitLabel(line: string, modes: LabelModes = {}): Labelled | null {
  let rest = line.trim();
  let start: number | null = null;
  let end: number | null = null;

  const lead = LEAD_TS.exec(rest);
  if (lead) {
    start = toSeconds(lead[1] ?? lead[3]);
    end = toSeconds(lead[2] ?? lead[4]);
    rest = rest.slice(lead[0].length);
  }

  // bracketed: [SPEAKER_01]: text  |  [화자1] text  |  (Speaker 1) text  |  [Grandma]: text
  if (rest.startsWith('[') || rest.startsWith('(')) {
    const br = (rest.startsWith('[') ? BRACKET_SQUARE : BRACKET_ROUND).exec(rest);
    if (!br) return null;
    const token = tidyLabel(br[1]!);
    const hasColon = br[2] !== undefined;
    const after = br[3] ?? '';
    if (STRICT_FULL.test(token))
      return { label: asId(token), start, end, text: after, strict: true };
    if (SOUND_NOTE.test(token) || TS_FULL.test(token) || !nameLabelOk(token, after)) return null;
    // Zoom's own text export: `[Grandma Sunja] 00:00:12 words`. A bracketed name is trusted
    // when a time follows it directly; the caller still needs the pattern to repeat.
    const stamped = !hasColon && rest.startsWith('[') ? ZOOM_TS.exec(after) : null;
    if (stamped) {
      return {
        label: asId(token),
        start: start ?? toSeconds(stamped[1]),
        end,
        text: stamped[2] ?? '',
        strict: false,
      };
    }
    if (hasColon || (modes.bracket && rest.startsWith('['))) {
      return { label: asId(token), start, end, text: after, strict: false };
    }
    return null;
  }

  if (modes.qa) {
    const qa = QA.exec(rest);
    if (qa) return { label: qa[1]!, start, end, text: qa[2] ?? '', strict: true };
  }

  // bare, colon required: SPEAKER_00 [01:02 - 01:10]: text  |  Grandma (0:05): text  |  Grandma: text
  const strict = BARE_STRICT.exec(rest);
  if (strict) {
    return {
      label: asId(strict[1]!),
      start: start ?? toSeconds(strict[2]),
      end: end ?? toSeconds(strict[3]),
      text: strict[4] ?? '',
      strict: true,
    };
  }
  // "Speaker 1 00:05: text": the time sits between the name and the colon
  const timed = BARE_TIMED.exec(rest);
  if (timed && nameLabelOk(tidyLabel(timed[1]!), timed[3] ?? '')) {
    return {
      label: asId(timed[1]!),
      start: start ?? toSeconds(timed[2]),
      end,
      text: timed[3] ?? '',
      strict: false,
    };
  }
  const bare = BARE_NAME.exec(rest);
  if (bare) {
    const label = tidyLabel(bare[1]!);
    const allowed = modes.allow?.has(label.toLowerCase()) === true && NAME_FULL.test(label);
    if (!allowed && !nameLabelOk(label, bare[4] ?? '')) return null;
    return {
      label: asId(label),
      start: start ?? toSeconds(bare[2]),
      end: end ?? toSeconds(bare[3]),
      text: bare[4] ?? '',
      strict: false,
    };
  }
  return null;
}

/* ── labels inside a line: the speakers that recur ───────────────────── */

/*
 * A paste that lost its line breaks ("Interviewer: Where were you born? Grandma: In Busan.
 * Interviewer: …") and a subtitle cue holding two speakers ("[Host]: … [할머니]: …") have the
 * same problem: where does a turn start? Taking the first label-shaped words a pattern finds
 * does not work. "Very poor. Interviewer:" would be one four-word "label", and the real one
 * after it is never looked at again, so the interviewer's question lands inside the relative's
 * answer. So the labels are decided for the WHOLE text first, from every way the words before
 * each ": " could be a label; then the text is cut before every occurrence of those labels.
 */

/** A period that does not end a sentence: "Mrs. Kim", "Dr. J. Park", "St. Mary", "Robert Jr." */
const ABBREVIATION =
  /^(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Rev|Fr|Capt|Col|Gen|Sgt|Lt|Hon|Mme|Mlle|Messrs|\p{Lu})\.$/u;

/** "Very poor. Interviewer" and "Yes. Grandma" are a sentence end and a label, never one label. */
function wordsHold(label: string): boolean {
  const words = baseLabel(label).split(' ');
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i]!;
    if (/[.!?…。;?]$/.test(w) && !ABBREVIATION.test(w)) return false;
    // a comma only in "Kim, Sunja"
    if (w.endsWith(',') && !(i === 0 && words.length === 2)) return false;
  }
  return true;
}

/**
 * What comes just before a label: how sure we can be that a turn starts there. 'hangul': a
 * Korean word, as speech-to-text ends a Korean question (with no "?"). 'label': the colon of
 * another label, so this one is the first word of that turn, never a turn of its own.
 */
type Boundary = 'start' | 'question' | 'sentence' | 'hangul' | 'space' | 'label';

interface Candidate {
  /** where the label starts (where the turn would start) */
  at: number;
  label: string;
  /** compared in any case: "grandma:" is "Grandma:" */
  key: string;
  words: number;
  bracketed: boolean;
  strict: boolean;
  boundary: Boundary;
  /** one plain lower-case word ("noah:"): a label only where such words take turns */
  weak: boolean;
}

/** The labels that could end at one colon (or at the "]" of a bracketed id), shortest first. */
type Slot = Candidate[];

const CLOSERS = new Set(['"', '”', '’', "'", ')', ']']);
const SENTENCE_ENDS = new Set(['.', '!', '…', '。']);

function boundaryAt(text: string, at: number): Boundary {
  if (at === 0 || text[at - 1] === '\n') return 'start';
  // right after another label's colon: "Grandma: Mina: the baker." is Grandma's turn
  if (text[at - 2] === ':') return 'label';
  let i = at - 2; // text[at - 1] is the space before the label
  while (i >= 0 && CLOSERS.has(text[i]!)) i--;
  const c = text[i];
  if (c === '?' || c === '？') return 'question';
  if (c !== undefined && SENTENCE_ENDS.has(c)) return 'sentence';
  if (c !== undefined && /\p{Script=Hangul}/u.test(c)) return 'hangul';
  return 'space';
}

/**
 * A time just before a label belongs to it: "[00:12] Grandma:", "00:12 Grandma:". Only a
 * whole one: in "[inaudible 00:12:33] Grandma:" the time is the end of a sound note.
 */
const TIME_BEFORE =
  /(?:^|[\s\n])(?:\[\d{1,2}(?::\d{2}){1,2}(?:[.,]\d{1,3})?\]|\d{1,2}(?::\d{2}){1,2}(?:[.,]\d{1,3})?) $/;

/** "noah:" in a speech-to-text paste in lower case: one plain word, never a speech verb */
const WEAK_LABEL = /^\p{Ll}[\p{Ll}\p{M}'’-]{1,23}$/u;
const WEAK_STOP =
  /^(?:said|says|asked|asks|told|tells|replied|replies|answered|answers|wrote|writes|shouted|yelled|whispered|added|explained|thought|remembered|recalled|meaning|means|namely|example|e\.g|i\.e|etc)$/;

/** Every way the words just before position `end` (a colon, or a bracket) could be a label. */
function slotAt(text: string, end: number, bracketOnly: boolean): Slot {
  const out: Slot = [];
  const from = Math.max(0, end - 90);
  const back = text.slice(from, end);
  const after = text.slice(end + 2, end + 5);
  const separated = (j: number) =>
    j > 0
      ? back[j - 1] === ' ' || back[j - 1] === '\n'
      : from === 0 || /[ \n]/.test(text[from - 1]!);
  const push = (j: number, label: string, bracketed: boolean) => {
    const strict = STRICT_FULL.test(label);
    if (bracketOnly && !(bracketed && strict)) return;
    const named =
      strict ||
      (nameLabelOk(label, after) && looksLikeName(label) && (bracketed || wordsHold(label)));
    const weak =
      !named &&
      !bracketed &&
      WEAK_LABEL.test(label) &&
      !WEAK_STOP.test(label) &&
      nameLabelOk(label, after);
    if (!named && !weak) return;
    const at = from + j;
    const boundary = boundaryAt(text, at);
    if (boundary === 'label') return;
    out.push({
      at,
      label,
      // a weak label is its own key: "grandma:" in her sentence never cuts at "Grandma"
      key: weak ? `~${label.toLowerCase()}` : label.toLowerCase(),
      words: label.split(' ').length,
      bracketed,
      strict,
      boundary,
      weak,
    });
  };

  // [SPEAKER_00]: / [Grandma]: / [화자1] (a strict id needs no colon)
  if (back.endsWith(']')) {
    const open = back.lastIndexOf('[');
    if (open >= 0 && separated(open) && back.length - open <= 62) {
      push(open, tidyLabel(back.slice(open + 1, -1)), true);
    }
    return out;
  }
  if (bracketOnly) return out;

  // "Zoë (Noah's grandma):" carries its note; "Grandma (00:09):" its time, which is not the name
  let nameEnd = back.length;
  let note = '';
  if (back.endsWith(')')) {
    const open = back.lastIndexOf('(');
    if (open < 1 || back[open - 1] !== ' ' || back.length - open > 45) return out;
    const inner = back.slice(open + 1, -1);
    if (!/^\d/.test(inner)) note = back.slice(open - 1);
    nameEnd = open - 1;
  }
  // one to four words before the colon, each a candidate of its own
  let i = nameEnd;
  for (let words = 0; words < 4 && i > 0; words++) {
    let j = i;
    while (j > 0 && back[j - 1] !== ' ' && back[j - 1] !== '\n') j--;
    if (j === i || !separated(j)) break;
    push(j, back.slice(j, nameEnd) + note, false);
    if (j === 0 || back[j - 1] === '\n') break;
    i = j - 1;
  }
  return out;
}

/** Every colon followed by a space (and every "] " of a bracketed id) that could close a label. */
function slotsOf(text: string): Slot[] {
  const slots: Slot[] = [];
  for (let i = text.indexOf(':'); i >= 0; i = text.indexOf(':', i + 1)) {
    const next = text[i + 1];
    if (next !== ' ' && next !== '\n' && next !== undefined) continue;
    const s = slotAt(text, i, false);
    if (s.length > 0) slots.push(s);
  }
  // "[화자1] 어디서 … [화자2] 부산이요": a strict id in brackets needs no colon
  for (let i = text.indexOf('] '); i >= 0; i = text.indexOf('] ', i + 1)) {
    const s = slotAt(text, i + 1, true);
    if (s.length > 0) slots.push(s);
  }
  return slots;
}

/**
 * The labels a text cuts at, decided once for all of it. `firm`: labels that start a line (of
 * the text, or of a cue), a name in brackets with a colon ("[Grandma]:"), a speaker id in
 * brackets; and, in a paste that lost its line breaks, every label used twice or more, and
 * lower-case words that take turns ("noah: … grandma: … noah: …"). `once`: names used once
 * that may start a turn, but only on a line that lost its breaks (it already holds two firm
 * turns): "…born? Grandma: In Busan.", a name once after a Korean question with no "?", a
 * one-word Korean name. In a file whose labels start its lines, a colon inside a sentence
 * ("…생선을 파셨어요: 힘들다고…", "Why did we leave? Hunger: that was the reason") is never a
 * speaker. In a script without capitals a longer label is dropped when the shorter one inside
 * it is also used on its own: "태어나셨어요 할머니" twice and "할머니" alone three more times
 * means the label is "할머니" and the other word ends the question. (Capitals already tell
 * "Noah Kim" and "Sunja Kim" from a sentence, and a family shares its last name, so those are
 * never pruned.)
 */
interface LabelSets {
  firm: Set<string>;
  once: Set<string>;
}

function labelSetOf(slots: Slot[]): LabelSets {
  const count = new Map<string, number>();
  for (const slot of slots) {
    for (const c of slot) if (!c.weak) count.set(c.key, (count.get(c.key) ?? 0) + 1);
  }
  const firm = new Set<string>();
  for (const slot of slots) {
    for (const c of slot) if (!c.weak && (c.boundary === 'start' || c.bracketed)) firm.add(c.key);
  }
  // Labels start the lines: a labelled file, whose mid-line colons are sentences. Paragraphs
  // that each start with a label but hold several turns are a paste that lost its line breaks:
  // there the recurring labels sit mostly in mid-line.
  const startKeys = new Set<string>();
  let startHits = 0;
  let midHits = 0;
  for (const slot of slots) {
    const start = slot.find((c) => c.boundary === 'start' && !c.weak);
    if (start) {
      startKeys.add(start.key);
      startHits++;
    } else if (slot.some((c) => (count.get(c.key) ?? 0) >= 2)) {
      midHits++;
    }
  }
  const labelled = startKeys.size >= 2 && midHits < startHits;
  if (!labelled) {
    for (const [key, n] of count) if (n >= 2) firm.add(key);
    for (const key of turnTakers(slots)) firm.add(key);
  }
  const once = new Set<string>();
  if (!labelled && firm.size > 0) {
    for (const slot of slots) {
      for (const c of slot) {
        if (c.weak || firm.has(c.key)) continue;
        // Once, in a script without capitals, only the one-word label is safe: "어땠어요
        // 외할머니" is the end of the question and a name, and nothing says which.
        if (!isCased(c.label) && c.words > 1) continue;
        if (c.boundary === 'question' || c.boundary === 'hangul') once.add(c.key);
        else if (c.words === 1 && /^[\p{Script=Hangul}]+$/u.test(c.label)) once.add(c.key);
      }
    }
  }
  // how often each label is extended by a longer label of the set at the same colon
  const extended = new Map<string, number>();
  const inSet = (k: string) => firm.has(k) || once.has(k);
  for (const slot of slots) {
    for (const c of slot) {
      if (c.words < 2 || !inSet(c.key)) continue;
      const inner = c.key.slice(c.key.indexOf(' ') + 1);
      extended.set(inner, (extended.get(inner) ?? 0) + 1);
    }
  }
  for (const slot of slots) {
    for (const c of slot) {
      if (c.words < 2 || !inSet(c.key) || isCased(c.label)) continue;
      const inner = c.key.slice(c.key.indexOf(' ') + 1);
      const alone = (count.get(inner) ?? 0) - (extended.get(inner) ?? 0);
      if (inSet(inner) && alone > 0) {
        firm.delete(c.key);
        once.delete(c.key);
      }
    }
  }
  return { firm, once };
}

/**
 * "noah: where were you born grandma: in busan noah: …", a speech-to-text paste in lower case:
 * its one-word labels count only when two of them or more, each used twice or more, take
 * turns (a speaker seldom follows himself), so "my rule: … another rule: …" is never cut.
 */
function turnTakers(slots: Slot[]): string[] {
  const n = new Map<string, number>();
  for (const slot of slots) for (const c of slot) if (c.weak) n.set(c.key, (n.get(c.key) ?? 0) + 1);
  const order: string[] = [];
  for (const slot of slots) {
    const c = slot.find((x) => x.weak && (n.get(x.key) ?? 0) >= 2);
    if (c) order.push(c.key);
  }
  const keys = new Set(order);
  let changes = 0;
  for (let i = 1; i < order.length; i++) if (order[i] !== order[i - 1]) changes++;
  const alternate = changes * 3 >= (order.length - 1) * 2;
  return keys.size >= 2 && order.length >= 4 && alternate ? [...keys] : [];
}

/** The turn starts of one line: firm labels, plus once-used names if the line lost its breaks. */
function lineStarts(
  line: string,
  slots: Slot[],
  sets: LabelSets,
): Array<{ at: number; key: string }> {
  const firm = turnStarts(line, slots, sets.firm);
  if (firm.length < 2 || sets.once.size === 0) return firm;
  return turnStarts(line, slots, new Set([...sets.firm, ...sets.once]));
}

/** Where a turn starts, in order: before the longest label of the set at each slot. */
function turnStarts(
  text: string,
  slots: Slot[],
  set: Set<string>,
): Array<{ at: number; key: string }> {
  const starts: Array<{ at: number; key: string }> = [];
  for (const slot of slots) {
    let best: Candidate | null = null;
    for (const c of slot) if (set.has(c.key) && (!best || c.words > best.words)) best = c;
    if (!best) continue;
    let at = best.at;
    const time = TIME_BEFORE.exec(text.slice(Math.max(0, at - 20), at));
    if (time) at -= time[0].length - (/^[\s\n]/.test(time[0]) ? 1 : 0);
    starts.push({ at, key: best.key });
  }
  return starts.sort((a, b) => a.at - b.at);
}

/**
 * "Interviewer: Where were you born? Grandma: In Busan. Interviewer: And then? Grandma: …"
 * on ONE line: put each turn back on its own line. Only lines that hold two labels or more are
 * cut (a transcript with one turn per line is left as it is), and only at labels of the set
 * above, so a colon in somebody's sentence ("He said: go") never splits it. Linear: every
 * colon looks back at most 90 characters.
 */
export function splitRunOnLabels(text: string): string {
  const slots = slotsOf(text);
  if (slots.length < 3) return text;
  const sets = labelSetOf(slots);
  if (sets.firm.size === 0) return text;
  // the slots of each line, in order (a slot lies in the line its candidates start in)
  slots.sort((a, b) => a[0]!.at - b[0]!.at);
  const perLine: Array<{ from: number; slots: Slot[] }> = [];
  let k = 0;
  for (let lineStart = 0; lineStart <= text.length;) {
    const lineEnd = text.indexOf('\n', lineStart);
    const stop = lineEnd < 0 ? text.length : lineEnd;
    const mine: Slot[] = [];
    while (k < slots.length && slots[k]![0]!.at < stop) mine.push(slots[k++]!);
    if (mine.length > 0) perLine.push({ from: lineStart, slots: mine });
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  // cut only the lines that hold two turns or more
  const cuts: number[] = [];
  const keys = new Set<string>();
  let total = 0;
  for (const { from, slots: mine } of perLine) {
    const starts = lineStarts(text, mine, sets);
    total += starts.length;
    for (const s of starts) keys.add(s.key);
    if (starts.length >= 2) for (const s of starts) if (s.at > from) cuts.push(s.at);
  }
  if (cuts.length === 0 || total < 3 || keys.size < 2) return text;
  let out = '';
  let from = 0;
  for (const at of cuts) {
    out += `${text.slice(from, at).replace(/ $/, '')}\n`; // the space before the label becomes the line break
    from = at;
  }
  return out + text.slice(from);
}

/* ── JSON ────────────────────────────────────────────────────────────── */

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * A speaker as the sender wrote it, as an id: a number (or a string of digits) is
 * `SPEAKER_nn`, as WhisperX writes it; any other string is tidied. The same rule reads the
 * `interviewee` the sender named, so `"interviewee": 0` finds the speaker written `0`.
 */
export function normalizeSpeakerId(v: unknown): string | null {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(Math.trunc(v)) || v < 0) return null;
    return `SPEAKER_${String(Math.trunc(v)).padStart(2, '0')}`;
  }
  if (typeof v !== 'string') return null;
  // no control or invisible characters in an id
  const s = tidyLabel(v.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2060\uFEFF]/g, ''));
  if (s === '') return null;
  if (/^\d{1,3}$/.test(s)) return `SPEAKER_${s.padStart(2, '0')}`;
  return safeSpeakerId(s.slice(0, 100));
}

/**
 * Where the turns are in a JSON transcript. Sentence-level lists come first (WhisperX
 * `segments` has the sentences AND a flat `word_segments`: the sentences win, or every
 * word would be said twice). A word-level list is the fallback: WhisperX `word_segments`,
 * AssemblyAI's top-level `words`, Deepgram's `results.channels[0].alternatives[0].words`.
 */
function segmentList(value: unknown): { list: unknown[]; words: boolean } | null {
  if (Array.isArray(value)) return { list: value, words: false };
  const o = asRecord(value);
  if (!o) return null;
  const results = asRecord(o.results);
  for (const c of [o.segments, o.utterances, o.transcription, o.chunks, results?.utterances]) {
    if (Array.isArray(c) && c.length > 0) return { list: c, words: false };
  }
  const channels = Array.isArray(results?.channels) ? (results.channels as unknown[]) : [];
  const alt = Array.isArray(asRecord(channels[0])?.alternatives)
    ? asRecord((asRecord(channels[0])!.alternatives as unknown[])[0])
    : null;
  for (const c of [o.word_segments, o.words, alt?.words]) {
    if (Array.isArray(c) && c.length > 0) return { list: c, words: true };
  }
  return null;
}

function speakerOf(o: Record<string, unknown>): string | null {
  return normalizeSpeakerId(
    o.speaker ?? o.speaker_id ?? o.speakerId ?? o.speaker_label ?? o.speakerLabel ?? o.spk,
  );
}

function textOf(o: Record<string, unknown>): string | null {
  if (typeof o.text === 'string') return o.text;
  if (typeof o.transcript === 'string') return o.transcript;
  if (typeof o.content === 'string') return o.content;
  if (Array.isArray(o.words)) {
    const words = o.words
      .map((w) => {
        const r = asRecord(w);
        const t = r?.word ?? r?.text;
        return typeof t === 'string' ? t.trim() : '';
      })
      .filter((w) => w !== '');
    if (words.length > 0) return words.join(' ');
  }
  return null;
}

/**
 * Seconds, whatever the producer used: `start`/`end` (s), `offsets.from/to` (ms),
 * `timestamps.from/to` ("00:00:04,600"), `timestamp: [s, e]`, `start_time`/`end_time`.
 * Bare integers that only make sense as milliseconds are scaled by the caller.
 */
function timesOf(o: Record<string, unknown>): { start: number | null; end: number | null } {
  const off = asRecord(o.offsets);
  if (off && typeof off.from === 'number') {
    return {
      start: toSeconds(off.from / 1000),
      end: typeof off.to === 'number' ? toSeconds(off.to / 1000) : null,
    };
  }
  const ts = asRecord(o.timestamps);
  if (ts && (typeof ts.from === 'string' || typeof ts.to === 'string')) {
    return { start: toSeconds(ts.from), end: toSeconds(ts.to) };
  }
  if (Array.isArray(o.timestamp)) {
    return { start: toSeconds(o.timestamp[0]), end: toSeconds(o.timestamp[1]) };
  }
  return {
    start: toSeconds(o.start ?? o.start_time ?? o.startTime),
    end: toSeconds(o.end ?? o.end_time ?? o.endTime),
  };
}

/** Milliseconds to seconds by DIVIDING: 4600 / 1000 is exactly 4.6, 4600 * 0.001 is not. */
const inSeconds = (n: number, ms: boolean): number => (ms ? n / 1000 : n);

/**
 * Are the times milliseconds? Only when every time is a whole number AND speech would be
 * impossibly slow in seconds: in seconds a character takes about 0.07 s to say, in
 * milliseconds about 70. The median over the items decides, so one odd item cannot. The bar
 * is 10 per character, not 2: a file of whole seconds with short answers ("No." over 9 s
 * is 3 per character) must stay in seconds, and real milliseconds are 40 or more.
 */
function inMilliseconds(list: unknown[]): boolean {
  if (asRecord(list[0])?.offsets) return false;
  const perChar: number[] = [];
  for (const item of list) {
    const o = asRecord(item);
    if (!o) continue;
    const s = o.start ?? o.start_time ?? o.startTime;
    const e = o.end ?? o.end_time ?? o.endTime;
    for (const n of [s, e]) if (typeof n === 'number' && !Number.isInteger(n)) return false;
    const text = textOf(o) ?? (typeof o.word === 'string' ? o.word : null);
    if (typeof s === 'number' && typeof e === 'number' && e > s && text && text.trim() !== '') {
      perChar.push((e - s) / text.trim().length);
      if (perChar.length >= 5000) break;
    }
  }
  if (perChar.length === 0) return false;
  perChar.sort((a, b) => a - b);
  // the lower median: with two items, one absurd segment cannot decide
  return perChar[Math.floor((perChar.length - 1) / 2)]! > 10;
}

/** A pause this long between two words starts a new turn when nothing else says who is speaking. */
const PAUSE_BREAK_S = 1.5;
/** Past this many characters a run of words is cut at the next sentence end, so one turn never swallows an hour. */
const RUN_SOFT_CHARS = 400;

interface Word {
  word: string;
  speaker: string | null;
  start: number | null;
  end: number | null;
  /** punctuation that belongs to the word before ("." in Speechmatics) */
  attach?: boolean;
}

/**
 * Words (one item each) into turns: a new turn when the speaker changes, at a long pause, or
 * at a sentence end once the run is long. WhisperX leaves some words (numerals, mostly)
 * without a time or a speaker; they join the run they are in.
 */
function gatherWords(words: Word[]): RawSeg[] {
  const segs: RawSeg[] = [];
  type Run = {
    speaker: string | null;
    start: number | null;
    end: number | null;
    words: string[];
    chars: number;
  };
  let run: Run | null = null;
  let lastSpeaker: string | null = null;
  let lastEnd: number | null = null;
  const close = (r: Run | null) => {
    if (r && r.words.length > 0) {
      segs.push({ speaker: r.speaker, start: r.start, end: r.end, text: r.words.join(' ') });
    }
  };

  for (const w of words) {
    if (w.attach && run && run.words.length > 0) {
      run.words[run.words.length - 1] += w.word;
      continue;
    }
    const speaker: string | null = w.speaker ?? lastSpeaker;
    const start: number | null = w.start ?? lastEnd;
    if (run) {
      const gap = start !== null && run.end !== null ? start - run.end : 0;
      const sentenceEnd = /[.!?。…]["'”’)\]]*$/.test(run.words[run.words.length - 1]!.slice(-12));
      if (
        speaker !== run.speaker ||
        gap >= PAUSE_BREAK_S ||
        (run.chars >= RUN_SOFT_CHARS && sentenceEnd)
      ) {
        close(run);
        run = null;
      }
    }
    if (!run) run = { speaker, start, end: null, words: [], chars: 0 };
    run.words.push(w.word);
    run.chars += w.word.length + 1;
    run.end = w.end ?? start ?? run.end;
    lastSpeaker = speaker;
    lastEnd = run.end;
  }
  close(run);
  return segs;
}

function wordItems(list: unknown[], ms: boolean): Word[] {
  const out: Word[] = [];
  for (const item of list) {
    const o = asRecord(item);
    if (!o) continue;
    const raw = o.punctuated_word ?? o.word ?? o.text;
    const word = typeof raw === 'string' ? raw.trim() : '';
    if (word === '') continue;
    const t = timesOf(o);
    out.push({
      word,
      speaker: speakerOf(o),
      start: t.start === null ? null : inSeconds(t.start, ms),
      end: t.end === null ? null : inSeconds(t.end, ms),
    });
  }
  return out;
}

/** Rev.ai: `monologues[]`, each a speaker and its `elements` (words, spaces and punctuation). */
function revMonologues(o: Record<string, unknown>): RawSeg[] | null {
  if (!Array.isArray(o.monologues)) return null;
  const segs: RawSeg[] = [];
  for (const m of o.monologues) {
    const r = asRecord(m);
    if (!r || !Array.isArray(r.elements)) continue;
    let text = '';
    let start: number | null = null;
    let end: number | null = null;
    for (const e of r.elements) {
      const el = asRecord(e);
      if (!el || typeof el.value !== 'string') continue;
      text += el.value;
      if (typeof el.ts === 'number') start ??= toSeconds(el.ts);
      if (typeof el.end_ts === 'number') end = toSeconds(el.end_ts);
    }
    const speaker = normalizeSpeakerId(r.speaker_name ?? r.speaker);
    if (text.trim() !== '') segs.push({ speaker, start, end, text: text.trim() });
  }
  return segs;
}

/** Speechmatics: `results[]` of words, each with `alternatives[0].content` and a speaker. */
function speechmaticsWords(o: Record<string, unknown>): Word[] | null {
  if (!Array.isArray(o.results) || !asRecord(o.results[0])?.alternatives) return null;
  const words: Word[] = [];
  for (const item of o.results) {
    const r = asRecord(item);
    const alt = r && Array.isArray(r.alternatives) ? asRecord(r.alternatives[0]) : null;
    if (!r || !alt || typeof alt.content !== 'string' || alt.content.trim() === '') continue;
    words.push({
      word: alt.content.trim(),
      speaker: normalizeSpeakerId(alt.speaker),
      start: toSeconds(r.start_time),
      end: toSeconds(r.end_time),
      attach: r.type === 'punctuation' || r.attaches_to === 'previous',
    });
  }
  return words;
}

export function parseJson(value: unknown, maxSegments: number): RawParse | null {
  const o = asRecord(value);
  const named = normalizeSpeakerId(o?.interviewee);
  // the interviewee as the speaker is written in the turns ("speaker_00" names "SPEAKER_00")
  const withNamed = (r: RawParse): RawParse => {
    if (!named) return r;
    const lower = named.toLowerCase();
    const hit = r.segs.find((s) => s.speaker !== null && s.speaker.toLowerCase() === lower);
    return { ...r, interviewee: hit?.speaker ?? named };
  };

  const rev = o ? revMonologues(o) : null;
  if (rev) return rev.length > 0 ? withNamed({ format: 'segments-json', segs: rev }) : null;
  const sm = o ? speechmaticsWords(o) : null;
  if (sm) {
    if (sm.length > maxSegments * 6) {
      throw new TranscriptError(
        `too many words (${sm.length}; the limit is ${maxSegments * 6})`,
        'too_many_segments',
      );
    }
    const segs = gatherWords(sm);
    return segs.length > 0 ? withNamed({ format: 'segments-json', segs }) : null;
  }

  const found = segmentList(value);
  if (!found || found.list.length === 0) return null;
  const { list, words } = found;
  // a transcript has far more words than turns: the same hostile-input cap, scaled
  const cap = words ? maxSegments * 6 : maxSegments;
  if (list.length > cap) {
    throw new TranscriptError(
      `too many segments (${list.length}; the limit is ${cap})`,
      'too_many_segments',
    );
  }

  const ms = inMilliseconds(list);
  let segs: RawSeg[] = [];
  if (words) {
    segs = gatherWords(wordItems(list, ms));
  } else {
    for (const item of list) {
      const s = asRecord(item);
      if (!s) continue;
      const text = textOf(s);
      if (text === null) continue;
      const t = timesOf(s);
      segs.push({
        speaker: speakerOf(s),
        start: t.start === null ? null : inSeconds(t.start, ms),
        end: t.end === null ? null : inSeconds(t.end, ms),
        text,
      });
    }
  }
  if (segs.length === 0) return null;
  return withNamed({ format: 'segments-json', segs });
}

/* ── SRT / VTT ───────────────────────────────────────────────────────── */

// "00:00:01,000 --> 00:00:04,000", "00:01.000 --> 00:04.000", Teams' unpadded "0:0:5.120",
// no fraction at all ("00:00:01 --> 00:00:04"), and a colon before it ("00:00:01:000"), which
// some exporters write. A fraction of any length is a fraction of a second.
const CUE =
  /^ ?(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,9}))? ?--> ?(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,9}))?/;

const cueSeconds = (h: string | undefined, m: string, s: string, f: string | undefined): number =>
  Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + (f ? Number(`0.${f}`) : 0);

// WebVTT cue settings after the timing ("align:start position:10%") and old SRT coordinates
// ("X1:100 X2:200 Y1:50 Y2:80") are not words
const CUE_SETTINGS =
  /^(?: ?(?:(?:vertical|line|position|size|align|region):[^ ]{1,40}|[XY][12]:\d{1,5}))*/;
// what a WebVTT file says about itself before its first cue: never anyone's words
const VTT_HEADER = /^(?:WEBVTT\b|Kind:|Language:|X-TIMESTAMP-MAP=)/;
// a WebVTT comment or style block: up to the next blank line
const VTT_BLOCK = /^(?:NOTE|STYLE|REGION)(?: |$)/;

// <v Name> or <v.loud Name>: bounded, so a line full of "<" cannot make it slow
const VOICE_TAG = /<v(?:\.[^ <>]{0,50})? ([^<>]{1,100})>/g;
const TAG = /<[^<>]{0,200}>/g;
const STYLE = /\{\\[^{}\n]{0,200}\}/g;

/** A line of a cue cut before every label of the file's speaker set (P1: "[Host]: … [할머니]: …"). */
function cutAtLabels(line: string, sets: LabelSets): string[] {
  if (sets.firm.size === 0) return [line];
  const starts = lineStarts(line, slotsOf(line), sets)
    .map((s) => s.at)
    .filter((at) => at > 0);
  if (starts.length === 0) return [line];
  const out: string[] = [];
  let from = 0;
  for (const at of starts) {
    out.push(line.slice(from, at).trim());
    from = at;
  }
  out.push(line.slice(from).trim());
  return out.filter((x) => x !== '');
}

/** One cue's words, split wherever a new voice starts, the cue's time shared by length. */
function cuePieces(cue: { start: number; end: number; lines: string[] }, set: LabelSets): RawSeg[] {
  const pieces: Array<{ speaker: string | null; text: string }> = [];
  const add = (speaker: string | null, text: string, fresh: boolean) => {
    const t = text.replace(TAG, ' ').replace(STYLE, ' ').replace(/ {2,}/g, ' ').trim();
    const last = pieces[pieces.length - 1];
    if (!fresh && last) {
      if (t !== '') last.text = last.text === '' ? t : `${last.text} ${t}`;
    } else {
      pieces.push({ speaker, text: t });
    }
  };
  for (const line of cue.lines) {
    // each voice tag starts a new piece; text before the first one continues the cue
    let last = 0;
    const parts: Array<{ speaker?: string; text: string }> = [];
    for (const m of line.matchAll(VOICE_TAG)) {
      parts.push({ text: line.slice(last, m.index) });
      parts.push({ speaker: asId(m[1]!), text: '' });
      last = m.index + m[0].length;
    }
    parts.push({ text: line.slice(last) });
    let voice: string | undefined;
    for (const p of parts) {
      if (p.speaker !== undefined) {
        voice = p.speaker;
        add(voice, '', true);
        continue;
      }
      if (p.text.trim() === '') continue;
      // inside the text, a label of the file's speakers starts a piece too
      const clean = p.text.replace(TAG, ' ').replace(/ {2,}/g, ' ').trim();
      for (const [k, chunk] of cutAtLabels(clean, set).entries()) {
        const l = splitLabel(chunk);
        if (l) add(l.label, l.text, true);
        else if (/^- \S/.test(chunk))
          add(null, chunk.slice(2), true); // a dialogue dash: someone else
        else add(voice ?? null, chunk, voice === undefined && k === 0 && pieces.length === 0);
      }
    }
  }
  const kept = pieces.filter((p) => p.text !== '');
  const total = kept.reduce((n, p) => n + p.text.length, 0);
  const dur = cue.end - cue.start;
  let done = 0;
  // the cue's own times at its two ends, exactly: no rounding error on a one-voice cue
  return kept.map((p, i) => {
    const from = i === 0 ? cue.start : cue.start + (dur * done) / total;
    done += p.text.length;
    const to = i === kept.length - 1 ? cue.end : cue.start + (dur * done) / total;
    return { speaker: p.speaker, start: from, end: to, text: p.text };
  });
}

export function parseSubtitles(text: string): RawParse | null {
  const lines = text.split('\n');
  let count = 0;
  for (const l of lines) if (CUE.test(l)) count++;
  if (count < 2) return null;

  const cues: Array<{ start: number; end: number; lines: string[] }> = [];
  let dropped = 0;
  let inBlock = false;
  let afterBlank = true;
  // the line just read was a timing line: the next line is that cue's words, even "1946"
  let afterTiming = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const m = CUE.exec(line);
    const justTimed = afterTiming;
    afterTiming = m !== null;
    if (m) {
      const cue = {
        start: cueSeconds(m[1], m[2]!, m[3]!, m[4]),
        end: cueSeconds(m[5], m[6]!, m[7]!, m[8]),
        lines: [] as string[],
      };
      // words written on the timing line itself are the cue's first words
      const tail = line.slice(m[0].length).replace(CUE_SETTINGS, '').trim();
      if (tail !== '') cue.lines.push(tail);
      cues.push(cue);
      inBlock = false;
      afterBlank = false;
      continue;
    }
    if (line === '') {
      inBlock = false;
      afterBlank = true;
      continue;
    }
    const next = lines[i + 1]?.trim() ?? '';
    // A cue's number, or (in WebVTT) a cue's name, on the line before its timing: one token
    // ("12", "a1b2c3d4-e5f6/12-0"); words with spaces before a timing are the last cue's words.
    // The line right after a timing is always words: a cue that says only "1946" is an answer.
    if (
      !justTimed &&
      CUE.test(next) &&
      (/^\d+$/.test(line) || (afterBlank && !line.includes(' ')))
    ) {
      afterBlank = false;
      continue;
    }
    // a cue number with a blank line between it and the timing
    if (!justTimed && /^\d+$/.test(line) && next === '' && CUE.test(lines[i + 2]?.trim() ?? ''))
      continue;
    if (afterBlank && VTT_BLOCK.test(line)) inBlock = true;
    afterBlank = false;
    if (inBlock || (cues.length === 0 && VTT_HEADER.test(line))) continue;
    // A blank line inside a cue does not end its words: they belong to the cue before them.
    // Words before the first cue have no time and no voice; they are left out, and counted.
    if (cues.length === 0) dropped++;
    else cues[cues.length - 1]!.lines.push(line);
  }

  // the speakers of the whole file, so that a cue holding two of them can be cut
  const set = labelSetOf(slotsOf(cues.map((c) => c.lines.join(' ')).join('\n')));
  const segs = cues.flatMap((c) => cuePieces(c, set));
  if (segs.length === 0) return null;
  return {
    format: 'subtitles',
    segs,
    ...(dropped > 0 ? { notices: { linesDropped: dropped } } : {}),
  };
}

/* ── what comes before the first speaker ─────────────────────────────── */

/*
 * Above a transcript there may be a title, header fields, an e-mail's attribution line or a
 * tool's summary. Those are not anyone's words, so they are left out, and counted. But ONLY
 * above the first speaker turn: below it every line belongs to a turn, even one that starts
 * with a date ("March 3rd, 1946, in Busan"), a key ("Title: Chief Engineer…") or "Recorded…".
 * And only what SAYS it is a header: speech-to-text that writes no full stops looks a lot like
 * a title, and dropping it loses the relative's words without a word to anyone. What stays in
 * the lead block (a greeting, the tape starting mid-answer) comes with no speaker; roles.ts
 * decides whose it is.
 */

/** "Date: …", "Title: …", "제목: …", an e-mail's "From: / Sent: / To: / Cc: / Subject:" */
const META_KEY =
  /^(?:date|time|title|location|place|topic|subject|session|tape|file|duration|language|transcriber|translator|from|sent|to|cc|bcc|reply-to|recorded(?: on| at| by)?|transcribed by|interview(?:er|ee)?'?s? ?(?:date|name|location|place)|날짜|일시|시간|장소|제목|주제|녹취|녹음|녹취자|면담 ?일시|면담 ?장소|대담 ?일시|보낸 ?사람|받는 ?사람|참조) ?:/iu;
/** "Interview with Grandma", "Recorded March 1, 2024", "-----Original Message-----", Otter's "SUMMARY KEYWORDS" */
const META_PHRASE =
  /^(?:interview(?:ed)? (?:with|by|of) |recorded (?:on |at |in |by |for |(?=\p{Lu}|\d))|transcribed (?:by|on|from|with) |transcript(?:ion)? (?:of|by) |https?:\/\/|www\.|copyright |©|-{2,} ?(?:original message|forwarded message)|(?:summary )?keywords$|speakers$|summary$|outline$|action items$)/iu;
/** an e-mail's attribution line: "On Mon, May 4, 2026 at 9:12 AM Noah <…> wrote:", "… 님이 작성:" */
const ATTRIBUTION = /^(?:on .{6,160} wrote:|.{6,160}님이 작성:)$/iu;
/** Otter's blocks above the turns: the heading, then lines up to a blank line */
const BLOCK_HEAD = /^(?:SUMMARY KEYWORDS|KEYWORDS|SPEAKERS|SUMMARY|OUTLINE|ACTION ITEMS)$/;
/** "Speaker 1 = Noah Kim, Speaker 2 = Sunja Kim": who the numbered voices are */
const MAPPING =
  /^(?:(?:speaker|voice|person|화자|참석자)[_ ]?\d{1,3} ?= ?[^,;=\n]{1,40}(?:[,;] ?|$)){1,8}$/iu;
const MAPPING_PAIR = /((?:speaker|voice|person|화자|참석자)[_ ]?\d{1,3}) ?= ?([^,;=\n]{1,40})/giu;

/**
 * The words a pure date, time or duration is made of: "Tue, 5/12 9:15AM • 45:30", "45m 12s",
 * "May 3, 2026, 3:21PM", "2024년 3월 1일 (금) 녹음". Whatever is left after taking them away
 * is a clause, and a line with a clause is speech ("March 3rd, 1946, in Busan").
 */
const TIME_WORD =
  /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|[ap]\.?m\.?|at|오전|오후|녹음|녹취|recorded|recording|요일|[월화수목금토일]|\d{1,4}(?:st|nd|rd|th|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?|[ap]\.?m\.?|년|월|일|시|분|초)?)$/iu;

/** Whole words only: "that 1946" is not a date because "that" is not a word of one. */
function isPureTime(l: string): boolean {
  if (l.length > 60 || !/\d/.test(l)) return false;
  return l
    .split(/[ ,/:•·|()\-–—]+/u)
    .every((t) => t === '' || TIME_WORD.test(t.replace(/\.$/, '')));
}

/** "Tape 2, side A", "Part 2", "Session 3 of 4", "제2부", "테이프 1": where the recording is */
const SECTION_PART =
  /^(?:(?:tape|side|part|session|reel|cassette|disc|disk|track|chapter|interview|day|테이프|세션|면담|녹음)\.? ?(?:#|no\.? ?)?(?:\d{1,3}|[a-d]|[ivx]{1,4})(?: of \d{1,3})?|제? ?\d{1,3} ?(?:부|회차|회|편|차))$/iu;

function isSection(l: string): boolean {
  if (l.length > 40) return false;
  const parts = l.replace(/[.:]$/, '').split(/ ?[,;–—] ?| - /u);
  return parts.length <= 3 && parts.every((p) => SECTION_PART.test(p.trim()));
}

/** what a title names: "Grandma's Story", "할머니 구술" */
const TITLE_WORD =
  /(?:^|[^a-z])(?:interview|transcript|story|stories|memories|memoir|recording|conversation|oral history|life|history|biography)(?:$|[^a-z])|구술|녹취|인터뷰|이야기|기록|대담|회고/iu;
/** how a Korean sentence ends: "…해 드릴게요" is speech, "할머니 구술" a title */
const KO_SENTENCE_END = /(?:요|다|죠|까|네|지|고|어|아|게|데|야|며|면|서)$/u;

/** A line of the lead block that says it is a header, not speech. */
const isMeta = (l: string): boolean =>
  META_KEY.test(l) ||
  META_PHRASE.test(l) ||
  ATTRIBUTION.test(l) ||
  MAPPING.test(l) ||
  isPureTime(l) ||
  isSection(l);

/**
 * The first line, as a title: short, no sentence end, followed by a blank line or a header
 * field, naming what it is ("Interview", "Story", "구술"), and shaped like a title: Title Case,
 * or in Korean not ending like a sentence. "Hi Grandma" and "I will tell you the story" are
 * speech. Above a full date ("Tue, 5/12 9:15AM • 45:30", as Otter writes its header) a title
 * may be in any case ("Grandma Sunja's story"), but never starts like a sentence ("I", "We").
 */
function isTitle(l: string, breakAfter: boolean, dateAfter: boolean): boolean {
  if (!breakAfter || l.length >= 70 || /[.!?…。"”’,]$/.test(l) || !TITLE_WORD.test(l)) return false;
  const words = l.split(' ');
  if (words.length > 8) return false;
  if (dateAfter && !STOP_FIRST.test(words[0]!)) return true;
  const long = words.filter((w) => /^\p{L}{4,}/u.test(w));
  if (long.some((w) => /^[\p{Lu}\p{Ll}]/u.test(w))) return long.every((w) => /^\p{Lu}/u.test(w));
  return !KO_SENTENCE_END.test(l);
}

/**
 * The unlabelled lines before the first speaker, sorted: header lines are left out (counted),
 * everything else is speech and is kept. `breaks[i]` says a blank line followed line i.
 * Numbered voices named in the lead ("Speaker 1 = Noah Kim") are returned as `names`.
 */
function leadingLines(
  lines: string[],
  breaks: boolean[],
): { speech: string[]; dropped: number; names: Map<string, string> } {
  const speech: string[] = [];
  const names = new Map<string, string>();
  let dropped = 0;
  let inBlock = false;
  lines.forEach((l, i) => {
    if (BLOCK_HEAD.test(l)) inBlock = true;
    const next = lines[i + 1];
    const breakAfter = breaks[i] || next === undefined || isMeta(next);
    // a full date, not a year: "Tue, 5/12 9:15AM • 45:30", "May 3, 2026"
    const dateAfter = next !== undefined && isPureTime(next) && /\d\D+\d/.test(next);
    if (inBlock || isMeta(l) || (i === 0 && isTitle(l, breakAfter, dateAfter))) {
      dropped++;
      if (MAPPING.test(l)) {
        for (const m of l.matchAll(MAPPING_PAIR)) names.set(voiceKey(m[1]!), tidyLabel(m[2]!));
      }
    } else {
      speech.push(l);
    }
    if (breaks[i]) inBlock = false;
  });
  return { speech, dropped, names };
}

/** "Speaker 1", "SPEAKER_01", "speaker1" are one voice */
const voiceKey = (id: string): string =>
  id
    .toLowerCase()
    .replace(/[_ ]/g, '')
    .replace(/(\D)0+(\d)/, '$1$2');

const noticesOf = (unlabelledStart: number, linesDropped: number): { notices?: ReaderNotices } =>
  unlabelledStart > 0 || linesDropped > 0
    ? {
        notices: {
          ...(unlabelledStart > 0 ? { unlabelledStart } : {}),
          ...(linesDropped > 0 ? { linesDropped } : {}),
        },
      }
    : {};

/* ── Otter / Zoom / Teams: a header line, then the words ─────────────── */

// "Family, Given" too: Zoom and Otter show a display name as the person typed it
const HEADER_LINE = new RegExp(
  String.raw`^(?:\[((?:${STRICT}|${COMMA_NAME}|${NAME})(?:${QUALIFIER})?)\]|((?:${STRICT}|${COMMA_NAME}|${NAME})(?:${QUALIFIER})?)) [[(]?(${TS})[\])]?$`,
  'u',
);

/** `Name  0:05` (Otter, Rev, Teams) or `[Name] 00:00:05` (Zoom) on a line by itself. */
function headerOf(line: string): { label: string; start: number | null } | null {
  const m = HEADER_LINE.exec(line);
  if (!m) return null;
  const label = tidyLabel(m[1] ?? m[2]!);
  if (!STRICT_FULL.test(label)) {
    // "We left at 5:30" or "Grandpa came home at 6:15" is a sentence, not a name and a time
    if (notALabel(label) || SOUND_NOTE.test(label) || label.length > 40) return null;
    if (
      baseLabel(label)
        .split(' ')
        .slice(1)
        .some((w) => /^\p{Ll}/u.test(w))
    )
      return null;
  }
  return { label: asId(label), start: toSeconds(m[3]) };
}

export function parseHeaderText(text: string): RawParse | null {
  const lines = text.split('\n');
  let headers = 0;
  for (const l of lines) if (headerOf(l) !== null) headers++;
  if (headers < 3) return null;

  const segs: RawSeg[] = [];
  const lead: string[] = [];
  const breaks: boolean[] = [];
  let dropped = 0;
  let cur: { speaker: string; start: number | null; lines: string[] } | null = null;
  const flush = () => {
    if (cur) {
      const t = cur.lines.join('\n').trim();
      if (t !== '') segs.push({ speaker: cur.speaker, start: cur.start, end: null, text: t });
    }
    cur = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    const h = headerOf(line);
    if (h) {
      flush();
      cur = { speaker: h.label, start: h.start, lines: [] };
    } else if (line === '') {
      if (!cur && lead.length > 0) breaks[lead.length - 1] = true;
    } else if (NOTE_LINE.test(line)) {
      dropped++; // "Note: the tape ran out"
    } else if (cur) {
      // A line under a speaker is that speaker's, whatever it starts with: "Recorded songs
      // on a tape…", "March 3rd, 1946, in Busan".
      cur.lines.push(line);
    } else {
      lead.push(line);
      breaks.push(false);
    }
  }
  // Otter's own last line names the tool, not anything the last speaker said
  if (cur && OTTER_FOOTER.test(cur.lines[cur.lines.length - 1] ?? '')) {
    cur.lines.pop();
    dropped++;
  }
  flush();
  // each segment's end is where the next one starts
  for (let i = 0; i + 1 < segs.length; i++) segs[i]!.end = segs[i + 1]!.start;
  if (segs.length < 2) return null;
  // words before the first header line: headers are left out, speech is kept (nobody's yet)
  const { speech, dropped: titles, names } = leadingLines(lead, breaks);
  for (const s of segs) s.speaker = names.get(voiceKey(s.speaker!)) ?? s.speaker;
  segs.unshift(...speech.map((t) => ({ speaker: null, start: null, end: null, text: t })));
  return { format: 'header-text', segs, ...noticesOf(speech.length, dropped + titles) };
}

/** "Transcribed by https://otter.ai": the export's own last line */
const OTTER_FOOTER = /^transcribed by https?:\/\/[^ ]{1,80}$/i;

/* ── labelled lines ──────────────────────────────────────────────────── */

const QA_LINE = /^(Q|A|문|답)[.)] \S/;
const BRACKET_LEAD = /^\[([^[\]\n]{1,60})\] \S/;
/** a sentence end: what a wrapped question line does NOT end with */
const ENDS_SENTENCE = /[.!?。…"”’)]$/;

/*
 * Label styles people type. "**Noah:**" (markdown bold) and "- Noah:" (a list) are labels
 * wherever they are. "<Noah> …" (a chat log), "Noah said: …" and "Noah - …" are labels only as
 * the style of the whole document: the same name used that way twice, and at least two names
 * (or a role such as "Interviewer"). Once, "Busan - that is where we lived" is a sentence.
 */
const BOLD_LABEL = /^(?:\*\*|__)([^*_\n]{1,60}?)(:?)(?:\*\*|__)(:?) ?(.*)$/;
const BULLET = /^[-*•·‣] (?=\S)/;
const ANGLE_LABEL = /^<([^<>\n]{1,40})> ?(.*)$/;
const SAID_LABEL = new RegExp(
  String.raw`^(${NAME}) (?:said|says|asked|asks|replied|replies|answered|answers) ?:(?: (.*))?$`,
  'u',
);
const DASH_LABEL = new RegExp(String.raw`^(${NAME}) [-–—] (.+)$`, 'u');
/** "<b>", "<i>", "<v Noah>": markup, not a chat name */
const MARKUP = /^(?:b|i|u|s|em|strong|br|p|span|font|c|v|ruby|rt|lang|div|a)(?: |$)/i;

function restyle(lines: string[]): string[] {
  // "- Noah: …" is a label only as the style of the document; "- Jae: the eldest" in a list
  // inside an answer is her words
  const bullets: Array<{ i: number; key: string; body: string }> = [];
  const out = lines.map((raw, i) => {
    const line = raw.trim();
    const bold = BOLD_LABEL.exec(line.replace(BULLET, ''));
    if (bold && (bold[2] || bold[3]) && (STRICT_FULL.test(bold[1]!) || NAME_FULL.test(bold[1]!))) {
      return `${tidyLabel(bold[1]!)}: ${bold[4] ?? ''}`.trim();
    }
    if (BULLET.test(line)) {
      const body = line.replace(BULLET, '');
      const l = splitLabel(body);
      if (l) bullets.push({ i, key: l.label.toLowerCase(), body });
    }
    return line;
  });
  const bulletUses = new Map<string, number>();
  for (const b of bullets) bulletUses.set(b.key, (bulletUses.get(b.key) ?? 0) + 1);
  const listed = [...bulletUses].filter(([, n]) => n >= 2).map(([k]) => k);
  if (listed.length >= 2 || listed.some((k) => ASKER_LABEL.test(k) || /^interviewee$/i.test(k))) {
    for (const b of bullets) if (listed.includes(b.key)) out[b.i] = b.body;
  }
  type Style = { re: RegExp; maxWords: number };
  const styles: Style[] = [
    { re: ANGLE_LABEL, maxWords: 4 },
    { re: SAID_LABEL, maxWords: 4 },
    { re: DASH_LABEL, maxWords: 3 },
  ];
  for (const { re, maxWords } of styles) {
    const count = new Map<string, number>();
    const hits: Array<{ i: number; token: string; rest: string }> = [];
    out.forEach((line, i) => {
      const m = re.exec(line);
      if (!m) return;
      const token = tidyLabel(m[1]!);
      const rest = m[2] ?? '';
      const named =
        STRICT_FULL.test(token) ||
        (token.split(' ').length <= maxWords &&
          !MARKUP.test(token) &&
          nameLabelOk(token, rest) &&
          looksLikeName(token));
      if (!named) return;
      hits.push({ i, token, rest });
      count.set(token.toLowerCase(), (count.get(token.toLowerCase()) ?? 0) + 1);
    });
    const used = [...count].filter(([, n]) => n >= 2).map(([k]) => k);
    const role = used.some((k) => ASKER_LABEL.test(k) || /^interviewee$/i.test(k));
    if (used.length === 0 || (used.length < 2 && !role)) continue;
    for (const h of hits)
      if (used.includes(h.token.toLowerCase())) out[h.i] = `${h.token}: ${h.rest}`;
  }
  return out;
}

/** A role named in a header block above the transcript: "Interviewee: Sunja Kim", "면담자: 김노아". */
const HEADER_ROLE =
  /^(?:interviewer|interviewee|narrator|respondent|host|guest|moderator|transcriber|translator|recorder|구술자|면담자|면접관|면접자|인터뷰어|인터뷰이|질문자|응답자|진행자|녹취자|기록자)$/i;
/** the roles that say who is TELLING: their name may pick the interviewee */
const TELLER_ROLE = /^(?:interviewee|narrator|respondent|구술자|인터뷰이|응답자)$/i;
/** a person's name as a header value: short, no sentence */
const NAME_VALUE = (v: string): boolean =>
  v !== '' && v.length <= 50 && v.split(' ').length <= 6 && !/[?!。]|\.$/.test(v);

/**
 * Lines that start with a speaker label. The whole document is looked at first, because a
 * line alone cannot say whether "Q." is a label, whether "[할머니]" is a name, or whether
 * "My father:" begins a sentence:
 *
 *   - "Q. …" / "A. …" are labels only when both recur
 *   - "[Name] …" with no colon is a label only when a few names start most lines
 *   - labels are compared in any case: "grandma:" once is "Grandma:", not a new speaker
 *   - a label that occurs once, while two others recur, and does not look like a name
 *     ("Rule one:", "Interview date:") is part of the sentence it starts
 *   - when the ONLY labels are the interviewer's ("Q:", "Interviewer:"), the unlabelled
 *     lines between them are the answers (speaker ANSWERS), not more of the question
 *   - a header block above the transcript ("Interviewee: Sunja Kim", "Date: …", "제목: …")
 *     and transcriber's notes are left out, and counted; "Interviewee: Sunja Kim" names the
 *     interviewee when exactly one speaker is that person
 *   - words before the first label are speech unless they say they are a header or a title
 */
export function parseLabelled(text: string): RawParse | null {
  const lines = restyle(text.split('\n'));

  let q = 0;
  let a = 0;
  const tokens = new Map<string, number>();
  let bracketLines = 0;
  let nonEmpty = 0;
  for (const line of lines) {
    if (line !== '') nonEmpty++;
    const qa = QA_LINE.exec(line);
    if (qa) {
      if (qa[1] === 'Q' || qa[1] === '문') q++;
      else a++;
    }
    const b = BRACKET_LEAD.exec(line);
    if (b) {
      const tok = tidyLabel(b[1]!);
      const strict = STRICT_FULL.test(tok);
      if (!SOUND_NOTE.test(tok) && !TS_FULL.test(tok) && (strict || NAME_FULL.test(tok))) {
        bracketLines++;
        if (!strict) tokens.set(tok, (tokens.get(tok) ?? 0) + 1);
      }
    }
  }
  const modes: LabelModes = {
    qa: q >= 2 && a >= 2,
    // A few names, starting a good share of the lines: a clarification such as "[Busan]" at
    // the start of a line now and then never becomes a speaker. A short file in which every
    // line starts with a name in brackets is a transcript too.
    bracket:
      bracketLines >= 3 &&
      tokens.size <= 6 &&
      (tokens.size * 2 <= bracketLines || bracketLines === nonEmpty) &&
      bracketLines * 3 >= nonEmpty,
  };

  // A header key used as a speaker's label ("Subject: In Busan, in a little house…" in a
  // research interview, again and again) is that speaker, not a header field.
  modes.allow = keysUsedAsLabels(lines);

  type Row = { line: string; l: Labelled | null; meta: boolean };
  const rows: Row[] = [];
  /** a blank line follows rows[i] */
  const breaks: boolean[] = [];
  let dropped = 0;
  for (const line of lines) {
    if (line === '') {
      if (rows.length > 0) breaks[rows.length - 1] = true;
      continue;
    }
    if (NOTE_LINE.test(line)) {
      dropped++; // a transcriber's note is not testimony
      continue;
    }
    rows.push({ line, l: splitLabel(line, modes), meta: false });
    breaks.push(false);
  }

  // one speaker, however the case of the label was typed
  const spellings = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.l) continue;
    const k = r.l.label.toLowerCase();
    const s = spellings.get(k) ?? new Map<string, number>();
    s.set(r.l.label, (s.get(r.l.label) ?? 0) + 1);
    spellings.set(k, s);
  }
  const canonical = new Map<string, string>();
  for (const [k, s] of spellings) {
    let best = '';
    let n = -1;
    for (const [spelling, c] of s) if (c > n) [best, n] = [spelling, c];
    canonical.set(k, best);
  }
  for (const r of rows) if (r.l) r.l = { ...r.l, label: canonical.get(r.l.label.toLowerCase())! };
  const counts = new Map<string, number>();
  for (const r of rows) if (r.l) counts.set(r.l.label, (counts.get(r.l.label) ?? 0) + 1);

  // The lead block: the rows above the first speaker turn. Only there can a line be a header:
  // "Interviewee: Sunja Kim" / "Interviewer: Noah Kim" (each role used once, its value a
  // name), a field such as "제목: 할머니 구술" or "Sent: Monday" used once. A label used again
  // is a speaker wherever it is. It names people; it is nobody's words.
  let named: string | null = null;
  for (const r of rows) {
    const l = r.l;
    if (!l) continue; // unlabelled lead lines are sorted below, with the title and the fields
    if (counts.get(l.label) !== 1) break;
    const role = HEADER_ROLE.test(baseLabel(l.label)) && NAME_VALUE(l.text);
    if (!role && !META_KEY.test(r.line)) break;
    if (role && TELLER_ROLE.test(baseLabel(l.label))) named = l.text;
    r.l = null;
    r.meta = true;
  }

  const recurring = [...counts.values()].filter((n) => n >= 2).length;
  // "Grandma 2:" among "Grandma:" lines is one more of those speakers, not a sentence with a colon
  const numberless = (label: string) => label.replace(/\s*\p{N}+$/u, '').toLowerCase();
  const recurringBases = new Set(
    [...counts].filter(([, n]) => n >= 2).map(([label]) => label.toLowerCase()),
  );
  for (const r of rows) {
    const l = r.l;
    if (
      l &&
      !l.strict &&
      counts.get(l.label) === 1 &&
      recurring >= 2 &&
      !looksLikeName(l.label) &&
      !recurringBases.has(numberless(l.label))
    ) {
      r.l = null; // "Rule one: never lie." inside an answer
    }
  }

  const labels = new Set(rows.filter((r) => r.l).map((r) => r.l!.label));
  const kept = rows.filter((r) => !r.meta);
  let blocks = 0;
  for (let i = 1; i < kept.length; i++) if (!kept[i]!.l && kept[i - 1]!.l) blocks++;
  const implicit =
    labels.size > 0 && [...labels].every((x) => ASKER_LABEL.test(baseLabel(x))) && blocks >= 2;

  // Turns collect their lines and are joined once at the end: a turn that grows line by line
  // must never be re-read whole (that was quadratic on a long answer of short lines).
  type Turn = { speaker: string | null; start: number | null; end: number | null; lines: string[] };
  const turns: Turn[] = [];
  const lead: string[] = [];
  const leadBreaks: boolean[] = [];
  let labelled = 0;
  for (let i = 0; i < rows.length; i++) {
    const { line, l, meta } = rows[i]!;
    if (meta) {
      dropped++;
      if (turns.length === 0 && lead.length > 0) leadBreaks[lead.length - 1] = true;
      continue;
    }
    if (l) {
      labelled++;
      turns.push({
        speaker: l.label,
        start: l.start,
        end: l.end,
        lines: l.text === '' ? [] : [l.text],
      });
      continue;
    }
    const prev = turns[turns.length - 1];
    if (!prev) {
      lead.push(line);
      leadBreaks.push(breaks[i] ?? false);
      continue;
    }
    // only the interviewer is labelled: this line answers the question above it, unless it
    // is that question wrapped onto a second line, the question goes on ("Let's talk about
    // your childhood.\nWhere were you born?"), or the label stood alone on its line
    const last = prev.lines[prev.lines.length - 1];
    const wrapped =
      last !== undefined &&
      ((!ENDS_SENTENCE.test(last) && /^\p{Ll}/u.test(line)) || ASKS_AT_END.test(line));
    if (implicit && prev.speaker !== ANSWERS && last !== undefined && !wrapped) {
      turns.push({ speaker: ANSWERS, start: null, end: null, lines: [line] });
      continue;
    }
    // a wrapped line continues the turn; keep the line break, so each line can be checked
    prev.lines.push(line);
  }
  // one colon in a paragraph of prose is not a transcript
  if (labelled < 2 || (labels.size < 2 && !implicit && labelled / kept.length < 0.5)) return null;

  const segs: RawSeg[] = turns.map((t) => ({
    speaker: t.speaker,
    start: t.start,
    end: t.end,
    text: t.lines.join('\n'),
  }));
  // Words before the first label: headers are left out; speech is kept with no speaker, and
  // roles.ts decides whose it is (a greeting is not the relative's; a tape that starts
  // mid-answer is). "Speaker 1 = Noah Kim" in the lead names the voices.
  const { speech, dropped: titles, names } = leadingLines(lead, leadBreaks);
  for (const s of segs) if (s.speaker) s.speaker = names.get(voiceKey(s.speaker)) ?? s.speaker;
  segs.unshift(...speech.map((t) => ({ speaker: null, start: null, end: null, text: t })));
  // one speaker's label, and lines between that nobody labelled: whose are they? Or one voice
  // read, and a word before a colon again and again that was not read as a label
  const labelsUnclear =
    (labels.size === 1 && !implicit && blocks >= 2) ||
    (labels.size <= 1 && unreadLabels(text, new Set([...labels].map((x) => x.toLowerCase()))));
  // "Interviewee: Sunja Kim" above the turns, and exactly one speaker is Sunja Kim: a hint for
  // the roles, not the sender's choice (another relative may tell too)
  const hint = named ? speakerNamed(named, labels) : null;
  return {
    format: 'labelled-text',
    segs,
    ...(labelsUnclear ? { labelsUnclear } : {}),
    ...(hint ? { intervieweeHint: names.get(voiceKey(hint)) ?? hint } : {}),
    ...noticesOf(speech.length, dropped + titles),
  };
}

/** a question going on onto its next line: it ends with a question mark, or a Korean request */
const ASKS_AT_END =
  /(?:[?？]["”’')\]]*|(?:주세요|주시겠어요|주실래요|말씀해 ?주세요|들려주세요|해 ?보세요)[.!…]*)$/u;

/**
 * Header keys that are a speaker's label here: used at the start of two lines or more, with
 * words after them that are speech, not a date ("Subject: In Busan, in a little house…").
 */
function keysUsedAsLabels(lines: string[]): Set<string> {
  const uses = new Map<string, { n: number; speech: number }>();
  for (const line of lines) {
    const m = /^(\p{L}[\p{L}\p{M}'’.\-]{0,23}) ?: (.+)$/u.exec(line);
    if (!m || !(STOP_FIRST.test(m[1]!) || META_KEY.test(line))) continue;
    const key = m[1]!.toLowerCase();
    const u = uses.get(key) ?? { n: 0, speech: 0 };
    u.n++;
    const value = m[2]!;
    if (!isPureTime(value) && (value.split(' ').length >= 3 || /[.!?…。]$/.test(value))) u.speech++;
    uses.set(key, u);
  }
  return new Set([...uses].filter(([, u]) => u.n >= 2 && u.speech * 2 >= u.n).map(([k]) => k));
}

/** The one label that is the person a header names ("Sunja Kim" is "Sunja", "Kim, Sunja", …). */
function speakerNamed(name: string, labels: Set<string>): string | null {
  const words = new Set(name.toLowerCase().replace(/,/g, '').split(' '));
  const hits = [...labels].filter((l) => {
    const b = baseLabel(l).toLowerCase().replace(/,/g, '');
    return b === name.toLowerCase() || b.split(' ').every((w) => words.has(w));
  });
  return hits.length === 1 ? hits[0]! : null;
}

/* ── [00:12] text, no speakers ───────────────────────────────────────── */

const STAMPED = new RegExp(String.raw`^[[(]? ?${TSRANGE} ?[\])]? (.+)$`);

export function parseTimestamped(text: string): RawParse | null {
  const segs: RawSeg[] = [];
  const lead: string[] = [];
  const breaks: boolean[] = [];
  let stamped = 0;
  let nonEmpty = 0;
  let notes = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      if (segs.length === 0 && lead.length > 0) breaks[lead.length - 1] = true;
      continue;
    }
    if (NOTE_LINE.test(line)) {
      notes++;
      continue;
    }
    nonEmpty++;
    const m = STAMPED.exec(line);
    if (m) {
      stamped++;
      segs.push({ speaker: null, start: toSeconds(m[1]), end: toSeconds(m[2]), text: m[3]! });
    } else if (segs.length > 0) {
      segs[segs.length - 1]!.text += `\n${line}`;
    } else {
      lead.push(line);
      breaks.push(false);
    }
  }
  if (!(stamped >= 3 && stamped / nonEmpty >= 0.6)) return null;
  // words above the first time: a header is left out (counted), speech is kept
  const { speech, dropped } = leadingLines(lead, breaks);
  segs.unshift(...speech.map((t) => ({ speaker: null, start: null, end: null, text: t })));
  return {
    format: 'timestamped-text',
    segs,
    ...(unreadLabels(text, new Set()) ? { labelsUnclear: true } : {}),
    ...noticesOf(0, dropped + notes),
  };
}

/* ── plain ───────────────────────────────────────────────────────────── */

export function parsePlain(text: string): RawParse {
  return {
    format: 'plain-text',
    segs: text
      .split('\n')
      .filter((l) => l.trim() !== '' && !NOTE_LINE.test(l.trim()))
      .map((l) => ({ speaker: null, start: null, end: null, text: l })),
    ...(unreadLabels(text, new Set()) ? { labelsUnclear: true } : {}),
  };
}

/**
 * Text read as one voice in which the same one word stands before a colon three times or
 * more ("zq: … zq: … zq: …"): labels we could not read, so whose words are whose must be
 * confirmed by a person. `read`: the labels that were read, lower-cased. Linear: every colon
 * looks back at most 24 characters.
 */
function unreadLabels(text: string, read: Set<string>): boolean {
  const seen = new Map<string, number>();
  for (let i = text.indexOf(': '); i >= 0; i = text.indexOf(': ', i + 2)) {
    let j = i;
    while (j > 0 && i - j <= 24 && LABEL_CHAR.test(text[j - 1]!)) j--;
    if (j === i || i - j > 24 || (j > 0 && !/[\s"“'‘([]/u.test(text[j - 1]!))) continue;
    const word = text.slice(j, i);
    const key = word.toLowerCase();
    if (!/^\p{L}/u.test(word) || STOP_FIRST.test(word) || WEAK_STOP.test(key) || read.has(key)) {
      continue;
    }
    const n = (seen.get(key) ?? 0) + 1;
    if (n >= 3) return true;
    seen.set(key, n);
  }
  return false;
}
const LABEL_CHAR = /[\p{L}\p{M}\p{N}'’_-]/u;
