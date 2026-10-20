import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { testContext, type RealSession } from './helpers';

// Local Supabase stack must be running — these tests FAIL when it is down (loop rule 1).
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

interface NoteResponse {
  id: string;
  title: string;
  body: string;
}

async function createNote(
  s: RealSession,
  archive: string,
  title: string,
  body: string,
  type = 'event',
): Promise<NoteResponse> {
  const res = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
    title,
    type,
    body,
  });
  if (res.status !== 201) throw new Error(`create '${title}' failed: ${res.status}`);
  return (await res.json()) as NoteResponse;
}

async function getNote(s: RealSession, archive: string, id: string): Promise<NoteResponse> {
  const res = await ctx.api(s.token, 'GET', `/v1/archives/${archive}/notes/${id}`);
  if (res.status !== 200) throw new Error(`get note failed: ${res.status}`);
  return (await res.json()) as NoteResponse;
}

describe('FM-016 rename with link-text rewrite', () => {
  it('rename rewrites incoming links preserving aliases embeds and anchors', async () => {
    const s = await ctx.realSession(`ren1-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Ren1 ${RUN}`);
    const mom = await createNote(
      s,
      archive,
      'Mom',
      'She loved the sea. ^b1\nAlso [[Mom]] herself and [[#Sea]].',
      'person',
    );
    const referrerBody = [
      'See [[Mom]] and [[Mom|my mother]] and ![[Mom]] and [[Mom#^b1]].',
      '```',
      '[[Mom]] in code stays',
      '```',
    ].join('\n');
    const a = await createNote(s, archive, 'Beach Trip', referrerBody);

    const renamed = await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${mom.id}`, {
      title: 'Grandma Kim',
    });
    expect(renamed.status).toBe(200);

    // referrer body rewritten byte-exactly: alias + embed + block fragment kept,
    // code fence untouched
    const after = await getNote(s, archive, a.id);
    expect(after.body).toBe(
      [
        'See [[Grandma Kim]] and [[Grandma Kim|my mother]] and ![[Grandma Kim]] and [[Grandma Kim#^b1]].',
        '```',
        '[[Mom]] in code stays',
        '```',
      ].join('\n'),
    );

    // title-only rename also rewrites the renamed note's OWN full self-link,
    // while the bare [[#Sea]] fragment (no target) is untouched
    const momAfter = await getNote(s, archive, mom.id);
    expect(momAfter.body).toBe(
      'She loved the sea. ^b1\nAlso [[Grandma Kim]] herself and [[#Sea]].',
    );

    // occurrences stay resolved to the SAME uuid, with the new authored text;
    // self rows survive the rename (incl. the empty-target fragment row)
    const backs = await ctx.api(
      s.token,
      'GET',
      `/v1/archives/${archive}/notes/${mom.id}/backlinks`,
    );
    const rows = (
      (await backs.json()) as {
        occurrences: Array<{
          sourceId: string;
          target: string;
          resolvedId: string;
        }>;
      }
    ).occurrences;
    const fromReferrer = rows.filter((r) => r.sourceId === a.id);
    expect(fromReferrer).toHaveLength(4);
    for (const r of fromReferrer) {
      expect(r.target).toBe('Grandma Kim');
      expect(r.resolvedId).toBe(mom.id);
    }
    const selfTargets = rows
      .filter((r) => r.sourceId === mom.id)
      .map((r) => r.target)
      .sort();
    expect(selfTargets).toEqual(['', 'Grandma Kim']);
  });

  it('citations by uuid and block anchor resolve identically across rename', async () => {
    const s = await ctx.realSession(`ren2-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Ren2 ${RUN}`);
    const mom = await createNote(s, archive, 'Mom Two', 'The wedding story. ^wed', 'person');
    await createNote(s, archive, 'Referrer Two', 'As told in [[Mom Two#^wed]].');

    // the machine citation is (uuid, blockId) — capture it before the rename
    const citation = { noteId: mom.id, blockId: 'wed' };
    const before = await getNote(s, archive, citation.noteId);
    expect(before.body).toContain('^wed');

    const renamed = await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${mom.id}`, {
      title: 'Grandma',
    });
    expect(renamed.status).toBe(200);

    // same uuid still fetches the note; the whole body is byte-identical —
    // a rename must not touch the cited note's content at all
    const resolvedAfter = await getNote(s, archive, citation.noteId);
    expect(resolvedAfter.title).toBe('Grandma');
    expect(resolvedAfter.body).toBe(before.body);
    expect(resolvedAfter.body).toContain('^wed');
    // the rewritten occurrence still carries the SAME (uuid, blockId) pair
    const backs = await ctx.api(
      s.token,
      'GET',
      `/v1/archives/${archive}/notes/${mom.id}/backlinks`,
    );
    const rows = (
      (await backs.json()) as {
        occurrences: Array<{
          target: string;
          resolvedId: string;
          blockId?: string;
        }>;
      }
    ).occurrences;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target: 'Grandma',
      resolvedId: citation.noteId,
      blockId: 'wed',
    });
  });

  it('each rewritten referrer gains an attributed revision row', async () => {
    const s = await ctx.realSession(`ren3-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Ren3 ${RUN}`);
    const mom = await createNote(s, archive, 'Mom Three', 'body', 'person');
    const r1 = await createNote(s, archive, 'Referrer A', 'First [[Mom Three]].');
    const r2 = await createNote(s, archive, 'Referrer B', 'Second [[Mom Three|mother]].');
    const untouched = await createNote(s, archive, 'Unrelated', 'No links here.');

    // a SECOND member performs the rename, so "attributed to the renaming user"
    // is discriminative: creator, owner, and renamer are different candidates
    const renamer = await ctx.realSession(`ren3b-${RUN}@test.local`);
    await ctx.pool.query(
      `insert into public.memberships (archive_id, user_id, role)
       values ($1, $2, 'contributor') on conflict do nothing`,
      [archive, renamer.userId],
    );
    const renamed = await ctx.api(renamer.token, 'PUT', `/v1/archives/${archive}/notes/${mom.id}`, {
      title: 'Grandmother Three',
    });
    expect(renamed.status).toBe(200);

    for (const [note, expected] of [
      [r1, 'First [[Grandmother Three]].'],
      [r2, 'Second [[Grandmother Three|mother]].'],
    ] as const) {
      const revs = await ctx.api(
        s.token,
        'GET',
        `/v1/archives/${archive}/notes/${note.id}/revisions`,
      );
      const rows = (await revs.json()) as Array<{ id: string; author: string; reason: string }>;
      // create + rewrite = 2, newest first, attributed to the RENAMER (not the creator)
      expect(rows).toHaveLength(2);
      expect(rows[0]?.author).toBe(renamer.userId);
      expect(rows[1]?.author).toBe(s.userId);
      // FM-039: the list is metadata-only, so the body assertion — which is the
      // point of this test — now reads through the revision-by-id route.
      const head = await ctx.api(
        s.token,
        'GET',
        `/v1/archives/${archive}/notes/${note.id}/revisions/${rows[0]!.id}`,
      );
      expect(head.status).toBe(200);
      expect(((await head.json()) as { body: string }).body).toBe(expected);
    }
    const untouchedRevs = await ctx.api(
      s.token,
      'GET',
      `/v1/archives/${archive}/notes/${untouched.id}/revisions`,
    );
    expect((await untouchedRevs.json()) as unknown[]).toHaveLength(1);
  });

  it('rename to a case insensitive colliding title is rejected', async () => {
    const s = await ctx.realSession(`ren4-${RUN}@test.local`);
    const archive = await ctx.provisionArchive(s, `Ren4 ${RUN}`);
    const mom = await createNote(s, archive, 'Mom Four', 'body', 'person');
    const referrer = await createNote(s, archive, 'Referrer Four', 'Links [[Mom Four]].');
    await createNote(s, archive, 'Private Note', 'other');

    // collision (case-insensitive, padded) -> 409; nothing changes anywhere
    const collide = await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${mom.id}`, {
      title: '  private NOTE ',
    });
    expect(collide.status).toBe(409);
    expect((await getNote(s, archive, mom.id)).title).toBe('Mom Four');
    expect((await getNote(s, archive, referrer.id)).body).toBe('Links [[Mom Four]].');
    const revs = await ctx.api(
      s.token,
      'GET',
      `/v1/archives/${archive}/notes/${referrer.id}/revisions`,
    );
    expect((await revs.json()) as unknown[]).toHaveLength(1);

    // titles carrying wikilink syntax are refused BEFORE any splice — they would
    // forge or corrupt links in other members' bodies (panel finding)
    for (const bad of ['Trip #3', 'Either|Or', 'X]] [[Salary Data', 'line\nbreak']) {
      const res = await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${mom.id}`, {
        title: bad,
      });
      expect(res.status).toBe(400);
    }
    expect((await getNote(s, archive, mom.id)).title).toBe('Mom Four');
    expect((await getNote(s, archive, referrer.id)).body).toBe('Links [[Mom Four]].');
    const badCreate = await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
      title: 'Weird|Name',
      type: 'event',
      body: 'x',
    });
    expect(badCreate.status).toBe(400);

    // case-only self-rename is allowed and STILL rewrites referrer casing
    const caseOnly = await ctx.api(s.token, 'PUT', `/v1/archives/${archive}/notes/${mom.id}`, {
      title: 'MOM FOUR',
    });
    expect(caseOnly.status).toBe(200);
    expect((await getNote(s, archive, mom.id)).title).toBe('MOM FOUR');
    expect((await getNote(s, archive, referrer.id)).body).toBe('Links [[MOM FOUR]].');
  });
});
