import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { parseFuzzyDate, validateNoteTitle } from '@funmem/core';
import { testContext, type RealSession } from './helpers';
import { linkKnownTitles, readFuzzyDate, readTitle, readType } from '../src/drafts';

/**
 * FM-071 — "let the app write the memory for me".
 *
 * The property that matters most here is a NEGATIVE one and it is asserted
 * directly: the composer never returns a sentence the contributor did not
 * write. Everything else — the title, the date, the links — is a rearrangement
 * of their own words, and the route writes no rows at all.
 */
const ctx = testContext();
const RUN = randomUUID().slice(0, 8);

afterAll(async () => {
  await ctx.close();
});

interface Draft {
  title: string;
  type: string;
  occurred: string | null;
  body: string;
  notes: string[];
  providerVersion: string;
}

const draft = (s: RealSession, archive: string, body: unknown) =>
  ctx.api(s.token, 'POST', `/v1/archives/${archive}/drafts`, body);

describe('FM-071 draft composition', () => {
  describe('reading a fuzzy date out of Korean prose', () => {
    it('reads the forms people actually write', () => {
      expect(readFuzzyDate('1987년 3월 15일에 있었던 일')).toBe('1987-03-15');
      expect(readFuzzyDate('1987년 3월에')).toBe('1987-03');
      expect(readFuzzyDate('1987년 봄')).toBe('1987');
      expect(readFuzzyDate('1994-07-15 이었다')).toBe('1994-07-15');
      expect(readFuzzyDate('1994.07.15')).toBe('1994-07-15');
      expect(readFuzzyDate('그해는 1962년이었다')).toBe('1962');
    });

    it('marks approximation only where the contributor hedged', () => {
      // THEIR uncertainty, never ours — this function has no confidence of its
      // own to express, and a `~` we invented would be a claim about the record
      expect(readFuzzyDate('1948년쯤이었을 거예요')).toBe('~1948');
      expect(readFuzzyDate('1950년 무렵')).toBe('~1950');
      expect(readFuzzyDate('1948년이었다')).toBe('1948');
    });

    it('answers null rather than guessing, and null is the common answer', () => {
      expect(readFuzzyDate('할머니가 국수를 삶아 주셨다')).toBeNull();
      expect(readFuzzyDate('')).toBeNull();
      // a number that is not a date must not become one
      expect(readFuzzyDate('그릇을 2000원에 샀다')).toBeNull();
      expect(readFuzzyDate('1234번지에 살았다')).toBeNull();
    });

    it('never emits a string the fuzzy-date parser would reject', () => {
      const inputs = [
        '1987년 13월 40일',
        '1987-13-45',
        '9999년',
        '1987년 2월 30일',
        '1987년 3월 15일',
        '1899년',
        '~~1948',
      ];
      for (const raw of inputs) {
        const out = readFuzzyDate(raw);
        if (out === null) continue;
        expect(parseFuzzyDate(out), `"${raw}" produced unparseable "${out}"`).not.toBeNull();
      }
      // a month out of range is dropped, not clamped
      expect(readFuzzyDate('1987년 13월')).toBe('1987');
    });
  });

  describe('proposing a title', () => {
    it('never proposes one the note validator would refuse', () => {
      const hostile = [
        '[[대괄호]] 있는 제목',
        '# 우물정 | 파이프 ^ 캐럿',
        '   ',
        '',
        'a'.repeat(400),
      ];
      for (const raw of hostile) {
        const t = readTitle(raw, null);
        if (t === '') continue; // refusing outright is a legitimate answer
        expect(validateNoteTitle(t), `"${raw}" produced an invalid title "${t}"`).toBeNull();
      }
    });

    it('cuts at the first sentence, and falls back to the photograph’s name', () => {
      expect(readTitle('마당의 빨랫줄. 그리고 흰 홑이불이 있었다.', null)).toBe('마당의 빨랫줄');
      // no words at all: the file's own name, minus one extension
      expect(readTitle('', '할머니 환갑.jpg')).toBe('할머니 환갑');
      expect(readTitle('   \n  ', '옛날 사진.HEIC')).toBe('옛날 사진');
    });
  });

  describe('linking to memories that already exist', () => {
    it('links the longest matching title, and only whole mentions', () => {
      const titles = ['김순자', '김순자 할머니', '부산 영도'];
      const { body, linked } = linkKnownTitles('김순자 할머니가 부산 영도에 사셨다', titles);
      // LONGEST FIRST: "김순자 할머니" must not be eaten by "김순자"
      expect(body).toContain('[[김순자 할머니]]');
      expect(body).not.toContain('[[김순자]] 할머니');
      expect(body).toContain('[[부산 영도]]');
      expect(linked).toContain('김순자 할머니');
    });

    it('leaves a link the contributor typed themselves alone', () => {
      const { body } = linkKnownTitles('이미 [[김순자]] 라고 적었다', ['김순자']);
      // one pair of brackets, not two nested ones
      expect(body).toBe('이미 [[김순자]] 라고 적었다');
      expect(body).not.toContain('[[[[');
    });

    it('changes no word of the contributor’s text', () => {
      const original = '어머니가 재봉틀 앞에 앉아 계셨다';
      const { body } = linkKnownTitles(original, ['재봉틀', '어머니']);
      // strip the markup back out and the text must be byte-identical
      expect(body.replace(/\[\[([^\]]*)\]\]/g, '$1')).toBe(original);
    });
  });

  it('guesses a type, and defaults to event rather than person', () => {
    // person is the expensive guess to get wrong: a person note is a hub other
    // memories link INTO, so a mislabelled one distorts the sky and the people
    // list at once, where a mislabelled event is one wrong colour
    expect(readType('그날 마당에서 빨래를 널었다', false)).toBe('event');
    expect(readType('전쟁 통 피난 시절 이야기', false)).toBe('period');
    expect(readType('어머니의 재봉틀', false)).toBe('object');
    // a photograph with no words of its own is evidence, not an account
    expect(readType('', true)).toBe('source');
  });

  describe('the route', () => {
    it('composes from plain prose and explains every move it made', async () => {
      const s = await ctx.realSession(`df1-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(s, `DF1 ${RUN}`);
      await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
        title: `김순자 ${RUN}`,
        type: 'person',
        body: '',
      });

      const text = `1994년 7월 15일이었다. 김순자 ${RUN} 가 첫 손주를 안았다.`;
      const res = await draft(s, archive, { text });
      expect(res.status).toBe(200);
      const d = (await res.json()) as Draft;

      expect(d.occurred, 'the date in the text was not read').toBe('1994-07-15');
      expect(d.title).not.toBe('');
      expect(d.body, 'an existing memory was not linked').toContain(`[[김순자 ${RUN}]]`);
      // the moves are SHOWN, in the contributor's language, before they accept
      expect(d.notes.length).toBeGreaterThan(2);
      expect(d.notes.join(' ')).toContain('1994-07-15');
      // and the draft's author is recorded, the way an embedding records its model
      expect(d.providerVersion).toBe('composer-deterministic-1');
    });

    it('adds no sentence the contributor did not write', async () => {
      const s = await ctx.realSession(`df2-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(s, `DF2 ${RUN}`);

      const text = '할머니는 국수를 잘 삶으셨다';
      const d = (await (await draft(s, archive, { text })).json()) as Draft;

      /**
       * THE CENTRAL PROPERTY. Strip the markup the composer may add and what is
       * left must be exactly what was typed. A generator that completed
       * "할머니는 국수를 잘 삶으셨다, 그리고 늘 웃으셨다" would put a sentence
       * nobody remembers into a dead person's record.
       */
      const stripped = d.body.replace(/!?\[\[([^\]]*)\]\]/g, '$1').trim();
      expect(stripped, 'the composer invented text').toBe(text);
    });

    it('writes nothing — accepting is a separate, explicit act', async () => {
      const s = await ctx.realSession(`df3-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(s, `DF3 ${RUN}`);

      const before = await ctx.pool.query<{ n: string }>(
        `select count(*) as n from public.notes where archive_id = $1`,
        [archive],
      );
      await draft(s, archive, { text: `초안만 ${RUN} 만들어 보는 글입니다.` });
      const after = await ctx.pool.query<{ n: string }>(
        `select count(*) as n from public.notes where archive_id = $1`,
        [archive],
      );
      expect(Number(after.rows[0]!.n), 'drafting created a note').toBe(Number(before.rows[0]!.n));
    });

    it('refuses an empty request and a photograph that is not the caller’s to see', async () => {
      const owner = await ctx.realSession(`df4a-${RUN}@test.local`);
      const other = await ctx.realSession(`df4b-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(owner, `DF4 ${RUN}`);
      await ctx.pool.query(
        `insert into public.memberships (archive_id, user_id, role)
         values ($1, $2, 'contributor') on conflict do nothing`,
        [archive, other.userId],
      );

      expect((await draft(owner, archive, {})).status, 'an empty draft was accepted').toBe(400);

      // a photograph uploaded with no `?note=` mints a note PRIVATE to its
      // uploader, so a co-member must not be able to have it described to them
      const up = await ctx.app.request(`/v1/archives/${archive}/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'image/png' },
        body: new Uint8Array(Buffer.from(`private-${RUN}\n`, 'utf8')),
      });
      const { id: mediaId } = (await up.json()) as { id: string };

      // POSITIVE CONTROL: the uploader can draft from it
      const mine = await draft(owner, archive, { mediaId });
      expect(mine.status, 'the uploader cannot draft from their own photograph').toBe(200);

      const theirs = await draft(other, archive, { mediaId });
      expect(theirs.status, 'a private photograph was described to a co-member').toBe(404);
    });

    it('embeds by content hash when the photograph is already stored', async () => {
      const s = await ctx.realSession(`df5-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(s, `DF5 ${RUN}`);
      const up = await ctx.app.request(`/v1/archives/${archive}/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${s.token}`, 'content-type': 'image/png' },
        body: new Uint8Array(Buffer.from(`stored-${RUN}\n`, 'utf8')),
      });
      const { id: mediaId, contentHash } = (await up.json()) as {
        id: string;
        contentHash: string;
      };

      const d = (await (await draft(s, archive, { mediaId, text: '그날의 사진' })).json()) as Draft;
      // BY HASH, not by media id: a row's id is per-uploader, so an id-keyed
      // embed breaks the moment a second relative reads the same memory
      expect(d.body, 'the photograph was not embedded by content hash').toContain(
        `![[${contentHash}]]`,
      );
      expect(d.body).not.toContain(mediaId);
    });

    it('a file only chosen, not yet uploaded, still names the memory', async () => {
      const s = await ctx.realSession(`df6-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(s, `DF6 ${RUN}`);

      // the ordinary composing case: the photograph is still in the browser
      const d = (await (await draft(s, archive, { filename: '할머니 환갑.jpg' })).json()) as Draft;
      expect(d.title).toBe('할머니 환갑');
      // nothing to embed yet, and it says so rather than embedding a null
      expect(d.body).not.toContain('![[');
      expect(d.notes.join(' ')).toContain('저장할 때');
    });
  });
});
