import { describe, expect, it } from 'vitest';
import { missingTargets, piecesOf } from '../src/lib/links';

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
});
