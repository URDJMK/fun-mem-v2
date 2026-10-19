import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { linkKnownTitles } from '../src/drafts';
import { KoreanGroundingGate } from '../src/drafts-gate';
import { checkGrounding, checkTitle, type ViolationKind } from '../src/grounding-ko';

/**
 * The grounding check, held to what a reviewer and a behaviour tester found it letting
 * through (each `rejects` below was ACCEPTED before), and to what it must keep accepting:
 * 46 real model proposals recorded from four interviews, and the tidy rewrites a careful
 * model makes. A check that rejects a faithful rewrite is safe but makes the notes worse;
 * one that accepts a wrong one puts a false sentence in a dead person's record.
 */

const gate = new KoreanGroundingGate();
const kinds = (src: string, body: string): ViolationKind[] =>
  checkGrounding(src, body).violations.map((v) => v.kind);
const rejects = (src: string, body: string, kind?: ViolationKind) => {
  const r = checkGrounding(src, body);
  expect(r.violations.length, `should be rejected: ${body}`).toBeGreaterThan(0);
  if (kind) expect(r.violations.map((v) => v.kind)).toContain(kind);
  // and the gate, which is what the import and /drafts actually use, agrees
  expect(
    gate.check(
      { title: '', type: 'event', occurred: null, body, notes: [] },
      { text: src, media: null, titles: [] },
    ).accepted,
  ).toBeNull();
};
const accepts = (src: string, body: string) => {
  const r = checkGrounding(src, body);
  expect(r.violations, `should be accepted: ${body}`).toEqual([]);
};

