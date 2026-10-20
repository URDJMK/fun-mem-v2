import { isBackchannel, looksLikeAsking } from './question-cues';
import { ASKER_LABEL, QUESTIONS, TELLER_LABEL, UNKNOWN, baseLabel } from './speaker-ids';
import type { Turn } from './transcript';

/**
 * Who is being remembered, and how sure we are.
 *
 * This is the decision with the worst failure mode in ingestion: guess the wrong
 * voice and the INTERVIEWER's words are filed as the family's testimony, or the
 * relative's words are thrown away as "questions". So the answer carries its
 * confidence, and the caller asks a person ("who is telling these memories?")
 * before saving anything that is not a sure answer.
 *
 *   sender    the transcript or the caller named the interviewee: trusted
 *   guess     inferred from the labels, who talks most, and who asks the questions
 *
 * A guess is HIGH only when the evidence agrees: the labels say who asks and the turns do
 * not contradict them, or one speaker talks at least twice as much as the next AND their
 * turns read as telling while another speaker's read as asking. Anything weaker is MEDIUM,
 * and any contradiction is LOW. Both are confirmed by a person before saving.
 *
 * Nothing anybody TOLD may be dropped without a person seeing it. A speaker who is not the
 * teller but says something at length (a misread label, "Granny:" once among "Grandma:", or
 * an answer the diarizer gave the interviewer's id), or a third voice who answers the
 * questions ("Grandpa: Nineteen sixty."), makes the guess LOW: "others may tell".
 *
 * "Asking" is measured by `looksLikeAsking`: a question mark, a question word in front, or
 * an invitation ("Tell me about…"), because speech-to-text may leave out the question mark
 * and many interviewers prompt with statements.
 *
 * Those cues read English. Words in any other script are plain text to them: nothing in them
 * asks, so "this voice never asks" cannot be known, and a single unlabelled voice of such
 * text is never a sure answer (the interviewer's questions would be filed as testimony).
 */

export interface SpeakerSummary {
  id: string;
  turns: number;
  chars: number;
  /** turns that contain a question mark */
  questions: number;
  role: 'interviewee' | 'interviewer';
}

export type RoleReason =
  | 'named_by_sender'
  | 'named_speaker_not_found'
  | 'monologue'
  | 'questions_guessed'
  | 'clear_majority'
  | 'likely_majority'
  | 'close_call'
  | 'asks_more_questions'
  | 'many_speakers'
  /** the labels say who asks ("Interviewer", "Q") and so who tells */
  | 'label_says_interviewer'
  /** the speaker picked, or the one the labels call the teller, mostly asks or prompts */
  | 'prompts_like_questions'
  /** another speaker also tells at length: a second relative, or words we could not place */
  | 'others_may_tell'
  /** lines look labelled but the labels could not be read */
  | 'labels_unclear'
  /** words with no speaker label (a tape that starts mid-answer, an answer the diarizer left
   * unattributed) were given to the teller: right in most files, but a person must see it */
  | 'unlabelled_to_teller'
  /** most of the words are in a script the question cues cannot read: whether the voice asks is unknown */
  | 'script_not_read';

export interface RoleDecision {
  speakers: SpeakerSummary[];
  /** the first interviewee: what older callers read ('' when nobody could be picked) */
  interviewee: string;
  /** every speaker whose words are testimony */
  interviewees: string[];
  source: 'sender' | 'guess';
  confidence: 'high' | 'medium' | 'low';
  reasons: RoleReason[];
  /** anything but a sure answer must not be saved without a person confirming it */
  needsConfirmation: boolean;
  /** turns that may be someone's testimony and that these roles leave out (a third voice, unplaced words) */
  leftOut?: number;
}

/** What the parser knows that the turns alone do not say. */
export interface RoleHints {
  /** the parser saw lines that look labelled but could not read the labels */
  labelsUnclear?: boolean;
  /** the file said nothing about who speaks: the one "voice" may be two people */
  anonymous?: boolean;
  /** the speaker an "Interviewee: Sunja Kim" header names: the teller, unless the turns say more */
  intervieweeHint?: string;
}

