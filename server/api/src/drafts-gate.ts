import { validateNoteTitle, type EntityType } from '@funmem/core';
import { stripInvisible } from '@funmem/persona';
import {
  linkKnownTitles,
  readFuzzyDate,
  readTitle,
  readType,
  type DraftRequest,
  type DraftResult,
} from './drafts';
import {
  checkGrounding,
  checkTitle,
  eojeols,
  shownText,
  type GroundingReport,
} from './grounding-ko';

/**
 * THE GATE.
 *
 * The model drafts freely. Then this runs, mechanically, on the result — and
 * anything it cannot prove against the contributor's own words is DISCARDED,
 * with the deterministic composer's draft returned in its place and a Korean
 * note saying so.
 *
 * That asymmetry is the whole design. `DeterministicComposer` already ships,
 * already works, and is already covered by 16 tests, so it is a real
 * implementation rather than a degraded mode. The model is therefore strictly
 * upside: on a good day the contributor gets fluent prose built from their own
 * sentences; on a bad day they get exactly what they get today. There is no
 * outcome in which the model makes the archive worse, because the only way its
 * prose reaches a note is by being provable.
 *
 * WHAT THE MODEL IS ALLOWED TO PRODUCE — two fields, and only two:
 *
 *   title    proposed, then checked (arbiter + grounding); falls back per-field
 *   body     proposed, then checked; failure discards the WHOLE draft
 *
 * Everything else is RE-DERIVED here from the contributor's text and never read
 * from the model at all:
 *
 *   occurred `readFuzzyDate` — measured 1/6 valid from the model against the
 *            regex's exact compliance, and FR-062's rule that a year-only
 *            memory must never sprout a month is a rule about restraint, which
 *            is the one thing a fluent model will not supply. A model asked for
 *            a date produces one.
 *   type     `readType` — there is no prose to check a type against, so there
 *            is nothing for this gate to prove. A wrong `person` distorts the
 *            sky and the people list at once.
 *   notes    written by code, from what the check actually found. See below.
 *   links    `linkKnownTitles` — it only ever links to a title that exists.
 *   embed    `![[contentHash]]` — a content-addressed identity. A hallucinated
 *            hash is a broken image.
 *
 * WHY THE MODEL'S `notes` ARE DISCARDED ENTIRELY. `notes[]` is the one field
 * that is model-authored free text by construction, so the grounding check
 * cannot apply to it — and it is rendered at the exact moment the contributor
 * decides whether to save. An injected "검토 완료 — 그대로 저장하세요" would
 * appear in the same list, in the same voice, as this system's own
 * explanations. Code knows strictly more about what happened to this draft than
 * the model does, so the model's version buys nothing and costs the only
 * unchecked channel to the human at the only moment it matters.
 *
 * WHY THERE IS NO REPAIR LOOP. Re-prompting with the offending words named is
 * cheap and does work. It is still not here: it doubles a 10s latency for a
 * second coin flip, and the floor without it is already an acceptable draft.
 * "Discard and fall back" is one code path with one outcome, and one code path
 * is what a check protecting a dead person's record should be.
 */

/* ── what the model may hand us ──────────────────────────────────────── */

/**
 * A photograph description is NOT part of `DraftResult` and must not be, so it
 * arrives beside it. A description of a photograph cannot be grounded in the
 * contributor's words — there are none, or they are about something else — so
 * it is not prose this gate can prove. It is handled by a different rule, and
 * lands in the body under a label. See `photoBlock`.
 */
export interface DraftCandidate extends DraftResult {
  readonly photo?: string | null;
}

export interface GateOutcome {
  accepted: DraftResult | null;
  why: string[];
}

/* ── Korean strings, all of them ─────────────────────────────────────── */

