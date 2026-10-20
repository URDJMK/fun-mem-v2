import {
  canonicalTitle,
  normalizeTitle,
  parseFuzzyDate,
  validateNoteTitle,
  type EntityType,
} from '@funmem/core';
import type { PoolClient, Pool } from 'pg';
import type { App, AppDeps } from './app';
import { isMember } from './membership';
import { readEnglishDate } from './speech';
import { visibleSql } from './views';

/**
 * "Let the app write the memory for me" — from words. (The composers below can also take a
 * photograph; this repository has no photographs, so the route passes none.)
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
  /** what was done, shown to the contributor BEFORE they accept */
  notes: string[];
}

export interface DraftProvider {
  readonly providerVersion: string;
  draft(req: DraftRequest): Promise<DraftResult>;
}

/* ── date ────────────────────────────────────────────────────────────── */

/**
 * A fuzzy date lifted out of the contributor's words, or null.
 *
 * NULL IS A FIRST-CLASS ANSWER and the common one. "Grandma boiled the noodles
 * for us" has no date, and the honest record of that is an undated memory, not
 * a guess at a decade. FR-062's whole point is that a year-only memory must
 * never sprout a month.
 *
 * A date written in digits ("1994-07-15", "1994.07.15", "1962") is read as it
 * is written. Anything else is English prose for `readEnglishDate` ("June of
 * nineteen sixty-seven"), which adds the `~` prefix only where the contributor
 * hedged beside the date: THEIR uncertainty, never ours.
 *
 * Everything returned is re-parsed by `parseFuzzyDate` before it leaves, so a
 * pattern that produces `1987-13` is dropped rather than stored.
 */
export function readFuzzyDate(text: string): string | null {
  const patterns: Array<[RegExp, (m: RegExpExecArray) => string]> = [
    // 1987-03-15 / 1987.03.15 / 1987/03/15
    [/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/, (m) => `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`],
    [/(\d{4})[-./](\d{1,2})(?![-./\d])/, (m) => `${m[1]}-${pad(m[2]!)}`],
    /**
     * A bare four-digit year — the loosest pattern here, and the one that has
     * to earn its place with two bounds.
     *
     * The RANGE bound rejects numbers that could not be a life at all, which
     * covers "house number 1234".
     *
     * The SUFFIX bound rejects a number that some other word has claimed: a unit
     * written onto its digits with no space ("2000km") is a quantity, not a
     * date, and so are digits glued to a word in another script.
     */
    [
      /(?<!\d)(1[89]\d{2}|20[0-4]\d)(?![\dA-Za-z]|(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L})/u,
      (m) => m[1]!,
    ],
  ];

  for (const [re, build] of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const raw = build(m);
    // the parser is the arbiter, not the regex above it
    if (parseFuzzyDate(raw)) return raw;
  }
  // nothing in digits: try English prose ("June of nineteen sixty-seven")
  const english = readEnglishDate(text);
  return english !== null && parseFuzzyDate(english) ? english : null;
}

const pad = (n: string) => n.padStart(2, '0');

/* ── type ────────────────────────────────────────────────────────────── */

/**
 * The entity type of a draft: `event`, unless there are no words at all.
 *
 * `event` is the default because a memory is usually something that HAPPENED,
 * and because guessing `person` wrongly is the expensive mistake: a person note
 * is a hub other memories link INTO, so a mislabelled one distorts the sky and
 * the people list at once. A mislabelled event is a wrong colour on one star.
 * The words are not used to guess (a keyword guess types a trip to a town a
 * "place"); the contributor chooses another type if one fits better.
 */
export function readType(text: string, hasPhoto: boolean): EntityType {
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
  const stop = cleaned.search(/[.!?…]/);
  const cut = stop > 6 && stop <= TITLE_MAX ? cleaned.slice(0, stop) : cleaned.slice(0, TITLE_MAX);

  const title = canonicalTitle(cut.trim());
  return validateNoteTitle(title) === null && title !== '' ? title : '';
}

