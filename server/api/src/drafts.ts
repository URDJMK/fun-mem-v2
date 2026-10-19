import {
  canonicalTitle,
  normalizeTitle,
  parseFuzzyDate,
  validateNoteTitle,
  type EntityType,
} from '@funmem/core';
import type { PoolClient, Pool } from 'pg';
import type { App, AppDeps } from './app';
import { isMember, UUID_RE } from './membership';
import { isNounTail } from './grounding-ko';
import { readEnglishDate } from './speech';
import { mediaVisibleSql, visibleSql } from './views';

/**
 * "Let the app write the memory for me" — from words, or from a photograph.
 *
 * WHAT THIS IS NOT: a generator. The default provider below composes; it does
 * not write. Every sentence in a returned draft came from the contributor's own
 * input, rearranged — a title lifted from their first line, a date lifted from
 * their words, their names turned into links against titles the archive already
 * holds. It cannot state a fact the person did not state, because it has no
 * mechanism for producing a sentence they did not type.
 *
 * That is a deliberate design choice and not a placeholder apology. This is a
 * record of a dead person. Spec §2.3 forbids averaging two relatives' accounts
 * into one narrative; a model that fluently completes "she loved..." breaks the
 * same rule from the other end, by inventing the half nobody remembered. The
 * grounded `/ask` path answers ONLY in cited claims for exactly this reason,
 * and an authoring path with weaker rules than the reading path would be
 * incoherent.
 *
 * WHERE A REAL MODEL GOES: `DraftProvider`, injected at the single call site in
 * `registerDraftRoutes`, mirroring how `AnswerProvider` is injected in
 * `ask.ts`. `providerVersion` rides on every response so a draft's author is
 * always auditable. That swap is D-47's to make — it needs a decision about
 * which model and whose credentials, and adding an env branch inside this
 * pipeline instead would let an unreviewed provider load itself silently.
 */

export interface DraftRequest {
  /** the contributor's own words, verbatim */
  text: string;
  /**
   * A photograph this memory is about.
   *
   * `contentHash` is null when the file is still sitting in the contributor's
   * browser — which is the ORDINARY case for composing. The photograph is not
   * uploaded until the memory is saved, so the draft can use its name but has
   * nothing to embed yet, and the embed is unnecessary anyway: a saved
   * photograph is attached to the note and listed from it.
   */
  media: { contentHash: string | null; filename: string | null } | null;
  /** every note title the caller can see, for link resolution */
  titles: string[];
}

export interface DraftResult {
  title: string;
  type: EntityType;
  occurred: string | null;
  body: string;
  /** what was done, in Korean, shown to the contributor BEFORE they accept */
  notes: string[];
}

export interface DraftProvider {
  readonly providerVersion: string;
  draft(req: DraftRequest): Promise<DraftResult>;
}

/* ── date ────────────────────────────────────────────────────────────── */

/**
 * A fuzzy date lifted out of Korean prose, or null.
 *
 * NULL IS A FIRST-CLASS ANSWER and the common one. "할머니가 국수를 삶아
 * 주셨다" has no date, and the honest record of that is an undated memory, not
 * a guess at a decade. FR-062's whole point is that a year-only memory must
 * never sprout a month.
 *
 * The `~` prefix is emitted ONLY when the contributor hedged in their own words
 * (쯤 / 무렵 / 경 / 대략 / 아마 / 년대). It marks THEIR uncertainty, never ours;
 * this function has no confidence of its own to express.
 *
 * Everything returned is re-parsed by `parseFuzzyDate` before it leaves, so a
 * pattern that produces `1987-13` is dropped rather than stored.
 */
