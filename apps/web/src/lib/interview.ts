/**
 * What an interview is while it is being recorded and read over: the words, who said them, what
 * the interviewer told Firepit at the start (what it is about, who is in the room, and which
 * voice is whose), and the notes they wrote as it went. Kept in the browser as it happens, so a
 * closed tab loses nothing. The audio is held in memory only until the whole recording has been
 * transcribed once more at the end (InterviewReview), then let go.
 */
import type { FreeTopic, RecordedSegment } from './api';
import type { LiveFailure, Segment } from './live';
import { wordCount } from './listen';

export type Mode = 'room' | 'call';

export type Role = 'teller' | 'asker' | 'listener';

export interface Person {
  id: string;
  name: string;
  role: Role;
  /** what they called themselves when introduced ("Nell" for "Grandma Nell"), to address them by */
  call?: string;
}

export interface Setup {
  /** the interviewer's own words about what today is for */
  about: string;
  /** topic ids from lib/questions.ts */
  topics: string[];
  /** topics in the interviewer's own words, read out of what they said today is about */
  free?: FreeTopic[];
  people: Person[];
  /** a recognised voice (a Deepgram speaker id such as `S2`) → the person it belongs to */
  voices: Record<string, string>;
}

/** a word the transcript mishears, and how the notes spell it */
export interface Respelling {
  from: string;
  to: string;
}

/** a line the interviewer wrote, and when in the recording */
export interface Note {
  /** seconds into the recording */
  at: number;
  text: string;
}

export interface Draft {
  mode: Mode;
  startedAt: string;
  segments: Segment[];
  setup?: Setup;
  notes?: Note[];
  /** the names Deepgram listened for, for the second transcription at the end */
  keyterms?: string[];
  /** mishearings found from the notes while recording ("THCL" is "NLCS"), made everywhere */
  respell?: Respelling[];
  /** the segments are the full recording's transcription, not the live one */
  retranscribed?: boolean;
  /** set once "Write the stories" has started this job; cleared only once it is saved */
  submittedJobId?: string;
}

const draftKey = (archiveId: string) => `firepit-live-draft:${archiveId}`;

export function readDraft(archiveId: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(archiveId));
    const d = raw ? (JSON.parse(raw) as Draft) : null;
    return d && Array.isArray(d.segments) && d.segments.length > 0 ? d : null;
  } catch {
    return null;
  }
}

/**
 * Keep the interview `d`, or with `null` let go of the one kept for this project. One with no
 * words yet changes nothing: an interview that has only just started must not erase the
 * unfinished one waiting to be picked up (its words exist nowhere else).
 */
export function writeDraft(archiveId: string, d: Draft | null): void {
  try {
    if (d === null) window.localStorage.removeItem(draftKey(archiveId));
    else if (d.segments.length > 0)
      window.localStorage.setItem(draftKey(archiveId), JSON.stringify(d));
  } catch {
    /* storage refused: the interview is still on the page */
  }
}

/** Signing out: no unfinished interview stays in this browser for whoever uses it next. */
export function clearDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(draftKey(''))) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    /* storage refused: there is nothing kept to let go of */
  }
}

export function newSetup(subjectName: string, interviewerName: string): Setup {
  return {
    about: '',
    topics: [],
    people: [
      { id: 'p1', name: subjectName, role: 'teller' },
      { id: 'p2', name: interviewerName, role: 'asker' },
    ],
    voices: {},
  };
}

/**
 * Who said it, as a person's name wherever Firepit knows it: on a call the two channels say who
 * is who; in the room a voice is named once its owner has introduced themselves. Any other voice
 * is numbered in the order it was first heard.
 */