describe('meaning reversal: a negation or a hedge is kept, both ways', () => {
  it('a dropped "not", "never", "n\'t" or "without" is caught (deleting a word adds none)', () => {
    rejects(
      'My father did not go to the war. He stayed on the farm with my mother.',
      'My father did go to the war. He stayed on the farm with my mother.',
      'negation',
    );
    rejects(
      "My father didn't go to the war. He stayed on the farm.",
      'My father did go to the war. He stayed on the farm.',
      'negation',
    );
    rejects(
      "I can't swim, I never learned. My brother was the swimmer.",
      'I can swim, I learned. My brother was the swimmer.',
      'negation',
    );
    rejects(
      "He wasn't there when she died. He was at sea on the fishing boat.",
      'He was there when she died. He was at sea on the fishing boat.',
      'negation',
    );
    rejects(
      'I never saw my father cry. Not once in all those years on the farm.',
      'I saw my father cry. Once in all those years on the farm.',
      'negation',
    );
    rejects('I cannot remember his face.', 'I can remember his face.', 'negation');
    rejects(
      'He left without saying goodbye to anyone.',
      'He left with saying goodbye to anyone.',
      'negation',
    );
  });

  it('an added negation, and one moved to another sentence, are caught', () => {
    rejects(
      'My father talked about the war every night at dinner.',
      'My father did not talk about the war at dinner.',
      'negation',
    );
    rejects(
      'I did not see him that year. He called every Sunday.',
      'I saw him that year. He did not call every Sunday.',
      'negation',
    );
  });

  it('a "No." answer cannot come back as "Yes."', () => {
    rejects('No. We did not leave.', 'Yes. We did not leave.');
  });

  it('a hedge or a wish is kept: "I think", "maybe", "about forty", "almost", "tried to"', () => {
    rejects(
      'I think it was 1946, maybe, when we moved to the city.',
      'It was 1946 when we moved to the city.',
      'hedge',
    );
    rejects('We had about forty cows on the farm.', 'We had forty cows on the farm.', 'hedge');
    rejects(
      'He almost died in the war, in the winter of 1944.',
      'He died in the war, in the winter of 1944.',
      'hedge',
    );
    rejects(
      'I tried to save him but the water was too cold.',
      'I saved him but the water was too cold.',
      'hedge',
    );
  });

  it('Korean: 없었 -> 있었, a dropped 안 / 못 / 아니 / 마라 / 몰랐, and 아마·쯤·인가·뻔·싶 are caught', () => {
    rejects(
      '그때는 집에 돈이 정말 하나도 없었어요. 아버지가 많이 힘드셨어요.',
      '그때는 집에 돈이 정말 많이 있었어요. 아버지가 힘드셨어요.',
      'negation',
    );
    rejects(
      '아버지는 평생 술을 안 드셨어요. 담배도 안 피우셨어요.',
      '아버지는 평생 술을 드셨어요. 담배도 피우셨어요.',
      'negation',
    );
    rejects(
      '그때는 집이 가난해서 학교에 못 갔어요. 대신 동생들을 돌봤어요.',
      '그때는 집이 가난해서 학교에 갔어요. 대신 동생들을 돌봤어요.',
      'negation',
    );
    rejects(
      '그 사람은 우리 아버지가 아니었어요. 외삼촌이었어요.',
      '그 사람은 우리 아버지였어요. 외삼촌이었어요.',
      'negation',
    );
    rejects(
      '밥 잘 챙겨 먹고, 사람한테 모질게 하지 마라.',
      '밥 잘 챙겨 먹고, 사람한테 모질게 해라.',
      'negation',
    );
    rejects(
      '그게 마지막이 될 줄 몰랐어요. 지금도 그게 마음에 걸려요.',
      '그게 마지막이 되었어요. 지금도 그게 마음에 걸려요.',
      'negation',
    );
    rejects(
      '아마 1946년쯤이었을 거예요. 우리가 서울로 이사 간 게요.',
      '1946년에 우리가 서울로 이사 갔어요.',
      'hedge',
    );
    rejects('막내딸은 1966년인가 잘 기억이 안 나요.', '막내딸은 1966년에 낳았어요.', 'hedge');
    rejects(
      '전쟁 때 오빠가 죽을 뻔했어요. 다리를 크게 다쳤어요.',
      '전쟁 때 오빠가 죽었어요. 다리를 크게 다쳤어요.',
      'hedge',
    );
    rejects(
      '나는 서울에 있는 대학에 가고 싶었어요. 그런데 집안 형편이 어려웠어요.',
      '나는 서울에 있는 대학에 갔어요. 그런데 집안 형편이 어려웠어요.',
      'hedge',
    );
  });

  it("the same negation written another way is fine: 안 갔어요 / 가지 않았어요, didn't / did not", () => {
    accepts(
      '그때는 학교에 안 갔어요. 집에서 동생을 봤어요.',
      '그때는 학교에 가지 않았어요. 집에서 동생을 봤어요.',
    );
    accepts(
      '그때는 학교에 못 갔어요. 집에서 동생을 봤어요.',
      '그때는 학교에 가지 못했어요. 집에서 동생을 봤어요.',
    );
    accepts(
      "He didn't talk much, and he wasn't one to complain.",
      'He did not talk much, and he was not one to complain.',
    );
    accepts('No one said anything about it.', 'Nobody said anything about it.');
    accepts('No, he never talked about the war.', 'He never talked about the war.');
  });
});

