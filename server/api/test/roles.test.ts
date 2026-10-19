import { describe, expect, it } from 'vitest';
import { QUESTIONS, assignRoles, type Turn } from '../src/transcript';

const turn = (index: number, speaker: string, text: string): Turn => ({
  index,
  speaker,
  start: null,
  end: null,
  text,
});
const long = 'word '.repeat(60).trim();

describe('who is being remembered', () => {
  it('trusts a speaker the sender named, and says so', () => {
    const r = assignRoles([turn(0, 'A', 'Where?'), turn(1, 'B', long)], 'A');
    expect(r).toMatchObject({
      interviewee: 'A',
      source: 'sender',
      confidence: 'high',
      needsConfirmation: false,
    });
    expect(r.reasons).toContain('named_by_sender');
    expect(r.speakers.find((s) => s.id === 'B')!.role).toBe('interviewer');
  });

  it('says so when the named speaker is not in the transcript, and falls back to a guess', () => {
    const r = assignRoles([turn(0, 'A', 'Where were you born?'), turn(1, 'B', long)], 'NOBODY');
    expect(r.interviewee).toBe('B');
    expect(r.source).toBe('guess');
    expect(r.reasons).toContain('named_speaker_not_found');
  });

  it('supports more than one person telling their story', () => {
    const r = assignRoles(
      [turn(0, 'Q', 'Tell me.'), turn(1, 'A', long), turn(2, 'B', long)],
      ['A', 'B'],
    );
    expect(r.interviewees).toEqual(['A', 'B']);
    expect(r.speakers.filter((s) => s.role === 'interviewee')).toHaveLength(2);
  });

  it('a clear majority who asks little is a confident guess', () => {
    const r = assignRoles([
      turn(0, 'Q', 'Where were you born?'),
      turn(1, 'A', long + long),
      turn(2, 'Q', 'And then?'),
      turn(3, 'A', long + long),
    ]);
    expect(r).toMatchObject({
      interviewee: 'A',
      source: 'guess',
      confidence: 'high',
      needsConfirmation: false,
    });
  });

  it('a close call is low confidence and needs a person to look', () => {
    const r = assignRoles([
      turn(0, 'A', long),
      turn(1, 'B', long),
      turn(2, 'A', long),
      turn(3, 'B', long + ' extra'),
    ]);
    expect(r.confidence).toBe('low');
    expect(r.needsConfirmation).toBe(true);
    expect(r.reasons).toContain('close_call');
  });

  it('the one who talks most but is the one asking the questions is NOT trusted', () => {
    const r = assignRoles([
      turn(0, 'A', `Can you tell me about it? ${long} And what happened next? Why did you go?`),
      turn(1, 'B', 'We left in spring.'),
      turn(2, 'A', `Really? ${long} And then who came? Was it your father?`),
      turn(3, 'B', 'It was him.'),
    ]);
    expect(r.confidence).toBe('low');
    expect(r.reasons).toContain('asks_more_questions');
    expect(r.needsConfirmation).toBe(true);
  });

  it('three or more voices with no dominant one is low confidence', () => {
    const r = assignRoles([turn(0, 'A', long), turn(1, 'B', long), turn(2, 'C', long)]);
    expect(r.confidence).toBe('low');
    expect(r.reasons).toContain('many_speakers');
  });

  // A MEDIUM guess is confirmed by a person before saving (it used to be saved silently,
  // which is how an interviewer's words were filed as testimony).
  it('a monologue is fine; a monologue with guessed questions is medium, and a person confirms it', () => {
    expect(assignRoles([turn(0, 'SPEAKER_00', long)])).toMatchObject({
      confidence: 'high',
      needsConfirmation: false,
    });
    const r = assignRoles([turn(0, QUESTIONS, 'Where?'), turn(1, 'SPEAKER_00', long)]);
    expect(r).toMatchObject({
      interviewee: 'SPEAKER_00',
      confidence: 'medium',
      needsConfirmation: true,
    });
    expect(r.speakers.find((s) => s.id === QUESTIONS)!.role).toBe('interviewer');
  });

  it('the guessed-questions voice can never be the interviewee, even if named', () => {
    const r = assignRoles([turn(0, QUESTIONS, 'Where?'), turn(1, 'SPEAKER_00', long)], QUESTIONS);
    expect(r.interviewee).toBe('SPEAKER_00');
  });
});