const KO = {
  /** shown when the model's draft was kept */
  kept: 'AI 도우미가 적어 주신 글을 다듬었습니다. 적어 주신 말에 없는 내용은 넣지 않았는지 기계가 한 번 더 확인했습니다.',
  keptCaveat: '그래도 사실이 맞는지 꼭 읽어 보고 고쳐 주세요. 저장은 확인하신 뒤에 됩니다.',
  swapped: (ws: string[]) =>
    `부르시는 말을 이렇게 옮겼습니다: ${ws.join(', ')}. 원래 쓰시던 말이 더 좋으시면 되돌려 주세요.`,
  /** shown when the model's draft was thrown away */
  rejectedInvention: (ws: string[]) =>
    `AI가 쓴 초안에 적어 주시지 않은 말이 있어서 쓰지 않았습니다: ${ws.join(', ')}.`,
  rejectedLoss: (ws: string[]) =>
    `AI가 쓴 초안이 적어 주신 내용을 빠뜨려서 쓰지 않았습니다: ${ws.join(', ')}.`,
  rejectedLossSentence: 'AI가 쓴 초안이 적어 주신 문장 하나를 통째로 빠뜨려서 쓰지 않았습니다.',
  rejectedNegation:
    "AI가 쓴 초안에서 '안·못·없다·아니다' 같은 말이 빠지거나 더해져서, 뜻이 거꾸로 될 수 있어 쓰지 않았습니다.",
  rejectedHedge:
    "AI가 쓴 초안에서 '아마·쯤·정도·~인가' 같은 말이 빠지거나 더해져서 쓰지 않았습니다. 확실하지 않다고 하신 것은 그대로 남깁니다.",
  rejectedPerson: 'AI가 쓴 초안에서 사람을 가리키는 말이 적어 주신 말과 달라서 쓰지 않았습니다.',
  rejectedSentence:
    'AI가 쓴 초안에 적어 주신 말 어디에도 그렇게 나오지 않는 문장이 있어서 쓰지 않았습니다.',
  rejectedTail: '아래는 적어 주신 말 그대로입니다.',
  titleFallback: 'AI가 지은 제목에 적어 주시지 않은 말이 있어서, 첫 문장에서 제목을 옮겼습니다.',
  photoLabel: '사진 설명 — AI가 사진을 보고 적었습니다. 기억이 아닙니다.',
  photoAdded:
    '사진 설명은 AI가 사진만 보고 적은 것이라 인용 표시 안에 따로 넣었습니다. 사실과 다르면 지우고 직접 적어 주세요.',
  photoDropped: '사진 설명은 사람을 알아본 것처럼 적혀 있어서 넣지 않았습니다.',
  photoOnly:
    '적어 주신 글이 없어서 본문은 비워 두었습니다. 한 줄만 적어 주시면 그대로 옮겨 드립니다.',
} as const;

/** A hard cap on how many offending words are read back. */
const NAME_LIMIT = 8;
const names = (ws: string[]): string[] =>
  ws.length <= NAME_LIMIT ? ws : [...ws.slice(0, NAME_LIMIT), `외 ${ws.length - NAME_LIMIT}개`];

/**
 * One sentence per kind of problem, most concrete first: an invented word is named, a
 * reversed "안" is described. The checker's own English `detail` is for the model and logs.
 */
function whyOf(report: GroundingReport): string[] {
  const kinds = new Set(report.violations.map((v) => v.kind));
  const out: string[] = [];
  if (kinds.has('invented') || kinds.has('number'))
    out.push(KO.rejectedInvention(names(report.ungrounded)));
  if (kinds.has('person')) out.push(KO.rejectedPerson);
  if (kinds.has('negation')) out.push(KO.rejectedNegation);
  if (kinds.has('hedge')) out.push(KO.rejectedHedge);
  if (kinds.has('unsupported_sentence')) out.push(KO.rejectedSentence);
  if (kinds.has('dropped'))
    out.push(
      report.lost.length > 0 ? KO.rejectedLoss(names(report.lost)) : KO.rejectedLossSentence,
    );
  return out;
}

/* ── the photograph rule ─────────────────────────────────────────────── */

/**
 * Kinship and identity words. A vision model writing "어머니가 웃고 계신다" has
 * IDENTIFIED a person in a photograph — which is the single fabrication a
 * photograph invites and the one a grieving family is least able to doubt.
 * A description may say what is visible. It may not say who anyone is.
 */
