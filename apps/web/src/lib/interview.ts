/**
 * What an interview is while it is being recorded and read over: the words, who said them, and
 * what the interviewer told Firepit at the start (what it is about, who is in the room, and which
 * voice is whose). Kept in the browser as it happens, so a closed tab loses nothing; the audio is
 * never kept anywhere.
 */
import type { LiveFailure, Segment } from './live';

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
  people: Person[];
  /** a recognised voice (a Deepgram speaker id such as `S2`) → the person it belongs to */
  voices: Record<string, string>;
}

export interface Draft {
  mode: Mode;
  startedAt: string;
  segments: Segment[];
  setup?: Setup;
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
}

/** Consecutive pieces from the same voice read as one turn. */
export function turnsOf(segments: Segment[]): Turn[] {
  const out: Turn[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker) last.text += ` ${s.text}`;
    else out.push({ speaker: s.speaker, start: s.start, text: s.text });
  }
  return out;
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
    'Live transcription isn’t set up on this server yet: it needs a DEEPGRAM_API_KEY in the .env file.',
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
