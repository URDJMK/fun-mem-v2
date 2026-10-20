/** Speaker id for the lines that look like the interviewer's questions when nobody is labelled. */
export const QUESTIONS = 'QUESTIONS';
/** Speaker id for a transcript with no speaker information at all. */
export const VOICE = 'SPEAKER_00';
/** Speaker id for unlabelled words that come before the first labelled speaker. */
export const UNKNOWN = 'UNKNOWN';
/**
 * Speaker id for the unlabelled lines of a transcript in which only the interviewer is
 * labelled ("Q: Where were you born?" and then the answer on its own line).
 */
export const ANSWERS = 'ANSWERS';

/** A label without its note in brackets: "Interviewer (Noah)" -> "Interviewer". */
export const baseLabel = (id: string): string => id.replace(/ \([^()]{0,60}\)$/, '').trim();

/**
 * Labels that SAY the speaker is the one asking: "Interviewer", "Q", "Host"… A number may
 * follow ("Interviewer 2").
 */
export const ASKER_LABEL = /^(?:interviewer|q|question|host|moderator)(?: ?\d{1,3})?$/i;
/**
 * Labels that SAY the speaker is the one telling: "Interviewee", "Narrator"… A bare "A" counts
 * only next to a "Q".
 */
export const TELLER_LABEL = /^(?:interviewee|narrator|a|answer|answers|respondent)(?: ?\d{1,3})?$/i;

/** Ids this code gives out itself. A speaker in a file who happens to be called this is renamed. */
const RESERVED = new Set([QUESTIONS, UNKNOWN, ANSWERS]);

/**
 * A speaker name read from a file, made safe to use as an id. It never equals an id this
 * code assigns itself, and never a property every JavaScript object already has
 * ("constructor", "toString", "__proto__"), so later code can key a map or an object by it.
 * Such a name gets " (speaker)" after it: "QUESTIONS (speaker)", "constructor (speaker)".
 */
export function safeSpeakerId(id: string): string {
  return RESERVED.has(id) || id in Object.prototype ? `${id} (speaker)` : id;
}
