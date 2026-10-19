import { checkGrounding } from './grounding-ko';
import { spokenNumbersToDigits, spokenYearsToDigits } from './speech';

/**
 * Does a model-written TITLE state a fact the speaker never stated?
 *
 * Titles are allowed new WORDS: a label that only reuses the speaker's words reads like a
 * sentence cut short, and the product owner chose readable labels ("My father's boat yard")
 * over that. A title is still the first thing a grandchild reads about a memory, so it may
 * not carry a new FACT. Checked against the speaker's own words for that memory:
 *
 *   numbers     every number in the title is one the speaker said: digits, spoken English
 *               ("forty-three", "second", "the sixties", "half a century") and Korean ("열",
 *               "두 번째", "셋째", "육십년대"); a year said by its last two digits ("in
 *               forty-three") is the same year; a place in an order only by a place ("the fifth
 *               child" is not "five children")
 *   names       an English title's capitalised words (the FIRST word too, unless it is an
 *               ordinary title word or the speaker's), a name after "Mr." or "Uncle" whatever
 *               its case, and any Korean word the speaker's words do not support (Korean names
 *               carry no capital: "순자 이모", "영수와 바다", "서울로 간 날"), except ordinary
 *               nouns; a one-syllable Korean word too ("술", "빚"), unless it is plain wording
 *   relatives   "grandmother" is not "mother" ("abuela" is not "madre"): when the speaker names
 *               relatives, the title's must be among them (any household word for the same
 *               person counts)
 *   facts       a death, prison, war, a fire, a hospital, twins, hunger, a loss … only when the
 *               speaker said the same thing; so are facts in plain words ("lost at sea", "lost his
 *               job", "went missing")
 *   denials     "never came back", "못 간 고향": only when the speaker denied something too
 *
 * A title that fails is not repaired: the caller falls back to a title built from the
 * speaker's own first sentence, which is always safe. So the rules are strict, and measured
 * against the 46 titles a real model wrote (all must pass).
 */

export interface TitleCheck {
  ok: boolean;
  /** which rule failed, for tests and logs (never shown as-is to a person) */
  reason?: string;
}

/* ── normalising words ───────────────────────────────────────────────── */

const fold = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC')
    .toLowerCase();

