/**
 * The interview coach: during a live oral history interview, the interviewer's next move.
 *
 * After each answer the web app sends the last few minutes of the conversation and asks what to
 * do next. The answer is ONE move: wait a little longer, follow up on what was just said, change
 * the topic (or go back to something mentioned earlier), suggest a break, or close the interview,
 * with the question to ask in plain words and a one-line reason. The interviewer decides.
 *
 * The guidance is oral history practice (Baylor University Institute for Oral History, Oral
 * History Association): open questions first, one question at a time, nothing leading, follow-ups
 * built from the narrator's own words, silence respected, sensitive subjects once there is trust,
 * a narrator's wish not to talk about something honoured, and a reflective close.
 *
 * Nothing here is stored or logged: the words come in, a suggestion goes out. The model's answer
 * is never trusted as it is: every field is checked and cut to size, and a reply that breaks the
 * rules (two questions in one, no question at all) is refused so the app can use its own bank.
 */
import { bodyLimit } from 'hono/body-limit';
import type { App, AppDeps } from './app';
import { memberRole, WRITE_ROLES } from './membership';
import type { ChatModel } from './nim';

/**
 * Chosen 2026-10-23 by running the coach on interview moments with each free NVIDIA model:
 * answers in about a second with thinking off, keeps to one open question, honours a narrator
 * who declines, and notices tiredness. Lightning interrupted mid-story; DeepSeek V4.1 Flash did
 * not answer within 30 s; Muse Glimmer took 9 s or failed. Set INTERVIEW_MODEL to change it.
 */
export const INTERVIEW_MODEL_DEFAULT = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

export const MOVES = ['wait', 'follow_up', 'change_topic', 'break', 'close'] as const;
export type Move = (typeof MOVES)[number];
export const KINDS = ['detail', 'meaning', 'restate', 'who_when', 'reflect'] as const;
export type Kind = (typeof KINDS)[number];

export interface CoachRequest {
  /** what to call the person being remembered ("Nell") */
  narrator: string;
  interviewer: string | null;
  /** the topics the interview set out to cover, as words ("Childhood") */
  topics: string[];
  minutes: number;
  /** the conversation so far, oldest first, already named by voice */
  transcript: Array<{ who: string; text: string }>;
  /** things mentioned but not yet explored, kept from earlier suggestions */
  threads: string[];
  /** questions already asked, so none is suggested twice */
  asked: string[];
  /** the interviewer chose a move other than the one suggested */
  want: Exclude<Move, 'wait'> | null;
  /** what the interviewer has written down so far: their spellings are the right ones */
  notes: string[];
}

export interface Suggestion {
  move: Move;
  kind: Kind | null;
  question: string;
  reason: string;
  /** new threads worth coming back to, in a few words each */
  threads: string[];
  /** the topic to move to, when the move is change_topic */
  topic: string | null;
}

/** the most of the conversation sent to the model: the recent minutes, which is what matters */
const MAX_TRANSCRIPT_CHARS = 6000;

const clip = (s: unknown, n: number): string =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '';

/** The request as the app sent it, checked; or why it cannot be used. */
export function readCoachRequest(raw: unknown): CoachRequest | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'expected an object' };
  const r = raw as Record<string, unknown>;
  const narrator = clip(r.narrator, 80);
  if (!narrator) return { error: 'narrator is required' };
  const lines = Array.isArray(r.transcript) ? r.transcript : [];
  const transcript: CoachRequest['transcript'] = [];
  for (const l of lines.slice(-200)) {
    if (!l || typeof l !== 'object') continue;
    const who = clip((l as Record<string, unknown>).who, 60) || 'Someone';
    const text = clip((l as Record<string, unknown>).text, 2000);
    if (text) transcript.push({ who, text });
  }
  // keep the most recent words within the budget
  let total = 0;
  let from = transcript.length;
  while (from > 0 && total + transcript[from - 1]!.text.length <= MAX_TRANSCRIPT_CHARS) {
    total += transcript[from - 1]!.text.length;
    from--;
  }
  const list = (v: unknown, n: number, len: number) =>
    (Array.isArray(v) ? v : [])
      .map((x) => clip(x, len))
      .filter(Boolean)
      .slice(0, n);
  const want =
    MOVES.includes(r.want as Move) && r.want !== 'wait' ? (r.want as CoachRequest['want']) : null;
  const minutes =
    typeof r.minutes === 'number' && Number.isFinite(r.minutes) ? Math.max(0, r.minutes) : 0;
  return {
    narrator,
    interviewer: clip(r.interviewer, 80) || null,
    topics: list(r.topics, 12, 40),
    minutes: Math.round(minutes),
    transcript: transcript.slice(from),
    threads: list(r.threads, 12, 80),
    asked: list(r.asked, 30, 200),
    want,
    notes: list(r.notes, 20, 200).slice(-12),
  };
}

