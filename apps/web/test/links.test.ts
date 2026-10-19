import { describe, expect, it } from 'vitest';
import { missingTargets, piecesOf } from '../src/lib/links';

const NOTES = [
  { id: 'n-mom', title: '어머니' },
  { id: 'n-busan', title: 'Busan' },
];

describe('a note read as words and links', () => {
  it('links to notes the reader can see, by title, ignoring case and composition', () => {
    const body = '[[어머니]]와 [[busan]]에 갔다. [[Busan|부산]]은 바다였다.';
    expect(piecesOf(body, NOTES)).toEqual([
      { kind: 'link', label: '어머니', noteId: 'n-mom' },
      { kind: 'text', text: '와 ' },
      { kind: 'link', label: 'busan', noteId: 'n-busan' },
      { kind: 'text', text: '에 갔다. ' },
      { kind: 'link', label: '부산', noteId: 'n-busan' },
      { kind: 'text', text: '은 바다였다.' },
    ]);
    expect(piecesOf('[[어머니]]'.normalize('NFD'), NOTES)).toEqual([
      { kind: 'link', label: '어머니'.normalize('NFD'), noteId: 'n-mom' },
    ]);
  });

  it('keeps what is not a link to another note exactly as written', () => {
    const body = '[[아버지]]는 ![[abc123]] 사진, [[#제목]] 그리고 `[[code]]`.';
    expect(piecesOf(body, NOTES)).toEqual([{ kind: 'text', text: body }]);
  });

  it('lists the notes a body points to that are not written yet, once each', () => {
    const body = '[[아버지]], [[아버지]], [[어머니]], [[ 삼촌 ]], ![[abc123]], [[#제목]]';
    expect(missingTargets(body, NOTES)).toEqual(['아버지', '삼촌']);
  });
});
