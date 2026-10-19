import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

// FM-020 read views: people index + depth-bounded neighborhood, audience-filtered.
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function note(
  s: RealSession,
  archive: string,
  title: string,
  type: string,
  body: string,
): Promise<string> {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type,
    body,
  });
  if (res.status !== 201) throw new Error(`create '${title}' failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** Restrict a note to its author only (private-to-author) via a pool fixture. */
async function restrict(archive: string, noteId: string): Promise<void> {
  await ctx.pool.query(
    `insert into public.audiences (archive_id, note_id, kind)
     values ($1, $2, 'private-to-author')
     on conflict (note_id) do update set kind = excluded.kind`,
    [archive, noteId],
  );
}

async function addMember(archive: string, userId: string): Promise<void> {
  await ctx.pool.query(
    `insert into public.memberships (archive_id, user_id, role)
     values ($1, $2, 'contributor') on conflict do nothing`,
    [archive, userId],
  );
}

describe('FM-020 people index and neighborhood', () => {
  it('people index lists person pages with backlink counts', async () => {
    const s = await ctx.realSession(`ppl-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Ppl ${RUN}`);
    await note(s, archive, 'Mom', 'person', 'She loved the sea.');
    await note(s, archive, 'Dad', 'person', 'He built boats.');
    await note(s, archive, 'Beach Trip', 'event', 'With [[Mom]] and [[Mom]] again and [[Dad]].');

    const res = await ctx.api(s.token, 'GET', `/v1/archives/${archive}/people`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: string; title: string; backlinks: number }>;
    // only person-typed notes, each with its incoming-occurrence count
    expect(rows.map((r) => r.title).sort()).toEqual(['Dad', 'Mom']);
    const mom = rows.find((r) => r.title === 'Mom')!;
    const dad = rows.find((r) => r.title === 'Dad')!;
    expect(mom.backlinks).toBe(2);
    expect(dad.backlinks).toBe(1);
    // summaries only — no body leaks into the index
    for (const r of rows) expect(r).not.toHaveProperty('body');

    const stranger = await ctx.realSession(`pplx-${RUN}@test.local`);
    expect((await ctx.api(stranger.token, 'GET', `/v1/archives/${archive}/people`)).status).toBe(
      404,
    );
  });

  it('local connections renders a depth bounded neighborhood', async () => {
    const s = await ctx.realSession(`nbr-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Nbr ${RUN}`);
    // A -> B -> C -> D (chain); depth 1 from A sees B, depth 2 sees C, never D
    await note(s, archive, 'A Hub', 'event', 'Links [[B Node]].');
    const bId = await note(s, archive, 'B Node', 'event', 'Links [[C Node]].');
    await note(s, archive, 'C Node', 'event', 'Links [[D Node]].');
    await note(s, archive, 'D Node', 'event', 'The far edge.');
    const aId = (
      (await (await ctx.api(s.token, 'GET', `/v1/archives/${archive}/notes`)).json()) as Array<{
        id: string;
        title: string;
      }>
    ).find((n) => n.title === 'A Hub')!.id;

    const d1 = await ctx.api(
      s.token,
      'GET',
      `/v1/archives/${archive}/notes/${aId}/neighborhood?depth=1`,
    );
    expect(d1.status).toBe(200);
    const g1 = (await d1.json()) as {
      nodes: Array<{ id: string; title: string; depth: number }>;
      edges: Array<{ source: string; target: string }>;
    };
    expect(g1.nodes.map((n) => n.title).sort()).toEqual(['A Hub', 'B Node']);
    expect(g1.edges).toContainEqual({ source: aId, target: bId });

    const d2 = await ctx.api(
      s.token,
      'GET',
      `/v1/archives/${archive}/notes/${aId}/neighborhood?depth=2`,
    );
    const g2 = (await d2.json()) as { nodes: Array<{ title: string; depth: number }> };
    expect(g2.nodes.map((n) => n.title).sort()).toEqual(['A Hub', 'B Node', 'C Node']);
    // each node reports its shortest depth
    expect(g2.nodes.find((n) => n.title === 'A Hub')!.depth).toBe(0);
    expect(g2.nodes.find((n) => n.title === 'C Node')!.depth).toBe(2);
    expect(g2.nodes.map((n) => n.title)).not.toContain('D Node');

    // an unknown / invisible seed is a uniform 404
    expect(
      (await ctx.api(s.token, 'GET', `/v1/archives/${archive}/notes/${randomUUID()}/neighborhood`))
        .status,
    ).toBe(404);
  });

  it('restricted notes are absent from neighborhood nodes and counts', async () => {
    const owner = await ctx.realSession(`res-${RUN}@test.local`);
    const other = await ctx.realSession(`reso-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `Res ${RUN}`);
    await addMember(archive, other.userId);

    // A links P(restricted) and Pub Person; P (a bridge) links C End and Pub Person.
    // For a non-author, P is unreachable, so C (only reachable via P) must not
    // appear, and Pub Person's backlink count must drop the restricted source P.
    const aId = await note(
      owner,
      archive,
      'A Start',
      'event',
      'To [[P Bridge]] and [[Pub Person]].',
    );
    const pId = await note(
      owner,
      archive,
      'P Bridge',
      'person',
      'Links [[C End]] and [[Pub Person]].',
    );
    await note(owner, archive, 'C End', 'event', 'Beyond the bridge.');
    await note(owner, archive, 'Pub Person', 'person', 'A public person.');
    await restrict(archive, pId);

    // owner (author) sees the restricted bridge and everything through it
    // (Pub Person is a depth-1 neighbor because it links back to A Start)
    const ownerView = (await (
      await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/notes/${aId}/neighborhood?depth=2`)
    ).json()) as { nodes: Array<{ title: string }> };
    expect(ownerView.nodes.map((n) => n.title).sort()).toEqual([
      'A Start',
      'C End',
      'P Bridge',
      'Pub Person',
    ]);

    // non-author: P is absent AND C (reachable ONLY via the restricted P) is
    // absent — no bridge leak; Pub Person stays (it links to A directly)
    const otherView = (await (
      await ctx.api(other.token, 'GET', `/v1/archives/${archive}/notes/${aId}/neighborhood?depth=2`)
    ).json()) as { nodes: Array<{ title: string }> };
    expect(otherView.nodes.map((n) => n.title).sort()).toEqual(['A Start', 'Pub Person']);
    expect(otherView.nodes.map((n) => n.title)).not.toContain('P Bridge');
    expect(otherView.nodes.map((n) => n.title)).not.toContain('C End');

    // and restricted sources do not inflate a non-author's people-index counts
    const people = (await (
      await ctx.api(other.token, 'GET', `/v1/archives/${archive}/people`)
    ).json()) as Array<{ title: string; backlinks: number }>;
    // P Bridge itself (a person) is restricted -> absent from the non-author's index
    expect(people.map((r) => r.title)).not.toContain('P Bridge');
    // Pub Person is linked from A (visible) and P (restricted) -> count is 1, not 2
    const pub = people.find((r) => r.title === 'Pub Person')!;
    expect(pub.backlinks).toBe(1);
    // the author counts both
    const peopleOwner = (await (
      await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/people`)
    ).json()) as Array<{ title: string; backlinks: number }>;
    expect(peopleOwner.find((r) => r.title === 'Pub Person')!.backlinks).toBe(2);
  });
});