describe('the wrong person: a relative, a gendered noun or a pronoun is never added or swapped', () => {
  it('she -> he, her -> his, woman -> man, daughter -> son', () => {
    rejects('She cried all night.', 'He cried all night.', 'person');
    rejects(
      'My mother ran the store. She kept the books and she hired the clerks.',
      'My mother ran the store. He kept the books and he hired the clerks.',
      'person',
    );
    rejects(
      'He gave her the watch. This was in the spring.',
      'He gave his the watch. This was in the spring.',
      'person',
    );
    rejects('A woman came to the door.', 'A man came to the door.', 'person');
    rejects(
      'My daughter came home. For some reason she was crying.',
      'My son came home. For some reason she was crying.',
      'person',
    );
  });

  it("he and she swapped inside one sentence, when both appear elsewhere (the tester's 45-minute case)", () => {
    const src =
      'My father repaired boats and he did not talk much. My mother sold fish at the market and came home after sunset every single day. I had four brothers and sisters but my youngest sister died of a fever when she was three.';
    rejects(
      src,
      src.replace('and he did not', 'and she did not').replace('when she was', 'when he was'),
      'person',
    );
  });

  it('a relative is not the relative it contains: grandmother, stepfather, godmother, great-grandfather, mother-in-law', () => {
    rejects(
      'My grandmother raised me after the war, in the little house by the river.',
      'My mother raised me after the war, in the little house by the river.',
      'person',
    );
    rejects(
      'My stepfather worked at the mill and he taught me to fish.',
      'My father worked at the mill and he taught me to fish.',
      'person',
    );
    rejects(
      'My godmother sent me a letter every birthday until she died.',
      'My mother sent me a letter every birthday until she died.',
      'person',
    );
    rejects(
      'My great-grandfather came over on a boat from Ireland with nothing.',
      'My grandfather came over on a boat from Ireland with nothing.',
      'person',
    );
    rejects(
      'My mother-in-law lived with us for ten years.',
      'My mother lived with us for ten years.',
      'person',
    );
    rejects('My brother carried me on his back.', 'My other carried me on his back.');
  });

  it('Korean: 외할머니 != 할머니, 큰아버지 != 아버지, 시어머니 != 어머니, 새어머니 != 어머니', () => {
    rejects(
      '외할머니가 저를 키워 주셨어요. 매일 국수를 삶아 주셨어요.',
      '할머니가 저를 키워 주셨어요. 매일 국수를 삶아 주셨어요.',
      'person',
    );
    rejects(
      '큰아버지가 부산 항구에서 배를 고치셨어요. 손이 정말 크셨어요.',
      '아버지가 부산 항구에서 배를 고치셨어요. 손이 정말 크셨어요.',
      'person',
    );
    rejects(
      '시어머니가 시장에서 생선을 파셨어요. 새벽 네 시에 나가셨어요.',
      '어머니가 시장에서 생선을 파셨어요. 새벽 네 시에 나가셨어요.',
      'person',
    );
    rejects(
      '새어머니가 시장에서 생선을 파셨어요. 새벽 네 시에 나가셨어요.',
      '어머니가 시장에서 생선을 파셨어요. 새벽 네 시에 나가셨어요.',
      'person',
    );
  });

  it('a pronoun for a person who IS named there is fine, and so is leaving one out', () => {
    accepts(
      'My father repaired boats and had big hands.',
      'My father repaired boats. He had big hands.',
    );
    accepts(
      'My mother ran the store. She kept the books.',
      'My mother ran the store and kept the books.',
    );
    accepts(
      'My mother sold fish. My mother left before dawn.',
      'My mother sold fish. She left before dawn.',
    );
    // the same person under a household word is reported, not refused
    const r = checkGrounding(
      '엄마가 김치 담그실 때 나도 옆에서 배추 씻었어요.',
      '어머니가 김치를 담그실 때 나도 옆에서 배추를 씻었어요.',
    );
    expect(r.violations).toEqual([]);
    expect(r.swapped).toContain('어머니가');
  });
});

