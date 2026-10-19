import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext } from './helpers';

// Extra coverage for the D-24 fence-amended endpoint (not a contract-required
// test — FM-019's required tests exercise it end-to-end through the UI).
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

describe('FM-019 notes list endpoint', () => {
  it('notes list returns summaries for members and uniform 404 for strangers', async () => {
    const owner = await ctx.realSession(`list-${RUN}@test.local`);
    const stranger = await ctx.realSession(`lists-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `List ${RUN}`);
    for (const title of ['Alpha', 'Beta']) {
      const res = await ctx.api(owner.token, 'POST', `/v1/archives/${archive}/notes`, {
        title,
        type: 'event',
        body: 'x',
      });
      expect(res.status).toBe(201);
    }
    const list = await ctx.api(owner.token, 'GET', `/v1/archives/${archive}/notes`);
    expect(list.status).toBe(200);
    const rows = (await list.json()) as Array<{ id: string; title: string; type: string }>;
    expect(rows.map((r) => r.title).sort()).toEqual(['Alpha', 'Beta']);
    // summaries only — bodies never ship in the list
    for (const r of rows) expect(r).not.toHaveProperty('body');

    const foreign = await ctx.api(stranger.token, 'GET', `/v1/archives/${archive}/notes`);
    expect(foreign.status).toBe(404);
  });
});
