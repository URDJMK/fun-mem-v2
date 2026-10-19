/**
 * Transcript intake: whatever the speech-to-text box produced -> one clean shape.
 *
 *   text  ──prepare──► one kind of line break, no invisible characters, NFC, ASCII brackets
 *         ──sniff────► raw segments (transcript-formats.ts)
 *   JSON  ──────────► raw segments
 *         ──normalize──► Turn[]  +  warnings the person should hear about
 *   then, once roles are known: applyRoles() folds the interviewer's "mm-hm" into the answer
 *
 * WHY THIS IS A SEPARATE, PURE FILE. The collaborator's GPU pipeline decides what
 * arrives; this file decides what the rest of the system is allowed to assume.
 * Nothing here touches the network or a database, so every behaviour below is
 * pinned by a unit test.
 *
 * THE PROMISE: nothing the relative said is lost, and nothing is invented. So:
 *   - only KNOWN sound notes are removed ("[Music]", "(laughs)", "♪ la la ♪", "[INAUDIBLE]");
 *     any other bracketed words ("[Busan]", "[sic]", "[그 당시에는]") stay
 *   - a recogniser stuck in a loop is collapsed, but only the SAME speaker saying the same
 *     thing four times or more ("I miss her." said four times by a grieving person stays)
 *   - a turn that is only "Mm-hm." stays "Mm-hm.": it is often the answer "yes"
 *   - nothing is dropped or folded here because of who might be speaking: that waits for
 *     the roles (applyRoles), so a one-word answer is never mistaken for an interjection
 *   - a segment with no speaker takes the previous speaker, never a made-up
 *     "SPEAKER_00" that collides with a real one
 *   - with NO speakers, ASR fragments are gathered into paragraphs cut at sentence ends,
 *     and, when the file clearly alternates, short lines ending in "?" are set apart as the
 *     interviewer's questions (and the caller is told that was a guess)
 *   - a turn too long for one model call is split at sentence boundaries, never leaving a
 *     scrap of a sentence on its own
 *
 * THE RULE FOR SPEAKERS: a label is a name for a voice, not a role. Which voice is
 * the person being remembered is decided by the caller, or by `roles.ts`.
 *
 * LINEAR TIME: every pattern below is bounded or anchored. Text arrives with its blank runs
 * squeezed to one space, which is what keeps the label patterns linear too.
 */

import { formatClock, toSeconds } from './clock';
import { isBackchannel, looksLikeAsking } from './question-cues';
import { assignRoles, unknownForTeller, type RoleDecision } from './roles';
import { ANSWERS, QUESTIONS, UNKNOWN, VOICE } from './speaker-ids';
import { capitalizeSentences, cleanSpeech } from './speech';
import { TranscriptError } from './transcript-error';
import {
  ANNOTATION_WORDS,
  KOREAN_SOUND_WORDS,
  STRICT_LABEL_ANY_CASE,
  parseHeaderText,
  parseJson,
  parseLabelled,
  parsePlain,
  parseSubtitles,
  parseTimestamped,
  splitRunOnLabels,
  type RawFormat,
  type RawParse,
  type RawSeg,
} from './transcript-formats';

export { formatClock, toSeconds };
export { TranscriptError, type TranscriptErrorCode } from './transcript-error';
export {
  assignRoles,
  type RoleDecision,
  type RoleHints,
  type RoleReason,
  type SpeakerSummary,
} from './roles';

export interface Turn {
  /** position in the merged transcript; stable, used as the citation id */
  index: number;
  speaker: string;
  /** seconds, or null when the source carried no timing */
  start: number | null;
  end: number | null;
  text: string;
}

export type TranscriptFormat = RawFormat;

export type WarningCode =
  | 'no_speakers'
  | 'questions_guessed'
  | 'unlabelled_filled'
  | 'annotations_removed'
  | 'repeats_collapsed'
  | 'backchannels_merged'
  | 'long_turns_split'
  | 'labels_unclear'
  /** the reader kept lines of speech that came before the first speaker label (count: lines) */
  | 'unlabelled_start'
  /** the reader left out title, header or note lines (count: lines) */
  | 'lines_dropped'
  /** passages with no speaker that read as the teller's were given to her (count: passages) */
  | 'unlabelled_to_teller'
  /** one speaker's name written two ways ("Grandma" / "grandma:") was read as one (count: spellings folded) */
  | 'labels_merged'
  /** the person chose who tells; turns by other voices that may be testimony were left out (count: turns) */
  | 'speaker_left_out';

export interface TranscriptWarning {
  code: WarningCode;
  count: number;
}