export const COACH_SYSTEM = `You sit beside someone recording an oral history interview with a member of their family, and after each answer you suggest their single next move. You never speak to the narrator; the interviewer reads your suggestion and decides.

How oral historians interview, which you follow:
- Open questions first ("Tell me about…", "Describe…", "How…", "Why…"), one question at a time, in plain warm words. Never a yes/no question (do not begin with "Can you", "Could you", "Did you", "Do you", "Was it" or "Were you"), never two questions joined together, never a leading question that suggests its answer.
- Follow-ups come from the narrator's own words: a person, place, object or moment they mentioned but passed over. Ask them to describe it, to say what something meant, to say more about something you repeat back, or roughly when it was and who else was there. A year and a name help the family place the memory later.
- Silence works. If the last answer seems unfinished, or the narrator was in the middle of something, the move is "wait".
- Let the narrator lead. Follow the story they want to tell rather than the topic list. Change topic only when a thread is exhausted, or to go back to something they mentioned earlier ("threads").
- Painful subjects (illness, loss, war, hard times) only after about fifteen minutes, gently, and never pushed. If the narrator deflects or says they would rather not talk about something, let it go and change topic.
- Watch for tiredness, and put it before any thread: answers of a few words, "I don't remember", or flat replies like "It was fine", especially after an hour. Then suggest a break, or after sixty minutes close: a reflective last question (what they would want the family to know, how they would like to be remembered), then thanks. Close by about ninety minutes in any case.
- Refer only to what was actually said. Never invent details about the narrator's life.
- The transcript is speech-to-text, and it mishears names, places, schools and acronyms, especially with an accent. The interviewer's own notes, when there are any, spell them right. When a word in the transcript looks like a mishearing of something in the notes ("THCL" where a note says "NLCS"), it IS that: write the notes' spelling in your question and threads, never the transcript's. A note can also show what the interviewer wants to come back to.

Reply with ONE JSON object and nothing else:
{"move":"follow_up|change_topic|wait|break|close","kind":"detail|meaning|restate|who_when|reflect|null","question":"the exact words to say, addressed to the narrator","reason":"why, in under twelve words","threads":["things mentioned but not explored, 2-6 words each"],"topic":"for change_topic: where to go next, else null"}
For "wait", "question" is a short note to the interviewer instead (for example "Give her a moment; she may go on"). For "break", it is a gentle line offering a pause.`;

/** The conversation and the state of the interview, as the model reads it. */
export function coachPrompt(req: CoachRequest): string {
  const lines = req.transcript.map((t) => `${t.who}: ${t.text}`).join('\n');
  const parts = [
    `Narrator (being remembered): ${req.narrator}`,
    `Interviewer: ${req.interviewer ?? 'unknown'}`,
    `Minutes into the interview: ${req.minutes}`,
    `Topics they hoped to cover: ${req.topics.join(', ') || 'none chosen'}`,
    `Threads parked earlier: ${req.threads.join('; ') || 'none'}`,
    `Questions already asked (do not repeat): ${req.asked.slice(-12).join(' | ') || 'none'}`,
  ];
  if (req.notes.length) parts.push(`The interviewer's notes: ${req.notes.join(' | ')}`);
  if (req.want) {
    parts.push(
      `The interviewer has chosen to ${req.want.replace('_', ' ')}: the move must be "${req.want}".`,
    );
  }
  return `${parts.join('\n')}\n\nThe conversation so far (most recent last):\n${lines || '(nothing yet)'}`;
}

