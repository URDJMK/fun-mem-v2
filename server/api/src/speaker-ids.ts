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
 * Labels that SAY the speaker is the one asking: "Interviewer", "Q", "질문자"… A number may
 * follow ("Interviewer 2"). Korean oral history writes 면담자 (and folklore work 조사자) for
 * the interviewer. "면접자" is here for the readers (a file labelled only "면접자:" with
 * unlabelled answers), but the role guess reads it as AMBIGUOUS_ASKER_LABEL below.
 */
export const ASKER_LABEL =
  /^(?:interviewer|q|question|host|moderator|면접관|면접자|인터뷰어|질문자|진행자|면담자|조사자|채록자|질문|문)(?: ?\d{1,3})?$/i;
/**
 * Labels that SAY the speaker is the one telling. A bare "A" counts only next to a "Q". Korean
 * oral history writes 구술자 (folklore 제보자) for the person telling; English "Narrator".
 */
export const TELLER_LABEL =
  /^(?:interviewee|narrator|a|answer|answers|respondent|응답자|인터뷰이|구술자|제보자|답|답변)(?: ?\d{1,3})?$/i;
/**
 * "면접자" is the interviewer in some transcripts and the person interviewed in others (in a job
 * interview it is the candidate). It is read as the asker only when its turns do ask; otherwise
 * the label says nothing, and who talks and how decides.
 */
export const AMBIGUOUS_ASKER_LABEL = /^면접자(?: ?\d{1,3})?$/;

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