/** "Sundays" -> "sunday", "Chulsoo's" -> "chulsoo", "boxes" -> "box": plural and possessive forgiven. */
const base = (w: string): string => {
  let x = fold(w).replace(/['’]s$|s['’]$|['’]$/, '');
  if (/(?:ss|sh|ch|x|z)es$/.test(x)) x = x.slice(0, -2);
  else if (x.length > 3 && /[^s]s$/.test(x)) x = x.slice(0, -1);
  return x;
};

const WORD = /[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*['’]?/gu;
const wordsOf = (s: string): string[] => s.match(WORD) ?? [];

/** Every form of every word the speaker used, hyphenated and dotted parts included. */
function vocabulary(source: string): Set<string> {
  const out = new Set<string>();
  for (const w of wordsOf(source)) {
    out.add(base(w));
    for (const part of w.split(/[-'’.]/)) if (part !== '') out.add(base(part));
    out.add(base(w.replace(/[-'’.]/g, '')));
  }
  return out;
}

/* ── numbers ─────────────────────────────────────────────────────────── */

/** "first" and "last" are not counted: "First job", "First days" is wording, not a count */
const EN_ORDINAL: Record<string, number> = {
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
  thirteenth: 13,
  fourteenth: 14,
  fifteenth: 15,
  sixteenth: 16,
  seventeenth: 17,
  eighteenth: 18,
  nineteenth: 19,
  twentieth: 20,
  thirtieth: 30,
  fortieth: 40,
  fiftieth: 50,
  sixtieth: 60,
  seventieth: 70,
  eightieth: 80,
  ninetieth: 90,
  hundredth: 100,
};
const EN_TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const EN_DECADE: Record<string, number> = {
  twenties: 20,
  thirties: 30,
  forties: 40,
  fifties: 50,
  sixties: 60,
  seventies: 70,
  eighties: 80,
  nineties: 90,
};

const KO_NATIVE: Record<string, number> = {
  하나: 1,
  둘: 2,
  셋: 3,
  넷: 4,
  다섯: 5,
  여섯: 6,
  일곱: 7,
  여덟: 8,
  아홉: 9,
  열: 10,
  스물: 20,
  서른: 30,
  마흔: 40,
  쉰: 50,
  예순: 60,
  일흔: 70,
  여든: 80,
  아흔: 90,
};
/** the forms a native number takes before a counter or a noun: "두 번째", "세 자녀", "스무 살" */
const KO_DETERMINER: Record<string, number> = { 한: 1, 두: 2, 세: 3, 네: 4, 스무: 20 };
const KO_ORDINAL: Record<string, number> = {
  첫째: 1,
  둘째: 2,
  셋째: 3,
  넷째: 4,
  다섯째: 5,
  여섯째: 6,
  일곱째: 7,
  여덟째: 8,
  아홉째: 9,
  열째: 10,
};
const KO_SINO: Record<string, number> = {
  일: 1,
  이: 2,
  삼: 3,
  사: 4,
  오: 5,
  육: 6,
  륙: 6,
  칠: 7,
  팔: 8,
  구: 9,
};
const KO_SINO_UNIT: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
/** what counts things in Korean: a numeral right before one of these is a number */
const KO_COUNTER =
  /^(?:년대|년도|년|월|일|시|살|세|학년|남매|형제|자매|식구|명|번째|번|개|층|주|달|킬로|원|분|초|등|위|째|대|권|장|채|마리|가지|군데)/;
/** counters a single Sino numeral syllable is never confused before ("이번", "이달" are "this …") */
const KO_UNIT_COUNTER = /^(?:년대|년도|년|월|학년|남매|형제|자매|식구|층|킬로|원)/;
/** what follows a native number: a particle or the copula ("여섯이었어요", "둘이요") */
const KO_NUMBER_TAIL = /^(?:이었|였|이에요|예요|이요|이|가|은|는|을|를|의|요|에|도|만|뿐)/;

/** "사십" 40, "천구백오십" 1950, "이십오" 25: a run of Sino-Korean numeral syllables, or null */
function sino(run: string): number | null {
  let total = 0;
  let digit = 0;
  for (const ch of run) {
    if (KO_SINO[ch] !== undefined) {
      if (digit !== 0) return null;
      digit = KO_SINO[ch]!;
    } else if (KO_SINO_UNIT[ch] !== undefined) {
      total += (digit === 0 ? 1 : digit) * KO_SINO_UNIT[ch]!;
      digit = 0;
    } else return null;
  }
  return total + digit;
}

interface Num {
  n: number;
  /** said like a year ("in forty-three", "'58", "1946"): its last two digits name the same year */
  yearish: boolean;
  /** a decade ("the sixties", "60s", "1960년대"): any year in it supports it */
  decade: boolean;
  /**
   * a place in an order ("fifth", "5th", "셋째", "두 번째"): only a place supports it. "The fifth
   * child" is not "five children", and "three children" is not "the third".
   */
  ordinal: boolean;
}

/** Every number a text states, in English or Korean, words or digits. Linear in the text. */
function numbersIn(text: string): Num[] {
  const out: Num[] = [];
  const add = (n: number, yearish = false, decade = false, ordinal = false) => {
    if (Number.isFinite(n)) {
      out.push({ n, yearish: !ordinal && (yearish || (n >= 1800 && n <= 2099)), decade, ordinal });
    }
  };
  // English: decades and the fixed phrases first, so their words are not read again below
  let t = ` ${text.toLowerCase().replace(/[‘’]/g, "'")} `;
  t = t.replace(/\b(?:the\s+)?(18|19|20)?(\d0)'?s\b/g, (_m, c?: string, d?: string) => {
    add(Number(`${c ?? ''}${d}`), true, true);
    return ' ';
  });
  t = t.replace(
    /\b(?:the\s+)?(?:nineteen\s+|eighteen\s+)?(twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/g,
    (_m, w: string) => {
      add(EN_DECADE[w]!, true, true);
      return ' ';
    },
  );
  t = t.replace(/\bhalf\s+a\s+century\b/g, () => (add(50), ' '));
  t = t.replace(/\ba\s+century\b|\bcentury\b/g, () => (add(100), ' '));
  t = t.replace(/\bhalf\s+a\s+dozen\b/g, () => (add(6), ' '));
  t = t.replace(/\b(?:a\s+)?dozens?\b/g, () => (add(12), ' '));
  t = t.replace(
    /\ba\s+(hundred|thousand)\b/g,
    (_m, w: string) => (add(w === 'hundred' ? 100 : 1000), ' '),
  );
  t = t.replace(/\btwice\b/g, () => (add(2), ' '));
  // ordinals: "twenty-first", "second", "1st"
  t = t.replace(
    /\b(?:(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-])?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|fortieth|fiftieth|sixtieth|seventieth|eightieth|ninetieth|hundredth)\b/g,
    (m, tens: string | undefined, ord: string) =>
      ord === 'first' && !tens
        ? m
        : (add((tens ? EN_TENS[tens]! : 0) + (EN_ORDINAL[ord] ?? 1), false, false, true), ' '),
  );
  t = t.replace(
    /\b(\d+)(?:st|nd|rd|th)\b/g,
    (_m, d: string) => (add(Number(d), false, false, true), ' '),
  );
  // spoken numbers and years, then every run of digits, noting a year-like setting; digits
  // before 번째 or 째 ("3번째") are a place in an order
  const spoken = spokenNumbersToDigits(spokenYearsToDigits(t));
  for (const m of spoken.matchAll(
    /(\b(?:in|of|since|until|till|from|by|before|after|around|circa)\s+|')?(\d[\d,]*)(\s?(?:번째|째))?/g,
  )) {
    add(Number(m[2]!.replace(/,/g, '')), m[1] !== undefined, false, m[3] !== undefined);
  }
  // Korean
  const eojeols = text
    .normalize('NFC')
    .split(/\s+/)
    .map((x) => x.replace(/[^가-힣0-9]+/g, ''));
  eojeols.forEach((w, i) => {
    if (w === '') return;
    const next = eojeols[i + 1] ?? '';
    const decade = /^(\d{2,4})년대/.exec(w);
    if (decade) return add(Number(decade[1]), true, true);
    const ordinal = Object.keys(KO_ORDINAL).find((k) => w.startsWith(k));
    if (ordinal) return add(KO_ORDINAL[ordinal]!, false, false, true);
    // a place written as one word: "두번째", "열두번째"
    const placeOf = /^(열|스물)?(한|두|세|네|스무)(?:번째|째)/.exec(w);
    if (placeOf) {
      return add(
        (placeOf[1] ? KO_NATIVE[placeOf[1]]! : 0) + KO_DETERMINER[placeOf[2]!]!,
        false,
        false,
        true,
      );
    }
    // native: "열", "여섯이었어요", "서른여덟", before a counter or a particle
    const native =
      /^(열|스물|서른|마흔|쉰|예순|일흔|여든|아흔)?(하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉)?/.exec(
        w,
      )!;
    if (native[0] !== '') {
      const rest = w.slice(native[0].length);
      if (rest === '' || KO_COUNTER.test(rest) || KO_NUMBER_TAIL.test(rest)) {
        return add(
          (native[1] ? KO_NATIVE[native[1]]! : 0) + (native[2] ? KO_NATIVE[native[2]]! : 0),
        );
      }
    }
    // determiner forms count the next word: "두 번째", "세 자녀", "스무 살", "열두 살"; 한 and 네
    // only before a counter ("한 번", "네 시"), since "한국" and "네." (yes) are not numbers
    const det = /^(열|스물)?(한|두|세|네|스무)$/.exec(w);
    if (det && next !== '' && (KO_COUNTER.test(next) || !/^[한네]$/.test(det[2]!))) {
      return add(
        (det[1] ? KO_NATIVE[det[1]]! : 0) + KO_DETERMINER[det[2]!]!,
        false,
        false,
        /^(?:번째|째)/.test(next),
      );
    }
    // Sino-Korean: "사십", "천구백오십" (two numeral syllables or more), or one numeral before an
    // unambiguous counter ("육남매", "오학년", "삼 년"); "이번" (this time) is not 2
    const run = /^([일이삼사오육륙칠팔구십백천]+)(.*)$/.exec(w);
    if (run) {
      const n = sino(run[1]!);
      const rest = run[2]! || next;
      if (
        n !== null &&
        n > 0 &&
        (run[1]!.length >= 2
          ? run[2] === '' || KO_COUNTER.test(run[2]!)
          : KO_UNIT_COUNTER.test(rest))
      ) {
        add(n, /^년(?!대)/.test(rest), /^년대/.test(rest));
      }
    }
  });
  return out;
}

/** Is the title's number one the source states? */
function supported(x: Num, have: Num[]): boolean {
  for (const h of have) {
    if (h.n === x.n && h.decade === x.decade && h.ordinal === x.ordinal) return true;
    if (x.ordinal || h.ordinal) continue;
    // a year said by its last two digits: "forty-six" for 1946, "in forty-three" for 1943
    if (!x.decade && !h.decade && h.n % 100 === x.n % 100 && x.n !== h.n) {
      if (x.n >= 1800 && h.n < 100) return true;
      if (x.n < 100 && x.yearish && h.n >= 1800) return true;
    }
    // a decade is supported by itself or by any year said in it ("the sixties" / "in 1964")
    if (
      x.decade &&
      (h.decade || h.yearish) &&
      Math.floor((h.n % 100) / 10) === Math.floor((x.n % 100) / 10)
    ) {
      if (x.n < 100 || h.n < 100 || Math.floor(h.n / 100) === Math.floor(x.n / 100)) return true;
    }
  }
  return false;
}

/* ── relatives ───────────────────────────────────────────────────────── */

/**
 * One referent per class, in any language. "grandmother" and "mother" are different people,
 * and so are "abuela" and "madre" (Spanish is folded: "tía" is "tia", "mamá" is "mama").
 */
const KIN: ReadonlyArray<readonly string[]> = [
  ['mother', 'mom', 'mum', 'mama', 'mommy', 'mummy', 'ma', 'mam', 'mamma', 'madre', 'mami'],
  ['father', 'dad', 'daddy', 'papa', 'pa', 'pop', 'pops', 'padre', 'papi'],
  [
    'grandmother',
    'grandma',
    'granny',
    'gran',
    'nana',
    'nan',
    'grandmom',
    'grandmama',
    'abuela',
    'abuelita',
  ],
  [
    'grandfather',
    'grandpa',
    'granddad',
    'grandad',
    'gramps',
    'grandpop',
    'granddaddy',
    'abuelo',
    'abuelito',
  ],
  ['brother', 'bro', 'hermano'],
  ['sister', 'sis', 'hermana'],
  ['son', 'hijo'],
  ['daughter', 'hija'],
  ['uncle', 'tio'],
  ['aunt', 'auntie', 'aunty', 'tia'],
  ['husband', 'esposo', 'marido'],
  ['wife', 'esposa'],
  ['cousin', 'primo', 'prima'],
  ['niece', 'sobrina'],
  ['nephew', 'sobrino'],
  ['grandson', 'nieto'],
  ['granddaughter', 'nieta'],
  ['grandchild', 'grandchildren', 'grandkid'],
  ['stepmother', 'stepmom', 'stepmum'],
  ['stepfather', 'stepdad'],
  ['godmother'],
  ['godfather'],
  ['어머니', '엄마', '어머님', '어무이', '엄니', '모친', '어미'],
  ['아버지', '아빠', '아부지', '아버님', '부친', '애비'],
  ['할머니', '할매', '할머님', '할무니', '조모'],
  ['할아버지', '할배', '할아버님', '할아부지', '조부'],
  ['외할머니', '외조모'],
  ['외할아버지', '외조부'],
  ['형', '형님'],
  ['누나', '누님'],
  ['오빠', '오라버니'],
  ['언니'],
  ['남동생'],
  ['여동생'],
  ['동생'],
  ['아내', '집사람', '안사람'],
  ['남편', '바깥양반'],
  ['아들'],
  ['딸'],
  ['이모'],
  ['고모'],
  ['삼촌'],
  ['외삼촌'],
  ['큰아버지', '백부'],
  ['작은아버지', '숙부'],
  ['큰어머니', '백모'],
  ['작은어머니', '숙모'],
  ['시어머니'],
  ['시아버지'],
  ['장모', '장모님'],
  ['장인', '장인어른'],
  ['새어머니', '계모'],
  ['새아버지', '계부'],
  ['손자'],
  ['손녀'],
  ['손주', '손주들'],
  ['며느리'],
  ['사위'],
];

const KIN_EN = new Map<string, number>();
const KIN_KO: Array<[string, number]> = [];
KIN.forEach((cls, i) => {
  for (const w of cls) {
    if (/[가-힣]/.test(w)) KIN_KO.push([w, i]);
    else KIN_EN.set(w, i);
  }
});
// longest first, so 외할머니 is read before 할머니 and 큰아버지 before 아버지
KIN_KO.sort((a, b) => b[0].length - a[0].length);

/** The relatives a text names, as class numbers. Korean is matched longest first and masked. */
function relativesIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const w of wordsOf(text)) {
    const cls = KIN_EN.get(base(w)) ?? KIN_EN.get(fold(w));
    if (cls !== undefined) out.add(cls);
  }
  let masked = text.normalize('NFC');
  for (const [w, cls] of KIN_KO) {
    if (!masked.includes(w)) continue;
    out.add(cls);
    masked = masked.split(w).join(' ');
  }
  return out;
}

/* ── facts that may not be added ─────────────────────────────────────── */

/**
 * Each entry is ONE lexeme in its forms: "died" in a title is supported by "death" in the source.
 * Spanish forms are folded ("murió" is "murio", "héroe" is "heroe").
 */
const HEAVY_EN: readonly RegExp[] = [
  /^(?:murder|murders|murdered|murderer|murderers|murdering|asesinato|asesinado|asesinada|asesino)$/,
  /^(?:kill|kills|killed|killer|killers|killing)$/,
  /^(?:suicides?|suicidio)$/,
  /^(?:prison|prisons|prisoner|prisoners|imprison|imprisoned|imprisonment|carcel|prision|preso)$/,
  /^(?:jail|jails|jailed)$/,
  /^(?:arrest|arrests|arrested)$/,
  /^(?:divorce|divorces|divorced|divorcio|divorciado|divorciada)$/,
  /^affairs?$/,
  /^(?:abuse|abused|abuses|abusive|abuser)$/,
  /^(?:beat|beats|beaten|beating|beatings)$/,
  /^(?:rape|raped|rapes|rapist)$/,
  /^(?:die|dies|died|dying|dead|death|deaths|muerte|murio|muerto|muerta|fallecio|fallecido|fallecida)$/,
  /^cancers?$/,
  /^(?:war|wars|wartime|guerra)$/,
  /^(?:hero|heroes|heroic|heroe|heroico|heroica)$/,
  /^(?:secret|secrets|secretly|secreto|secreta)$/,
  /^illegitimate$/,
  /^(?:adopt|adopted|adoption)$/,
  /^(?:bankrupt|bankruptcy)$/,
  /^(?:drown|drowns|drowned|drowning|ahogado|ahogada)$/,
  /^strokes?$/,
  /^(?:saint|saints|saintly)$/,
  /^(?:mistress|mistresses)$/,
  /^(?:cheat|cheats|cheated|cheating)$/,
  /^(?:addict|addicts|addicted|addiction)$/,
  /^(?:alcoholic|alcoholics|alcoholism)$/,
  /^(?:drunk|drunken|drunkard)$/,
  /^(?:thief|thieves|steal|stole|stolen)$/,
  /^(?:crime|crimes|criminal|criminals)$/,
  /^(?:overdose|overdosed)$/,
  /^(?:funerals?|entierro)$/,
  /^(?:widow|widowed|widower|viuda|viudo)$/,
  /^(?:orphan|orphans|orphaned|huerfano|huerfana)$/,
  /^(?:abandon|abandoned)$/,
  /^(?:betray|betrayed|betrayal)$/,
  /^(?:monster|monsters|villain|villains|traitor|traitors|coward|liar)$/,
  /^(?:gamble|gambler|gambling|gambled)$/,
  /^(?:miscarriage|abortion)$/,
  // facts a model likes to add to a family story
  /^(?:hospital|hospitals|hospitalised|hospitalized|hospitalizado|hospitalizada)$/,
  /^(?:sick|sickness|ill|illness|illnesses|disease|diseases|enfermedad|enfermo|enferma)$/,
  /^(?:accident|accidents|accidente)$/,
  /^(?:fire|fires|burned|burnt|burning|incendio)$/,
  /^(?:flood|floods|flooded|flooding)$/,
  /^(?:storm|storms|typhoon|typhoons|hurricane)$/,
  /^(?:escape|escaped|escapes|fled|flee|fleeing|refugee|refugees)$/,
  /^(?:twin|twins)$/,
  /^(?:army|military|soldier|soldiers|ejercito|soldado)$/,
  /^(?:police|policeman|policemen|policia)$/,
  /^(?:emigrate|emigrated|emigration|immigrant|immigrants|immigrated|immigration)$/,
  /^(?:famine|starve|starved|starving|starvation|hambruna)$/,
  /^(?:hunger|hungry|hambre)$/,
  // "Lost in the market", "The year we lost everything": a loss someone has to have said
  /^(?:lost|lose|loses|losing|loss|losses)$/,
  /^(?:poverty|impoverished|destitute|pobreza)$/,
  /^forever$/,
];

/**
 * Facts said in plain words, which no single word carries: "A father lost at sea", "How my father
 * lost his job". Each needs one of its own phrases in the source. Read on folded text, linear.
 */
const HEAVY_EN_PHRASES: readonly RegExp[] = [
  /\blost at sea\b/,
  /\b(?:lost|lose|loses|losing) (?:his|her|my|their|our|the|a) (?:job|jobs|work|business|shop|store|farm)\b|\b(?:was|were|got|get|gets|been|being) (?:fired|sacked|laid off|let go)\b|\blaid off\b|\b(?:unemployed|unemployment|jobless)\b/,
  /\b(?:disappeared|disappearance|vanished|went missing|gone missing|go missing|goes missing)\b/,
  /\b(?:ran|run|runs|running) away\b|\b(?:walked|walks|walk) out on\b/,
];

/**
 * Words that deny. "My father never came back" states a fact (he did not come back) that a source
 * with no denial in it cannot support. English words, and Korean 않/없/아니/못 (and 안 before a verb).
 */
const NEG_EN =
  /^(?:never|not|no|nobody|nothing|none|nowhere|neither|nor|without|cannot|nunca|jamas|nadie|nada)$|n['’]t$/;
const NEG_KO = /않|없|아니|아닌|아님|못하|못했|못한|못할/;
function denies(text: string): boolean {
  if (wordsOf(text).some((w) => NEG_EN.test(fold(w)))) return true;
  const ko = text.normalize('NFC');
  if (NEG_KO.test(ko)) return true;
  // "못" before a word denies ("못 간 고향"); so does "안", first or after a particle ("학교에 안
  // 간", "안 오신 날"), but after a bare noun it is "inside" ("집 안 풍경", "그 안")
  const eo = ko.split(/\s+/);
  return eo.some(
    (w, i) =>
      i + 1 < eo.length &&
      /^[가-힣]/.test(eo[i + 1]!) &&
      (w === '못' ||
        (w === '안' && (i === 0 || /[에을를이가은는도만서게고며면요]$/.test(eo[i - 1]!)))),
  );
}

const HEAVY_KO: ReadonlyArray<readonly string[]> = [
  ['살인', '살해', '죽였'],
  ['자살'],
  ['감옥', '교도소', '수감', '징역', '옥살이'],
  ['체포', '구속'],
  ['이혼'],
  ['불륜', '외도'],
  ['학대'],
  ['폭행', '폭력', '때렸', '때리'],
  ['강간', '성폭행'],
  ['암', '항암'],
  ['전쟁', '육이오', '6.25', '6·25'],
  ['입양'],
  ['파산', '부도'],
  ['비밀'],
  ['사망', '죽음', '죽었', '죽은', '돌아가', '별세', '세상을 떠'],
  ['익사', '물에 빠져'],
  ['뇌졸중', '중풍'],
  ['장례', '초상'],
  ['영웅'],
  ['성자'],
  ['중독', '알코올', '술주정'],
  ['도박'],
  ['도둑', '훔쳤', '훔친'],
  ['범죄', '범인'],
  ['과부', '홀아비'],
  ['고아'],
  ['배신'],
  ['병원', '입원'],
  ['병', '질병', '아프', '아팠', '투병'],
  ['사고'],
  ['화재', '불이 나', '불이 났', '불타'],
  ['홍수', '물난리'],
  ['태풍'],
  ['탈출', '도망', '피난', '피란'],
  ['쌍둥이'],
  ['군대', '군인', '입대'],
  ['경찰'],
  ['이민'],
];

/* ── words a title may use freely ────────────────────────────────────── */

/**
 * An English title's first word is a name the speaker never said ("Sunja's kitchen", "Busan
 * days", "Tom and the boat") unless it is the speaker's own word or an ordinary title word.
 */
const EN_TITLE_WORDS = new Set(
  (
    'a an the this that these those my our his her their your its i we he she they it you ' +
    'in on at from with without after before during since until under over by for to of into ' +
    'through across around near behind beyond between among about along against toward towards ' +
    'and but or when while how why what where who whose which if as once all every each some no ' +
    'both many few most life love home family childhood school work faith hope grief advice ' +
    'memories memory money thanks thank letters letter days day summer winter spring autumn fall ' +
    'morning evening night weekend holidays holiday new old young little big last early late long ' +
    'short happy sad quiet kind best good hard better worst always never sometimes still just more ' +
    'less nothing everything something peace hunger food dinner lunch breakfast music songs song ' +
    'stories story words lessons lesson neighbours neighbors friends friendship together alone ' +
    'growing coming going leaving living working learning being becoming finding losing making ' +
    'getting starting moving meeting saying remembering waiting looking volunteer volunteering ' +
    'mornings nights evenings sundays weekends birthdays journey road house houses kitchen garden ' +
    'church market harbour harbor sea river village town city country farm shop factory ' +
    'first last only one born married moved met lost found left came went grew lived worked ' +
    'raised learned opened started bought sold built taught became'
  ).split(' '),
);
/** after these a word is a name, whatever its case ("mr. park", "Uncle Jae") */
const EN_NAME_AFTER =
  /^(?:mr|mrs|ms|miss|dr|uncle|aunt|auntie|aunty|grandma|grandpa|grandmother|grandfather|saint|st)$/i;

/** Ordinary Korean nouns a title may use although the speaker did not say them. */
const KO_COMMON = new Set(
  (
    '기억 추억 이야기 얘기 시절 하루 그날 그때 옛날 처음 마지막 우리 사랑 마음 가족 고향 집안 인생 세월 ' +
    '시간 날들 순간 여름 겨울 봄날 가을 아침 저녁 점심 첫날 행복 슬픔 눈물 웃음 손맛 모습 생각 시작 ' +
    '어린 젊은 부엌 마당 동네 바다 바닷가 학교 시장 교회 오늘 어제 내일 평생 일생 소리 냄새 노래 음식 ' +
    '선물 편지 사진 결혼 결혼식 생일 명절 추석 설날 농사 장사 가게 공장 일터 직장 첫사랑 ' +
    '구경 솜씨 살림 생활 배움 당부 자랑 신혼 시댁 친정 일상 습관 성격 말씀 마지막 부탁 소원 꿈 ' +
    '수리 일과 나날 풍경 기쁨 걱정 고생 정 은혜 감사 인사 만남 이별 떠남 귀향 고향집 어린시절 ' +
    '모두 함께 혼자 둘이 같이 대한 관한 위한 이후 이전 무렵 당시 시대 세대 일상 ' +
    '자녀 자식 아이 아이들 애들 식구 형제 남매 자매 부모 부모님 집 사람들 친구 친구들 이웃'
  ).split(' '),
);
/**
 * One-syllable Korean words a title may use unsaid: times, places, parts of a phrase and plain
 * words that state nothing about anyone. Any other one-syllable word the speaker's words do not
 * support is a fact: "술" (drink) and "끊" (quit) in "아버지가 술을 끊은 날", "빚", "매", "약".
 */
const KO_COMMON_ONE = new Set(
  (
    '날 때 곳 길 집 꿈 맛 정 말 봄 밤 낮 해 달 철 속 앞 뒤 옆 위 밑 안 밖 첫 셈 것 거 건 걸 일 삶 몸 ' +
    '품 빛 뜻 힘 손 맘 등 줄 쪽 편 번 끝 새 옛 온 한 두 세 네 그 이 저 제 내 참 늘 또 잘 다 꼭 더 덕 복'
  ).split(' '),
);
/** what a Korean word may carry after its stem: particles, and the copula */
const KO_TAIL =
  /(?:에서의|으로의|로의|과의|와의|에게|한테|께서|에서|으로|이랑|하고|까지|부터|처럼|보다|이나|이며|이고|이었|이야|이요|이에요|예요|의|이|가|은|는|을|를|와|과|로|랑|도|만|에|께)$/;
/** honorific titles: a one-syllable word right before one is a surname ("박 선생님", "김 할머니") */
const KO_TITLE_AFTER =
  /^(?:선생님?|씨|아저씨|아주머니|아줌마|할머니|할아버지|교수님?|목사님?|사장님?|장로님?|권사님?|집사님?|여사|군|양)/;

/* ── the check ───────────────────────────────────────────────────────── */

export function checkTitleFacts(title: string, sourceText: string): TitleCheck {
  if (typeof title !== 'string' || typeof sourceText !== 'string') {
    return { ok: false, reason: 'not text' };
  }
  const t = title.normalize('NFC');
  const src = sourceText.normalize('NFC');

  // numbers: 1950, "second", "열 남매" in a title are facts someone has to have said
  const have = numbersIn(src);
  for (const x of numbersIn(t)) {
    if (!supported(x, have)) return { ok: false, reason: `number ${x.n}` };
  }

  // relatives: when the speaker names relatives, the title's are among them ("Grandma" is not
  // "my mother"); a relative inferred where the speaker names none ("남편" for "이이") is allowed
  const kinHave = relativesIn(src);
  if (kinHave.size > 0) {
    // ...except the person the title is addressed to: "손주들에게 당부", "To my grandchildren"
    const addressed = t.replace(
      /[가-힣]+(?:에게|한테|께)(?=\s|$)|\b(?:to|for)\s+(?:my\s+|our\s+|the\s+)?\w+/gi,
      ' ',
    );
    for (const k of relativesIn(addressed))
      if (!kinHave.has(k)) return { ok: false, reason: 'relative' };
  }

  // English names: capitalised words, the first word unless it is ordinary, a word after "Mr."
  const vocab = vocabulary(src);
  const said = (w: string) => {
    const parts = [w, w.replace(/[-'’.]/g, ''), ...w.split(/[-'’.]/)].filter((p) => p !== '');
    return parts.some((p) => vocab.has(base(p)));
  };
  const words = wordsOf(t);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!/[A-Za-z]/.test(w) || /[가-힣]/.test(w)) continue;
    if (/^I(?:['’](?:m|d|ve|ll))?$/.test(w)) continue;
    if (KIN_EN.has(base(w)) || KIN_EN.has(fold(w))) continue; // checked as a relative
    const afterTitle = i > 0 && EN_NAME_AFTER.test(words[i - 1]!.replace(/\.$/, ''));
    const capital = /^\p{Lu}/u.test(w);
    const nameish =
      afterTitle ||
      (i > 0
        ? capital
        : !EN_TITLE_WORDS.has(base(w)) && !EN_TITLE_WORDS.has(fold(w)) && !/ing$/i.test(w));
    if (nameish && !said(w)) return { ok: false, reason: `name ${w}` };
  }

  // Korean: every word the speaker's words do not support must be an ordinary noun. Names carry
  // no capital in Korean, so "순자 이모", "영수와 바다", "서울로 간 날" are caught here.
  if (/[가-힣]/.test(t)) {
    const unsupported = new Set(checkGrounding(src, t).ungrounded.map((w) => w.normalize('NFC')));
    const eojeols = t
      .split(/\s+/)
      .map((e) => e.replace(/^[^가-힣A-Za-z0-9]+|[^가-힣A-Za-z0-9]+$/g, ''));
    for (let i = 0; i < eojeols.length; i++) {
      const e = eojeols[i]!;
      if (!/[가-힣]/.test(e)) continue;
      const stem = e.replace(KO_TAIL, '') || e;
      // a surname before an honorific title: "박 선생님", "김씨 아저씨"
      if (stem.length <= 2 && KO_TITLE_AFTER.test(eojeols[i + 1] ?? '') && !src.includes(stem)) {
        return { ok: false, reason: `name ${stem}` };
      }
      if (!unsupported.has(e) && !unsupported.has(stem)) continue;
      if (src.includes(stem)) continue; // said as such ("일요일마다" has "일요일")
      if (KO_COMMON.has(stem) || KO_COMMON.has(e)) continue;
      // a fact word ("별세", "장례식") is judged by the fact rule below, against its whole lexeme
      if (HEAVY_KO.some((g) => g.some((w) => e.includes(w)))) continue;
      // the person a title is addressed to ("손주들에게 당부") is not a fact about them
      if (/(?:에게|한테|께)$/.test(e) && KIN_KO.some(([k]) => stem.startsWith(k))) continue;
      if (KIN_KO.some(([k]) => stem.endsWith(k) || stem.startsWith(k))) continue; // a relative
      if (numbersIn(e).length > 0) continue; // a number, checked above
      // a counter after a number ("세 번째", "두 살"): part of the number, checked above
      if (i > 0 && KO_COUNTER.test(e) && numbersIn(`${eojeols[i - 1]} ${e}`).length > 0) continue;
      // the grammar of a denial ("못 간", "가지 않은"): judged by the denial rule below
      if (/^(?:안|못)$|^않/.test(e)) continue;
      // one syllable: an ordinary word ("날", "집", "때") is wording; any other is a fact
      if (
        [...stem].filter((c) => /[가-힣]/.test(c)).length <= 1 &&
        (KO_COMMON_ONE.has(stem) || KO_COMMON_ONE.has(e))
      ) {
        continue;
      }
      return { ok: false, reason: `word ${stem}` };
    }
  }

  // facts that may not be added: only when the speaker said the same thing
  const titleWords = words.map((w) => fold(w).replace(/['’]s$/, ''));
  const srcWords = wordsOf(src).map((w) => fold(w).replace(/['’]s$/, ''));
  for (const lexeme of HEAVY_EN) {
    if (titleWords.some((w) => lexeme.test(w)) && !srcWords.some((w) => lexeme.test(w))) {
      return { ok: false, reason: `fact ${lexeme.source}` };
    }
  }
  for (const group of HEAVY_KO) {
    if (group.some((w) => t.includes(w)) && !group.some((w) => src.includes(w))) {
      return { ok: false, reason: `fact ${group[0]}` };
    }
  }
  // facts in plain words ("lost at sea", "lost his job"): only when the speaker said one too
  const flat = (s: string): string =>
    ` ${fold(s)
      .replace(/’/g, "'")
      .replace(/[^\p{L}\p{N}']+/gu, ' ')} `;
  const titleFlat = flat(t);
  let srcFlat: string | null = null;
  for (const phrase of HEAVY_EN_PHRASES) {
    if (!phrase.test(titleFlat)) continue;
    srcFlat ??= flat(src);
    if (!phrase.test(srcFlat)) return { ok: false, reason: `fact ${phrase.source.slice(0, 20)}` };
  }
  // a denial ("never came back", "못 간 고향") is a fact only a denial in the source supports
  if (denies(t) && !denies(src)) return { ok: false, reason: 'denial' };
  return { ok: true };
}