interface Stat {
  turns: number;
  chars: number;
  questions: number;
  prompts: number;
  /** turns that do not read as asking, and their characters */
  told: number;
  toldChars: number;
  /** turns that do not ask, right after another speaker's question: answers */
  answers: number;
  /** turns of four words or more that do not ask */
  remarks: number;
  /** passages that STATE something at length (not the preface of the speaker's own question) */
  statements: number;
  /** turns that are only "Mm-hm.", "I see." */
  backchannels: number;
  /** where the speaker first speaks, and what */
  first: number;
  firstText: string;
}

type Confidence = RoleDecision['confidence'];
type Role = 'asker' | 'teller';

/** A non-top speaker who tells at this length, in two turns or more, may be a second relative. */
const OTHER_TELLER_CHARS = 40;
/** A passage of this many words that states rather than asks is something a speaker TOLD */
const STATEMENT_WORDS = 12;
/** a third voice's turn of this many words that does not ask may be testimony */
const REMARK_WORDS = 4;
/** "Interviewee: Sunja Kim" at the top of a file is a header, not a turn of speech */
const HEADER_WORDS = 8;
/** a header is a handful of lines */
const MAX_HEADERS = 8;
/** talk about the recording itself is nobody's testimony */
const META =
  /\b(?:record(?:s|ed|ing|er)?|microphone|mic|tape|camera|interview(?:s|ed|ing)?|battery|batteries)\b/i;

const SENTENCES = /(?<=[.!?…])\s+|\n+/;
const wordsIn = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** how many letters are looked at to tell what script a voice is written in */
const SCRIPT_SAMPLE = 20_000;
const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;

/**
 * Are most of the letters outside the Latin alphabet? The question cues read English; in another
 * script they find nothing, so the absence of questions proves nothing. Looks at the first
 * SCRIPT_SAMPLE letters, so a long transcript costs no more than a short one.
 */
function mostlyOtherScript(texts: string[]): boolean {
  let letters = 0;
  let other = 0;
  for (const text of texts) {
    for (const ch of text) {
      if (!LETTER.test(ch)) continue;
      letters++;
      if (!LATIN.test(ch)) other++;
      if (letters >= SCRIPT_SAMPLE) return other * 2 > letters;
    }
  }
  return other * 2 > letters;
}

/**
 * Passages of a turn that STATE something at length: runs of sentences that do not ask, of
 * STATEMENT_WORDS or more. The run a speaker opens a question with ("I remember the house you
 * grew up in, by the river. What was it like?") is a preface, not a statement; talk about the
 * recording is not one either.
 */
function statementsIn(text: string): number {
  let found = 0;
  let run: string[] = [];
  let runStartsTurn = true;
  let atStart = true;
  const close = (askingFollows: boolean) => {
    if (run.length === 0) return;
    const said = run.join(' ');
    const long = wordsIn(said) >= STATEMENT_WORDS;
    if (long && !(runStartsTurn && askingFollows) && !META.test(said)) found++;
    run = [];
  };
  for (const sentence of text.split(SENTENCES)) {
    if (sentence.trim() === '') continue;
    if (looksLikeAsking(sentence)) {
      close(true);
      atStart = false;
      continue;
    }
    if (run.length === 0) runStartsTurn = atStart;
    run.push(sentence);
    atStart = false;
  }
  close(false);
  return found;
}

const tokensOf = (s: string): string[] =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');