export interface ParsedTranscript {
  /** speaker id the SENDER says is the interviewee, if the JSON named one */
  interviewee?: string;
  /**
   * speaker id an "Interviewee: Sunja Kim" header in the text names: a hint for the role guess,
   * not the sender's word (a second relative who tells at length still makes the guess ask)
   */
  intervieweeHint?: string;
  format: TranscriptFormat;
  turns: Turn[];
  warnings: TranscriptWarning[];
  /** characters of speech after cleaning */
  chars: number;
}

export const MAX_TRANSCRIPT_CHARS = 400_000;
/** a JSON transcript as text: under the 8 MB request limit even after Korean text is encoded */
export const MAX_JSON_CHARS = 6_000_000;
export const MAX_SEGMENTS = 50_000;
/** A turn longer than this is split: one model call must be able to hold it. */
export const MAX_TURN_CHARS = 2500;
/** A piece shorter than this is never left on its own at the end of a split turn. */
export const MIN_TAIL_CHARS = 80;
export { ANSWERS, QUESTIONS, UNKNOWN, VOICE };

/* ── preparing text ──────────────────────────────────────────────────── */

const LINE_BREAKS = /\r\n?|[\u000B\u000C\u0085\u2028\u2029]/g;
// C0 and C1 control characters except tab and the line breaks handled above
const CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F]/g;
// zero-width and direction marks, soft hyphen, word joiner, BOM: invisible, and they break labels
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const SPACES = /[\t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
/**
 * Full-width brackets and colon, as typed on a Korean, Japanese or Chinese keyboard, read as
 * their ASCII twins so "［할머니］：" is a label. Only these, and only for the readers: her own
 * "，！；？" stay in her words (the question cues and sentence ends understand them as they are).
 */
const FULL_WIDTH: Record<string, string> = {
  '［': '[',
  '］': ']',
  '（': '(',
  '）': ')',
  '：': ':',
  '【': '[',
  '】': ']',
};

/** The same cleaning for every string from a file: no control or invisible characters, NFC. */
export function cleanString(s: string): string {
  return s
    .replace(LINE_BREAKS, '\n')
    .replace(CONTROL, '')
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(SPACES, ' ');
}

/**
 * Text as the readers expect it: one kind of line break, no control or invisible characters,
 * NFC, ASCII brackets and colons, every run of blanks one space, lines trimmed. An email
 * reply (most lines quoted with ">") loses its quote marks first.
 */
export function prepareText(input: string): string {
  let t = cleanString(input.replace(/^\uFEFF/, ''))
    .replace(/[［］（）：【】]/g, (c) => FULL_WIDTH[c]!)
    .replace(/ {2,}/g, ' ')
    .replace(/^ | $/gm, '');
  const lines = t.split('\n');
  let nonEmpty = 0;
  let quoted = 0;
  for (const l of lines) {
    if (l === '') continue;
    nonEmpty++;
    if (l.startsWith('>')) quoted++;
  }
  if (nonEmpty > 0 && quoted * 2 >= nonEmpty) {
    t = lines.map((l) => l.replace(/^(?:> ?)+/, '')).join('\n');
  }
  return t;
}

/* ── cleaning ────────────────────────────────────────────────────────── */

const TS = String.raw`\d{1,2}(?::\d{2}){1,2}(?:[.,]\d{1,3})?`;
/** more sounds a transcriber writes in brackets, beyond the readers' list: "[GROANS]", "(whispering)" */
const MORE_SOUND_WORDS =
  'groans?|groaning|moans?|sneez(?:es|ing)|yawn(?:s|ing)?|whisper(?:s|ing)|mumbl(?:es|ing)|gasps?|' +
  'screams?|shouting|sniffl(?:es|ing)|weep(?:s|ing)|humming|whistl(?:es|ing)|snor(?:es|ing)|' +
  'hiccups?|footsteps|knock(?:s|ing)|typing|sounds?|sound effects?|foreign|door (?:opens|closes|slams)';
const SOUND = `(?:${ANNOTATION_WORDS}|${MORE_SOUND_WORDS}|${KOREAN_SOUND_WORDS})(?: ${TS})?`;
const SOUND_PATTERNS: Array<{ re: RegExp; counts: boolean; keep?: (m: string) => boolean }> = [
  { re: new RegExp(String.raw`\[${SOUND}\]`, 'gi'), counts: true },
  { re: new RegExp(String.raw`\(${SOUND}\)`, 'gi'), counts: true },
  // "[BLANK_AUDIO]", "[PHONE RINGS]", "[CROSSTALK 00:02:11]": an all-capitals tag of two words or
  // more is a note. One all-capitals word is kept: it is a name more often than a sound ("He
  // worked for the [UN]", "[KBS]", "[YMCA]"); the known sounds ("[MUSIC]", "[INAUDIBLE]") went above.
  // A speaker ("[INTERVIEWER]") always stays.
  {
    re: new RegExp(String.raw`\[[A-Z][A-Z' _-]{1,40}(?: ${TS})?\]`, 'g'),
    counts: true,
    keep: (m) => {
      const inner = m.slice(1, -1).trim();
      return STRICT_LABEL_ANY_CASE.test(inner) || /^[A-Z']+$/.test(inner);
    },
  },
  // a note from the transcriber inside the words: "[Note: the tape was paused]"
  {
    re: /[[(](?:note|nb|editor'?s note|transcriber'?s note|translator'?s note)[: ][^[\]()\n]{0,200}[\])]/gi,
    counts: true,
  },
  { re: /\*(?:laughs?|sighs?|coughs?|pauses?|smiles?|chuckles?|cries)\*/gi, counts: true },
  { re: /[♪♫]+[^♪♫\n]{0,200}[♪♫]+/g, counts: true },
  { re: /[♪♫]+/g, counts: true },
  // a time in brackets is not a word: "[00:12]", "(01:02:03)", "[00:12 - 00:15]"
  {
    re: new RegExp(String.raw`[[(] ?${TS}(?: ?(?:-->|->|–|—|-|to) ?${TS})? ?[\])]`, 'g'),
    counts: false,
  },
];

/** Known sound notes out, everything else kept. Returns how many notes went. */
export function stripSoundNotes(t: string): { text: string; removed: number } {
  let removed = 0;
  let out = t;
  for (const p of SOUND_PATTERNS) {
    out = out.replace(p.re, (m: string) => {
      if (p.keep?.(m)) return m;
      if (p.counts) removed++;
      return ' ';
    });
  }
  return { text: out, removed };
}

/** `[Music]`, `(laughs)`, `*sighs*`, `♪ … ♪`, `(웃음)`: sounds, not words. Other brackets stay. */
export function stripAnnotations(t: string): string {
  return stripSoundNotes(t).text;
}

const HALLUCINATIONS = new Set([
  'thanks for watching',
  'thank you for watching',
  'thank you for watching this video',
  'please subscribe',
  'please subscribe to my channel',
  'subtitles by the amara org community',
  '시청해주셔서 감사합니다',
  '시청해 주셔서 감사합니다',
  '구독과 좋아요 부탁드립니다',
  '다음 영상에서 만나요',
]);

const keyOf = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const wordCount = (key: string): number => (key === '' ? 0 : key.split(' ').length);

/**
 * A loop needs this many repeats in a row: four of a sentence of four words or more, eight of
 * a shorter one. "I miss her." said four times, or "No. No. No. No.", is a person, not a
 * recogniser stuck on silence.
 */
const loopRun = (key: string): number => (wordCount(key) >= 4 ? 4 : 8);

const SENTENCE_BREAK = /(?<=[.!?。…？！])\s+/;

/**
 * "Thank you. Thank you. Thank you. … " looped inside one segment -> one. Emphasis is not a
 * loop: "No. No. No. No." and "I miss her." four times are testimony, so a sentence of up
 * to three words must repeat eight times, a longer one four. Linear.
 */
function collapseLoops(text: string): { text: string; collapsed: number } {
  const parts = text.split(SENTENCE_BREAK);
  if (parts.length < 4) return { text, collapsed: 0 };
  const out: string[] = [];
  let collapsed = 0;
  for (let i = 0; i < parts.length;) {
    const key = keyOf(parts[i]!);
    let j = i;
    while (key !== '' && j + 1 < parts.length && keyOf(parts[j + 1]!) === key) j++;
    const run = j - i + 1;
    if (key !== '' && run >= loopRun(key)) {
      out.push(parts[i]!);
      collapsed += run - 1;
    } else {
      out.push(...parts.slice(i, j + 1));
    }
    i = j + 1;
  }
  return { text: out.join(' '), collapsed };
}

/** markdown and email structure at the start of a line: never part of anyone's words */
const LEAD_STRUCTURE = /^\s*(?:>+|#{1,6}(?=\s)|`{3,}[\w-]{0,20}|~{3,}|-{3,}|\*{3,}|_{3,})/;

/**
 * "> quoted", "# heading", "```", "---" at the start of any line of a segment: removed, so a
 * note made from these words can never contain a line a later reader takes for a marker.
 */
function neutralize(text: string): string {
  if (!/[>#`~*_-]/.test(text)) return text;
  return text
    .split('\n')
    .map((line) => {
      let l = line;
      for (let i = 0; i < 6; i++) {
        const next = l.replace(LEAD_STRUCTURE, '');
        if (next === l) break;
        l = next;
      }
      return l.trimStart();
    })
    .join('\n');
}

/** Only a sound of listening or agreeing, nothing else: "Mm-hm.", "Yeah.", "네." (question-cues.ts) */
export { isBackchannel };

/**
 * Only a sound of LISTENING ("Oh.", "I see.", "그렇구나."), never a word of agreement ("Yes.",
 * "맞아요.") and never "Mm-hm." / "Uh-huh.": after "So you were born in Busan, in 1946." those
 * are her "yes", as much as "Yes." is.
 */
const LISTENING = /^(?:hmm+|oh|ah|wow|i see|really|음|아|그렇군요|그렇구나)[.!?…,\s]*$/i;
/** a teller turn that opens by contradicting what was just said: the interjection before it is what she answers */
const CONTRADICTS =
  /^(?:no\b|nope\b|not\b|never\b|nah\b|wrong\b|actually\b|아니|아뇨|안\s|그게 아니|그건 아니)/i;
const isListening = (t: string): boolean => t.length <= 40 && LISTENING.test(t.trim());

const isQuestion = (t: string): boolean => t.length < 150 && /[?？]["”’')\]]*$/.test(t);
const endsSentence = (t: string): boolean => /[.!?。…？！]["'”’)\]]*$/.test(t.slice(-12));
const hasWords = (t: string): boolean => /[\p{L}\p{N}]/u.test(t);

/* ── normalizing ─────────────────────────────────────────────────────── */

interface Seg {
  speaker: string;
  start: number | null;
  end: number | null;
  text: string;
  /** the words were only fillers ("Mm-hm."): kept when they are the whole turn, else dropped */
  filler: boolean;
}

/** A pause this long between two fragments of one voice starts a new paragraph. */
const PARAGRAPH_PAUSE_S = 1.5;
/** Past this many characters a paragraph of one voice ends at the next sentence end. */
const PARAGRAPH_CHARS = 400;

function normalize(raw: RawParse): ParsedTranscript {
  // refused BEFORE any cleaning, so one giant text field cannot make the server work for seconds
  const rawChars = raw.segs.reduce((n, s) => n + s.text.length, 0);
  if (rawChars > MAX_TRANSCRIPT_CHARS * 2) {
    throw new TranscriptError(
      `the transcript is too long (${rawChars.toLocaleString('en-US')} characters; the limit is ${MAX_TRANSCRIPT_CHARS.toLocaleString('en-US')})`,
      'too_long',
    );
  }
  const warnings = new Map<WarningCode, number>();
  const warn = (code: WarningCode, n = 1) => warnings.set(code, (warnings.get(code) ?? 0) + n);
  if (raw.notices?.unlabelledStart) warn('unlabelled_start', raw.notices.unlabelledStart);
  if (raw.notices?.linesDropped) warn('lines_dropped', raw.notices.linesDropped);

  /* 0. one name written two ways is one speaker: "Grandma", "grandma", "GRANDMA", "Grandma.", "(Grandma)" */
  const { segs: input, merged: spellings, rename } = mergeSpellings(raw.segs);
  const interviewee = raw.interviewee !== undefined ? rename(raw.interviewee) : undefined;
  const intervieweeHint =
    raw.intervieweeHint !== undefined ? rename(raw.intervieweeHint) : undefined;
  if (spellings > 0) warn('labels_merged', spellings);

  /* 1. clean each segment's words */
  type Clean = RawSeg & { filler: boolean };
  const cleaned: Clean[] = [];
  let notes = 0;
  for (const s of input) {
    const plain = neutralize(cleanString(s.text));
    const { text: stripped, removed } = stripSoundNotes(plain);
    notes += removed;
    const words = stripped.replace(/\s+/g, ' ').trim();
    if (!hasWords(words)) continue;
    let t = cleanSpeech(words, { capitalize: false, keepFillerOnly: false });
    const filler = t === '';
    if (filler) t = words; // nothing but "mm-hm": what was said stays said
    if (HALLUCINATIONS.has(keyOf(t))) continue;
    const loops = collapseLoops(t);
    if (loops.collapsed > 0) warn('repeats_collapsed', loops.collapsed);
    cleaned.push({ ...s, text: loops.text, filler });
  }
  if (notes > 0) warn('annotations_removed', notes);

  /* 2. one speaker saying one thing over and over (a recogniser stuck on silence): keep one */
  const deduped: Clean[] = [];
  for (let i = 0; i < cleaned.length;) {
    const first = cleaned[i]!;
    const k = keyOf(first.text);
    let j = i;
    while (
      j + 1 < cleaned.length &&
      cleaned[j + 1]!.speaker === first.speaker &&
      keyOf(cleaned[j + 1]!.text) === k
    ) {
      j++;
    }
    const run = j - i + 1;
    if (k !== '' && run >= loopRun(k)) {
      deduped.push({ ...first, end: cleaned[j]!.end ?? first.end });
      warn('repeats_collapsed', run - 1);
    } else {
      deduped.push(...cleaned.slice(i, j + 1));
    }
    i = j + 1;
  }

  /* 3. who spoke: carry a missing speaker forward; never invent one that collides */
  const known = new Set(deduped.map((s) => s.speaker).filter((s): s is string => s !== null));
  const voices = known.size;
  let segs: Seg[];
  if (voices === 0) {
    warn('no_speakers');
    segs = deduped.map((s) => ({ ...s, speaker: VOICE }));
  } else {
    // A passage with no speaker continues the one before it, unless it ANSWERS that one's
    // question (or asks after that one told): a diarizer that left the relative's "Four. All
    // older than me." unattributed must not file it as the interviewer's. Such a passage is
    // UNKNOWN, and the roles decide whose it is (applyRoles gives an answer to the teller).
    // Lines before the first label are UNKNOWN too; the reader has counted them already.
    let prev: string | null = null;
    let prevAsks = false;
    segs = deduped.map((s) => {
      const asks = looksLikeAsking(s.text);
      let speaker: string;
      if (s.speaker !== null) {
        speaker = s.speaker;
      } else if (prev === null) {
        if (!raw.notices?.unlabelledStart) warn('unlabelled_filled');
        speaker = UNKNOWN;
      } else if (prev !== UNKNOWN && asks !== prevAsks) {
        speaker = UNKNOWN;
      } else {
        if (prev !== UNKNOWN) warn('unlabelled_filled');
        speaker = prev;
      }
      prev = speaker;
      prevAsks = asks;
      return { ...s, speaker };
    });
  }

  /*
   * 4. nobody is labelled: short lines ending in "?" are most likely the interviewer, but only
   * when the file clearly alternates (a quarter of the lines are questions, and most of them
   * are followed by an answer). A monologue with a few questions in it stays one voice.
   */
  if (voices <= 1 && raw.format !== 'labelled-text' && raw.format !== 'header-text') {
    const q = segs.map((s) => isQuestion(s.text));
    let asked = 0;
    let answered = 0;
    for (let i = 0; i < q.length; i++) {
      if (!q[i]) continue;
      asked++;
      if (i + 1 < q.length && !q[i + 1]) answered++;
    }
    if (asked > 0 && asked * 4 >= segs.length && answered * 2 > asked) {
      segs = segs.map((s, i) => (q[i] ? { ...s, speaker: QUESTIONS } : s));
      warn('questions_guessed', asked);
    }
  }

  /* 5. turns: merge by speaker when speakers are real; otherwise gather fragments */
  const merged: Seg[] = [];
  const fragmentSource =
    raw.format === 'segments-json' ||
    raw.format === 'subtitles' ||
    raw.format === 'timestamped-text';
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    const sameVoice = prev !== undefined && prev.speaker === s.speaker;
    let join = false;
    if (sameVoice && voices >= 2) {
      join = true;
    } else if (sameVoice && fragmentSource && s.speaker !== QUESTIONS) {
      // ASR fragments of one voice: paragraphs that end at a sentence end, or at a pause
      const gap = prev.end !== null && s.start !== null ? s.start - prev.end : 0;
      join =
        gap < PARAGRAPH_PAUSE_S &&
        !(endsSentence(prev.text) && prev.text.length >= PARAGRAPH_CHARS);
    }
    if (join && prev) {
      if (prev.filler && !s.filler) {
        prev.text = s.text; // "Mm-hm." then the words: the words are the turn
        prev.filler = false;
      } else if (!s.filler || prev.filler) {
        prev.text = `${prev.text} ${s.text}`;
      } // else a lone "um" between two fragments of one turn adds nothing
      prev.end = s.end ?? prev.end;
    } else {
      merged.push({ ...s });
    }
  }

  /* 6. a capital at the start of each turn and after each sentence end; a turn must fit in one model call */
  const turns: Turn[] = [];
  for (const m of merged) {
    const pieces = splitLong({ ...m, text: capitalizeSentences(m.text) });
    if (pieces.length > 1) warn('long_turns_split');
    for (const p of pieces) {
      turns.push({
        index: turns.length,
        speaker: p.speaker,
        start: p.start,
        end: p.end,
        text: p.text,
      });
    }
  }
  if (turns.length === 0) {
    throw new TranscriptError('no speech was found in the transcript', 'no_speech');
  }

  const chars = turns.reduce((n, t) => n + t.text.length, 0);
  if (chars > MAX_TRANSCRIPT_CHARS) {
    throw new TranscriptError(
      `the transcript is too long (${chars.toLocaleString('en-US')} characters; the limit is ${MAX_TRANSCRIPT_CHARS.toLocaleString('en-US')})`,
      'too_long',
    );
  }
  if (raw.labelsUnclear) warn('labels_unclear');
  return {
    format: raw.format,
    turns,
    warnings: [...warnings].map(([code, count]) => ({ code, count })),
    chars,
    ...(interviewee ? { interviewee } : {}),
    ...(intervieweeHint ? { intervieweeHint } : {}),
  };
}

/** Our own ids are never folded into a speaker's, or a speaker's into ours. */
const OWN_IDS = new Set([QUESTIONS, UNKNOWN, ANSWERS, VOICE]);
const spellingOf = (id: string): string =>
  id
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Labels that differ only in case, accents, spaces or punctuation name one speaker: the most
 * used spelling wins. A hand-typed "grandma:" or "Grandma.:" among twenty "Grandma:" lines was
 * a third "speaker" whose one answer nobody counted as testimony. Only these PROVABLE variants
 * are folded: "Grandpa" and "Grandma" differ by one letter and are two people.
 */
function mergeSpellings(segs: RawSeg[]): {
  segs: RawSeg[];
  merged: number;
  rename: (id: string) => string;
} {
  const uses = new Map<string, number>();
  for (const s of segs) if (s.speaker !== null) uses.set(s.speaker, (uses.get(s.speaker) ?? 0) + 1);
  const byKey = new Map<string, string[]>();
  for (const id of uses.keys()) {
    const k = spellingOf(id);
    if (k === '') continue;
    const same = byKey.get(k);
    if (same) same.push(id);
    else byKey.set(k, [id]);
  }
  const to = new Map<string, string>();
  let merged = 0;
  for (const ids of byKey.values()) {
    if (ids.length < 2 || ids.some((id) => OWN_IDS.has(id))) continue;
    const main = ids.reduce((a, b) => (uses.get(b)! > uses.get(a)! ? b : a));
    for (const id of ids) if (id !== main) to.set(id, main);
    merged += ids.length - 1;
  }
  const rename = (id: string) => to.get(id) ?? id;
  if (merged === 0) return { segs, merged, rename };
  return {
    segs: segs.map((s) =>
      s.speaker !== null && to.has(s.speaker) ? { ...s, speaker: to.get(s.speaker)! } : s,
    ),
    merged,
    rename,
  };
}

/**
 * Split an over-long turn at sentence boundaries (or, with none, at spaces). The last piece is
 * never a scrap: when it would be shorter than MIN_TAIL_CHARS, whole sentences (or words)
 * move into it from the piece before, so "He died at 52." is never a turn on its own.
 */
function splitLong(t: Seg): Seg[] {
  if (t.text.length <= MAX_TURN_CHARS) return [t];
  const pieces: string[] = [];
  let cur = '';
  const push = () => {
    if (cur.trim() !== '') pieces.push(cur.trim());
    cur = '';
  };
  for (const sentence of t.text.split(SENTENCE_BREAK)) {
    let s = sentence;
    while (s.length > MAX_TURN_CHARS) {
      // no punctuation to break on: cut at the last space before the limit
      const cut = s.lastIndexOf(' ', MAX_TURN_CHARS);
      const at = cut > MAX_TURN_CHARS / 2 ? cut : MAX_TURN_CHARS;
      push();
      pieces.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    if (cur.length + s.length + 1 > MAX_TURN_CHARS) push();
    cur = cur === '' ? s : `${cur} ${s}`;
  }
  push();
  rebalanceTail(pieces);

  const total = pieces.reduce((n, p) => n + p.length, 0);
  const dur = t.start !== null && t.end !== null ? t.end - t.start : null;
  let done = 0;
  return pieces.map((text) => {
    const from = done / total;
    done += text.length;
    const to = done / total;
    return {
      speaker: t.speaker,
      text,
      filler: false,
      start: dur === null ? t.start : t.start! + dur * from,
      end: dur === null ? t.end : t.start! + dur * to,
    };
  });
}

/**
 * Move the end of the next-to-last piece into a last piece that is too short to stand alone.
 * Whole sentences first; only a sentence too long to move gives words. Neither piece ever
 * grows past MAX_TURN_CHARS.
 */
function rebalanceTail(pieces: string[]): void {
  const n = pieces.length;
  if (n < 2 || pieces[n - 1]!.length >= MIN_TAIL_CHARS) return;
  let tail = pieces[n - 1]!;
  if (pieces[n - 2]!.length + 1 + tail.length <= MAX_TURN_CHARS) {
    pieces.splice(n - 2, 2, `${pieces[n - 2]!} ${tail}`);
    return;
  }
  const sentences = pieces[n - 2]!.split(SENTENCE_BREAK);
  while (sentences.length > 1 && tail.length < MIN_TAIL_CHARS) {
    const s = sentences[sentences.length - 1]!;
    if (s.length + 1 + tail.length > MAX_TURN_CHARS) break;
    sentences.pop();
    tail = `${s} ${tail}`;
  }
  const words = sentences.join(' ').split(' ');
  while (words.length > 1 && tail.length < MIN_TAIL_CHARS) tail = `${words.pop()!} ${tail}`;
  pieces.splice(n - 2, 2, words.join(' '), tail);
}

/* ── entry ───────────────────────────────────────────────────────────── */

/** Text that is meant to be JSON: an object of keys, or an array of objects (or strings). */
const JSON_LIKE = /^(?:\{\s*"|\[\s*[{"\]])/;

const DAMAGED_JSON =
  'this looks like a JSON file but it could not be read; it may be damaged or cut off. Export it again from the transcription tool, or paste the transcript as text';
const UNKNOWN_JSON =
  'this JSON file has no transcript we can read (expected a "segments" list with a "text" in each, or another known speech-to-text format). Export it again from the transcription tool, or paste the transcript as text';

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** A parsed JSON value -> raw segments, or a refusal that says what to do. */
function fromJson(value: unknown): RawParse {
  const raw = parseJson(value, MAX_SEGMENTS);
  if (raw) return raw;
  // OpenAI Whisper's default answer: { "text": "…" }, the words and nothing else
  const o = asRecord(value);
  if (o && typeof o.text === 'string' && o.text.trim() !== '') {
    return {
      format: 'plain-text',
      segs: o.text
        .split(/\r\n?|\n/)
        .filter((l) => l.trim() !== '')
        .map((l) => ({ speaker: null, start: null, end: null, text: l })),
    };
  }
  throw new TranscriptError(UNKNOWN_JSON, 'unreadable');
}

function readText(text: string): RawParse {
  const subtitles = parseSubtitles(text);
  if (subtitles) return subtitles;
  const lines = splitRunOnLabels(text);
  return (
    parseHeaderText(lines) ?? parseLabelled(lines) ?? parseTimestamped(lines) ?? parsePlain(lines)
  );
}

/**
 * A line that begins like a speaker label: some words (perhaps a long note in brackets the
 * reader would not accept as a name), then a colon and a space. Bounded: linear.
 */
const LABEL_LIKE = /^\p{L}[\p{L}\p{M}\p{N}'’.,()/_ -]{0,80}?:(?: |$)/u;

export function parseTranscript(input: unknown): ParsedTranscript {
  if (typeof input === 'object' && input !== null) return normalize(fromJson(input));
  if (typeof input !== 'string') {
    throw new TranscriptError('the transcript must be text or JSON', 'unreadable');
  }
  const original = input.replace(/^\uFEFF/, '');
  if (original.trim() === '') throw new TranscriptError('the transcript is empty', 'empty');
  const trimmed = original.trimStart();
  const jsonish = JSON_LIKE.test(trimmed);
  // Checked BEFORE parsing so a huge paste cannot burn CPU. Cleaning shrinks text, so the exact
  // limit is enforced on the cleaned characters in normalize(). JSON gets a larger cap because
  // a speech-to-text file repeats every word with its timing: an hour of speech is about 1 MB
  // of JSON for 60,000 characters of talk, and that file must not be called "too long".
  if (original.length > (jsonish ? MAX_JSON_CHARS : MAX_TRANSCRIPT_CHARS * 2)) {
    throw new TranscriptError(
      `the transcript is too long (${original.length.toLocaleString('en-US')} characters; the limit is ${MAX_TRANSCRIPT_CHARS.toLocaleString('en-US')} characters of speech)`,
      'too_long',
    );
  }
  if (jsonish) {
    // JSON is never handed to the text readers: its keys and braces would become testimony
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      throw new TranscriptError(DAMAGED_JSON, 'unreadable');
    }
    return normalize(fromJson(value));
  }

  const text = prepareText(original);
  if (text.trim() === '') throw new TranscriptError('the transcript is empty', 'empty');
  const parsed = normalize(readText(text));

  // Lines that begin like "Somebody:" while fewer than two speakers were recognised: labels
  // we could not read. The words are all kept; whose they are must be confirmed by a person.
  if (!parsed.warnings.some((w) => w.code === 'labels_unclear')) {
    let like = 0;
    let nonEmpty = 0;
    for (const line of text.split('\n')) {
      if (line === '') continue;
      nonEmpty++;
      if (LABEL_LIKE.test(line)) like++;
    }
    const anonymous = parsed.warnings.some((w) => w.code === 'no_speakers');
    const recognised = new Set(
      parsed.turns
        .map((t) => t.speaker)
        .filter((s) => s !== QUESTIONS && s !== UNKNOWN && !(anonymous && s === VOICE)),
    );
    if (like >= 2 && like * 10 >= nonEmpty * 3 && recognised.size < 2) {
      parsed.warnings.push({ code: 'labels_unclear', count: like });
    }
  }
  return parsed;
}

/* ── once roles are known ────────────────────────────────────────────── */

/**
 * Roles, and the turns as the rest of the pipeline should see them:
 *
 *   - an interviewer's pure "mm-hm" between two parts of a teller's answer is folded away,
 *     and the two parts become one turn
 *   - a teller's pure "mm-hm" between two turns of the interviewer is dropped only when the
 *     interviewer was not asking anything (then it is listening); after a question it is an
 *     ANSWER ("Mm-hm." = yes) and stays. A word of agreement ("Yes.", "Right.", "맞아요.")
 *     from a teller always stays: after "Mom said you were born in Busan." it confirms a fact
 *   - every other turn is kept as it was; indices are renumbered 0..n-1
 *
 * `named` (the interviewee the caller or the file named) defaults to the file's own.
 */
export function applyRoles(
  parsed: ParsedTranscript,
  named?: string | string[],
): { turns: Turn[]; roles: RoleDecision; warnings: TranscriptWarning[] } {
  const roles = assignRoles(parsed.turns, named ?? parsed.interviewee, {
    labelsUnclear: parsed.warnings.some((w) => w.code === 'labels_unclear'),
    anonymous: parsed.warnings.some((w) => w.code === 'no_speakers'),
    ...(parsed.intervieweeHint ? { intervieweeHint: parsed.intervieweeHint } : {}),
  });
  const tellers = new Set(roles.interviewees);
  // words nobody was labelled for that read as the teller's (the start of a tape that began
  // mid-answer, an answer the diarizer left without a speaker) are HERS: never silently nobody's
  const teller = roles.interviewees.length === 1 ? roles.interviewees[0]! : null;
  const placed = teller !== null ? unknownForTeller(parsed.turns, teller) : new Set<number>();
  const src = parsed.turns.map((t, i) => (placed.has(i) ? { ...t, speaker: teller! } : t));
  const out: Turn[] = [];
  let folded = 0;
  // A guess a person still has to confirm folds nothing: folded with the WRONG roles, the
  // relative's one-word answers would be the "interviewer's mm-hm" and vanish from the preview.
  const settled = !roles.needsConfirmation;
  for (let i = 0; settled && i < src.length; i++) {
    const t = src[i]!;
    const before = out[out.length - 1];
    const after = src[i + 1];
    if (
      before &&
      after &&
      before.speaker === after.speaker &&
      before.speaker !== t.speaker &&
      isBackchannel(t.text)
    ) {
      // "Right?" / "No, it was my uncle.": folded, her "No." would read as taking back her own sentence
      const listener =
        !tellers.has(t.speaker) && tellers.has(before.speaker) && !CONTRADICTS.test(after.text);
      const listening =
        tellers.has(t.speaker) &&
        !tellers.has(before.speaker) &&
        isListening(t.text) &&
        !looksLikeAsking(before.text);
      if (listener || listening) {
        folded++;
        if (before.text.length + 1 + after.text.length <= MAX_TURN_CHARS) {
          before.text = `${before.text} ${after.text}`;
          before.end = after.end ?? before.end;
          i++; // `after` is now part of `before`
        }
        continue;
      }
    }
    out.push({ ...t });
  }
  const turns = (settled ? out : src).map((t, index) => ({ ...t, index }));
  const warnings = [...parsed.warnings];
  if (placed.size > 0) warnings.push({ code: 'unlabelled_to_teller', count: placed.size });
  // the person chose: what that choice leaves out is their call, but the result keeps a trace of it
  if (roles.source === 'sender' && roles.leftOut) {
    warnings.push({ code: 'speaker_left_out', count: roles.leftOut });
  }
  if (folded > 0) warnings.push({ code: 'backchannels_merged', count: folded });
  return { turns, roles, warnings };
}