describe('a word is a word: never licensed by one it starts with or sits inside', () => {
  it('"he" does not license "hero", nor "no" November, "me" medal, "it" Italy, "at" attacked', () => {
    rejects(
      'He went to the war and he came back thin and quiet.',
      'He went to the war and he came back a hero.',
      'invented',
    );
    rejects(
      'No, we left the farm in the spring and went to the city by train.',
      'No, we left the farm in November and went to the city by train.',
      'invented',
    );
    rejects(
      'He came back from the war with nothing for me.',
      'He came back from the war with a medal for me.',
      'invented',
    );
    rejects(
      'It was a long trip in a boat to get there.',
      'It was a long trip in a boat to get to Italy.',
      'invented',
    );
    rejects(
      'He was at the store when it happened to him.',
      'He was attacked at the store when it happened.',
      'invented',
    );
    rejects('My mother had a sister in Ohio.', 'My other mother had a sister in Ohio.', 'invented');
    expect(checkGrounding('He went to the war.', 'He went to the war, a hero.').ungrounded).toEqual(
      ['hero'],
    );
  });

  it('a number matches only the same number: 19 is not 1952, 10 is not 100, 120 is not 20 or 12', () => {
    rejects(
      'I was 19 when I married your grandfather in the church.',
      'I was 19 in 1952 when I married your grandfather in the church.',
      'number',
    );
    rejects(
      'We had 10 cows in the barn on the farm.',
      'We had 100 cows in the barn on the farm.',
      'number',
    );
    rejects(
      'We had 120 cows on the farm in 1952.',
      'We had 20 cows on the farm in 1952.',
      'number',
    );
    rejects(
      'We had 120 cows on the farm in 1952.',
      'We had 12 cows on the farm in 1952.',
      'number',
    );
    rejects(
      'In nineteen sixty-six he spilled gravy. We married in nineteen sixty-seven.',
      'In nineteen seventy-six he spilled gravy. We married in nineteen sixty-seven.',
      'number',
    );
    rejects(
      'My father was forty and my brother was four.',
      'My father was fourteen and my brother was four.',
      'number',
    );
    rejects(
      '나는 1946년에 부산에서 태어났어요. 바닷가 집이었어요.',
      '나는 1947년에 부산에서 태어났어요. 바닷가 집이었어요.',
      'number',
    );
  });

  it('a number said once is not written twice: "she was three" -> "four" when "four brothers" is there', () => {
    const src =
      'I had four brothers and sisters but my youngest sister died of a fever when she was three.';
    rejects(src, src.replace('was three', 'was four'), 'number');
  });

  it('names match exactly, accents folded: Ann != Annie, Zoë != Zoey, Tom != Tomas, José != Josh', () => {
    rejects(
      'My friend Ann came over every Sunday for dinner.',
      'My friend Annie came over every Sunday for dinner.',
      'invented',
    );
    rejects(
      'My cousin Zoë lived with us that year.',
      'My cousin Zoey lived with us that year.',
      'invented',
    );
    rejects(
      'Tom worked at the mill with my father.',
      'Tomas worked at the mill with my father.',
      'invented',
    );
    rejects(
      'My uncle José drove the truck to the market.',
      'My uncle Josh drove the truck to the market.',
      'invented',
    );
    accepts(
      'My uncle José drove the truck to the market.',
      'My uncle Jose drove the truck to the market.',
    );
  });

  it('Korean: 부산 does not license 부산대 (a particle is a closed list, 대 is not one)', () => {
    rejects(
      '나는 부산에서 학교를 다녔어요. 친구들이 많았어요.',
      '나는 부산대에서 학교를 다녔어요. 친구들이 많았어요.',
      'invented',
    );
  });

  it('a word hidden in a link is still a word (the retry is told the real reason)', () => {
    const r = checkGrounding(
      'My father repaired boats in the harbour.',
      'My father was a [[captain]] who repaired boats in the harbour.',
    );
    expect(r.ungrounded).toContain('captain');
    expect(
      checkGrounding('My father repaired boats.', 'My [[Dad|father]] repaired boats.').violations,
    ).toEqual([]);
  });
});

