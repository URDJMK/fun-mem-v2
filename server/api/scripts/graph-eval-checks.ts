import { extractWikilinks, normalizeTitle } from '@funmem/core';
import type { GraphProposal } from '../src/graph/types';

/** Pure eval assertions, so their failure paths are checked without a live model. */
export function noteAndLinkChecks(
  graph: GraphProposal,
  stories: ReadonlyArray<{ title: string; body: string }>,
  subjectNames: readonly string[],
): Array<{ label: string; ok: boolean }> {
  const subject = new Set(subjectNames.map(normalizeTitle));
  return [
    { label: 'at least one story', ok: stories.length > 0 },
    ...graph.entities
      .filter((e) => !e.subject)
      .map((e) => ({ label: `a note for ${e.name}`, ok: !!e.note })),
    ...stories.flatMap((s) => {
      const prose = s.body
        .split('\n')
        .filter((line) => !line.startsWith('>'))
        .join('\n');
      const links = extractWikilinks(prose).filter((l) => !l.embed && l.target);
      return [
        { label: `prose links in “${s.title}”`, ok: links.length > 0 },
        {
          label: `no protagonist link in “${s.title}”`,
          ok: !links.some((l) => subject.has(normalizeTitle(l.target))),
        },
      ];
    }),
  ];
}