export function speakerLabels(
  segments: Segment[],
  mode: Mode,
  setup: Setup | undefined,
  subjectName: string,
): Map<string, string> {
  const m = new Map<string, string>();
  const person = (id: string | undefined) => setup?.people.find((p) => p.id === id);
  if (mode === 'call') {
    const asker = setup?.people.find((p) => p.role === 'asker');
    const teller = setup?.people.find((p) => p.role === 'teller');
    m.set('mic', asker?.name || 'You');
    m.set('call', teller?.name || subjectName);
    return m;
  }
  let unnamed = 0;
  const seen = [...Object.keys(setup?.voices ?? {}), ...segments.map((s) => s.speaker)];
  for (const sp of seen) {
    if (m.has(sp)) continue;
    const p = person(setup?.voices[sp]);
    m.set(sp, p?.name || `Speaker ${++unnamed}`);
  }
  return m;
}

/** The speaker id whose voice belongs to the person being remembered, when Firepit knows it. */
export function tellerVoice(draft: Draft): string | null {
  if (draft.mode === 'call') return 'call';
  const teller = draft.setup?.people.find((p) => p.role === 'teller');
  if (!teller) return null;
  return Object.entries(draft.setup?.voices ?? {}).find(([, id]) => id === teller.id)?.[0] ?? null;
}

export interface Turn {
  speaker: string;
  start: number;
  text: string;
  /** the segments it is made of */
  ids: number[];
}

/** Consecutive pieces from the same voice read as one turn. */
export function turnsOf(segments: Segment[]): Turn[] {
  const out: Turn[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker) {
      last.text += ` ${s.text}`;
      last.ids.push(s.id);
    } else out.push({ speaker: s.speaker, start: s.start, text: s.text, ids: [s.id] });
  }
  return out;
}

/* ── voices that should not be there ─────────────────────── */

/**
 * a stray voice this close on both sides of one known voice (seconds), and this short (words),
 * is that voice; anything longer may be a real answer between two questions
 */
const SANDWICH_GAP = 1.5;
const SANDWICH_WORDS = 6;

/**
 * Live, Deepgram tells voices apart word by word with nothing of what comes next, and now and
 * then it starts a new voice that is nobody new: a "Speaker 3" in a room of two. Once everyone
 * has been introduced, a voice nobody owns is one of the known voices:
 *
 * - a few words that sit inside one voice's talk (that voice just before and just after, with
 *   no real pause) are that voice, heard for a moment as someone else;
 * - any other stretch of it votes, with the rest of that stray voice, for the person being
 *   remembered or the interviewer: a question is the interviewer's, a long answer the
 *   narrator's, and the voice that just spoke is probably the other one.
 *
 * The segments come back with those voices replaced; one it cannot place keeps its own.
 */