/** The name a header line gives: "Sunja Kim" of "Sunja Kim (born 1946), Busan". */
const headerName = (text: string): string => text.split(/[(,;:–—]| - /)[0]!.trim();

/**
 * Who a header's names refer to: "Sunja" or "Kim Sunja" for "Sunja Kim". Built once over every
 * candidate speaker, so a file of 40,000 one-line "speakers" stays linear (an index per token,
 * then a handful of header names looked up in it).
 */
function nameIndex(candidates: string[]): (name: string) => string | null {
  const tokensById = new Map<string, string[]>();
  const byToken = new Map<string, string[]>();
  for (const id of candidates) {
    const have = tokensOf(baseLabel(id));
    if (have.length === 0) continue;
    tokensById.set(id, have);
    for (const w of new Set(have)) {
      const ids = byToken.get(w);
      if (ids) ids.push(id);
      else byToken.set(w, [id]);
    }
  }
  return (name: string) => {
    const want = tokensOf(name);
    if (want.length === 0) return null;
    const hits = new Set<string>();
    for (const w of want) {
      for (const id of byToken.get(w) ?? []) {
        const have = tokensById.get(id)!;
        if (have.every((x) => want.includes(x)) || want.every((x) => have.includes(x)))
          hits.add(id);
      }
    }
    return hits.size === 1 ? [...hits][0]! : null;
  };
}

/** "Noah Kim (interviewer), Sunja Kim (interviewee)": names a header line gives a role to */
const ROLE_IN_PARENS = /^\s*([^()]{1,40}?)\s*\(([^()]{1,20})\)\s*$/;

/* ── words above the first label ─────────────────────────────────────── */

/** "Interview date: March 1, 2024", "Date of birth: …": a header field, never speech */
const KEY_VALUE = /^[\p{Lu}\p{Lo}][\p{L}\p{N} '’.&/()-]{0,30}:\s*\S/u;
/** an e-mail address or attribution, a "Speaker 1 = Noah" legend, a rule of dashes: never speech */
const MAIL_SHAPE = /@[\w-]+\.\w|\bwrote:|-{3,}|\b\w+[ \t]?\d*[ \t]?=[ \t]?\S/iu;
/** on a short line: a time, a duration, a weekday date, an all-capitals heading ("45m 12s", "Tue, 5/12 9:15AM") */
const TIME_SHAPE =
  /\b\d{1,2}:\d{2}(?::\d{2})?\b|\b\d+[ \t]?(?:h|hr|hrs|m|min|mins|s|sec|secs)\b|\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,[ \t]|^[\p{Lu}\s]{6,}$/iu;
/** "Okay, so, …" in front of what an interviewer opens with */
const OPENER = String.raw`(?:(?:okay|ok|alright|all right|so|well|right|um|uh|now|and)[,.!\s]+)*`;
/** what an interviewer calls the relative: "Grandma, …" */
const KIN = String.raw`(?:grandma|grandmother|granny|nana|grandpa|grandfather|papa|mom|mother|dad|father|aunt\w*|uncle\w*)`;
/** the interviewer opening the session: a greeting, thanks, a sound check, "today is…", "this is…" */
const INTRO = new RegExp(
  String.raw`^${OPENER}(?:${KIN}[,!\s]+)?(?:hello|hi|hey|good (?:morning|afternoon|evening|day)|welcome|thank(?:s| you)|testing|test\b|can you hear|are you ready|ready when you are|is (?:this|it) (?:on|working|recording)|today(?: is|,| we| i\b)|this is\b|i(?:'m| am) here with|we(?:'re| are) here\b|my name is|let'?s (?:start|begin|get started|do this)|shall we (?:start|begin)|let me (?:start|check|turn)|(?:we(?:'re| are)|i(?:'m| am)) (?:recording|starting|going to start|good to go|ready|all set|rolling|live)\b|for the (?:family|record|archive))`,
  'i',
);
const VOCATIVE = new RegExp(String.raw`^${OPENER}${KIN}\s?[,!]`, 'i');
/** how a tape that began mid-answer starts: "and that is why…", "…because" */
const CUT_START =
  /^(?:\.{2,}|…|(?:and|but|so|because|cause|'cause|then|or|which|who|that|when|while|after|before|until|till|since|though|although|anyway|also|plus)\b)/i;
/** words a sentence is made of: a lower-case passage with these is speech cut short, not a title */
const FUNCTION_WORD =
  /\b(?:the|a|an|was|were|is|are|we|i|he|she|they|my|his|her|our|their|to|of|in|at|on|had|did|would)\b/i;

/**
 * What a passage with no speaker ABOVE the first label is. Only a passage cut off mid-answer
 * ("and that is why we never went back…") may be the teller's; an
 * interviewer's greeting ("Hello Grandma, thank you…"), a sound check, an intro ("Today is March
 * 1st and I am here with…"), a header field, an e-mail attribution or a question never is. Those
 * were filed as her memory at HIGH confidence once (round 3), dated and titled with the header.
 */
export function leadKind(text: string, teller: string): 'not' | 'cut' | 'unclear' {
  const t = text.trim();
  if (!/[\p{L}\p{N}]/u.test(t) || META.test(t)) return 'not';
  // "which was the hardest winter we ever had": lower case and not addressed to her, a sentence
  // cut short, though "which" can open a question ("where were you born" asks: it says "you")
  const cutWh =
    /^\p{Ll}/u.test(t) &&
    /^(?:what|where|when|which|who|why|how|and|so|then)\b/i.test(t) &&
    !t.includes('?') &&
    !/\byou(?:r|rs|'re|'ve|'d)?\b/i.test(t.split(/\s+/).slice(0, 8).join(' '));
  if (looksLikeAsking(t) && !cutWh) return 'not';
  if (KEY_VALUE.test(t) || MAIL_SHAPE.test(t) || (wordsIn(t) <= 10 && TIME_SHAPE.test(t)))
    return 'not';
  const head = t.slice(0, 120);
  if (INTRO.test(head) || VOCATIVE.test(head)) return 'not';
  if (cutWh || CUT_START.test(t)) return 'cut';
  if (/^\p{Ll}/u.test(t) && wordsIn(t) >= 6 && FUNCTION_WORD.test(t)) return 'cut';
  // a title or a line about her ("Grandma Sunja's story", "family history project grandma sunja")
  const names = tokensOf(baseLabel(teller));
  if (names.length > 0 && tokensOf(t).some((w) => names.includes(w))) return 'not';
  return 'unclear';
}

/**
 * Words nobody was labelled for that read as the TELLER's: the start of a tape that began
 * mid-answer (above the first label, shaped like speech cut short, when the first labelled turn
 * is not hers), and a passage with no speaker right after another speaker's question (an answer
 * the diarizer left unattributed). Never a question, a greeting, a header, talk about the
 * recording. Returns turn positions.
 */
export function unknownForTeller(turns: Turn[], teller: string): Set<number> {
  const out = new Set<number>();
  // the next labelled speaker after each position, read back to front (one pass each way: linear)
  const nextLabelled: Array<string | null> = new Array(turns.length).fill(null);
  for (let i = turns.length - 2; i >= 0; i--) {
    const n = turns[i + 1]!;
    nextLabelled[i] = n.speaker !== UNKNOWN ? n.speaker : (nextLabelled[i + 1] ?? null);
  }
  let prev: Turn | null = null;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.speaker !== UNKNOWN) {
      prev = t;
      continue;
    }
    const placed =
      prev === null
        ? nextLabelled[i] !== null &&
          nextLabelled[i] !== teller &&
          leadKind(t.text, teller) === 'cut'
        : /[\p{L}\p{N}]/u.test(t.text) &&
          !looksLikeAsking(t.text) &&
          !META.test(t.text) &&
          prev.speaker !== teller &&
          looksLikeAsking(prev.text);
    if (placed) out.add(i);
  }
  return out;
}

export function assignRoles(
  turns: Turn[],
  named?: string | string[],
  hints: RoleHints = {},
): RoleDecision {
  const stats = new Map<string, Stat>();
  const asking = turns.map((t) => looksLikeAsking(t.text));
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const s = stats.get(t.speaker) ?? {
      turns: 0,
      chars: 0,
      questions: 0,
      prompts: 0,
      told: 0,
      toldChars: 0,
      answers: 0,
      remarks: 0,
      statements: 0,
      backchannels: 0,
      first: i,
      firstText: t.text,
    };
    s.turns++;
    s.chars += t.text.length;
    if (t.text.includes('?')) s.questions++;
    if (asking[i]) {
      s.prompts++;
    } else {
      s.told++;
      s.toldChars += t.text.length;
      if (i > 0 && turns[i - 1]!.speaker !== t.speaker && asking[i - 1]) s.answers++;
      if (wordsIn(t.text) >= REMARK_WORDS) s.remarks++;
    }
    s.statements += statementsIn(t.text);
    if (isBackchannel(t.text)) s.backchannels++;
    stats.set(t.speaker, s);
  }
  const stat = (id: string): Stat => stats.get(id)!;
  // a quiet interviewer's "Mm-hm." and "I see." neither ask nor tell: they do not count either way
  const promptShare = (id: string): number =>
    stat(id).prompts / Math.max(1, stat(id).turns - stat(id).backchannels);
  /** most of their turns ask or prompt */
  const asks = (id: string): boolean => promptShare(id) > 0.5;
  /** most of their turns tell */
  const tells = (id: string): boolean => promptShare(id) < 0.5;

  const reasons: RoleReason[] = [];
  const because = (...rs: RoleReason[]) => {
    for (const r of rs) if (!reasons.includes(r)) reasons.push(r);
  };
  let forceLow = false;

  const byLower = new Map([...stats.keys()].map((id) => [id.toLowerCase(), id] as const));
  const find = (x: string): string | null => {
    const raw = x.trim().replace(/\s+/g, ' ');
    const forms = /^\d{1,3}$/.test(raw) ? [raw, `SPEAKER_${raw.padStart(2, '0')}`] : [raw];
    for (const f of forms) {
      const hit = stats.has(f) ? f : byLower.get(f.toLowerCase());
      if (hit && hit !== QUESTIONS) return hit;
    }
    return null;
  };

  /* who is a voice, what the labels say, and what is a header (the sender's choice needs it too) */
  const real = [...stats.keys()].filter((id) => id !== QUESTIONS);
  const byChars = (ids: string[]) => [...ids].sort((a, b) => stat(b).chars - stat(a).chars);

  // what the label itself says: "Interviewer", "Q" ask; "Interviewee", "A" next to "Q" tell
  const hasQ = real.some((id) => /^q$/i.test(baseLabel(id)));
  const labelRole = (id: string): Role | null => {
    const b = baseLabel(id);
    if (TELLER_LABEL.test(b) && (b.toLowerCase() !== 'a' || hasQ)) return 'teller';
    if (ASKER_LABEL.test(b)) return 'asker';
    return null;
  };
  // The top of a file may hold a header: "Interviewee: Sunja Kim", "Consent: yes, recorded with
  // permission", "Participants: Noah Kim (interviewer), Sunja Kim (interviewee)". A speaker who
  // speaks once, briefly and without asking, before anyone has spoken twice, is a header line:
  // never testimony, never a voice that makes the guess ask, and a hint for who is who. A real
  // header is a handful of lines: only the first few count (40,000 one-line "speakers" once
  // took 84 seconds here).
  const recurring = real.filter((id) => id !== UNKNOWN && stat(id).turns >= 2);
  const firstRecurring = recurring.reduce((m, id) => Math.min(m, stat(id).first), turns.length);
  const headers = new Set<string>();
  for (const id of real) {
    if (recurring.length === 0 || headers.size >= MAX_HEADERS) break;
    const st = stat(id);
    if (st.first >= firstRecurring) break; // speakers are in the order they first speak
    if (id === UNKNOWN || st.turns !== 1 || asking[st.first]) continue;
    if (wordsIn(st.firstText) <= HEADER_WORDS) headers.add(id);
  }
  const plain = real.filter((id) => !headers.has(id) && labelRole(id) === null && id !== UNKNOWN);
  const named2 = new Map<string, Role>();
  if (headers.size > 0 || hints.intervieweeHint) {
    const who = nameIndex(plain);
    const give = (name: string, role: Role | null) => {
      const id = role ? who(name) : null;
      if (id && role && !named2.has(id)) named2.set(id, role);
    };
    for (const h of headers) {
      const role = labelRole(h);
      if (role) give(headerName(stat(h).firstText), role);
      // "Participants: Noah Kim (interviewer), Sunja Kim (interviewee)"
      for (const part of stat(h).firstText.split(/[,;]/)) {
        const m = ROLE_IN_PARENS.exec(part);
        if (!m) continue;
        const word = m[2]!.trim();
        give(m[1]!, TELLER_LABEL.test(word) ? 'teller' : ASKER_LABEL.test(word) ? 'asker' : null);
      }
    }
    // a name an "Interviewee: …" header gave the reader: a hint as strong as a label, not the
    // sender's word, so a second relative who tells at length still makes the guess ask
    if (hints.intervieweeHint) {
      const id = find(hints.intervieweeHint);
      if (id && !headers.has(id) && labelRole(id) === null) named2.set(id, 'teller');
    }
  }
  const voices = real.filter((id) => !headers.has(id));
  const roleOf = (id: string): Role | null => labelRole(id) ?? named2.get(id) ?? null;

  /* 1. named by the sender: an id as written, a number as WhisperX writes it, any case */
  const asked = [
    ...new Set(
      (Array.isArray(named) ? named : named !== undefined ? [named] : []).filter(
        (x): x is string => typeof x === 'string' && x.trim() !== '',
      ),
    ),
  ];
  const found = [...new Set(asked.map(find).filter((x): x is string => x !== null))];
  if (found.length > 0) {
    because('named_by_sender');
    let confidence: Confidence = 'high';
    if (found.length < asked.length) {
      because('named_speaker_not_found');
      confidence = 'low';
    }
    return decide(found, 'sender', confidence);
  }
  if (asked.length > 0) {
    // the sender said who, and that person is not here: a guess, and a person must look
    because('named_speaker_not_found');
    forceLow = true;
  }

  /* 2. a guess */
  if (real.length === 0) return decide([], 'guess', 'low');

  let interviewees: string[];
  let confidence: Confidence;
  // 2a. labels that say who asks ("Interviewer", "Q") or who tells ("A" next to "Q")
  const askers = voices.filter((id) => roleOf(id) === 'asker');
  const tellers = voices.filter((id) => roleOf(id) === 'teller');
  const labelled =
    (askers.length > 0 && askers.length < voices.length) ||
    (tellers.length > 0 && tellers.length < voices.length);
  if (labelled) {
    because('label_says_interviewer');
    const askerSet = new Set(askers);
    const others = voices.filter((id) => !askerSet.has(id) && id !== UNKNOWN);
    interviewees = tellers.length > 0 ? tellers : others.filter((id) => !asks(id));
    if (interviewees.length === 0)
      interviewees = byChars(others.length > 0 ? others : voices).slice(0, 1);
    // the turns must not contradict the labels (a file that calls the relative "Interviewer")
    const contradicts =
      interviewees.some((id) => asks(id) && stat(id).turns >= 2) &&
      askers.some((id) => tells(id) && stat(id).turns >= 2);
    if (contradicts) {
      confidence = 'low';
      because('prompts_like_questions');
    } else if (interviewees.some((id) => asks(id) && stat(id).turns >= 2)) {
      // the one the labels leave as the teller mostly asks: not a sure answer
      confidence = 'medium';
      because('prompts_like_questions');
    } else {
      confidence = interviewees.length === 1 ? 'high' : 'medium';
    }
  } else {
    // 2b. who talks most, and whether their turns read as telling
    const pool = voices.filter((id) => id !== UNKNOWN);
    const sorted = byChars(pool.length > 0 ? pool : voices);
    const top = sorted[0]!;
    interviewees = [top];
    if (sorted.length === 1) {
      if (stats.has(QUESTIONS)) {
        confidence = 'medium';
        because('questions_guessed');
      } else if (asks(top) || (hints.anonymous && stat(top).prompts > 0)) {
        // one voice that asks: an interviewer and a relative the file did not tell apart
        confidence = 'medium';
        because('monologue', 'prompts_like_questions');
      } else if (mostlyOtherScript(turns.filter((t) => t.speaker === top).map((t) => t.text))) {
        // the cues cannot read this script: "never asks" is not known, so a person must say
        confidence = 'medium';
        because('monologue', 'script_not_read');
      } else {
        confidence = 'high';
        because('monologue');
      }
    } else {
      const second = sorted[1]!;
      const total = sorted.reduce((n, id) => n + stat(id).chars, 0);
      const ratio = stat(top).chars / Math.max(1, stat(second).chars);
      const qTop = stat(top).questions / stat(top).turns;
      const qSecond = stat(second).questions / stat(second).turns;
      const rest = sorted.slice(1);
      // the other asks, or only listens ("Mm-hm.", "I see.") and asks: never tells anything
      const listensOrAsks = (id: string) =>
        asks(id) || (stat(id).turns >= 2 && stat(id).told === stat(id).backchannels);
      const shapeAgrees = tells(top) && rest.some(listensOrAsks);
      const shapeConflicts = asks(top) && rest.some((id) => tells(id));
      if (sorted.length >= 3 && stat(top).chars / total < 0.6) {
        confidence = 'low';
        because('many_speakers');
      } else if (qTop - qSecond > 0.3 || shapeConflicts) {
        // the one who talks most is also the one asking the questions
        confidence = 'low';
        if (qTop - qSecond > 0.3) because('asks_more_questions');
        if (shapeConflicts) because('prompts_like_questions');
      } else if (ratio >= 2) {
        confidence = shapeAgrees ? 'high' : 'medium';
        because('clear_majority');
      } else if (ratio >= 1.3) {
        // a relative who answers briefly: sure only when the shape is plain, nearly every turn of
        // hers telling and nearly every one of the other's asking
        const plainShape =
          promptShare(top) <= 0.2 &&
          rest.some((id) => promptShare(id) >= 0.8 && stat(id).turns >= 3);
        confidence = plainShape ? 'high' : 'medium';
        because('likely_majority');
      } else {
        confidence = 'low';
        because('close_call');
      }
    }
    // Everything under one "Interviewer" or "Q": the relative's label was not read (a header the
    // reader did not know, a second voice inside a subtitle cue). Never a sure monologue.
    if (interviewees.some((id) => roleOf(id) === 'asker')) {
      confidence = 'low';
      because('label_says_interviewer', 'labels_unclear');
    }
  }

  /* 3. someone else also tells: a second relative, a misread label, words with no speaker */
  const totalReal = voices.reduce((n, id) => n + stat(id).chars, 0);
  const tellerSet = new Set(interviewees);
  const listeners = voices.filter((id) => !tellerSet.has(id) && id !== UNKNOWN);
  // the interviewer: of those not telling, whoever asks the most
  const principal = [...listeners].sort(
    (a, b) => stat(b).prompts - stat(a).prompts || stat(b).turns - stat(a).turns,
  )[0];
  const placed =
    interviewees.length === 1 ? unknownForTeller(turns, interviewees[0]!) : new Set<number>();
  // a passage with no speaker that is told, and that we cannot give to the teller
  const firstLabelled = turns.findIndex((t) => t.speaker !== UNKNOWN);
  const teller = interviewees.length === 1 ? interviewees[0]! : '';
  const unplaced = turns.some(
    (t, i) =>
      t.speaker === UNKNOWN &&
      !placed.has(i) &&
      !asking[i] &&
      wordsIn(t.text) >= REMARK_WORDS &&
      !META.test(t.text) &&
      // above the first label only a passage that may be speech counts; a greeting or a header never
      (i > firstLabelled || leadKind(t.text, teller) === 'unclear'),
  );
  const othersTell =
    unplaced ||
    voices.some((id) => {
      if (tellerSet.has(id)) return false;
      const s = stat(id);
      if (id === UNKNOWN) {
        // a big passage nobody could place (the words given to the teller are hers, not "another")
        let left = 0;
        for (let i = 0; i < turns.length; i++) {
          if (turns[i]!.speaker === UNKNOWN && !placed.has(i) && !asking[i])
            left += turns[i]!.text.length;
        }
        return left >= OTHER_TELLER_CHARS && left * 4 >= totalReal;
      }
      // a speaker the labels call the asker may make remarks of their own
      if (roleOf(id) === 'asker') return false;
      // something told at length: a misread label ("Granny:" once), or an answer under the interviewer's id
      if (s.statements > 0) return true;
      // a third voice who answers the questions, or tells: a second relative
      if (id !== principal && (s.answers > 0 || s.remarks > 0)) return true;
      return voices.length >= 3 && s.told >= 2 && s.toldChars / s.told >= OTHER_TELLER_CHARS;
    });
  if (othersTell) {
    confidence = 'low';
    because('others_may_tell');
  }
  // words with no speaker given to the teller (a tape that starts mid-answer, an answer with no
  // speaker after a question): right in most files, but a guess that did it is never HIGH
  if (placed.size > 0 && confidence === 'high') {
    confidence = 'medium';
    because('unlabelled_to_teller');
  }
  if (hints.labelsUnclear) {
    confidence = 'low';
    because('labels_unclear');
  }
  return decide(interviewees, 'guess', forceLow ? 'low' : confidence);

  function decide(ids: string[], source: RoleDecision['source'], conf: Confidence): RoleDecision {
    const idSet = new Set(ids);
    const one = ids.length === 1 ? ids[0]! : null;
    const given = one !== null ? unknownForTeller(turns, one) : new Set<number>();
    // words with no speaker that all went to the teller are hers: no separate "UNKNOWN" voice
    let unknownGiven = stats.has(UNKNOWN);
    for (let i = 0; unknownGiven && i < turns.length; i++) {
      if (turns[i]!.speaker === UNKNOWN && !given.has(i)) unknownGiven = false;
    }
    const speakers: SpeakerSummary[] = [...stats.entries()]
      .filter(([id]) => !(id === UNKNOWN && unknownGiven))
      .map(([id, s]) => ({
        id,
        turns: s.turns,
        chars: s.chars,
        questions: s.questions,
        role: idSet.has(id) ? 'interviewee' : 'interviewer',
      }));
    const leftOut = leftOutBy(idSet, one, given);
    return {
      speakers,
      interviewee: ids[0] ?? '',
      interviewees: ids,
      source,
      confidence: conf,
      reasons,
      needsConfirmation: conf === 'low' || (source === 'guess' && conf !== 'high'),
      ...(leftOut > 0 ? { leftOut } : {}),
    };
  }

  /**
   * Turns that may be testimony and are not the tellers': a third voice's remarks, a passage with
   * no speaker nobody placed. The interviewer's own turns, headers and questions are not counted.
   */
  function leftOutBy(idSet: Set<string>, one: string | null, given: Set<number>): number {
    let principalHere: string | null = null;
    let most = -1;
    for (const id of real) {
      if (idSet.has(id) || id === UNKNOWN || headers.has(id)) continue;
      if (stat(id).prompts > most) {
        most = stat(id).prompts;
        principalHere = id;
      }
    }
    const firstLabelledHere = turns.findIndex((t) => t.speaker !== UNKNOWN);
    let n = 0;
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i]!;
      if (idSet.has(t.speaker) || headers.has(t.speaker) || t.speaker === QUESTIONS) continue;
      if (asking[i] || given.has(i) || wordsIn(t.text) < REMARK_WORDS) continue;
      if (t.speaker === UNKNOWN) {
        if (
          !META.test(t.text) &&
          (i > firstLabelledHere || leadKind(t.text, one ?? '') === 'unclear')
        )
          n++;
      } else if (t.speaker !== principalHere && roleOf(t.speaker) !== 'asker') {
        n++;
      }
    }
    return n;
  }
}
