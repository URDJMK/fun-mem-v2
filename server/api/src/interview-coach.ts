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

/** at most one suggestion per person every few seconds, so a stuck page cannot run up a bill */
const MIN_GAP_MS = 3000;

export function registerCoachRoutes(app: App, deps: AppDeps): void {
  const last = new Map<string, number>();
  app.post(
    '/v1/archives/:archiveId/interview/suggest',
    bodyLimit({
      maxSize: 64 * 1024,
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
      const now = Date.now();
      if (now - (last.get(userId) ?? 0) < MIN_GAP_MS) {
        return c.json({ error: 'one suggestion at a time', code: 'busy' }, 429);
      }
      last.set(userId, now);

      const req = readCoachRequest(await c.req.json().catch(() => null));
      if ('error' in req) return c.json({ error: req.error, code: 'bad_request' }, 400);
      try {
        return c.json(await suggest(deps.interviewChat, req, c.req.raw.signal));
      } catch (e) {
        const code = e instanceof CoachError ? e.code : 'unavailable';
        return c.json({ error: 'no suggestion', code }, code === 'not_configured' ? 503 : 502);
      }
    },
  );
}
