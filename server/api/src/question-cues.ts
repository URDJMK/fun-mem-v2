/**
 * Does a turn of speech read as a QUESTION or an invitation to tell ("Tell me about your
 * father", "…말씀해 주세요")? Used to tell an interviewer from the relative, and to pick the
 * question to quote above a memory.
 *
 * A question mark is the strongest cue and Korean speech-to-text rarely writes one, so the
 * cues are words too. Kept in one place because the role guess (transcript side) and the
 * pipeline (note side) must agree on what a prompt is.
 *
 * Korean is the hard case: a question and a statement often end the same way ("다니셨어요" is
 * "did you go?" and "she went"), and the question words double as "some-" words ("몇 년" is
 * "several years", "어디 갔다 왔어요" is "I went somewhere"). So a Korean sentence asks when its
 * ENDING can only ask (-나요, -ㄴ가요, -ㄹ까요, -ㅂ니까, a request), or when a question word sits in
 * its last clause and the clause is not an embedded question ("왜 그랬는지 몰라요" tells). The
 * weaker question words also need the honorific the interviewer uses to the elder (-시-):
 * "어디서 태어나셨어요" asks, "몇 년 살았어요" tells. Before this, a Korean interview transcribed
 * without "?" read as two people telling, and almost every one of them had to be confirmed.
 *
 * Every check here is linear in the length of the turn: the patterns are anchored or read a
 * bounded tail, and the last sentence is found by a scan, not by a pattern.
 */

/** "So, …", "Okay and …" in front of a prompt */
const OPEN = String.raw`(?:(?:so|okay|ok|and|well|now|alright|all right|right|um|uh)[,\s]+)*`;
/**
 * The start of a turn that asks or invites: "Tell me…", "Where were you born", "And then?", "And
 * your mother". A question word in front asks only in a short turn or one addressed to her ("so
 * where were you born"): "When I was young we lived in Busan" and "and then we walked to Busan"
 * are her own story.
 */
const PROMPT_LEAD = new RegExp(
  String.raw`^${OPEN}(?:(tell|describe|talk|explain|share|walk me|go on|continue|keep going|say more|let'?s)\b|(and then)(?=\s*(?:what\b|$|[?.!,]))|(what about|how about|and your|your)\b|(what|where|when|which|who|why|how|do|did|can|could|would|was|were|is|are|have|has|will)\b)`,
  'i',
);
const ASKS_HER = /\byou(?:r|rs|'re|'ve|'d|'ll)?\b/i;

function englishPrompt(t: string): boolean {
  const m = PROMPT_LEAD.exec(t);
  if (!m) return false;
  if (m[1] || m[2]) return true;
  const words = t.split(/\s+/).length;
  if (m[3]) return words <= 6; // "and your mother", "what about school"
  return words <= 6 || ASKS_HER.test(t.split(/\s+/).slice(0, 8).join(' '));
}

/** An invitation at the start of the LAST sentence: "That is lovely. Tell me more about him." */
const LAST_PROMPT =
  /^(?:tell (?:me|us)|describe|talk about|explain|share|walk me|go on|continue|keep going|say more)\b/i;

/** Korean requests, and asking whether she remembers or knows, which speech-to-text writes without a "?". */
const KO_PROMPT_END =
  /(?:주세요|주시겠어요|주실래요|주시겠습니까|주시면 좋겠(?:습니다|어요)|주시면 (?:돼요|됩니다)|해 ?줘|해 ?봐|해 ?보세요|말씀해|이야기해|얘기해|들려줘|습니까|실래요|시겠어요|궁금해요|궁금합니다|궁금하네요|기억나세요|기억하세요|기억하시나요|생각나세요|아세요|아시나요)$/;

/** Question words that only ask ("how", "why"): 어떻게든 ("somehow") and 왜냐하면 ("because") do not. */
const KO_WH_STRONG = /(?:어떻게(?!든)|어땠|어떠셨|어떠했|어때|왜(?!냐))/;
/** Question words that are also "some-" words: they ask only with the honorific ending of a question to an elder. */
const KO_WH_WEAK =
  /(?:어디(?!든|나)|어떤|언제(?!나|든)|누구(?!나|든)|누가|누굴|뭐(?!든|라도)|뭘|무엇(?!이든)|무슨|몇(?!몇)|얼마(?!\s*(?:안|전|후|뒤|만에)))/;