describe('every sentence from one place: a long source is not a bag of words', () => {
  // ~3,000 characters of one person's answers: every word of the fabrications below is in here
  const answers = [
    'My husband worked at the shipyard for thirty years and he came home tired every night.',
    'We were poor, but we were happy then, and the children never went hungry.',
    'My brother went to the war in nineteen fifty and he came back thin and quiet.',
    'The doctor came to the house when my mother was sick, and he said she would be fine.',
    'I was married at nineteen, and I did not really know what marriage was.',
    'He hit the nail so hard that the board split in two, and we all laughed.',
    'She had a garden behind the house with peppers and beans and a little apple tree.',
    'My father was a kind man, and he loved the sea more than anything.',
    'We moved to Seoul later, before the factory closed and there was no more work.',
    'I miss the old house every day, the smell of the stove and the sound of the rain.',
    'He drank tea in the morning and he never complained about the work.',
    'My real father died when I was small, and my uncle raised me like his own.',
  ];
  const src = Array.from({ length: 3 }, () => answers.join(' ')).join('\n');
  const fabricated = [
    'My husband beat me.',
    'He was not my real father.',
    'The doctor was wrong.',
    'I was married before.',
    'My brother died in the war.',
    'He hit me once.',
    'She had a secret.',
    'He drank too much.',
  ];
  it.each(fabricated)('appending "%s" is rejected', (sentence) => {
    expect(kinds(src, `${src} ${sentence}`)).toContain('unsupported_sentence');
  });
  it('and the source itself, rewritten as one copy, still passes', () => {
    accepts(src, src);
  });
});

describe('nothing the person said is left out', () => {
  it('one sentence dropped from a long answer, and the date is not taken from it', () => {
    rejects(
      'My father repaired boats in the harbour every day of his life, and my mother sold fish at the market. My brother Tom drowned in 1952.',
      'My father repaired boats in the harbour every day of his life, and my mother sold fish at the market.',
      'dropped',
    );
  });

  it('a whole turn dropped from a memory of several turns', () => {
    rejects(
      'My father repaired boats in the harbour every day of his life, and my mother sold fish at the market by the pier.\nHe was in prison for two years before I was born.',
      'My father repaired boats in the harbour every day of his life, and my mother sold fish at the market by the pier.',
      'dropped',
    );
  });

  it('a year in a short last sentence ("That was nineteen sixty-one.") is not tidied away', () => {
    rejects(
      'My first job was at the shipyard in Ulsan, I was seventeen. They gave me a hammer and a bucket and said go hit the rust. That was nineteen sixty-one.',
      'My first job was at the shipyard in Ulsan, I was seventeen. They gave me a hammer and a bucket and said go hit the rust.',
      'dropped',
    );
  });

  it('a name said mid-sentence is kept', () => {
    rejects(
      'I lost two friends in one week, Eddie Marks and a boy from Ohio whose name I never learned, and I think about them every year.',
      'I lost two friends in one week, and a boy from Ohio whose name I never learned, and I think about them every year.',
      'dropped',
    );
  });

  it('Korean: a dropped sentence', () => {
    rejects(
      '아버지는 평생 항구에서 배를 고치셨고 어머니는 시장에서 생선을 파셨어요. 오빠는 1952년에 바다에서 죽었어요.',
      '아버지는 평생 항구에서 배를 고치셨고 어머니는 시장에서 생선을 파셨어요.',
      'dropped',
    );
  });
});

