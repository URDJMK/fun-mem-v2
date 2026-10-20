import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-052 — the backlinks endpoint reports whether each occurrence's fragment
 * still resolves in the target note.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function note(s: RealSession, archive: string, title: string, body: string): Promise<string> {
  const r = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'person',
    body,
  });
  if (r.status !== 201) throw new Error(`create '${title}': ${r.status} ${await r.text()}`);
  return ((await r.json()) as { id: string }).id;
}

interface Occ {
  target: string;
  heading?: string;
  blockId?: string;
  resolvedId: string | null;
  fragmentStatus?: 'ok' | 'broken';
}

const backlinks = async (s: RealSession, archive: string, noteId: string): Promise<Occ[]> => {
  const r = await ctx.api(s.token, 'GET', `/v1/archives/${archive}/notes/${noteId}/backlinks`);
  if (r.status !== 200) throw new Error(`backlinks: ${r.status}`);
  return ((await r.json()) as { occurrences: Occ[] }).occurrences;
};

describe('FM-052 fragment integrity (endpoint)', () => {
  it('backlinks report a broken fragment without disturbing resolution', async () => {
    const s = await ctx.realSession(`fr1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `FR1 ${RUN}`);
    const targetTitle = `Grandma ${RUN}`;
    const target = await note(
      s,
      archive,
      targetTitle,
      '# Day 1\n## Morning\n\nCoffee at the harbour. ^goodanchor',
    );
    await note(
      s,
      archive,
      `Ref ${RUN}`,
      [
        `working block [[${targetTitle}#^goodanchor]]`,
        `broken block [[${targetTitle}#^missinganchor]]`,
        `working heading [[${targetTitle}#Morning]]`,
        `broken heading [[${targetTitle}#Childhood]]`,
        `no fragment [[${targetTitle}]]`,
      ].join('\n\n'),
    );

    const occ = await backlinks(s, archive, target);
    const by = (needle: string) => occ.find((o) => (o.blockId ?? o.heading ?? '') === needle);

    expect(by('goodanchor')?.fragmentStatus, 'a working block fragment was called broken').toBe(
      'ok',
    );
    expect(by('missinganchor')?.fragmentStatus, 'a missing block id was not reported').toBe(
      'broken',
    );
    expect(by('Morning')?.fragmentStatus, 'a working heading was called broken').toBe('ok');
    expect(by('Childhood')?.fragmentStatus, 'a missing heading was not reported').toBe('broken');

    // ABSENT for a fragmentless link — never conflate "no fragment" with "fine"
    const plain = occ.find((o) => o.heading === undefined && o.blockId === undefined);
    expect(plain, 'the fragmentless occurrence is missing').toBeDefined();
    expect(
      'fragmentStatus' in (plain as object),
      'a fragmentless link was labelled instead of left alone',
    ).toBe(false);
  });

  it('a fragment-broken occurrence keeps its resolvedId', async () => {
    const s = await ctx.realSession(`fr2-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `FR2 ${RUN}`);
    const targetTitle = `Dad ${RUN}`;
    const target = await note(s, archive, targetTitle, 'A note with no anchors at all.');
    const src = await note(s, archive, `Src ${RUN}`, `cite [[${targetTitle}#^nothere]]`);

    const occ = await backlinks(s, archive, target);
    expect(occ).toHaveLength(1);
    expect(occ[0]!.fragmentStatus).toBe('broken');
    // load-bearing: the rename cascade selects strictly on resolved_id, so
    // marking brokenness by nulling it would silently drop this referrer
    expect(occ[0]!.resolvedId, 'brokenness was marked by dropping resolution').toBe(target);

    // and the row in the database still resolves, so a rename still cascades
    const row = await ctx.pool.query<{ resolved_id: string | null }>(
      `select resolved_id from public.links where archive_id = $1 and source_id = $2`,
      [archive, src],
    );
    expect(row.rows[0]!.resolved_id).toBe(target);
  });
});
