import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { crossNoteMarker } from '../src/conflicts';
import { markerTarget, withoutMarkersNaming } from '../src/notes';
import { testContext, type RealSession } from './helpers';

/**
 * FR-143: "undo" and "delete" mean gone, including what the machine quoted of a note elsewhere
 * (round-3 review D2). An import that finds two memories disagreeing writes into the new one
 * `> ⚠ May disagree with [[<other>]] · … that note says “<the other's words>”`. When the other
 * note was erased, that line stayed, word for word, under a dead link; a preview made before the
 * erasure wrote it into a new note; and the jobs kept quoting it.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);
afterAll(async () => {
  await ctx.close();
});

const BORN_1950 = 'I was born in 1950 in the fishing village of Haeundae near the harbour.';
const BORN_1946 = 'I was born in 1946 in the fishing village of Haeundae near the harbour.';
const interview = (answer: string, tag: string) => ({
  interviewee: 'Grandma Kim',
  segments: [
    { start: 0, end: 5, speaker: 'Interviewer', text: `Where were you born? ${tag}` },
    { start: 6, end: 15, speaker: 'Grandma Kim', text: answer },
  ],
});

interface Saved {
  status: string;
  jobId: string;
  runId: string;
  saved: Array<{ id: string; title: string }>;
  memories: Array<{ body: string; conflicts?: unknown[]; notes: string[] }>;
}

let n = 0;
async function setup(label: string) {
  const owner = await ctx.realSession(`eq-${label}-${RUN}-${n++}@test.local`);
  const archive = await ctx.provisionArchive(owner, `EQ ${label} ${RUN}`);
  const call = (method: string, path: string, body?: unknown, s: RealSession = owner) =>
    ctx.api(s.token, method, `/v1/archives/${archive}${path}`, body);
  const ingest = async (body: object): Promise<Saved> => {
    const r = await call('POST', '/ingest', body);
    expect(r.status).toBe(200);
    return (await r.json()) as Saved;
  };
  const q = async <T>(sql: string, p: unknown[]) => (await ctx.pool.query(sql, p)).rows as T[];
  const note = async (id: string) =>
    (
      await q<{ title: string; body: string }>(
        `select title, body from public.notes where id = $1`,
        [id],
      )
    )[0];
  const reasons = async (id: string) =>
    (
      await q<{ reason: string }>(
        `select reason::text from public.revisions where note_id = $1 order by seq`,
        [id],
      )
    ).map((r) => r.reason);
  const links = async (id: string) =>
    await q<{ target: string; resolved_id: string | null }>(
      `select target, resolved_id from public.links where source_id = $1`,
      [id],
    );
  const chunkText = async (id: string) =>
    (await q<{ content: string }>(`select content from public.chunks where note_id = $1`, [id]))
      .map((r) => r.content)
      .join('\n');
  /** the first interview, saved; then the second, saved: it disagrees with the first */
  const twoImports = async () => {
    const first = await ingest({ transcript: interview(BORN_1950, `one ${RUN}`), save: true });
    const second = await ingest({ transcript: interview(BORN_1946, `two ${RUN}`), save: true });
    const a = first.saved[0]!;
    const b = second.saved[0]!;
    // the premise: the second memory quotes the first, under a link to it
    expect((await note(b.id))!.body).toContain(`May disagree with [[${a.title}]]`);
    expect((await note(b.id))!.body).toContain('1950');
    expect((await links(b.id)).map((l) => l.resolved_id)).toContain(a.id);
    return { first, second, a, b };
  };
  return { owner, archive, call, ingest, note, reasons, links, chunkText, twoImports };
}