export function readFuzzyDate(text: string): string | null {
  const approx = /(쯤|무렵|경에|년대|대략|아마|어림)/.test(text) ? '~' : '';

  const patterns: Array<[RegExp, (m: RegExpExecArray) => string]> = [
    // 1987년 3월 15일  /  1987년 3월  /  1987년
    [
      /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/,
      (m) => `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`,
    ],
    [/(\d{4})\s*년\s*(\d{1,2})\s*월/, (m) => `${m[1]}-${pad(m[2]!)}`],
    [/(\d{4})\s*년/, (m) => m[1]!],
    // 1987-03-15 / 1987.03.15 / 1987/03/15
    [/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/, (m) => `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`],
    [/(\d{4})[-./](\d{1,2})(?![-./\d])/, (m) => `${m[1]}-${pad(m[2]!)}`],
    /**
     * A bare four-digit year — the loosest pattern here, and the one that has
     * to earn its place with two bounds.
     *
     * The RANGE bound rejects numbers that could not be a life at all, which
     * covers "1234번지".
     *
     * The SUFFIX bound rejects a number that some other word has claimed. A
     * Korean counter attaches directly to its digits with no space — 2000원,
     * 3000명, 1500미터 — so digits immediately followed by a Hangul syllable
     * are a quantity, not a date. A year in prose is written either with 년
     * (caught by the patterns above) or standing alone. Latin letters are
     * excluded for the same reason (2000km).
     *
     * Found by the test: "그릇을 2000원에 샀다" was being filed under the year
     * 2000, which would have put a bowl on the timeline.
     */
    [/(?<!\d)(1[89]\d{2}|20[0-4]\d)(?![\d가-힣A-Za-z])/, (m) => m[1]!],
  ];

  for (const [re, build] of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const raw = approx + build(m);
    // the parser is the arbiter, not the regex above it
    if (parseFuzzyDate(raw)) return raw;
  }
  // nothing in Korean form: try English prose ("June of nineteen sixty-seven")
  const english = readEnglishDate(text);
  return english !== null && parseFuzzyDate(english) ? english : null;
}

const pad = (n: string) => n.padStart(2, '0');

/* ── type ────────────────────────────────────────────────────────────── */

/**
 * Guess the entity type from the contributor's words.
 *
 * `event` is the default because a memory is usually something that HAPPENED,
 * and because guessing `person` wrongly is the expensive mistake: a person note
 * is a hub other memories link INTO, so a mislabelled one distorts the sky and
 * the people list at once. A mislabelled event is a wrong colour on one star.
 */
export function readType(text: string, hasPhoto: boolean): EntityType {
  const cue: Array<[EntityType, RegExp]> = [
    ['place', /(집|고향|마을|동네|학교|병원|시장|바닷가|산소|고을|읍|면|리)\b|에서 살/],
    ['period', /(시절|무렵|년대|어린 시절|젊었을|말년|전쟁 통|피난)/],
    ['object', /(반지|시계|사진첩|편지|옷|그릇|가방|자전거|재봉틀|물건)/],
    ['person', /(아버지|어머니|할머니|할아버지|아들|딸|남편|아내|형|누나|동생|이모|삼촌)$/],
  ];
  for (const [type, re] of cue) if (re.test(text)) return type;
  // A photograph with no words of its own is a SOURCE — a piece of evidence
  // rather than an account of an event. That matches what the upload path
  // already mints, so accepting a draft cannot silently retype the note.
  return hasPhoto && text.trim() === '' ? 'source' : 'event';
}

/* ── title ───────────────────────────────────────────────────────────── */

const TITLE_MAX = 60;

/**
 * A title from the contributor's first line.
 *
 * Titles are not decoration here: `notes_archive_title_ci` is UNIQUE on the
 * normalized title, `validateNoteTitle` refuses `[ ] # ^ |` because FM-016
 * splices titles verbatim into other members' bodies during a rename cascade,
 * and every wikilink in the archive addresses notes BY TITLE. So this strips
 * exactly the characters that rule out, then defers to the validator rather
 * than trusting its own stripping.
 */