describe('what a careful tidy rewrite does still passes', () => {
  it.each([
    [
      'fillers out, spoken years in digits',
      'So at a church supper in nineteen sixty-six, he spilled gravy on my sleeve, and I said it was only a sleeve. We got married in June of nineteen sixty-seven, in the spring.',
      'At a church supper in 1966, he spilled gravy on my sleeve, and I said it was only a sleeve. We got married in June of 1967, in the spring.',
    ],
    [
      'a leading "Yes." dropped',
      'Yes. In nineteen eighty-one I opened a little alteration shop with the sewing machine.',
      'In 1981 I opened a little alteration shop with the sewing machine.',
    ],
    [
      'a repeated sentence once',
      'He was a good man. He was a good man. Everybody in the town said so.',
      'He was a good man. Everybody in the town said so.',
    ],
    [
      'two sentences joined',
      'We moved to Daegu. Minho had found work at a printing house there.',
      'We moved to Daegu, and Minho had found work at a printing house there.',
    ],
    [
      'clauses reordered',
      'On Sundays he took me to the pier and we watched the ships.',
      'He took me to the pier on Sundays, and we watched the ships.',
    ],
    [
      'spoken numbers in digits',
      'Oh, did I say forty-six? The papers say forty-seven. We had three children.',
      'Did I say 46? The papers say 47. We had 3 children.',
    ],
    [
      'a false start out',
      'I was, we were living in Daegu then, above the tailor shop.',
      'We were living in Daegu then, above the tailor shop.',
    ],
    [
      'punctuation where there was none',
      'my father repaired boats he had big hands really big',
      'My father repaired boats. He had big hands, really big.',
    ],
    [
      'two turns as one memory',
      'My father repaired boats.\nHe had big hands, really big, and he did not talk much at all.',
      'My father repaired boats. He had big hands, really big, and he did not talk much at all.',
    ],
    [
      'ko: 하셨다 -> 하셨습니다',
      '아버지는 배를 고치는 일을 하셨다. 손이 정말 크셨다.',
      '아버지는 배를 고치는 일을 하셨습니다. 손이 정말 크셨습니다.',
    ],
    [
      'ko: spacing joined',
      '그 일은 안 했어요. 대신 밭에 나갔어요.',
      '그 일은 안했어요. 대신 밭에 나갔어요.',
    ],
    [
      'ko: spacing split',
      '밥상 차려주심. 아무 말도 안 하셨음.',
      '밥상을 차려 주셨다. 아무 말도 안 하셨다.',
    ],
    [
      'ko: fillers out',
      '음, 그니까 아버지가 배를 고치셨어요. 손이 크셨어요.',
      '아버지가 배를 고치셨어요. 손이 크셨어요.',
    ],
    [
      'ko: a particle added',
      '나 부산 살았어요. 바닷가 집이었어요.',
      '나는 부산에서 살았어요. 바닷가 집이었어요.',
    ],
    [
      'ko: sentences joined with 고',
      '아버지는 배를 고치셨어요. 손이 크셨어요.',
      '아버지는 배를 고치셨고 손이 크셨어요.',
    ],
    [
      'ko: a stammer out',
      '근데 한 선생님이, 한 선생님이 내 글씨가 제일 예쁘다고 하셨어요.',
      '한 선생님이 내 글씨가 제일 예쁘다고 하셨어요.',
    ],
    [
      'ko: 반말 -> 존댓말',
      '부산에서 태어났지. 바닷가 집이었어.',
      '부산에서 태어났어요. 바닷가 집이었어요.',
    ],
  ])('%s', (_name, src, body) => accepts(src, body));
});

describe('the golden set: 46 real model proposals from four interviews', () => {
  const golden = JSON.parse(
    readFileSync(new URL('./fixtures/grounding-golden.json', import.meta.url), 'utf8'),
  ) as Array<{ interview: string; source: string; title: string; body: string }>;
  it('are all still accepted by the gate', () => {
    expect(golden).toHaveLength(46);
    const refused = golden.filter(
      (p) =>
        gate.check(
          { title: p.title, type: 'event', occurred: null, body: p.body, notes: [] },
          { text: p.source, media: null, titles: [] },
        ).accepted === null,
    );
    expect(refused.map((p) => `${p.interview}: ${p.title}`)).toEqual([]);
  });
});

describe('titles', () => {
  it('a title with a word, a number or a person the speaker never said fails; one built from their words passes', () => {
    const src =
      'My father repaired boats in the harbour, and every Sunday he took me down to the pier.';
    expect(checkTitle(src, 'Sundays at the pier').violations).toEqual([]);
    expect(checkTitle(src, 'Sundays at the pier').ungrounded).toEqual([]);
    expect(checkTitle(src, "Dad's years in prison").ungrounded.length).toBeGreaterThan(0);
    expect(checkTitle(src, 'The pier in 1950').ungrounded).toContain('1950');
    expect(checkTitle(src, 'My mother at the pier').violations.map((v) => v.kind)).toContain(
      'person',
    );
  });
});

