import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

/**
 * FM-026 — the /ask endpoint end to end, against real Postgres and real
 * sessions. The unit suites prove each stage in isolation; this proves they are
 * actually wired in that order, which is the part a reverted wiring would still
 * pass unit tests for (the FM-055 lesson).
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

async function makeNote(s: RealSession, archive: string, title: string, body: string) {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type: 'event',
    body,
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

const ask = (s: RealSession, archive: string, question: string, turn = 0) =>
  ctx.app.request(`/v1/archives/${archive}/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ question, turn }),
  });

interface AskBody {
  providerVersion: string;
  selfIdentification: string | null;
  abstained: boolean;
  reason: string;
  message?: string;
  claims: Array<{ text: string; kind: string; citation: { noteId: string; chunkId: string } }>;
  evidence: { relevant: number; fitted: number };
}

describe('FM-026 ask endpoint', () => {
  it('every claim in an answer cites evidence that was actually retrieved', async () => {
    const s = await ctx.realSession(`ask1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `ASK1 ${RUN}`);
    const noteId = await makeNote(
      s,
      archive,
      `할머니 ${RUN}`,
      '할머니는 1943년에 부산에서 태어나셨다. 어린 시절 이야기를 자주 하셨다.',
    );

    const res = await ask(s, archive, '부산');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AskBody;

    expect(body.abstained, `abstained unexpectedly: ${body.reason}`).toBe(false);
    expect(body.claims.length).toBeGreaterThan(0);

    // Every citation points at the note we actually wrote — nothing invented.
    for (const cl of body.claims) {
      expect(cl.citation.noteId).toBe(noteId);
      expect(cl.citation.chunkId).toBeTruthy();
      expect(['quote', 'paraphrase', 'inference']).toContain(cl.kind);
    }
    // the provider is recorded, so an answer is auditable
    expect(body.providerVersion).toBeTruthy();
    // and self-identification is present on the first turn
    expect(body.selfIdentification, 'no self-identification on turn 0').toBeTruthy();
    expect((await (await ask(s, archive, '부산', 3)).json()).selfIdentification).toBeNull();
  });

  it('a question the archive cannot answer abstains with an offer', async () => {
    const s = await ctx.realSession(`ask2-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `ASK2 ${RUN}`);
    await makeNote(s, archive, `할머니 ${RUN}`, '할머니는 부산에서 태어나셨다.');

    // nothing in the archive is about this
    const res = await ask(s, archive, `ZZUNRELATED${RUN}`);
    const body = (await res.json()) as AskBody;
    expect(body.abstained, 'answered a question with no evidence').toBe(true);
    expect(body.claims).toHaveLength(0);
    expect(body.message, 'abstention carried no message').toBeTruthy();
    expect(body.message, 'the abstention offers no next step').toMatch(/가족|물어/);
  });

  it('a restricted note is never retrieved into evidence', async () => {
    const owner = await ctx.realSession(`ask3a-${RUN}@test.local`);
    const member = await ctx.realSession(`ask3b-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(owner, `ASK3 ${RUN}`);
    const secret = `ZZSECRET${RUN}`;
    const noteId = await makeNote(owner, archive, `비밀 ${RUN}`, `${secret} 특별한 이야기입니다.`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role)
       values ($1, $2, 'contributor') on conflict do nothing`,
      [archive, member.userId],
    );

    // POSITIVE CONTROL: before restricting, the co-member CAN get it. Without
    // this, the assertion below is satisfied by an endpoint that answers nothing.
    const before = (await (await ask(member, archive, secret)).json()) as AskBody;
    expect(before.abstained, 'the endpoint answers nothing even unrestricted').toBe(false);

    await ctx.pool.query(
      `insert into public.audiences (archive_id, note_id, kind)
       values ($1, $2, 'private-to-author')
       on conflict (note_id) do update set kind = excluded.kind`,
      [archive, noteId],
    );

    const res = await ask(member, archive, secret);
    const text = await res.text();
    expect(text, 'restricted content reached the answer').not.toContain(secret);
    const body = JSON.parse(text) as AskBody;
    expect(body.abstained, 'answered from a restricted note').toBe(true);
    expect(body.claims).toHaveLength(0);
  });
});