/** a question word right before the copula asks whatever the honorific: "누구였어요", "언제예요", "몇 살이었어요" */
const KO_WH_COPULA =
  /(?:어디|언제|누구|뭐|무엇|몇[ \t]?[가-힣]{1,3}|얼마)(?:이)?(?:예요|에요|였어요|었어요|였나요|였죠|였지|였어|야|일까요?)$/;
/**
 * A question word inside a statement: "왜 그랬는지 몰라요", "어디서 왔는지 기억이 안 나요", "어떻게 살았나
 * 싶어요" ("I wonder how"), and a concessive "무슨 말을 해도" ("whatever I said").
 */
const KO_EMBEDDED =
  /(?:는지|은지|던지|을지|인지|건지|한지|된지)|지\s*(?:몰|모르|모를|기억|알|생각|궁금|잊)|나\s*싶|(?:어도|아도|해도|여도|와도|가도|봐도|라도|든지|든가)\s|냐고|느냐고|냐면|냐하면|(?:하고|라고|고)\s*(?:물|하셨|했|하시)/;
/**
 * A question word used as "some-", "any-" or a duration, not to ask: "무슨 일이든", "어디서든",
 * "누구보다", "몇 년 동안", "몇 시간씩", "언제나".
 */
const KO_INDEFINITE =
  /(?:어디|어떤|무슨|누구|누가|언제|뭐|뭘|무엇|몇|얼마)[가-힣\s]{0,4}?(?:든|라도|나마|보다)|몇[ \t]?[가-힣]{1,2}[ \t]?(?:동안|씩|째|쯤|정도|만에|간)|언제나|누구나|어디나/;
/** a narrative clause ("몇 년 일하시다가 병이 나셨어요"): a question word in it does not make it ask */
const KO_CONNECTIVE = /(?:다가|는데|어서|아서|해서|면서|니까|지만|더니)\s/;
/** the honorific ending of a question to an elder: 태어나셨어요, 사세요, 계셨나요, 하십니까 */
const KO_HONORIFIC_END = /(?:셨|시|세|셔|십|신|실|계셨|계시)[가-힣]{0,3}$/;
/** a short follow-up made of a topic and 요: "어머니는요", "학교는요", "그래서요", "그다음에요" */
const KO_FOLLOW_UP =
  /^(?:[가-힣]{1,8}(?:는|은)요?|(?:그래서|그리고|그러고|그러면|그 ?다음(?:에|엔|은)?|다음(?:에|엔|은)?)요)$/;
const KO_FILLER_WH = /^뭐[,\s]+(?=그냥|그렇게|그런|이제|다\s|좀|있잖아|어쩌|그래)/;
/** a casual (반말) ending: "어디서 태어났어", "결혼은 언제 했어", "무슨 일 했어" */
const KO_CASUAL_END = /(?:어|아|니|냐|야|지|래|대)$/;
/** a short question: a casual one with a "some-" word asks only when it is this short */
const KO_SHORT_HANGUL = 14;

const SENTENCE_END = new Set(['.', '!', '?', '？', '！', '。', '…']);
const TRAILING = new Set([
  '.',
  '!',
  '?',
  '？',
  '！',
  '。',
  '…',
  '"',
  "'",
  '”',
  '’',
  ')',
  '~',
  '～',
  ' ',
  '\n',
  '\t',
]);
/** the question clause of a Korean sentence is its end: a question word further back belongs to something else */
const KO_CLAUSE_CHARS = 24;

/** The last sentence of a turn, found by scanning back from the end (no pattern can go quadratic). */
function lastSentence(t: string): string {
  let end = t.length;
  while (end > 0 && TRAILING.has(t[end - 1]!)) end--;
  let i = end - 1;
  while (i >= 0 && !SENTENCE_END.has(t[i]!)) i--;
  return t.slice(i + 1, end).trim();
}

