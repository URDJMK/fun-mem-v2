import { spokenNumbersToDigits, spokenYearsToDigits } from './speech';

/**
 * Does a model-written TITLE state a fact the speaker never stated?
 *
 * Titles are allowed new WORDS: a label that only reuses the speaker's words reads like a
 * sentence cut short, and the product owner chose readable labels ("My father's boat yard")
 * over that. A title is still the first thing a grandchild reads about a memory, so it may
 * not carry a new FACT. Checked against the speaker's own words for that memory:
 *
 *   numbers     every number in the title is one the speaker said: digits and spoken English
 *               ("forty-three", "second", "the sixties", "half a century"); a year said by its
 *               last two digits ("in forty-three") is the same year; a place in an order only
 *               by a place ("the fifth child" is not "five children")
 *   names       capitalised words (the FIRST word too, unless it is an ordinary title word or
 *               the speaker's), and a name after "Mr." or "Uncle" whatever its case
 *   other       a word in a script these rules do not read (Greek, Cyrillic, Han, …): a name
 *   scripts     there may carry no capital and a number may be a word, so it is allowed only
 *               when the speaker said that very word, exactly as they said it
 *   relatives   "grandmother" is not "mother" ("abuela" is not "madre"): when the speaker names
 *               relatives, the title's must be among them (any household word for the same
 *               person counts)
 *   facts       a death, prison, war, a fire, a hospital, twins, hunger, a loss … only when the
 *               speaker said the same thing; so are facts in plain words ("lost at sea", "lost his
 *               job", "went missing")
 *   denials     "never came back": only when the speaker denied something too
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

interface Num {
  n: number;
  /** said like a year ("in forty-three", "'58", "1946"): its last two digits name the same year */
  yearish: boolean;
  /** a decade ("the sixties", "60s"): any year in it supports it */
  decade: boolean;
  /**
   * a place in an order ("fifth", "5th"): only a place supports it. "The fifth child" is not
   * "five children", and "three children" is not "the third".
   */
  ordinal: boolean;
}

/** Every number a text states, in words or digits. Linear in the text. */
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
  // spoken numbers and years, then every run of digits, noting a year-like setting
  const spoken = spokenNumbersToDigits(spokenYearsToDigits(t));
  for (const m of spoken.matchAll(
    /(\b(?:in|of|since|until|till|from|by|before|after|around|circa)\s+|')?(\d[\d,]*)/g,
  )) {
    add(Number(m[2]!.replace(/,/g, '')), m[1] !== undefined);
  }
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
];

/** word -> its class in `KIN` */
const KIN_CLASS = new Map<string, number>();
KIN.forEach((cls, i) => {
  for (const w of cls) KIN_CLASS.set(w, i);
});

/** The relatives a text names, as class numbers. */
function relativesIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const w of wordsOf(text)) {
    const cls = KIN_CLASS.get(base(w)) ?? KIN_CLASS.get(fold(w));
    if (cls !== undefined) out.add(cls);
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
 * with no denial in it cannot support.
 */
const NEG_EN =
  /^(?:never|not|no|nobody|nothing|none|nowhere|neither|nor|without|cannot|nunca|jamas|nadie|nada)$|n['’]t$/;
const denies = (text: string): boolean => wordsOf(text).some((w) => NEG_EN.test(fold(w)));

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

/**
 * A letter of a script other than the Latin alphabet: a word holding one is opaque to the rules
 * above. (Letters every script shares, like "µ", are not counted.)
 */
const OTHER_SCRIPT = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])\p{L}/u;

/* ── the check ───────────────────────────────────────────────────────── */

export function checkTitleFacts(title: string, sourceText: string): TitleCheck {
  if (typeof title !== 'string' || typeof sourceText !== 'string') {
    return { ok: false, reason: 'not text' };
  }
  const t = title.normalize('NFC');
  const src = sourceText.normalize('NFC');

  // numbers: 1950, "second", "a dozen" in a title are facts someone has to have said
  const have = numbersIn(src);
  for (const x of numbersIn(t)) {
    if (!supported(x, have)) return { ok: false, reason: `number ${x.n}` };
  }

  // relatives: when the speaker names relatives, the title's are among them ("Grandma" is not
  // "my mother"); a relative inferred where the speaker names none is allowed
  const kinHave = relativesIn(src);
  if (kinHave.size > 0) {
    // ...except the person the title is addressed to: "To my grandchildren"
    const addressed = t.replace(/\b(?:to|for)\s+(?:my\s+|our\s+|the\s+)?\w+/gi, ' ');
    for (const k of relativesIn(addressed))
      if (!kinHave.has(k)) return { ok: false, reason: 'relative' };
  }

  // names: capitalised words, the first word unless it is ordinary, a word after "Mr."
  const vocab = vocabulary(src);
  const said = (w: string) => {
    const parts = [w, w.replace(/[-'’.]/g, ''), ...w.split(/[-'’.]/)].filter((p) => p !== '');
    return parts.some((p) => vocab.has(base(p)));
  };
  const words = wordsOf(t);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!/[A-Za-z]/.test(w) || OTHER_SCRIPT.test(w)) continue;
    if (/^I(?:['’](?:m|d|ve|ll))?$/.test(w)) continue;
    if (KIN_CLASS.has(base(w)) || KIN_CLASS.has(fold(w))) continue; // checked as a relative
    const afterTitle = i > 0 && EN_NAME_AFTER.test(words[i - 1]!.replace(/\.$/, ''));
    const capital = /^\p{Lu}/u.test(w);
    const nameish =
      afterTitle ||
      (i > 0
        ? capital
        : !EN_TITLE_WORDS.has(base(w)) && !EN_TITLE_WORDS.has(fold(w)) && !/ing$/i.test(w));
    if (nameish && !said(w)) return { ok: false, reason: `name ${w}` };
  }

  // a word in another script: the rules above cannot read it (a name there may carry no capital,
  // a number may be a word), so it is allowed only when the speaker said that very word
  const spoken = new Set(wordsOf(src));
  for (const w of words) {
    if (OTHER_SCRIPT.test(w) && !spoken.has(w)) return { ok: false, reason: `word ${w}` };
  }

  // facts that may not be added: only when the speaker said the same thing
  const titleWords = words.map((w) => fold(w).replace(/['’]s$/, ''));
  const srcWords = wordsOf(src).map((w) => fold(w).replace(/['’]s$/, ''));
  for (const lexeme of HEAVY_EN) {
    if (titleWords.some((w) => lexeme.test(w)) && !srcWords.some((w) => lexeme.test(w))) {
      return { ok: false, reason: `fact ${lexeme.source}` };
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
  // a denial ("never came back") is a fact only a denial in the source supports
  if (denies(t) && !denies(src)) return { ok: false, reason: 'denial' };
  return { ok: true };
}