/** The model's reply as a Suggestion, or null when it breaks the rules or cannot be read. */
export function readSuggestion(text: string): Suggestion | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  // "follow up" and "Follow-Up" are follow_up
  const said =
    typeof j.move === 'string'
      ? j.move
          .trim()
          .toLowerCase()
          .replace(/[\s-]+/g, '_')
      : '';
  const move = MOVES.includes(said as Move) ? (said as Move) : null;
  if (!move) return null;
  let question = clip(j.question, 240);
  if (!question) return null;
  // one question at a time: of two questions, keep the first, if it stands on its own
  if (move !== 'wait' && (question.match(/\?/g) ?? []).length > 1) {
    const first = question.slice(0, question.indexOf('?') + 1);
    if (first.split(/\s+/).length < 4) return null;
    question = first;
  }
  const kind = KINDS.includes(j.kind as Kind) ? (j.kind as Kind) : null;
  const threads = (Array.isArray(j.threads) ? j.threads : [])
    .map((t) => clip(t, 60))
    .filter(Boolean)
    .slice(0, 4);
  return {
    move,
    kind: move === 'follow_up' || move === 'close' ? kind : null,
    question,
    reason: clip(j.reason, 120),
    threads,
    topic: move === 'change_topic' ? clip(j.topic, 60) || null : null,
  };
}

/** The last words are the narrator's, and they end without a sentence's closing punctuation. */
export function midSentence(req: CoachRequest): boolean {
  const last = req.transcript.at(-1);
  if (!last || last.who !== req.narrator) return false;
  return !/[.!?…]["'”’)]*$/.test(last.text.trim());
}

export class CoachError extends Error {
  constructor(readonly code: 'not_configured' | 'unavailable' | 'unreadable') {
    super(code);
  }
}

/** One suggestion from the model. Throws CoachError when there is none to give. */
export async function suggest(
  model: ChatModel | null | undefined,
  req: CoachRequest,
  signal?: AbortSignal,
): Promise<Suggestion> {
  // The narrator stopped in the middle of a sentence: wait. Speech-to-text closes every finished
  // sentence with punctuation, so this is read from the words, not left to the model, which
  // (tested) sometimes jumps in with a follow-up here: the one thing an interviewer must not do.
  if (!req.want && midSentence(req)) {
    return {
      move: 'wait',
      kind: null,
      question: `Give ${req.narrator} a moment; they stopped mid-sentence and may go on.`,
      reason: 'The last words were not a finished sentence',
      threads: [],
      topic: null,
    };
  }
  if (!model) throw new CoachError('not_configured');
  // one more try when the answer breaks the rules: an answer takes about a second, so a second
  // attempt still lands inside the pause, and beats falling back to a generic question
  let s: Suggestion | null = null;
  for (let attempt = 0; attempt < 2 && !s; attempt++) {
    let text: string;
    try {
      text = await model.complete(COACH_SYSTEM, coachPrompt(req), {
        signal,
        temperature: attempt === 0 ? 0.4 : 0.2,
        priority: 'high',
        timeoutMs: 9000,
      });
    } catch {
      throw new CoachError('unavailable');
    }
    s = readSuggestion(text);
  }
  if (!s) throw new CoachError('unreadable');
  if (req.want && s.move !== req.want) s.move = req.want;
  return s;
}

/* ── today's topics, from what the interviewer said ─────── */

export interface TopicsRequest {
  narrator: string;
  /** the interviewer's answer to "what would you like to talk about today?" */
  about: string;
}

export interface FreeTopic {
  label: string;
  /** one open invitation to begin it with */
  opener: string;
}

export function readTopicsRequest(raw: unknown): TopicsRequest | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'expected an object' };
  const r = raw as Record<string, unknown>;
  const narrator = clip(r.narrator, 80);
  const about = clip(r.about, 1500);
  if (!narrator) return { error: 'narrator is required' };
  if (!about) return { error: 'about is required' };
  return { narrator, about };
}

export const TOPICS_SYSTEM = `Someone is about to record an oral history interview with a member of their family. They have just said, out loud, what today's interview is about. List the topics they named, so an interview assistant can raise them one at a time.

- Use only what they said. A topic can be anything: a school, a place, a job, a war, a person, a period of life.
- If they said the interview is about the person's whole life, their life in general, or anything they like, reply with an empty list: the assistant then walks through a life story.
- Each topic has a short label (one to four words, as a heading) and an opener: one open invitation, addressed to the narrator, in plain warm words, beginning "Tell me about" or "Describe". Never a yes/no question.

Reply with ONE JSON object and nothing else:
{"topics":[{"label":"...","opener":"..."}]}`;