/** A Hangul syllable's final consonant, by its index in the Unicode table (ㄴ 4, ㄹ 8, ㅂ 17, ㅆ 20); -1 if none or not Hangul. */
function finalOf(ch: string | undefined): number {
  if (ch === undefined) return -1;
  const c = ch.charCodeAt(0) - 0xac00;
  return c >= 0 && c < 11172 ? c % 28 : -1;
}
const FINAL_N = 4;
const FINAL_L = 8;
const FINAL_B = 17;
const FINAL_SS = 20;
/** stems a question in -나요 is made of: 있나요, 하나요, 되나요 (not 기억나요/생각나요, "I remember") */
const NA_STEM = new Set([
  '있',
  '없',
  '하',
  '되',
  '가',
  '오',
  '보',
  '시',
  '드',
  '주',
  '좋',
  '맞',
  '많',
  '같',
  '싶',
  '알',
  '모르',
  '계',
]);

/** An ending that can only ask: -나요, -ㄴ가요, -ㄹ까요, -ㅂ니까, -ㄹ래요 to an elder. */
function koAskingEnding(s: string): boolean {
  const n = s.length;
  const before = (k: number) => s[n - k - 1];
  if (s.endsWith('나요')) {
    const b = before(2);
    return b !== undefined && (finalOf(b) === FINAL_SS || NA_STEM.has(b));
  }
  if (s.endsWith('가요')) return finalOf(before(2)) === FINAL_N; // 인가요, 는가요, 한가요; not 학교에 가요
  if (s.endsWith('니까')) return finalOf(before(2)) === FINAL_B; // 합니까, 입니까; not 가니까 ("because")
  if (s.endsWith('까요') || s.endsWith('까')) {
    const b = before(s.endsWith('까요') ? 2 : 1);
    return finalOf(b) === FINAL_L; // 할까요, 일까요; not 가니까요 ("because")
  }
  return false;
}

/** A Korean sentence that asks, without a question mark. */
function koAsks(sentence: string): boolean {
  const s = sentence.replace(/[\s.!…~～]+$/, '');
  if (!/[가-힣]$/.test(s)) return false;
  if (KO_PROMPT_END.test(s) || koAskingEnding(s)) return true;
  if (KO_FOLLOW_UP.test(s)) return true;
  // "뭐 그냥 살았지" ("well, we just lived"): 뭐 as a filler in front, not "what"
  const clause = s.replace(KO_FILLER_WH, '').slice(-KO_CLAUSE_CHARS);
  if (KO_EMBEDDED.test(clause)) return false;
  if (KO_WH_STRONG.test(clause) || KO_WH_COPULA.test(clause)) return true;
  if (!KO_WH_WEAK.test(clause) || KO_INDEFINITE.test(clause) || KO_CONNECTIVE.test(clause))
    return false;
  if (KO_HONORIFIC_END.test(clause)) return true;
  let hangul = 0;
  for (const ch of s) if (ch >= '가' && ch <= '힣') hangul++;
  return hangul <= KO_SHORT_HANGUL && KO_CASUAL_END.test(s);
}

/** A question, or an invitation to tell ("Tell me about…", "말씀해 주세요"). */
export function looksLikeAsking(text: string): boolean {
  const t = text.trim();
  if (/[?？]/.test(t)) return true;
  if (englishPrompt(t)) return true;
  const last = lastSentence(t);
  return LAST_PROMPT.test(last) || koAsks(last.slice(-200));
}

const BACKCHANNEL =
  /^(?:mm+(?:-?hm+)?|mhm|uh-?huh|hmm+|yeah|yep|yes|right|okay|ok|i see|oh|wow|really|sure|네|응|음|아|예|그렇군요|맞아요|그래요|그렇죠|그렇구나)[.!?…,\s]*$/i;

/** Only a sound of listening or agreeing, nothing else: "Mm-hm.", "Yeah.", "네." */
export const isBackchannel = (t: string): boolean => t.length <= 40 && BACKCHANNEL.test(t.trim());