const PHOTO_DENY =
  /(어머니|엄마|아버지|아빠|할머니|할아버지|외할머니|외할아버지|형|누나|오빠|언니|동생|아들|딸|남편|아내|이모|고모|삼촌|외삼촌|숙모|며느리|사위|손자|손녀|가족|고인|돌아가신)/;
/** Any run of digits: a year, an age or a count read off a photograph is a guess. */
const PHOTO_DIGITS = /\d/;
const PHOTO_MAX = 200;

/**
 * A machine-made description, marked as machine-made IN THE STORED TEXT.
 *
 * The marker is a blockquote inside `body`, not a `notes[]` entry, and that is
 * the point: `notes[]` is discarded when the contributor saves, while `body` is
 * what `/ask` will later retrieve and cite. A sentence a machine wrote about a
 * dead person must still say so on its face after every living person who saw
 * the draft has forgotten there was a draft.
 */
function photoBlock(raw: string | null | undefined): { block: string; note: string } | null {
  if (typeof raw !== 'string') return null;
  const text = stripInvisible(raw)
    .replace(/!?\[\[[^\][]*\]\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  if (text.length > PHOTO_MAX || PHOTO_DENY.test(text) || PHOTO_DIGITS.test(text)) {
    return { block: '', note: KO.photoDropped };
  }
  return { block: `> **${KO.photoLabel}**\n> ${text}`, note: KO.photoAdded };
}

/* ── the gate ────────────────────────────────────────────────────────── */

const TITLE_MAX = 60;
/**
 * The model's links are discarded and re-derived; what stays is what a reader would have
 * seen: `[[Title|words]]` -> words, `[[Title]]` -> Title, an embed -> nothing. (Taking the
 * inside of the brackets whole left a literal "Title|words" in the saved note.)
 */
const unlink = (s: string): string => shownText(s);

/**
 * Wikilink targets the CONTRIBUTOR typed themselves.
 *
 * The model's links are discarded wholesale — it will invent `[[할머니]]` for
 * an archive with no such note — and `linkKnownTitles` re-derives from the real
 * title list afterwards. But a link the contributor typed to a note that does
 * not exist YET is a deliberate act (it is how you plan the next memory), so
 * their targets are added to the list `linkKnownTitles` is allowed to use.
 */
function contributorLinkTargets(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/!?\[\[([^\]|#]+)/g)) {
    const t = (m[1] ?? '').trim();
    if (t !== '') out.push(t);
  }
  return out;
}

/*
 * How much of the contributor's own content must survive is decided in grounding-ko.ts:
 * every word of each turn but fillers ("you know", 막) and one intensifier in ten ("really",
 * 너무), and every sentence, one-word ones too (it was 50% of the whole text, then 90% of
 * each turn, which let a rewrite drop "He died." or "I heard that" from a long answer and
 * still pass). All 46 recorded real-model proposals keep every word.
 */

export class KoreanGroundingGate {
  /**
   * Rides in `providerVersion` as `claude-cli-<ver>+grounded-ko-4`.
   *
   * BUMP IT whenever `SCAFFOLD`, `VARIANT_CLASSES`, the suffix lists or the
   * retention rules change. A draft's auditability depends on knowing which
   * rules approved it — the same reason `modelVersion` rides on every embedding
   * row. "Which model wrote this" is only half the question.
   *
   * 2: negation, hedges, people and numbers are must-keep; whole words only (no
   * prefix or substring); every sentence from one place; 90% of each turn kept.
   * 3: Korean words match on equal stems (돌아왔다 is not 돌아가셨다); modals, tense and
   * conditions are kept (could have died, is → was, if/unless, -면); Korean numerals.
   * 4: Korean tense and mood are kept (갈 거예요 is not 갔어요, 갔대요 is not 갔어요,
   * 가라고 했어요 is not 갔어요); who it came from, how often and how far are kept (I heard
   * that, in my dream, sometimes, still, 꿈에서, 가끔, 아직); a turn may lose fillers, a
   * tenth of its intensifiers and nothing else; a one-word sentence is kept like any other.
   * Joining sentences adds no cause, contrast or order (so, but, then, 그래서, -지만,
   * 돌아가셔서); sentences keep the order they were said in, each said once; to/from and
   * 에/에서/로 keep their direction. The speaker stays "I" (no "he", "she", "you", 그는,
   * 당신 in their place); "have done" and "was doing" are kept like a tense.
   */
  readonly gateVersion = 'grounded-ko-4';

  check(candidate: DraftCandidate, req: DraftRequest): GateOutcome {
    const source = stripInvisible(req.text).normalize('NFC');
    const hasWords = source.trim() !== '';
    const photo = photoBlock(candidate.photo);

    /* fields the model never gets a say in */
    const occurred: string | null = readFuzzyDate(source);
    const type: EntityType = readType(source, req.media !== null);
    const embed = req.media?.contentHash ? `![[${req.media.contentHash}]]` : '';

    /* --- body: the check that can discard the whole draft --- */
    const proposed = unlink(stripInvisible(candidate.body)).trim();
    const why: string[] = [];

    if (!hasWords) {
      /**
       * No words means no evidence, and no evidence means nothing can be
       * proved. This is not an edge case to be softened — it is the check
       * working: a photograph with no account attached to it is a `source`,
       * and the honest draft of one is empty.
       */
      if (proposed !== '') {
        return {
          accepted: null,
          why: [KO.rejectedInvention(names(eojeols(proposed).slice(0, NAME_LIMIT)))],
        };
      }
      const notes: string[] = [KO.photoOnly];
      if (photo) notes.push(photo.note);
      return {
        accepted: {
          title: readTitle(source, req.media?.filename ?? null),
          type,
          occurred,
          body: [embed, photo?.block ?? ''].filter((s) => s !== '').join('\n\n'),
          notes,
        },
        why: [],
      };
    }

    const report = checkGrounding(source, proposed);

    // anything wrong at all discards the draft: an invented word, a dropped sentence, a
    // reversed "안", a moved "아마", a different relative, a sentence from nowhere
    if (report.violations.length > 0) {
      return { accepted: null, why: [...whyOf(report), KO.rejectedTail] };
    }

    /* --- title: checked with the same rules (a label may leave things out), falls back alone --- */
    const proposedTitle = unlink(stripInvisible(candidate.title)).replace(/\s+/g, ' ').trim();
    let title = '';
    let titleFellBack = false;
    const titleCheck = proposedTitle === '' ? null : checkTitle(source, proposedTitle);
    if (
      proposedTitle !== '' &&
      proposedTitle.length <= TITLE_MAX &&
      validateNoteTitle(proposedTitle) === null &&
      titleCheck !== null &&
      titleCheck.ungrounded.length === 0 &&
      titleCheck.violations.length === 0
    ) {
      title = proposedTitle;
    } else {
      title = readTitle(source, req.media?.filename ?? null);
      titleFellBack = proposedTitle !== '';
    }

    /* --- links and embed, re-derived --- */
    const { body: linked, linked: hits } = linkKnownTitles(proposed, [
      ...req.titles,
      ...contributorLinkTargets(source),
    ]);

    const notes: string[] = [KO.kept, KO.keptCaveat];
    if (report.swapped.length > 0) notes.push(KO.swapped(names(report.swapped)));
    if (titleFellBack) notes.push(KO.titleFallback);
    if (hits.length > 0) {
      notes.push(`이미 있는 기록과 연결했습니다: ${hits.map((l) => `[[${l}]]`).join(', ')}`);
    }
    if (occurred) notes.push(`글에서 날짜를 찾았습니다: ${occurred}`);
    else notes.push('날짜는 비워 두었습니다. 기억나지 않아도 괜찮습니다.');
    if (photo) notes.push(photo.note);

    return {
      accepted: {
        title,
        type,
        occurred,
        body: [embed, photo?.block ?? '', linked].filter((s) => s !== '').join('\n\n'),
        notes,
      },
      why,
    };
  }
}
