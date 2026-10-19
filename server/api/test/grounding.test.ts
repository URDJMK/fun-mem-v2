import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-026 — retrieval side of grounded Q&A.
 *
 * Two properties are asserted here and nowhere else: search now reports WHICH
 * leg found each hit (hardening req 2, the input to abstention), and a
 * restricted note never enters that set at all. The second is the one FM-027
 * depends on — its named shortcut is "strip restricted citations
 * post-generation instead of pre-retrieval", and post-generation stripping
 * cannot catch restricted content paraphrased into prose without a citation.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

async function makeNote(s: RealSession, archive: string, title: string, body: string) {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body,
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/** Fixture mechanism only — never an access-control oracle. */
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

afterAll(async () => {
  await ctx.close();
});

describe('FM-026 grounded retrieval', () => {
  it('search reports which leg found each hit', async () => {
    const s = await ctx.realSession(`gr1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `GR1 ${RUN}`);
    await makeNote(s, archive, `할머니 ${RUN}`, '할머니는 1943년에 부산에서 태어나셨다.');

    const res = await ctx.app.request(
      `/v1/archives/${archive}/search?q=${encodeURIComponent('부산')}`,
      { headers: { authorization: `Bearer ${s.token}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ legs?: string[]; ranks?: Record<string, number>; score: number }>;
    };
    expect(body.results.length, 'nothing matched, so leg reporting is untested').toBeGreaterThan(0);

    const hit = body.results[0]!;
    expect(Array.isArray(hit.legs), 'legs was not projected').toBe(true);
    expect(hit.legs!.length, 'a hit with no leg is impossible').toBeGreaterThan(0);
    // every reported leg is a real leg name, and carries a rank
    for (const leg of hit.legs!) {
      expect(['ts', 'pgroonga', 'vector', 'title', 'date']).toContain(leg);
      expect(typeof hit.ranks![leg], `no rank for leg ${leg}`).toBe('number');
    }
    // a content query must be found by a CONTENT leg, not only by the title —
    // otherwise abstention could never distinguish evidence from metadata
    expect(hit.legs!.some((l) => l === 'ts' || l === 'pgroonga' || l === 'vector')).toBe(true);
  });

  it('search excludes a restricted note from every leg', async () => {
    const owner = await ctx.realSession(`gr2a-${RUN}@test.local`);
    const member = await ctx.realSession(`gr2b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `GR2 ${RUN}`);
    const secret = `ZZSECRET${RUN}`;
    const noteId = await makeNote(owner, archive, `비밀 ${RUN}`, `${secret} 특별한 이야기`);
    await addMember(archive, member.userId);
    await restrict(archive, noteId);

    // POSITIVE CONTROL: the owner CAN find it. Without this, "the stranger
    // finds nothing" is satisfied by a query that matches nothing at all.
    const byOwner = await ctx.app.request(
      `/v1/archives/${archive}/search?q=${encodeURIComponent(secret)}`,
      { headers: { authorization: `Bearer ${owner.token}` } },
    );
    const ownerBody = (await byOwner.json()) as { results: unknown[] };
    expect(ownerBody.results.length, 'the note is unfindable even by its owner').toBeGreaterThan(0);

    // a co-member without access finds nothing, and no fragment leaks
    const res = await ctx.app.request(
      `/v1/archives/${archive}/search?q=${encodeURIComponent(secret)}`,
      { headers: { authorization: `Bearer ${member.token}` } },
    );
    const text = await res.text();
    expect(text, 'restricted content leaked into a retrieval response').not.toContain(secret);
    const body = JSON.parse(text) as { results: unknown[]; total: number };
    expect(body.results, 'a restricted note was retrievable').toHaveLength(0);
    // the candidate count must not disclose existence either
    expect(body.total).toBe(0);
  });
});