export function resolveVoices(segments: Segment[], setup: Setup | undefined): Segment[] {
  const voices = setup?.voices ?? {};
  const known = (sp: string) => sp in voices;
  if (Object.keys(voices).length === 0 || segments.every((s) => known(s.speaker))) return segments;
  const roleOf = (sp: string) => setup?.people.find((p) => p.id === voices[sp])?.role;
  const tellerV = Object.keys(voices).find((v) => roleOf(v) === 'teller');
  const askerV = Object.keys(voices).find((v) => roleOf(v) === 'asker');

  // the nearest known voice before and after each segment
  const prev: Array<number | null> = [];
  let p: number | null = null;
  for (let i = 0; i < segments.length; i++) {
    prev.push(p);
    if (known(segments[i]!.speaker)) p = i;
  }
  const next: Array<number | null> = new Array<number | null>(segments.length).fill(null);
  let n: number | null = null;
  for (let i = segments.length - 1; i >= 0; i--) {
    next[i] = n;
    if (known(segments[i]!.speaker)) n = i;
  }

  const out = segments.slice();
  const votes = new Map<string, { teller: number; asker: number }>();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (known(s.speaker)) continue;
    const a = prev[i] === null ? null : segments[prev[i]!]!;
    const b = next[i] === null ? null : segments[next[i]!]!;
    if (
      a &&
      b &&
      a.speaker === b.speaker &&
      wordCount(s.text) <= SANDWICH_WORDS &&
      s.start - a.end < SANDWICH_GAP &&
      b.start - s.end < SANDWICH_GAP
    ) {
      out[i] = { ...s, speaker: a.speaker };
      continue;
    }
    const v = votes.get(s.speaker) ?? { teller: 0, asker: 0 };
    if (/\?["'”’)]*$/.test(s.text.trim())) v.asker += 1;
    if (wordCount(s.text) >= 15) v.teller += 1;
    if (a?.speaker === tellerV) v.asker += 0.5;
    if (a?.speaker === askerV) v.teller += 0.5;
    votes.set(s.speaker, v);
  }
  const to = new Map<string, string>();
  for (const [sp, v] of votes) {
    if (v.teller > v.asker && tellerV) to.set(sp, tellerV);
    else if (v.asker > v.teller && askerV) to.set(sp, askerV);
  }
  return out.map((s) => (to.has(s.speaker) ? { ...s, speaker: to.get(s.speaker)! } : s));
}

/* ── the second transcription, of the whole recording ─────── */

/**
 * The full recording's transcription, in the live transcript's voices. On a call each source is
 * its own voice already (`mic`, `call`). In the room, Deepgram numbers the voices afresh; each
 * number becomes the live voice it overlaps most in time, so the names given at the start still
 * hold. A voice that overlaps none is `R1`, `R2`… for the review to name.
 */
export function alignRecorded(
  recorded: Array<{ source: string | null; segments: RecordedSegment[] }>,
  live: Segment[],
): Segment[] {
  const out: Array<Omit<Segment, 'id'>> = [];
  for (const { source, segments } of recorded) {
    if (source !== null) {
      for (const r of segments)
        out.push({ speaker: source, start: r.start, end: r.end, text: r.text });
      continue;
    }
    const overlap = new Map<number, Map<string, number>>();
    for (const r of segments) {
      if (r.speaker === null) continue;
      const row = overlap.get(r.speaker) ?? new Map<string, number>();
      for (const l of live) {
        const o = Math.min(r.end, l.end) - Math.max(r.start, l.start);
        if (o > 0) row.set(l.speaker, (row.get(l.speaker) ?? 0) + o);
      }
      overlap.set(r.speaker, row);
    }
    const voiceOf = (n: number | null) => {
      const row = n === null ? undefined : overlap.get(n);
      const best = row ? [...row.entries()].sort((x, y) => y[1] - x[1])[0] : undefined;
      return best ? best[0] : `R${(n ?? 0) + 1}`;
    };
    for (const r of segments)
      out.push({ speaker: voiceOf(r.speaker), start: r.start, end: r.end, text: r.text });
  }
  return out.sort((a, b) => a.start - b.start).map((s, i) => ({ ...s, id: i + 1 }));
}

/* ── notes ───────────────────────────────────────────────── */

const COMMON = new Set(
  `i a an the and or but so to of in on at for with he she they we it his her their my our
  then when where what who how went moved talk talked told later also`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * The words in the notes worth listening for: acronyms ("NLCS") and names ("North London",
 * "Mrs Park"). A capital that only starts a note does not count, unless the note is just a name
 * or two. Boosting an ordinary word makes it heard where it was not said, so these are few.
 */
export function noteTerms(notes: readonly string[]): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const note of notes) {
    const words = note
      .split(/[\s,;:!?()“”"/]+/)
      .map((w) => w.replace(/^['’]+|['’.]+$/g, ''))
      .filter(Boolean);
    const short = words.length <= 3;
    let run: string[] = [];
    const flush = () => {
      if (run.length) add(run.join(' '));
      run = [];
    };
    words.forEach((w, i) => {
      if (/^[A-Z][A-Z0-9&-]+$/.test(w)) {
        flush();
        return add(w);
      }
      const named = /^\p{Lu}\p{Ll}/u.test(w) && !COMMON.has(w.toLowerCase());
      if (named && (i > 0 || short) && run.length < 3) run.push(w);
      else flush();
    });
    flush();
  }
  return out.slice(0, 20);
}

/** seconds of transcript before a note and after it in which its words are looked for */
const BEFORE_NOTE = 240;
const AFTER_NOTE = 60;

/**
 * The transcript lines said around each note: a note is written during or just after what it is
 * about, so the misheard words are near it. Only these go to the model, not the whole interview.
 */
export function linesNearNotes(
  notes: readonly Note[],
  segments: readonly Segment[],
  max = 400,
): Array<{ id: number; text: string }> {
  return segments
    .filter((s) => notes.some((n) => s.start >= n.at - BEFORE_NOTE && s.start <= n.at + AFTER_NOTE))
    .slice(0, max)
    .map((s) => ({ id: s.id, text: s.text }));
}

/** The transcript with the accepted corrections made: each `from` replaced in its own line. */
export function applyCorrections(
  segments: readonly Segment[],
  fixes: ReadonlyArray<{ id: number; from: string; to: string }>,
): Segment[] {
  return segments.map((s) => {
    const mine = fixes.filter((f) => f.id === s.id);
    return mine.length
      ? { ...s, text: mine.reduce((t, f) => t.split(f.from).join(f.to), s.text) }
      : s;
  });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every line with the mishearings found while recording made right: a word misheard once as
 * "THCL" for the notes' "NLCS" is misheard the same way each time. Whole words only, so a
 * respelling never lands inside another word.
 */
export function respell(segments: Segment[], pairs: readonly Respelling[]): Segment[] {
  if (pairs.length === 0) return segments;
  const rules = pairs.map(
    (p) =>
      [new RegExp(`(?<![\\p{L}\\p{N}])${escape(p.from)}(?![\\p{L}\\p{N}])`, 'gu'), p.to] as const,
  );
  return segments.map((s) => {
    const text = rules.reduce((t, [re, to]) => t.replace(re, to), s.text);
    return text === s.text ? s : { ...s, text };
  });
}

export function clock(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Where the call's sound can come from. Chrome and Edge share a tab's audio everywhere, and on
 * Windows the whole computer's ("Entire screen" + "Share system audio"), which covers the Zoom
 * or Teams desktop app. On a Mac only a tab's.
 */
const ON_WINDOWS = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent);
export const SHARE_HOW = ON_WINDOWS
  ? 'For a call in the browser, share its tab and tick “Also share tab audio”. For the Zoom or Teams app, share “Entire screen” and tick “Share system audio”.'
  : 'Share the call’s browser tab and tick “Also share tab audio”. (A call in the Zoom or Teams app can’t be heard from a browser on a Mac.)';

export type StartFailure = LiveFailure | 'mic' | 'no_call_audio';

export const FAILURE: Record<StartFailure, string> = {
  not_configured:
    'Live transcription isn’t available here yet. You can still bring in a recorded transcript.',
  rate_limited: 'Too many recordings were started just now. Wait a minute, then try again.',
  token: 'Couldn’t start transcribing. Check your connection and try again.',
  connection: 'The connection to the transcription service was lost. What was said so far is kept.',
  unsupported: 'This browser can’t record audio for transcription. Try Chrome or Edge.',
  mic: 'Firepit needs your microphone. Allow it in the address bar, then try again.',
  no_call_audio: `No sound came with the shared screen. ${SHARE_HOW}`,
};

/** Asks for the audio: the microphone, and on a call also the call's tab. */
export async function openSources(
  mode: Mode,
): Promise<{ streams: MediaStream[]; mic: MediaStream }> {
  let mic: MediaStream;
  try {
    mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    throw new Error('mic');
  }
  if (mode === 'room') return { streams: [mic], mic };

  let shared: MediaStream;
  try {
    // browsers only share a tab's sound along with its picture; the picture is dropped at once
    shared = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch {
    mic.getTracks().forEach((t) => t.stop());
    throw new Error('no_call_audio');
  }
  shared.getVideoTracks().forEach((t) => t.stop());
  const audio = shared.getAudioTracks();
  if (audio.length === 0) {
    mic.getTracks().forEach((t) => t.stop());
    throw new Error('no_call_audio');
  }
  return { streams: [mic, new MediaStream(audio)], mic };
}