describe('Korean links never land inside a word', () => {
  it('큰[[아버지]] and 외[[할머니]] are not made; 우리 [[할머니]]가 is', () => {
    expect(
      linkKnownTitles('큰아버지가 배를 고치셨다. 아버지는 집에 계셨다.', ['아버지']).body,
    ).toBe('큰아버지가 배를 고치셨다. [[아버지]]는 집에 계셨다.');
    expect(linkKnownTitles('외할머니가 국수를 삶아 주셨다.', ['할머니']).linked).toEqual([]);
    expect(linkKnownTitles('우리 할머니가 국수를 삶아 주셨다.', ['할머니']).body).toBe(
      '우리 [[할머니]]가 국수를 삶아 주셨다.',
    );
  });
});

describe('the report', () => {
  it('names each violation by kind, keeps listing the unsupported words, and is empty when clean', () => {
    const r = checkGrounding('He did not talk much.', 'He did talk much, a captain.');
    expect(r.violations.map((v) => v.kind)).toEqual(
      expect.arrayContaining(['invented', 'negation']),
    );
    expect(r.ungrounded).toEqual(['captain']);
    for (const v of r.violations) expect(typeof v.detail).toBe('string');
    expect(checkGrounding('He did not talk much.', 'He did not talk much.')).toMatchObject({
      ungrounded: [],
      violations: [],
      retention: 1,
    });
  });
});

describe('time: linear, and bounded on hostile text', () => {
  const ms = (f: () => void): number => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  it('a 6,000-character Korean window takes well under 500 ms', () => {
    const ko =
      '어머니는 새벽마다 시장에 나가서 생선을 파셨어요. 정말 부지런하셨어요. 아버지는 항구에서 배를 고치셨고 손이 크셨어요. ';
    const big = ko.repeat(Math.ceil(6000 / ko.length)).slice(0, 6000);
    const varied = Array.from(
      { length: 200 },
      (_, i) => `${i}년에 우리 어머니가 ${i}번째 시장에서 생선 ${i}마리를 파셨어요.`,
    )
      .join(' ')
      .slice(0, 6000);
    expect(ms(() => checkGrounding(big, big))).toBeLessThan(500);
    expect(ms(() => checkGrounding(varied, varied))).toBeLessThan(500);
  });
  it.each([
    ['2,500 Hangul characters without a space', '다'.repeat(2500)],
    ['400,000 characters of one unbroken Latin word', 'a'.repeat(400_000)],
    ['100,000 Hangul syllables in one word', '가나다라마'.repeat(20_000)],
    [
      '5,000 one-word sentences',
      Array.from({ length: 5000 }, (_, i) => `Word${i % 50}.`).join(' '),
    ],
    ['400,000 characters of punctuation', '.,!?;:'.repeat(66_667)],
    ['100,000 abbreviation-like "x."', 'x. '.repeat(100_000)],
    [
      '5,000 identical sentences',
      Array.from({ length: 5000 }, () => 'the cat sat on the mat with the dog.').join(' '),
    ],
    ['50,000 negations', Array.from({ length: 50_000 }, (_, i) => `not w${i % 997}`).join(' ')],
    [
      '50,000 Korean negations',
      Array.from({ length: 50_000 }, (_, i) => `안 갔${i % 997}`).join(' '),
    ],
  ])('%s: under 3 s', (_name, text) => {
    expect(ms(() => checkGrounding(text, text))).toBeLessThan(3000);
  });
  it('common words that never occur together, 5,000 x 2,000 sentences: under 3 s, and refused', () => {
    const src = Array.from({ length: 5000 }, (_, i) =>
      i % 2 ? 'cat dog bird fish.' : 'rat mat hat bat.',
    ).join(' ');
    const body = Array.from({ length: 2000 }, () => 'cat rat fish hat dog bat.').join(' ');
    let r: ReturnType<typeof checkGrounding> | null = null;
    expect(ms(() => (r = checkGrounding(src, body)))).toBeLessThan(3000);
    expect(r!.violations.map((v) => v.kind)).toContain('unsupported_sentence');
  });
});