export function readTitle(text: string, filename: string | null): string {
  const first = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');

  const source =
    first ??
    // no words: fall back to the photograph's own name, minus one extension
    (filename ?? '').replace(/\.[A-Za-z0-9]{1,8}$/, '').trim();

  const cleaned = source
    .replace(/[[\]#^|]/g, ' ') // exactly what validateNoteTitle refuses
    .replace(/\s+/g, ' ')
    .trim();

  // cut at a sentence end if there is one early enough, so a title is a phrase
  // rather than a truncated paragraph
  const stop = cleaned.search(/[.!?。…]|\s(그리고|그런데|그래서)\s/u);
  const cut = stop > 6 && stop <= TITLE_MAX ? cleaned.slice(0, stop) : cleaned.slice(0, TITLE_MAX);

  const title = canonicalTitle(cut.trim());
  return validateNoteTitle(title) === null && title !== '' ? title : '';
}

/* ── links ───────────────────────────────────────────────────────────── */

/**
 * Wrap mentions of notes the archive ALREADY HOLDS as `[[wikilinks]]`.
 *
 * This is the one place the draft adds characters the contributor did not type,
 * and it is safe for a specific reason: it only ever links to a title that
 * exists, never invents a target, and never changes a word. If it is wrong, it
 * is wrong by linking "어머니" to the wrong 어머니 — visible, and one edit away.
 *
 * LONGEST TITLE FIRST, so "김순자 할머니" is not eaten by "김순자". Matching is
 * done on a masked copy so an earlier match cannot be re-matched inside, and so
 * a `[[…]]` the contributor typed themselves is left alone.
 */
export function linkKnownTitles(
  body: string,
  titles: string[],
): { body: string; linked: string[] } {
  const ordered = [...new Set(titles)].sort((a, b) => b.length - a.length);
  const linked: string[] = [];

  // mask: '.' = free, '#' = already spoken for
  const mask = Array.from(body, () => '.');
  // nothing inside a link is a bracket: a run of "[[[[" is read once, not once per bracket
  for (const m of body.matchAll(/\[\[[^\][]*\]\]/g)) {
    for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = '#';
  }

  const edits: Array<{ at: number; len: number; title: string }> = [];
  for (const title of ordered) {
    if (title.length < 2) continue; // a one-character title matches everywhere
    const norm = normalizeTitle(title);
    let from = 0;
    for (;;) {
      const at = body.indexOf(title, from);
      if (at === -1) break;
      from = at + title.length;
      if (mask.slice(at, at + title.length).includes('#')) continue;
      // a title is only a mention when it stands as a word: not mid-token in a
      // Latin word; for a Korean title, not after another syllable of the same
      // word ("큰[[아버지]]", "외[[할머니]]"), and followed by nothing but particles
      // or the copula ("[[아버지]]가", "[[김순자]]씨가"). "[[이모]]부가" would point
      // the aunt's husband at the aunt, "[[아들]]딸" a daughter at a son.
      if (/[A-Za-z0-9]/.test(body[at - 1] ?? ' ')) continue;
      if (/[A-Za-z0-9]/.test(body[at + title.length] ?? ' ')) continue;
      if (/[가-힣]$/.test(title)) {
        if (/[가-힣]/.test(body[at - 1] ?? ' ')) continue;
        const rest = /^[가-힣]*/.exec(body.slice(at + title.length, at + title.length + 13))![0];
        if (!isNounTail(rest)) continue;
      } else if (/^[가-힣]/.test(title) && /[가-힣]/.test(body[at - 1] ?? ' ')) continue;
      for (let i = at; i < at + title.length; i++) mask[i] = '#';
      edits.push({ at, len: title.length, title });
      if (!linked.some((l) => normalizeTitle(l) === norm)) linked.push(title);
    }
  }

  // apply right-to-left so earlier offsets stay valid
  let out = body;
  for (const e of edits.sort((a, b) => b.at - a.at)) {
    out = `${out.slice(0, e.at)}[[${e.title}]]${out.slice(e.at + e.len)}`;
  }
  return { body: out, linked };
}

/* ── the default provider ────────────────────────────────────────────── */

export class DeterministicComposer implements DraftProvider {
  readonly providerVersion = 'composer-deterministic-1';

  /**
   * Nothing is awaited here, and the `Promise` is not an oversight: the
   * INTERFACE is async because a real model provider will be, and a synchronous
   * signature would have to be widened at every call site the day one lands.
   */
  draft(req: DraftRequest): Promise<DraftResult> {
    return Promise.resolve(this.draftSync(req));
  }

  /** The same composition, synchronously — for callers already inside a loop. */
  draftSync(req: DraftRequest): DraftResult {
    const text = req.text.trim();
    const notes: string[] = [];

    const title = readTitle(text, req.media?.filename ?? null);
    if (title === '') notes.push('제목을 짓지 못했습니다. 직접 적어 주세요.');
    else notes.push(`첫 문장에서 제목을 옮겼습니다: “${title}”`);

    const occurred = readFuzzyDate(text);
    if (occurred) notes.push(`글에서 날짜를 찾았습니다: ${occurred}`);
    else notes.push('날짜는 비워 두었습니다. 기억나지 않아도 괜찮습니다.');

    const type = readType(text, req.media !== null);

    /**
     * The photograph is embedded by CONTENT HASH, not by media id.
     *
     * `![[<hash>]]` is what the editor's resolver reads, and the hash is the
     * addressable identity — a `media` row's id is per-uploader (two relatives
     * uploading the same photograph get two rows), so an id-keyed embed would
     * break the moment the note is read by the other one.
     */
    const embed = req.media?.contentHash ? `![[${req.media.contentHash}]]\n\n` : '';
    if (req.media?.contentHash) notes.push('사진을 본문에 넣었습니다.');
    else if (req.media) notes.push('사진은 저장할 때 이 기억에 붙습니다.');

    const { body, linked } = linkKnownTitles(text, req.titles);
    if (linked.length > 0) {
      notes.push(`이미 있는 기록과 연결했습니다: ${linked.map((l) => `[[${l}]]`).join(', ')}`);
    }

    notes.push('내용은 적어 주신 말 그대로입니다. 없는 이야기는 만들지 않았습니다.');

    return { title, type, occurred, body: embed + body, notes };
  }
}

/* ── route ───────────────────────────────────────────────────────────── */

export async function visibleTitles(pool: Pool | PoolClient, archiveId: string, userId: string) {
  const rows = await pool.query<{ title: string }>(
    `select title from public.notes n
      where archive_id = $1 and ${visibleSql('n', '$2')}
      order by char_length(title) desc
      limit 500`,
    [archiveId, userId],
  );
  return rows.rows.map((r) => r.title);
}

export function registerDraftRoutes(app: App, deps: AppDeps, provider?: DraftProvider): void {
  // DI at exactly ONE call site, mirroring ask.ts. A real generator swaps in
  // here when D-47 is decided — never as an env branch inside the pipeline.
  const composer: DraftProvider = provider ?? new DeterministicComposer();

  /**
   * Propose a memory. Writes NOTHING — the contributor accepts it with an
   * ordinary `POST /notes`, having read and edited it first.
   *
   * That separation is the consent story, not an implementation detail: an
   * endpoint that both drafted and saved would put words into a dead person's
   * record that no living person had approved.
   */
  app.post('/v1/archives/:archiveId/drafts', async (c) => {
    const archiveId = c.req.param('archiveId');
    const userId = c.get('userId');
    if (!archiveId || !(await isMember(deps.pool, userId, archiveId))) {
      return c.json({ error: 'not found' }, 404);
    }

    const input = (await c.req.json().catch(() => ({}))) as {
      text?: string;
      mediaId?: string;
      filename?: string;
    };
    const text = typeof input.text === 'string' ? input.text : '';

    let media: DraftRequest['media'] = null;
    if (input.mediaId !== undefined) {
      if (!UUID_RE.test(input.mediaId)) return c.json({ error: 'not found' }, 404);
      // the same visibility rule the by-id read uses, so a photograph the
      // caller may not see cannot be described back to them
      const row = await deps.pool.query<{ content_hash: string; filename: string | null }>(
        `select m.content_hash, m.filename from public.media m
          where m.id = $1 and m.archive_id = $2 and ${mediaVisibleSql('m', '$2', '$3')}`,
        [input.mediaId, archiveId, userId],
      );
      if (row.rowCount === 0) return c.json({ error: 'not found' }, 404);
      media = { contentHash: row.rows[0]!.content_hash, filename: row.rows[0]!.filename };
    } else if (typeof input.filename === 'string' && input.filename.trim() !== '') {
      /**
       * A file the contributor has CHOSEN but not yet uploaded.
       *
       * Nothing is looked up and nothing is trusted: the name is the
       * contributor's own string, it is used only to propose a title, and that
       * title goes back to them to read before anything is written. There is no
       * row here to authorize against because there is no row yet.
       */
      media = { contentHash: null, filename: input.filename.slice(0, 300) };
    }

    if (text.trim() === '' && media === null) {
      return c.json({ error: 'text, mediaId or filename is required' }, 400);
    }

    const result = await composer.draft({
      text,
      media,
      titles: await visibleTitles(deps.pool, archiveId, userId),
    });

    return c.json({ ...result, providerVersion: composer.providerVersion });
  });
}