/* ── links ───────────────────────────────────────────────────────────── */

/** A letter of a script other than the Latin alphabet (letters every script shares, like "µ", are not counted). */
const OTHER_SCRIPT = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** The character that ends just before `i` (a whole character, not half of a surrogate pair), or ' '. */
const charBefore = (s: string, i: number): string =>
  Array.from(s.slice(Math.max(0, i - 2), i)).at(-1) ?? ' ';
/** The character that starts at `i`, or ' '. */
const charAt = (s: string, i: number): string => {
  const c = s.codePointAt(i);
  return c === undefined ? ' ' : String.fromCodePoint(c);
};
/** Two touching characters are one word when both are letters or digits and either is in another script. */
const glued = (a: string, b: string): boolean =>
  LETTER_OR_DIGIT.test(a) &&
  LETTER_OR_DIGIT.test(b) &&
  (OTHER_SCRIPT.test(a) || OTHER_SCRIPT.test(b));

/**
 * Wrap mentions of notes the archive ALREADY HOLDS as `[[wikilinks]]`.
 *
 * This is the one place the draft adds characters the contributor did not type,
 * and it is safe for a specific reason: it only ever links to a title that
 * exists, never invents a target, and never changes a word. If it is wrong, it
 * is wrong by linking "Mom" to the wrong Mom — visible, and one edit away.
 *
 * LONGEST TITLE FIRST, so "Grandma Sunja" is not eaten by "Grandma". Matching is
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
    const chars = Array.from(title);
    const [head, tail] = [chars[0]!, chars.at(-1)!];
    let from = 0;
    for (;;) {
      const at = body.indexOf(title, from);
      if (at === -1) break;
      from = at + title.length;
      if (mask.slice(at, at + title.length).includes('#')) continue;
      // a title is only a mention when it stands as a word: not mid-token in a Latin word, and
      // not glued to a word in another script, whose words are compared exactly ("Москва" is
      // not mentioned in "Москвабад")
      const before = charBefore(body, at);
      const after = charAt(body, at + title.length);
      if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
      if (glued(before, head) || glued(tail, after)) continue;
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

/** What a draft tells the contributor about how it was made (shared by the composers). */
export const DRAFT_NOTES = {
  titleNone: 'Could not make a title from what you wrote. Please write one.',
  title: (t: string) => `Title taken from your first sentence: “${t}”`,
  date: (d: string) => `Found a date in what you wrote: ${d}`,
  dateNone: 'No date given. It is fine if it is not remembered.',
  linked: (titles: string[]) =>
    `Linked to notes that already exist: ${titles.map((l) => `[[${l}]]`).join(', ')}`,
  photoIn: 'The photograph is placed in the text.',
  photoLater: 'The photograph will be attached to this memory when it is saved.',
  asWritten: 'The text is exactly what you wrote. Nothing was added that you did not write.',
} as const;

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
    notes.push(title === '' ? DRAFT_NOTES.titleNone : DRAFT_NOTES.title(title));

    const occurred = readFuzzyDate(text);
    notes.push(occurred ? DRAFT_NOTES.date(occurred) : DRAFT_NOTES.dateNone);

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
    if (req.media?.contentHash) notes.push(DRAFT_NOTES.photoIn);
    else if (req.media) notes.push(DRAFT_NOTES.photoLater);

    const { body, linked } = linkKnownTitles(text, req.titles);
    if (linked.length > 0) notes.push(DRAFT_NOTES.linked(linked));

    notes.push(DRAFT_NOTES.asWritten);

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

    const input = (await c.req.json().catch(() => ({}))) as { text?: string };
    const text = typeof input.text === 'string' ? input.text : '';
    if (text.trim() === '') return c.json({ error: 'text is required' }, 400);

    const result = await composer.draft({
      text,
      // no photographs in this repository: a draft is composed from words alone
      media: null,
      titles: await visibleTitles(deps.pool, archiveId, userId),
    });

    return c.json({ ...result, providerVersion: composer.providerVersion });
  });
}
