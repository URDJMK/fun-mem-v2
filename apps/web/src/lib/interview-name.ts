import { TOPICS } from './questions';

/**
 * A live interview's default name: the day it was recorded and the topics chosen at the start
 * ("Interview, 26 Oct 2026 · Childhood, Work"). Never the first words said: those named an
 * interview "Hi.".
 */
export function interviewName(startedAt: string, topics: readonly string[]): string {
  const day = new Date(startedAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const labels = topics
    .map((id) => TOPICS.find((t) => t.id === id)?.label)
    .filter((l): l is string => !!l)
    .slice(0, 2);
  return `Interview, ${day}${labels.length ? ` · ${labels.join(', ')}` : ''}`;
}