/** a yes/no question, which never opens a topic */
const CLOSED = /^(?:can|could|did|do|does|was|were|is|are|have|had|would)\s+you\b/i;

/** The model's topics, checked: at most five, each with a heading and an open opener. */
export function readTopics(text: string): FreeTopic[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let j: { topics?: unknown };
  try {
    j = JSON.parse(text.slice(start, end + 1)) as { topics?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(j.topics)) return null;
  const out: FreeTopic[] = [];
  for (const t of j.topics) {
    if (!t || typeof t !== 'object') continue;
    const label = clip((t as Record<string, unknown>).label, 40);
    const opener = clip((t as Record<string, unknown>).opener, 200);
    if (!label || !opener || CLOSED.test(opener)) continue;
    if (out.some((o) => o.label.toLowerCase() === label.toLowerCase())) continue;
    out.push({ label, opener });
  }
  return out.slice(0, 5);
}

/** Today's topics in the interviewer's words; an empty list means the whole life. */
export async function suggestTopics(
  model: ChatModel | null | undefined,
  req: TopicsRequest,
  signal?: AbortSignal,
): Promise<FreeTopic[]> {
  if (!model) throw new CoachError('not_configured');
  let text: string;
  try {
    text = await model.complete(
      TOPICS_SYSTEM,
      `Narrator: ${req.narrator}\nWhat the interviewer said today is about: "${req.about}"`,
      { signal, temperature: 0.2, priority: 'high', timeoutMs: 9000 },
    );
  } catch {
    throw new CoachError('unavailable');
  }
  const topics = readTopics(text);
  if (!topics) throw new CoachError('unreadable');
  return topics;
}

/* ── corrections: the notes' spellings, back in the transcript ── */

export interface CorrectionsRequest {
  notes: string[];
  /** the transcript lines said near the notes, by id */
  lines: Array<{ id: number; text: string }>;
}

export interface Correction {
  id: number;
  /** the words as they were transcribed, exactly as they appear in the line */
  from: string;
  /** the same words as the notes spell them */
  to: string;
}

export function readCorrectionsRequest(raw: unknown): CorrectionsRequest | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'expected an object' };
  const r = raw as Record<string, unknown>;
  const notes = (Array.isArray(r.notes) ? r.notes : [])
    .map((n) => clip(n, 300))
    .filter(Boolean)
    .slice(0, 60);
  const lines: CorrectionsRequest['lines'] = [];
  for (const l of Array.isArray(r.lines) ? r.lines.slice(0, 400) : []) {
    if (!l || typeof l !== 'object') continue;
    const id = (l as Record<string, unknown>).id;
    const text = clip((l as Record<string, unknown>).text, 600);
    if (typeof id === 'number' && Number.isInteger(id) && text) lines.push({ id, text });
  }
  if (notes.length === 0) return { error: 'notes are required' };
  if (lines.length === 0) return { error: 'lines are required' };
  return { notes, lines };
}

export const CORRECTIONS_SYSTEM = `An oral history interview was transcribed by speech-to-text, which often mishears names, places, schools and acronyms, especially in accented speech. While it was recorded, the interviewer wrote notes by hand, and the notes spell those words right.

Find the words in the transcript lines that are the speech-to-text's mishearing of something written in the notes: "THCL" in a line where the notes say "NLCS", or "Sole" where the notes say "Seoul". Only words that plausibly were misheard from a word in the notes; never an ordinary word that happens to differ, never a rewording, never a guess without a note behind it.

Reply with ONE JSON object and nothing else:
{"fixes":[{"id":<line id>,"from":"the words exactly as they appear in that line","to":"the words as the notes spell them"}]}
No fixes: {"fixes":[]}`;

