/**
 * What the interview assistant can say without an AI model, written the way oral historians
 * interview (Baylor University Institute for Oral History; Oral History Association): each topic
 * opens with one broad invitation ("Tell me about…"), and what follows comes from the narrator's
 * answer. The AI coach writes those follow-ups from what was actually said; the generic ones here
 * are its stand-in when it cannot be reached. `{name}` is the narrator, as they called themselves.
 */
export interface Topic {
  id: string;
  label: string;
  /** one open invitation that lets the narrator choose where to begin */
  opener: string;
  /** painful for many people: offered once there is trust, never first */
  sensitive?: boolean;
}

export const TOPICS: Topic[] = [
  { id: 'childhood', label: 'Childhood', opener: 'Tell me about your childhood.' },
  { id: 'family', label: 'Family', opener: 'Tell me about your family when you were growing up.' },
  {
    id: 'places',
    label: 'Places & moves',
    opener: 'Tell me about the places you have called home.',
  },
  {
    id: 'traditions',
    label: 'Food & traditions',
    opener: 'Tell me about the food and traditions your family kept.',
  },
  { id: 'work', label: 'Work', opener: 'Tell me about the work you have done in your life.' },
  {
    id: 'love',
    label: 'Love & partners',
    opener: 'Tell me about the people you have shared your life with.',
  },
  {
    id: 'hard',
    label: 'Hard times',
    opener: 'Tell me about a hard time in your life, if you would like to.',
    sensitive: true,
  },
  { id: 'advice', label: 'Advice & beliefs', opener: 'Tell me what life has taught you.' },
];

export type ProbeKind = 'detail' | 'meaning' | 'restate' | 'who_when' | 'reflect';

/** Follow-ups that work after any answer, by kind; the AI's are better because they are specific. */
export const PROBES: Record<ProbeKind, string[]> = {
  detail: ['Describe that for me. What did it look like?', 'Take me back there. What do you see?'],
  who_when: ['Roughly when was that?', 'Who else was there?'],
  restate: ['Tell me more about that.', 'What happened next?'],
  meaning: ['What did that mean to you at the time?'],
  reflect: ['How do you feel about that now, looking back?'],
};

/** the order generic follow-ups come in: a scene first, then when and who, then meaning */
export const PROBE_ORDER: ProbeKind[] = ['detail', 'who_when', 'restate', 'meaning', 'reflect'];

/** A reflective last question, then thanks: how an oral history interview closes. */
export const CLOSING = [
  'Looking back over everything we talked about, what would you most want the family to know?',
  'How would you like to be remembered?',
];
export const THANKS = 'Thank {name} for sharing these memories with you.';

/** Short reminders shown one at a time while the interview runs. */
export const TIPS = [
  'Let a silence sit for a few seconds. The best part often comes after it.',
  'Follow the story they want to tell, even if it leaves your topics.',
  'Ask roughly when it happened. A year puts the memory on the timeline.',
  'Ask who else was there. Each name becomes a person in the project.',
  'Keep your “mm-hm”s quiet: a nod records nothing over their voice.',
  'If something is hard to talk about, let it go. You can come back another day.',
];

export function fill(text: string, name: string): string {
  return text.replaceAll('{name}', name);
}

/**
 * The audio label oral historians record before the first question: who is speaking, when, and
 * who is being interviewed, said by the interviewer so the narrator is not quizzed for it.
 */
export function labelScript(
  interviewer: string,
  narrator: string,
  topicLabels: string[],
  /** a family project's name: the narrator is one of its people */
  project: string | null = null,
  when = new Date(),
): string {
  const date = when.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const who = interviewer ? `This is ${interviewer}. ` : '';
  const about = topicLabels.length
    ? ` We'll talk about ${topicLabels.map((t) => t.toLowerCase()).join(' and ')}.`
    : '';
  const forWhom = project
    ? ` for ${/project$/i.test(project) ? project : `${project} project`}`
    : '';
  return `${who}Today is ${date}. I'm interviewing ${narrator}${forWhom}.${about}`;
}

/**
 * The topics in the order to raise them: the ones the interviewer named in their own words
 * first, then the chosen ones from the bank (the whole bank, a life story, when nothing was
 * chosen or named), gentle ones first and anything painful last, so it comes once there is trust.
 */
export function topicOrder(
  chosen: string[],
  free: ReadonlyArray<{ label: string; opener: string }> = [],
): Topic[] {
  const own: Topic[] = free.map((t) => ({
    id: `free:${t.label}`,
    label: t.label,
    opener: t.opener,
  }));
  const list = chosen.length || own.length ? TOPICS.filter((t) => chosen.includes(t.id)) : TOPICS;
  return [...own, ...list.filter((t) => !t.sensitive), ...list.filter((t) => t.sensitive)];
}
