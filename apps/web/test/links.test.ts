import { describe, expect, it } from 'vitest';
import { missingTargets, piecesOf, withMentions } from '../src/lib/links';

const NOTES = [
  { id: 'n-mom', title: 'Mother' },
  { id: 'n-cafe', title: 'Café Rosa' },
];

describe('a note read as words and links', () => {
  it('links to notes the reader can see, by title, ignoring case and composition', () => {
    const body = '[[Mother]] and [[café rosa]] in town. [[Café Rosa|the café]] was ours.';
    expect(piecesOf(body, NOTES)).toEqual([
      { kind: 'link', label: 'Mother', noteId: 'n-mom' },
      { kind: 'text', text: ' and ' },
      { kind: 'link', label: 'café rosa', noteId: 'n-cafe' },
      { kind: 'text', text: ' in town. ' },
      { kind: 'link', label: 'the café', noteId: 'n-cafe' },
      { kind: 'text', text: ' was ours.' },
    ]);
    // "é" written as "e" and a combining accent is the same title
    expect(piecesOf('[[Café Rosa]]', NOTES)).toEqual([
      { kind: 'link', label: 'Café Rosa', noteId: 'n-cafe' },
    ]);
  });

  it('keeps what is not a link to another note exactly as written', () => {
    const body = '[[Father]] and ![[abc123]] the photo, [[#Heading]] and `[[code]]`.';
    expect(piecesOf(body, NOTES)).toEqual([{ kind: 'text', text: body }]);
  });

  it('lists the notes a body points to that are not written yet, once each', () => {
    const body = '[[Father]], [[father]], [[Mother]], [[ Uncle Joe ]], ![[abc123]], [[#Heading]]';
    expect(missingTargets(body, NOTES)).toEqual(['Father', 'Uncle Joe']);
  });

  it('shows kept proposed notes before resolving saved notes, and leaves aliases intact', () => {
    expect(
      piecesOf('Meet [[MOTHER|Mom]] and [[Café Rosa]].', NOTES, {
        proposed: new Map([
          ['mother', true],
          ['café rosa', true],
        ]),
      }),
    ).toEqual([
      { kind: 'text', text: 'Meet ' },
      { kind: 'proposed', label: 'Mom' },
      { kind: 'text', text: ' and ' },
      { kind: 'proposed', label: 'Café Rosa' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('reads a left-out proposed target as plain words even when a saved note has that title', () => {
    expect(
      piecesOf('Meet [[Mother|Mom]], then [[Mother]].', NOTES, {
        proposed: new Map([['mother', false]]),
      }),
    ).toEqual([{ kind: 'text', text: 'Meet Mom, then Mother.' }]);
    expect(
      piecesOf('![[Mother]] and [[#Mother]]', NOTES, {
        proposed: new Map([['mother', false]]),
      }),
    ).toEqual([{ kind: 'text', text: '![[Mother]] and [[#Mother]]' }]);
  });
});

describe('withMentions: the names a story mentions open their entity (graph design 6.3)', () => {
  const sarah = { entityId: 'e-sarah', words: ['Sarah'] };
  const tom = { entityId: 'e-tom', words: ['her brother Tom'] };

  it('marks the first time each is named, keeping the words as written', () => {
    expect(
      withMentions(
        [{ kind: 'text', text: 'Noah met Sarah, who brought her brother Tom. Sarah laughed.' }],
        [sarah, tom],
      ),
    ).toEqual([
      { kind: 'text', text: 'Noah met ' },
      { kind: 'entity', label: 'Sarah', entityId: 'e-sarah' },
      { kind: 'text', text: ', who brought ' },
      { kind: 'entity', label: 'her brother Tom', entityId: 'e-tom' },
      { kind: 'text', text: '. Sarah laughed.' },
    ]);
  });

  it('ignores case, but only whole words, and leaves links alone', () => {
    const mother = { entityId: 'e-mother', words: ['his mother'] };
    expect(
      withMentions(
        [
          { kind: 'link', label: 'Sarah', noteId: 'n1' },
          { kind: 'text', text: ' and Tomorrow. His mother came.' },
        ],
        [sarah, mother, { entityId: 'e-tom', words: ['Tom'] }],
      ),
    ).toEqual([
      { kind: 'link', label: 'Sarah', noteId: 'n1' },
      { kind: 'text', text: ' and Tomorrow. ' },
      { kind: 'entity', label: 'His mother', entityId: 'e-mother' },
      { kind: 'text', text: ' came.' },
    ]);
  });

  it('prefers the longer name', () => {
    expect(
      withMentions(
        [{ kind: 'text', text: 'Sarah Lee came.' }],
        [sarah, { entityId: 'e-lee', words: ['Sarah Lee'] }],
      ),
    ).toEqual([
      { kind: 'entity', label: 'Sarah Lee', entityId: 'e-lee' },
      { kind: 'text', text: ' came.' },
    ]);
  });
});
