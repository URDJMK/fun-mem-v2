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
  describe('reading a fuzzy date out of the contributor’s words', () => {
    it('reads the forms people actually write', () => {
      expect(readFuzzyDate('It happened on 1987-03-15')).toBe('1987-03-15');
      expect(readFuzzyDate('1994-07-15 was the day')).toBe('1994-07-15');
      expect(readFuzzyDate('1994.07.15')).toBe('1994-07-15');
      expect(readFuzzyDate('That year was 1962')).toBe('1962');
      expect(readFuzzyDate('We married in June of nineteen sixty-seven.')).toBe('1967-06');
    });

    it('marks approximation only where the contributor hedged', () => {
      // THEIR uncertainty, never ours — this function has no confidence of its
      // own to express, and a `~` we invented would be a claim about the record
      expect(readFuzzyDate('It was about nineteen forty-eight')).toBe('~1948');
      expect(readFuzzyDate('It was in nineteen forty-eight')).toBe('1948');
    });

    it('answers null rather than guessing, and null is the common answer', () => {
      expect(readFuzzyDate('Grandma boiled noodles for us')).toBeNull();
      expect(readFuzzyDate('')).toBeNull();
      // a number that is not a date must not become one
      expect(readFuzzyDate('We drove 2000km that summer')).toBeNull();
      expect(readFuzzyDate('We lived at number 1234')).toBeNull();
    });

    it('never emits a string the fuzzy-date parser would reject', () => {
      const inputs = [
        '1987-13-45',
        '1987.13.40',
        '9999',
        '1987-02-30',
        '1987-03-15',
        '1899',
        '~~1948',
        'February 30, 1987',
      ];
      for (const raw of inputs) {
        const out = readFuzzyDate(raw);
        if (out === null) continue;
        expect(parseFuzzyDate(out), `"${raw}" produced unparseable "${out}"`).not.toBeNull();
      }
      // a month out of range is dropped, not clamped
      expect(readFuzzyDate('1987-13')).toBe('1987');
    });
  });

  describe('proposing a title', () => {
    it('never proposes one the note validator would refuse', () => {
      const hostile = [
        '[[Brackets]] in a title',
        '# Hash | pipe ^ caret',
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
      expect(readTitle('The clothesline in the yard. And there were white sheets.', null)).toBe(
        'The clothesline in the yard',
      );
      // no words at all: the file's own name, minus one extension
      expect(readTitle('', 'Grandma 60th birthday.jpg')).toBe('Grandma 60th birthday');
      expect(readTitle('   \n  ', 'Old photo.HEIC')).toBe('Old photo');
    });
  });

  describe('linking to memories that already exist', () => {
    it('links the longest matching title, and only whole mentions', () => {
      const titles = ['Sunja', 'Sunja Kim', 'Yeongdo Island', 'Bus'];
      const { body, linked } = linkKnownTitles(
        'Sunja Kim lived on Yeongdo Island in Busan',
        titles,
      );
      // LONGEST FIRST: "Sunja Kim" must not be eaten by "Sunja"
      expect(body).toContain('[[Sunja Kim]]');
      expect(body).not.toContain('[[Sunja]] Kim');
      expect(body).toContain('[[Yeongdo Island]]');
      // a title inside another word is not a mention of it
      expect(body).not.toContain('[[Bus]]');
      expect(linked).toContain('Sunja Kim');
    });

    it('leaves a link the contributor typed themselves alone', () => {
      const { body } = linkKnownTitles('I already wrote [[Sunja]] here', ['Sunja']);
      // one pair of brackets, not two nested ones
      expect(body).toBe('I already wrote [[Sunja]] here');
      expect(body).not.toContain('[[[[');
    });

    it('changes no word of the contributor’s text', () => {
      const original = 'Mother sat at the sewing machine';
      const { body } = linkKnownTitles(original, ['sewing machine', 'Mother']);
      // strip the markup back out and the text must be byte-identical
      expect(body.replace(/\[\[([^\]]*)\]\]/g, '$1')).toBe(original);
    });

    it('a title in another script is a mention only as the whole word, exactly', () => {
      const { body } = linkKnownTitles(
        'Grandpa came from Москва. He never went back to Москвабад.',
        ['Москва'],
      );
      expect(body).toBe('Grandpa came from [[Москва]]. He never went back to Москвабад.');
      // another form of the word is another word
      expect(linkKnownTitles('Москвы нет', ['Москва']).linked).toEqual([]);
    });
  });

  it('the type is an event (a source for a photograph alone): no guessing from keywords', () => {
    // person is the expensive guess to get wrong: a person note is a hub other
    // memories link INTO, so a mislabelled one distorts the sky and the people
    // list at once, where a mislabelled event is one wrong colour
    expect(readType('That day I hung the laundry in the yard', false)).toBe('event');
    expect(readType('A story of the war years', false)).toBe('event');
    expect(readType("Grandma's sewing machine", false)).toBe('event');
    // a photograph with no words of its own is evidence, not an account
    expect(readType('', true)).toBe('source');
  });

  describe('the route', () => {
    it('composes from plain prose and explains every move it made', async () => {
      const s = await ctx.realSession(`df1-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(s, `DF1 ${RUN}`);
      await ctx.api(s.token, 'POST', `/v1/archives/${archive}/notes`, {
        title: `Sunja ${RUN}`,
        type: 'person',
        body: '',
      });

      const text = `It was 1994-07-15. Sunja ${RUN} held her first grandchild.`;
      const res = await draft(s, archive, { text });
      expect(res.status).toBe(200);
      const d = (await res.json()) as Draft;

      expect(d.occurred, 'the date in the text was not read').toBe('1994-07-15');
      expect(d.title).not.toBe('');
      expect(d.body, 'an existing memory was not linked').toContain(`[[Sunja ${RUN}]]`);
      // the moves are SHOWN, before the contributor accepts
      expect(d.notes.length).toBeGreaterThan(2);
      expect(d.notes.join(' ')).toContain('1994-07-15');
      // and the draft's author is recorded, the way an embedding records its model
      expect(d.providerVersion).toBe('composer-deterministic-1');
    });

    it('adds no sentence the contributor did not write', async () => {
      const s = await ctx.realSession(`df2-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(s, `DF2 ${RUN}`);

      const text = 'Grandma was good at boiling noodles';
      const d = (await (await draft(s, archive, { text })).json()) as Draft;

      /**
       * THE CENTRAL PROPERTY. Strip the markup the composer may add and what is
       * left must be exactly what was typed. A generator that completed
       * "Grandma was good at boiling noodles, and she always smiled" would put a
       * sentence nobody remembers into a dead person's record.
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
      await draft(s, archive, { text: `Only a draft ${RUN}, written to try it out.` });
      const after = await ctx.pool.query<{ n: string }>(
        `select count(*) as n from public.notes where archive_id = $1`,
        [archive],
      );
      expect(Number(after.rows[0]!.n), 'drafting created a note').toBe(Number(before.rows[0]!.n));
    });

    it('refuses a request without words: there are no photographs here to draft from', async () => {
      const s = await ctx.realSession(`df4-${RUN}@test.local`);
      const archive = await ctx.provisionArchive(s, `DF4 ${RUN}`);

      expect((await draft(s, archive, {})).status, 'an empty draft was accepted').toBe(400);
      // v1 also composed from a photograph alone: by its id, or by the name of one not yet uploaded
      expect((await draft(s, archive, { mediaId: randomUUID() })).status).toBe(400);
      expect((await draft(s, archive, { filename: 'grandma-60th.jpg' })).status).toBe(400);

      // words that come with them are composed as words alone: nothing embedded, nothing promised
      const res = await draft(s, archive, {
        text: 'The photo from that day.',
        mediaId: randomUUID(),
        filename: 'grandma-60th.jpg',
      });
      expect(res.status).toBe(200);
      const d = (await res.json()) as Draft;
      expect(d.body).toBe('The photo from that day.');
      expect(d.notes.join(' ')).not.toMatch(/photograph/i);
    });
  });
});
