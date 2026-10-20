/**
 * Does a turn of speech read as a QUESTION or an invitation to tell ("Tell me about your
 * father")? Used to tell an interviewer from the relative, and to pick the question to quote
 * above a memory.
 *
 * A question mark is the strongest cue, but speech-to-text may leave it out and many
 * interviewers prompt with statements, so the cues are words too. Kept in one place because the
 * role guess (transcript side) and the pipeline (note side) must agree on what a prompt is.
 *
 * Every check here is linear in the length of the turn: the patterns are anchored or read a
 * bounded tail, and the last sentence is found by a scan, not by a pattern.
 */

/** "So, …", "Okay and …" in front of a prompt */
const OPEN = String.raw`(?:(?:so|okay|ok|and|well|now|alright|all right|right|um|uh)[,\s]+)*`;
/**
 * The start of a turn that asks or invites: "Tell me…", "Where were you born", "And then?", "And
 * your mother". A question word in front asks only in a short turn or one addressed to her ("so
 * where were you born"): "When I was young we lived in Busan" and "and then we walked to Busan"
 * are her own story.
 */
const PROMPT_LEAD = new RegExp(
  String.raw`^${OPEN}(?:(tell|describe|talk|explain|share|walk me|go on|continue|keep going|say more|let'?s)\b|(and then)(?=\s*(?:what\b|$|[?.!,]))|(what about|how about|and your|your)\b|(what|where|when|which|who|why|how|do|did|can|could|would|was|were|is|are|have|has|will)\b)`,
  'i',
);
const ASKS_HER = /\byou(?:r|rs|'re|'ve|'d|'ll)?\b/i;

function promptAtStart(t: string): boolean {
  const m = PROMPT_LEAD.exec(t);
  if (!m) return false;
  if (m[1] || m[2]) return true;
  const words = t.split(/\s+/).length;
  if (m[3]) return words <= 6; // "and your mother", "what about school"
  return words <= 6 || ASKS_HER.test(t.split(/\s+/).slice(0, 8).join(' '));
}

/** An invitation at the start of the LAST sentence: "That is lovely. Tell me more about him." */
const LAST_PROMPT =
  /^(?:tell (?:me|us)|describe|talk about|explain|share|walk me|go on|continue|keep going|say more)\b/i;

const SENTENCE_END = new Set(['.', '!', '?', '…']);
const TRAILING = new Set(['.', '!', '?', '…', '"', "'", '”', '’', ')', '~', ' ', '\n', '\t']);

/** The last sentence of a turn, found by scanning back from the end (no pattern can go quadratic). */
function lastSentence(t: string): string {
  let end = t.length;
  while (end > 0 && TRAILING.has(t[end - 1]!)) end--;
  let i = end - 1;
  while (i >= 0 && !SENTENCE_END.has(t[i]!)) i--;
  return t.slice(i + 1, end).trim();
}

/** A question, or an invitation to tell ("Tell me about…"). */
export function looksLikeAsking(text: string): boolean {
  const t = text.trim();
  if (t.includes('?')) return true;
  if (promptAtStart(t)) return true;
  return LAST_PROMPT.test(lastSentence(t));
}

const BACKCHANNEL =
  /^(?:mm+(?:-?hm+)?|mhm|uh-?huh|hmm+|yeah|yep|yes|right|okay|ok|i see|oh|wow|really|sure)[.!?…,\s]*$/i;

/** Only a sound of listening or agreeing, nothing else: "Mm-hm.", "Yeah." */
export const isBackchannel = (t: string): boolean => t.length <= 40 && BACKCHANNEL.test(t.trim());