describe('the reader of a "may disagree" line', () => {
  const at = { when: '2026-10-19', who: 'Mina', channel: 'interview' as const, teller: 'Grandma' };
  const en = crossNoteMarker(at, {
    claim: 'I was born in 1946.',
    title: 'Born in Haeundae',
    existing: 'I was born in 1950.',
  });
  const ko = crossNoteMarker(at, {
    claim: '저는 1946년에 태어났어요.',
    title: '해운대에서 태어남',
    existing: '저는 1950년에 태어났어요.',
  });
  const viaAssistant = crossNoteMarker(
    { ...at, channel: 'assistant' },
    { claim: 'She left in 1971.', title: 'The move', existing: 'She left in 1970.' },
  );

  it('knows the line in both languages and from the assistant, and nothing a person rewrote', () => {
    expect(markerTarget(en)).toBe('Born in Haeundae');
    expect(markerTarget(ko)).toBe('해운대에서 태어남');
    expect(markerTarget(viaAssistant)).toBe('The move');
    expect(markerTarget(`${en}\r`)).toBe('Born in Haeundae');
    expect(markerTarget('We talked about [[Born in Haeundae]] at dinner.')).toBeNull();
    expect(markerTarget(en.replace('that note says', 'I think it says'))).toBeNull();
    expect(markerTarget(`${en} I am not so sure.`)).toBeNull();
  });

  it('takes out only the lines naming an erased title, and leaves no empty block behind', () => {
    const gone = new Set(['born in haeundae']);
    const joined = `Words.\n\n> Question: “Where?”\n${en}`;
    expect(withoutMarkersNaming(joined, gone)).toBe('Words.\n\n> Question: “Where?”');
    expect(withoutMarkersNaming(`Words.\n\n${en}`, gone)).toBe('Words.');
    expect(withoutMarkersNaming(`Words.\n\n${en}\n\nMore words.`, gone)).toBe(
      'Words.\n\nMore words.',
    );
    expect(withoutMarkersNaming(`Words.\n\n${en}\n${viaAssistant}`, gone)).toBe(
      `Words.\n\n${viaAssistant}`,
    );
    const own = `Words about [[Born in Haeundae]].\n\n${en}`;
    expect(withoutMarkersNaming(own, gone)).toBe('Words about [[Born in Haeundae]].');
    expect(withoutMarkersNaming(joined, new Set(['the move']))).toBe(joined);
    expect(withoutMarkersNaming(`가.\n\n${ko}`, new Set(['해운대에서 태어남']))).toBe('가.');
  });

  it('reads 400,000 characters of near-misses in linear time', () => {
    const gone = new Set(['born in haeundae']);
    const almost = en.slice(0, -1); // never closes
    const lines = Math.ceil(400_000 / almost.length);
    const body = Array.from({ length: lines }, () => almost).join('\n');
    const long = `> ⚠ May disagree with [[${'x]] · '.repeat(80_000)}: that note says “”`;
    const t0 = performance.now();
    expect(withoutMarkersNaming(body, gone)).toBe(body);
    expect(withoutMarkersNaming(`${long}\n${en}`, gone)).toBe(long);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('D2 an erased note is not quoted by the notes that disagreed with it', () => {
  it(
    "undo: the other import's memory loses the line, as a machine revision that does not hold its own undo back",
    { timeout: 60_000 },
    async () => {
      const { call, note, reasons, links, chunkText, twoImports } = await setup('undo');
      const { first, second, a, b } = await twoImports();
      const u = await call('POST', `/ingest-runs/${first.runId}/undo`);
      expect(await u.json()).toEqual({ erased: 1, kept: [], alreadyUndone: false });
      const after = (await note(b.id))!.body;
      expect(after).not.toContain('1950');
      expect(after).not.toContain('May disagree');
      expect(after).toContain(BORN_1946);
      expect(after).toContain('> From the interview transcript');
      expect(await links(b.id)).toEqual([]);
      expect(await chunkText(b.id)).not.toContain('1950');
      expect(await reasons(b.id)).toEqual(['ai-suggestion', 'erasure-cascade']);
      void a;
      // the machine took the line out: the second import is still undone in full
      const u2 = await call('POST', `/ingest-runs/${second.runId}/undo`);
      expect(await u2.json()).toEqual({ erased: 1, kept: [], alreadyUndone: false });
    },
  );

  it(
    'delete by hand: the line goes; a link a person wrote to the same note stays theirs',
    { timeout: 60_000 },
    async () => {
      const { call, note, reasons, twoImports } = await setup('delete');
      const { a, b } = await twoImports();
      const own = `\n\nWe talked about [[${a.title}]] at dinner.`;
      const edited = await call('PUT', `/notes/${b.id}`, { body: (await note(b.id))!.body + own });
      expect(edited.status).toBe(200);
      expect((await call('DELETE', `/notes/${a.id}`)).status).toBe(200);
      const after = (await note(b.id))!.body;
      expect(after).not.toContain('May disagree');
      expect(after).not.toContain('1950 in the fishing village of Haeundae near');
      expect(after).toContain(`We talked about [[${a.title}]] at dinner.`);
      expect(await reasons(b.id)).toEqual(['ai-suggestion', 'edit', 'erasure-cascade']);
    },
  );

  it(
    'a preview made before the erasure saves without the quote, and no job goes on holding it',
    { timeout: 60_000 },
    async () => {
      const { call, note, links, ingest } = await setup('stale');
      const first = await ingest({ transcript: interview(BORN_1950, `one ${RUN}`), save: true });
      const preview = await ingest({ transcript: interview(BORN_1946, `two ${RUN}`) });
      expect(preview.status).toBe('previewed');
      expect(JSON.stringify(preview.memories)).toContain('1950');
      expect((await call('POST', `/ingest-runs/${first.runId}/undo`)).status).toBe(200);
      // the preview, looked at again, no longer quotes the erased memory
      const held = (await (await call('GET', `/ingest/${preview.jobId}`)).json()) as {
        outcome: Saved;
      };
      expect(JSON.stringify(held.outcome)).not.toContain('1950');
      expect(held.outcome.memories[0]!.conflicts).toBeUndefined();
      const saved = (await (
        await call('POST', `/ingest/${preview.jobId}/save`, {})
      ).json()) as Saved;
      expect(saved.status).toBe('saved');
      const body = (await note(saved.saved[0]!.id))!.body;
      expect(body).not.toContain('1950');
      expect(body).not.toContain('May disagree');
      expect(await links(saved.saved[0]!.id)).toEqual([]);
    },
  );

  it(
    'a save checks again under the lock: a note made private after the preview is not quoted',
    { timeout: 60_000 },
    async () => {
      const { archive, call, note, ingest } = await setup('lock');
      const first = await ingest({ transcript: interview(BORN_1950, `one ${RUN}`), save: true });
      const preview = await ingest({ transcript: interview(BORN_1946, `two ${RUN}`) });
      expect(JSON.stringify(preview.memories)).toContain('1950');
      // nothing tells the jobs about this: the save itself must notice
      await ctx.pool.query(
        `insert into public.audiences (archive_id, note_id, kind) values ($1, $2, 'private-to-author')`,
        [archive, first.saved[0]!.id],
      );
      const saved = (await (
        await call('POST', `/ingest/${preview.jobId}/save`, {})
      ).json()) as Saved;
      expect(saved.status).toBe('saved');
      const body = (await note(saved.saved[0]!.id))!.body;
      expect(body).not.toContain('1950');
      expect(JSON.stringify(saved.memories)).not.toContain('1950');
    },
  );

  it('a hand delete also lets go of what an open preview quotes', { timeout: 60_000 }, async () => {
    const { call, ingest } = await setup('preview-delete');
    const first = await ingest({ transcript: interview(BORN_1950, `one ${RUN}`), save: true });
    const preview = await ingest({ transcript: interview(BORN_1946, `two ${RUN}`) });
    expect(JSON.stringify(preview.memories)).toContain('1950');
    expect((await call('DELETE', `/notes/${first.saved[0]!.id}`)).status).toBe(200);
    const held = (await (await call('GET', `/ingest/${preview.jobId}`)).json()) as {
      outcome: Saved;
    };
    expect(JSON.stringify(held.outcome)).not.toContain('1950');
    expect(held.outcome.memories[0]!.body).toContain(BORN_1946);
  });
});