/** The model's fixes, each checked against its line and the notes; an unfounded one is dropped. */
export function readCorrections(text: string, req: CorrectionsRequest): Correction[] | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let j: { fixes?: unknown };
  try {
    j = JSON.parse(text.slice(start, end + 1)) as { fixes?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(j.fixes)) return null;
  const byId = new Map(req.lines.map((l) => [l.id, l.text]));
  const notes = req.notes.join('\n').toLowerCase();
  const out: Correction[] = [];
  for (const f of j.fixes) {
    if (!f || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    const id = typeof r.id === 'number' ? r.id : NaN;
    const line = byId.get(id);
    const from = clip(r.from, 80);
    const to = clip(r.to, 80);
    // the words must be in the line, and the spelling must come from the notes
    if (!line || !from || !to || from === to || !line.includes(from)) continue;
    if (!notes.includes(to.toLowerCase())) continue;
    if (out.some((o) => o.id === id && o.from === from)) continue;
    out.push({ id, from, to });
  }
  return out.slice(0, 100);
}

/** Where the transcript misheard what the notes spell right. */
export async function suggestCorrections(
  model: ChatModel | null | undefined,
  req: CorrectionsRequest,
  signal?: AbortSignal,
): Promise<Correction[]> {
  if (!model) throw new CoachError('not_configured');
  const notes = req.notes.map((n) => `- ${n}`).join('\n');
  const lines = req.lines.map((l) => `[${l.id}] ${l.text}`).join('\n');
  let text: string;
  try {
    text = await model.complete(
      CORRECTIONS_SYSTEM,
      `The interviewer's notes:\n${notes}\n\nTranscript lines:\n${lines}`,
      { signal, temperature: 0, timeoutMs: 45_000 },
    );
  } catch {
    throw new CoachError('unavailable');
  }
  const fixes = readCorrections(text, req);
  if (!fixes) throw new CoachError('unreadable');
  return fixes;
}

/* ── the routes ─────────────────────────────────────────── */

export type CoachAction = 'suggest' | 'topics' | 'corrections';

/**
 * One coach call, from the request's JSON to the answer. The route and the demo dev server
 * (apps/web/vite.config.ts) both answer through this, so they cannot drift apart.
 */
export async function answerCoach(
  action: CoachAction,
  model: ChatModel | null | undefined,
  raw: unknown,
  signal?: AbortSignal,
): Promise<{ status: 200 | 400 | 502 | 503; body: unknown }> {
  const bad = (error: string) => ({ status: 400 as const, body: { error, code: 'bad_request' } });
  try {
    if (action === 'suggest') {
      const req = readCoachRequest(raw);
      if ('error' in req) return bad(req.error);
      return { status: 200, body: await suggest(model, req, signal) };
    }
    if (action === 'topics') {
      const req = readTopicsRequest(raw);
      if ('error' in req) return bad(req.error);
      return { status: 200, body: { topics: await suggestTopics(model, req, signal) } };
    }
    const req = readCorrectionsRequest(raw);
    if ('error' in req) return bad(req.error);
    return { status: 200, body: { fixes: await suggestCorrections(model, req, signal) } };
  } catch (e) {
    const code = e instanceof CoachError ? e.code : 'unavailable';
    return { status: code === 'not_configured' ? 503 : 502, body: { error: 'no answer', code } };
  }
}

/** at most one call of each kind per person every few seconds, so a stuck page cannot run up a bill */
const MIN_GAP_MS = 3000;

export function registerCoachRoutes(app: App, deps: AppDeps): void {
  const last = new Map<string, number>();
  const route = (action: CoachAction, maxSize: number) =>
    app.post(
      `/v1/archives/:archiveId/interview/${action}`,
      bodyLimit({
        maxSize,
        onError: (c) => c.json({ error: 'the request is too large', code: 'too_large' }, 413),
      }),
      async (c) => {
        const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
        const userId = c.get('userId');
        const role = await memberRole(deps.pool, userId, archiveId);
        if (role === null) return c.json({ error: 'not found' }, 404);
        if (!WRITE_ROLES.includes(role)) {
          return c.json(
            { error: 'only people who can add memories can record interviews', code: 'forbidden' },
            403,
          );
        }
        const key = `${userId}:${action}`;
        const now = Date.now();
        if (now - (last.get(key) ?? 0) < MIN_GAP_MS) {
          return c.json({ error: 'one at a time', code: 'busy' }, 429);
        }
        last.set(key, now);
        const raw = await c.req.json().catch(() => null);
        const out = await answerCoach(action, deps.interviewChat, raw, c.req.raw.signal);
        return c.json(out.body, out.status);
      },
    );
  route('suggest', 64 * 1024);
  route('topics', 8 * 1024);
  route('corrections', 320 * 1024);
}
