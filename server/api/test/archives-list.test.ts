import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext } from './helpers';

const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

describe('GET /v1/archives', () => {
  it("lists only the caller's archives; a new user gets []", async () => {
    const owner = await ctx.realSession(`al-${RUN}@test.local`);
    const other = await ctx.realSession(`alo-${RUN}@test.local`);

    const empty = await ctx.api(owner.token, 'GET', '/v1/archives');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const archive = await ctx.provisionArchive(owner, `Mine ${RUN}`);
    await ctx.provisionArchive(other, `Theirs ${RUN}`);

    const mine = (await (await ctx.api(owner.token, 'GET', '/v1/archives')).json()) as Array<{
      id: string;
      subjectName: string;
      kind: string;
      role: string;
    }>;
    expect(mine).toEqual([
      {
        id: archive,
        subjectName: `Mine ${RUN}`,
        kind: 'personal',
        jurisdiction: 'US',
        role: 'owner',
      },
    ]);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await ctx.app.request('/v1/archives');
    expect(res.status).toBe(401);
  });
});
