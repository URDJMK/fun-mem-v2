import {
  countryCode,
  extractWikilinks,
  normalizeTitle,
  parseProfileInput,
  readProfile,
  type ProfileFields,
} from '@funmem/core';
import { DEMO_NAME } from './demo';

/**
 * The API, played in the browser for demo mode (lib/demo.ts). It keeps the same shapes as the
 * real routes (server/api/src, docs/ingest/api.md) so the pages cannot tell, and it is far
 * simpler: Ask quotes the sentences that share the question's words, and an import keeps each
 * of the teller's longer turns as one memory in their own words. Data lives in localStorage.
 */

interface DemoNote {
  id: string;
  title: string;
  type: string;
  body: string;
  occurred: string | null;
  createdAt: string;
  revised: string | null;
  /** a person's profile (PRD D13) */
  profile?: ProfileFields;
}

interface DemoRun {
  id: string;
  createdAt: string;
  source: string | null;
  noteIds: string[];
  undone: boolean;
}

interface DemoArchive {
  id: string;
  subjectName: string;
  /** absent in sample data saved before projects had kinds: personal */
  kind?: 'personal' | 'family';
  /** absent in sample data saved before it was shown: US */
  jurisdiction?: string;
  role: string;
  /** a personal project's protagonist (the server keeps it on their person note) */
  profile?: ProfileFields;
  notes: DemoNote[];
  runs: DemoRun[];
  /** the other people in it; the demo person is always in, with `role` */
  members?: Array<{ userId: string; name: string; role: string; joinedAt: string }>;
  invites?: DemoInvite[];
}

interface DemoInvite {
  id: string;
  /** an account found by search (one of DEMO_PEOPLE), or an email with no account yet */
  userId?: string;
  email?: string;
  role: string;
  createdAt: string;
  expiresAt: string;
  answeredAt?: string;
  revokedAt?: string;
}

const DEMO_USER = 'demo-user';

/** other people on Firepit, made up, for search to find */
const DEMO_PEOPLE = [
  { userId: 'demo-carol', name: 'Carol Marsh', email: 'carol.marsh@example.com' },
  { userId: 'demo-june', name: 'June Okafor', email: 'june.okafor@example.com' },
  { userId: 'demo-sam', name: 'Sam Marsh', email: 'sammarsh@example.com' },
  { userId: 'demo-ruth', name: 'Ruth Lindqvist', email: 'ruth.l@example.com' },
  { userId: 'demo-theo2', name: 'Theo Marsh Jr.', email: 'theo.junior@example.com' },
];
const mask = (email: string) => {
  const at = email.indexOf('@');
  return `${email.slice(0, Math.min(3, at))}•••${email.slice(at)}`;
};
// link invitations saved by an older demo have neither, and are left out
const isOpen = (i: DemoInvite) =>
  !!(i.userId || i.email) && !i.answeredAt && !i.revokedAt && new Date(i.expiresAt) > new Date();

/** invitations to the demo person, from projects they are not in yet */
interface DemoInboxItem {
  id: string;
  role: string;
  createdAt: string;
  projectName: string;
  kind: 'personal' | 'family';
  invitedBy: string;
}
const INBOX = 'firepit-demo-inbox';
const seedInbox = (): DemoInboxItem[] => [
  {
    id: 'demo-invite-okafor',
    role: 'contributor',
    createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    projectName: 'The Okafor family',
    kind: 'family',
    invitedBy: 'June Okafor',
  },
];
let inbox: DemoInboxItem[] | null = null;
function myInbox(): DemoInboxItem[] {
  if (inbox) return inbox;
  try {
    const raw = window.localStorage.getItem(INBOX);
    if (raw) inbox = JSON.parse(raw) as DemoInboxItem[];
  } catch {
    /* the sample invitation instead */
  }
  inbox ??= seedInbox();
  return inbox;
}
function persistInbox() {
  try {
    window.localStorage.setItem(INBOX, JSON.stringify(inbox));
  } catch {
    /* lasts as long as the page */
  }
}

interface DemoJob {
  id: string;
  archiveId: string;
  polls: number;
  source: string | null;
  memories: Array<
    Record<string, unknown> & { title: string; body: string; occurred: string | null }
  >;
  saved?: Array<{ id: string; title: string; index: number }>;
  runId?: string;
  /** "Find people, places and things": the demo has no AI, so it says so */
  graph?: boolean;
}

const STORE = 'firepit-demo-data';
const NELL = '00000000-0000-4000-8000-00000000a001';

export class DemoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`demo ${status}`);
  }
}

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function note(
  title: string,
  type: string,
  occurred: string | null,
  body: string,
  daysAgo: number,
): DemoNote {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return { id: uid(), title, type, body, occurred, createdAt: at, revised: at };
}

function seed(): DemoArchive[] {
  const told = (source: string) => `> From “${source}” · told by Grandma Nell`;
  const notes = [
    note(
      'The board lit up like a Christmas tree',
      'event',
      '1959',
      `In the spring of 1959 Nell took a job as a switchboard operator at the telephone exchange. She was twenty-one.\n\n“You sat on a stool with the headset on, and the board was lit up like a Christmas tree. [[Mrs. Harju]] walked behind us the whole shift.”\n\nShe sat next to [[Dorothy Peltier]], who became a lifelong friend.\n\n${told('Her twenties in Duluth')}\n> ⚠ May disagree with [[Leaving the exchange]] · 18 Oct 2026 · Aunt Carol: that note says “Mom kept working nights until I was born in 1963.”`,
      2,
    ),
    note(
      'The dance at the Pavilion',
      'event',
      '~1959',
      `“There was a band from Minneapolis, and I wore my sister’s blue dress.” It was the first time she saw [[Grandpa Walter]].\n\n${told('Her twenties in Duluth')}`,
      3,
    ),
    note(
      'Leaving the exchange',
      'event',
      '1963',
      'Mom kept working nights until I was born in 1963. — Aunt Carol',
      4,
    ),
    note(
      'Summers at the bait shop',
      'period',
      '~1946',
      `“[[Uncle Joe]] let us take the rowboat out if we brought back a bucket of perch.” The shop was out on [[Park Point]], and it smelled of minnows and Juicy Fruit.\n\n${told('The lake house summers')}`,
      6,
    ),
    note(
      'Growing up on Garfield Avenue',
      'period',
      '1942',
      `A narrow house with a green door, two blocks from the streetcar. Her mother, [[Agnes]], kept chickens in the yard.\n\n${told('Her whole life — a first chat')}`,
      9,
    ),
    note(
      'Uncle Joe',
      'person',
      null,
      'Her mother’s younger brother. Ran a bait shop on [[Park Point]] in the 1940s, and moved to [[Seattle]] in the early 1950s.',
      6,
    ),
    note('Grandpa Walter', 'person', null, 'Her husband. They married in 1961.', 3),
    note(
      'Dorothy Peltier',
      'person',
      null,
      'Sat next to Nell at the exchange. A lifelong friend.',
      2,
    ),
    note('Mrs. Harju', 'person', null, 'The supervisor at the telephone exchange.', 2),
    note('Agnes', 'person', null, 'Nell’s mother. Uncle Joe was her baby brother.', 9),
    note(
      'Park Point',
      'place',
      null,
      'The long sandbar in Duluth where Uncle Joe kept his bait shop.',
      6,
    ),
    note('Seattle', 'place', null, 'Where Uncle Joe moved after he left Duluth.', 6),
  ];
  const byTitle = (t: string) => notes.find((n) => n.title === t)!.id;
  return [
    {
      id: NELL,
      subjectName: 'Grandma Nell',
      role: 'owner',
      notes,
      runs: [
        {
          id: uid(),
          createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          source: 'Her twenties in Duluth',
          noteIds: [
            byTitle('The board lit up like a Christmas tree'),
            byTitle('The dance at the Pavilion'),
          ],
          undone: false,
        },
        {
          id: uid(),
          createdAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
          source: 'The lake house summers',
          noteIds: [byTitle('Summers at the bait shop')],
          undone: false,
        },
        {
          id: uid(),
          createdAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
          source: 'Her whole life — a first chat',
          noteIds: [byTitle('Growing up on Garfield Avenue')],
          undone: false,
        },
      ],
    },
    { id: uid(), subjectName: 'Grandpa Walter', role: 'contributor', notes: [], runs: [] },
  ].map((a, i) =>
    // Grandma Nell's project has Aunt Carol in it too, to show what the Members page lists
    i === 0
      ? {
          ...a,
          members: [
            {
              userId: 'demo-carol',
              name: 'Carol Marsh',
              role: 'contributor',
              joinedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
            },
          ],
        }
      : a,
  );
}

let data: DemoArchive[] | null = null;
const jobs = new Map<string, DemoJob>();

function db(): DemoArchive[] {
  if (data) return data;
  try {
    const raw = window.localStorage.getItem(STORE);
    if (raw) data = JSON.parse(raw) as DemoArchive[];
  } catch {
    /* a fresh sample archive instead */
  }
  data ??= seed();
  return data;
}

function persist() {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(data));
  } catch {
    /* the change lasts as long as the page */
  }
}

/** Throw away every change and start again from the sample archive. */
export function resetDemo() {
  data = seed();
  persist();
  inbox = seedInbox();
  persistInbox();
}

const ENTITY_TYPE: Record<string, 'person' | 'place' | 'thing' | undefined> = {
  person: 'person',
  place: 'place',
  object: 'thing',
};

/** "[[Walter|Dad]]" → "Dad" */
const plainLabel = (raw: string) => {
  const l = extractWikilinks(raw)[0];
  return (l?.alias ?? l?.target ?? raw).trim();
};
const plainLinkText = (text: string) =>
  text.replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, t: string, s?: string) =>
    (s ?? t).trim(),
  );

/** the server's GET /graph, from the demo's notes: the same shape, same-story lines only */
function demoGraph(a: DemoArchive, around?: string) {
  const ents = a.notes.filter((n) => ENTITY_TYPE[n.type]);
  const subject = ents.find(
    (n) => n.type === 'person' && normalizeTitle(n.title) === normalizeTitle(a.subjectName),
  );
  const storiesOf = new Map<string, Set<string>>();
  const inStory = new Map<string, Set<string>>();
  for (const l of links(a)) {
    if (!ENTITY_TYPE[l.to.type] || ENTITY_TYPE[l.from.type]) continue;
    storiesOf.set(l.to.id, (storiesOf.get(l.to.id) ?? new Set()).add(l.from.id));
    inStory.set(l.from.id, (inStory.get(l.from.id) ?? new Set()).add(l.to.id));
  }
  const together = new Map<string, { a: string; b: string; stories: number }>();
  for (const ids of inStory.values()) {
    const list = [...ids].filter((x) => x !== subject?.id).sort();
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const k = `${list[i]}:${list[j]}`;
        const t = together.get(k) ?? { a: list[i]!, b: list[j]!, stories: 0 };
        t.stories++;
        together.set(k, t);
      }
  }
  let nodes = ents.map((n) => ({
    id: n.id,
    name: n.title,
    type: ENTITY_TYPE[n.type]!,
    stories: storiesOf.get(n.id)?.size ?? 0,
    subject: n.id === subject?.id,
    noteId: n.id,
  }));
  let lines = [...together.values()];
  if (around) {
    lines = lines.filter((l) => l.a === around || l.b === around);
    const near = new Set([around, ...lines.flatMap((l) => [l.a, l.b])]);
    nodes = nodes.filter((n) => near.has(n.id));
  }
  nodes.sort(
    (x, y) =>
      Number(y.subject) - Number(x.subject) ||
      y.stories - x.stories ||
      x.name.localeCompare(y.name),
  );
  return { nodes, told: [], together: lines, more: 0 };
}

const summary = (n: DemoNote) => ({
  id: n.id,
  title: n.title,
  type: n.type,
  occurred: n.occurred,
  revised: n.revised,
});

function archiveOf(id: string): DemoArchive {
  const a = db().find((x) => x.id.toLowerCase() === id.toLowerCase());
  if (!a) throw new DemoError(404, null);
  return a;
}

function noteOf(a: DemoArchive, id: string): DemoNote {
  const n = a.notes.find((x) => x.id === id);
  if (!n) throw new DemoError(404, null);
  return n;
}

const DATE_RE = /^(~?\d{4}(-\d{2}(-\d{2})?)?|unknown)$/;

function checkFields(a: DemoArchive, f: { title?: unknown; occurred?: unknown }, except?: string) {
  const title = typeof f.title === 'string' ? f.title.trim() : '';
  if (!title || /[[\]#^|]/.test(title)) throw new DemoError(400, 'bad_request');
  if (
    f.occurred !== null &&
    f.occurred !== undefined &&
    !(typeof f.occurred === 'string' && DATE_RE.test(f.occurred))
  )
    throw new DemoError(400, 'date');
  const key = normalizeTitle(title);
  if (a.notes.some((n) => n.id !== except && normalizeTitle(n.title) === key))
    throw new DemoError(409, null);
  return title;
}

/** Which notes link to which, resolved by title the way the server resolves them. */
function links(a: DemoArchive): Array<{ from: DemoNote; to: DemoNote; raw: string }> {
  const byTitle = new Map(a.notes.map((n) => [normalizeTitle(n.title), n]));
  const out: Array<{ from: DemoNote; to: DemoNote; raw: string }> = [];
  for (const from of a.notes) {
    for (const l of extractWikilinks(from.body)) {
      const to = l.embed ? undefined : byTitle.get(normalizeTitle(l.target));
      if (to && to.id !== from.id) out.push({ from, to, raw: l.raw });
    }
  }
  return out;
}

function snippet(body: string, raw: string): string {
  const at = Math.max(0, body.indexOf(raw));
  const start = Math.max(0, at - 60);
  const text = body
    .slice(start, at + raw.length + 80)
    .replace(/\s+/g, ' ')
    .trim();
  return (start > 0 ? '…' : '') + text + (at + raw.length + 80 < body.length ? '…' : '');
}

const STOP = new Set(
  'the and was were did does what when where who whom why how with that this from have had for her his she him they them their about into back then there here been your you are not but all any can could would should will just like than very much many some more most other our out over said says say tell told ever after before during'.split(
    ' ',
  ),
);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !STOP.has(w));
}

function ask(a: DemoArchive, question: string) {
  // the person's own name is in every question about them, so it says nothing about which note answers
  const theirs = new Set(words(a.subjectName));
  const want = new Set(words(question).filter((w) => !theirs.has(w)));
  const scored: Array<{ score: number; text: string; noteId: string }> = [];
  for (const n of a.notes) {
    const prose = n.body
      .split('\n')
      .filter((l) => !l.startsWith('>'))
      .join(' ');
    for (const sentence of prose.match(/[^.!?]+[.!?]+["”]?/g) ?? []) {
      const plain = sentence
        .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, t: string, al?: string) => al ?? t)
        .trim();
      const hits =
        words(plain).filter((w) => want.has(w)).length +
        words(n.title).filter((w) => want.has(w)).length;
      if (hits > 0) scored.push({ score: hits, text: plain, noteId: n.id });
    }
  }
  scored.sort((x, y) => y.score - x.score);
  const best = scored.filter((s) => s.score >= Math.max(1, scored[0]?.score ?? 0) - 0).slice(0, 3);
  const relevant = new Set(scored.map((s) => s.noteId)).size;
  if (best.length === 0) {
    return {
      providerVersion: 'demo',
      selfIdentification: null,
      abstained: true,
      reason: 'no_evidence',
      message:
        'There is not enough in the records to answer this. Would you like to ask your family?',
      claims: [],
      evidence: { relevant, fitted: relevant },
    };
  }
  return {
    providerVersion: 'demo',
    selfIdentification: null,
    abstained: false,
    reason: null,
    claims: best.map((b) => ({
      text: b.text,
      kind: 'quote',
      citation: { noteId: b.noteId, anchor: null },
    })),
    sources: [...new Set(best.map((b) => b.noteId))],
    partial: false,
    evidence: { relevant, fitted: relevant },
  };
}

function segmentsOf(
  transcript: string,
): { turns: Array<{ who: string; text: string }>; interviewee?: string } | null {
  try {
    const j = JSON.parse(transcript) as {
      interviewee?: unknown;
      segments?: Array<{ speaker?: unknown; text?: unknown }>;
    };
    if (!Array.isArray(j.segments)) return null;
    const turns: Array<{ who: string; text: string }> = [];
    for (const s of j.segments) {
      const who = String(s.speaker ?? 'Speaker');
      const text = String(s.text ?? '').trim();
      if (!text) continue;
      const last = turns[turns.length - 1];
      if (last?.who === who) last.text += ` ${text}`;
      else turns.push({ who, text });
    }
    return {
      turns,
      ...(typeof j.interviewee === 'string' ? { interviewee: j.interviewee } : {}),
    };
  } catch {
    return null;
  }
}

/** Each of the teller's turns of a sentence or more becomes one memory, in their own words. */
function prepare(transcript: string, teller: string | undefined, source: string | null) {
  const turns: Array<{ who: string; text: string }> = [];
  // a recorded interview arrives as WhisperX-style JSON: its segments are the turns
  const json = transcript.trimStart().startsWith('{') ? segmentsOf(transcript) : null;
  if (json) {
    turns.push(...json.turns);
    teller ??= json.interviewee;
  }
  for (const line of json ? [] : transcript.split('\n')) {
    const m = /^\s*\[?([^:\]]{1,40})\]?\s*:\s*(.+)$/.exec(line);
    if (m) turns.push({ who: m[1]!.trim(), text: m[2]!.trim() });
    else if (line.trim() && turns.length > 0) turns[turns.length - 1]!.text += ` ${line.trim()}`;
  }
  if (turns.length === 0 && transcript.trim())
    turns.push({ who: teller ?? 'Speaker', text: transcript.trim() });
  if (turns.length === 0) throw new DemoError(400, 'empty');
  const chars = new Map<string, number>();
  for (const t of turns) chars.set(t.who, (chars.get(t.who) ?? 0) + t.text.length);
  const named = teller
    ? [...chars.keys()].find((k) => k.toLowerCase() === teller.toLowerCase())
    : undefined;
  const who = named ?? [...chars.entries()].sort((x, y) => y[1] - x[1])[0]![0];
  const name = teller ?? who;
  return turns
    .filter((t) => t.who === who && t.text.length >= 40)
    .map((t, i) => {
      const first = t.text
        .replace(/[“”"]/g, '')
        .split(/[.!?,;]/)[0]!
        .trim()
        .split(/\s+/)
        .slice(0, 8)
        .join(' ');
      const year = /\b(1[89]\d\d|20[0-2]\d)\b/.exec(t.text)?.[1] ?? null;
      return {
        id: `m${i + 1}`,
        title: first || `Memory ${i + 1}`,
        type: 'event',
        occurred: year,
        body: `“${t.text}”\n\n> From “${source ?? 'an interview'}” · told by ${name}`,
        notes: year ? [] : ['No year was said, so this one has no date.'],
        method: 'verbatim',
        speaker: who,
        speakerName: name,
        turns: [i],
        anchor: first.toLowerCase(),
        startSec: null,
        endSec: null,
      };
    });
}

function jobView(job: DemoJob) {
  const running = job.polls < 2;
  return {
    id: job.id,
    status: running ? 'running' : 'succeeded',
    stage: running ? (job.polls === 0 ? 'reading' : 'organizing') : 'done',
    progress: { done: job.polls, total: 2 },
    startedAt: now(),
    elapsedMs: job.polls * 1500,
    canCancel: running,
    ...(running
      ? {}
      : {
          outcome: {
            status: job.saved ? 'saved' : 'previewed',
            memories: job.memories,
            interviewees: [],
            speakers: [],
            degraded: { windows: 0, reasons: [] },
            saved: job.saved,
            runId: job.runId ?? null,
            ...(job.graph
              ? { graph: { entities: [], relationships: [], pending: { reason: 'no_model' } } }
              : {}),
          },
        }),
  };
}

type Body = Record<string, unknown>;

/** One /v1 call. Paths are the part after /v1, exactly as lib/api.ts sends them. */
export async function demoFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120)); // a beat, so loading states are seen
  const b = (body ?? {}) as Body;
  const url = new URL(path, 'http://demo');
  const p = url.pathname.split('/').filter(Boolean);
  const all = db();

  if (method === 'GET' && path === '/archives')
    return all.map(({ id, subjectName, kind, jurisdiction, role }) => ({
      id,
      subjectName,
      kind: kind ?? 'personal',
      jurisdiction: jurisdiction ?? 'US',
      role,
    }));
  // invitations to the demo person (server/api/src/invites.ts)
  if (method === 'GET' && path === '/invites') return myInbox();
  if (method === 'POST' && p[0] === 'invites' && p[1]) {
    const box = myInbox();
    const item = box.find((x) => x.id === p[1]);
    if (!item || (p[2] !== 'accept' && p[2] !== 'decline')) throw new DemoError(404, null);
    inbox = box.filter((x) => x !== item);
    persistInbox();
    if (p[2] === 'decline') return { declined: true };
    const joined: DemoArchive = {
      id: uid(),
      subjectName: item.projectName,
      kind: item.kind,
      jurisdiction: 'GB',
      role: item.role,
      notes: [],
      runs: [],
      members: [
        {
          userId: 'demo-june',
          name: item.invitedBy,
          role: 'owner',
          joinedAt: item.createdAt,
        },
      ],
    };
    all.push(joined);
    persist();
    return { archiveId: joined.id, role: item.role };
  }
  if (method === 'POST' && path === '/provision') {
    const subjectName = typeof b.subjectName === 'string' ? b.subjectName.trim() : '';
    // the same rule as the server (server/api/src/provision.ts): a real country code only
    if (!subjectName || !countryCode(typeof b.jurisdiction === 'string' ? b.jurisdiction : ''))
      throw new DemoError(400, null);
    const kind = b.kind === 'family' ? 'family' : 'personal';
    const profile = parseProfileInput(b.profile ?? {});
    if (typeof profile === 'string') throw new DemoError(400, 'bad_request');
    const a: DemoArchive = {
      id: uid(),
      subjectName,
      kind,
      jurisdiction: countryCode(String(b.jurisdiction)) ?? 'US',
      role: 'owner',
      ...(kind === 'personal' ? { profile } : {}),
      // the protagonist's own person note, as the server makes it (graph design 3.5)
      notes:
        kind === 'personal'
          ? [
              {
                id: uid(),
                title: subjectName,
                type: 'person',
                body: '',
                occurred: null,
                createdAt: now(),
                revised: now(),
              },
            ]
          : [],
      runs: [],
    };
    all.push(a);
    persist();
    return { tenantId: uid(), archiveId: a.id };
  }
  if (p[0] !== 'archives' || !p[1]) throw new DemoError(404, null);
  const a = archiveOf(p[1]);
  const [, , what, id, sub] = p;

  /* ── the project itself (server/api/src/project-settings.ts) ── */
  if (!what && method === 'PATCH') {
    if (b.subjectName !== undefined) {
      if (a.role !== 'owner' && a.role !== 'steward') throw new DemoError(403, 'forbidden');
      const name = typeof b.subjectName === 'string' ? b.subjectName.trim() : '';
      if (!name || name.length > 120) throw new DemoError(400, 'bad_request');
      a.subjectName = name;
    }
    if (b.kind !== undefined) {
      if (a.role !== 'owner') throw new DemoError(403, 'forbidden');
      if (b.kind !== 'family') throw new DemoError(400, 'bad_request');
      a.kind = 'family';
    }
    persist();
    return { id: a.id, subjectName: a.subjectName, kind: a.kind ?? 'personal' };
  }
  if (!what && method === 'DELETE') {
    if (a.role !== 'owner') throw new DemoError(403, 'forbidden');
    if (String(b.confirm ?? '').trim() !== a.subjectName)
      throw new DemoError(400, 'confirm_mismatch');
    all.splice(all.indexOf(a), 1);
    persist();
    return { deleted: true };
  }

  /* ── members and invites ── */
  const manage = a.role === 'owner' || a.role === 'steward';
  if (what === 'members' && !id && method === 'GET') {
    return [
      { userId: DEMO_USER, name: DEMO_NAME, role: a.role, joinedAt: now(), you: true },
      ...(a.members ?? []).map((m) => ({ ...m, you: false })),
    ];
  }
  if (what === 'members' && id && method === 'DELETE') {
    if (id === DEMO_USER) {
      // leaving: anyone but the owner
      if (a.role === 'owner') throw new DemoError(400, 'bad_request');
      all.splice(all.indexOf(a), 1);
    } else {
      if (a.role !== 'owner') throw new DemoError(403, 'forbidden');
      a.members = (a.members ?? []).filter((m) => m.userId !== id);
    }
    persist();
    return { removed: true };
  }
  if (what === 'members' && id && method === 'PATCH') {
    if (a.role !== 'owner') throw new DemoError(403, 'forbidden');
    const role = String(b.role ?? '');
    if (id === DEMO_USER || !['steward', 'contributor', 'viewer'].includes(role))
      throw new DemoError(400, 'bad_request');
    const m = (a.members ?? []).find((x) => x.userId === id);
    if (!m) throw new DemoError(404, null);
    m.role = role;
    persist();
    return { userId: id, role };
  }
  if (what === 'people-search' && method === 'GET') {
    if (!manage) throw new DemoError(403, 'forbidden');
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    if (q.length < 3) return [];
    const inIt = new Set((a.members ?? []).map((m) => m.userId));
    return DEMO_PEOPLE.filter(
      (x) =>
        x.email.startsWith(q) ||
        x.name.toLowerCase().startsWith(q) ||
        x.name.toLowerCase().includes(` ${q}`),
    )
      .slice(0, 6)
      .map((x) => ({
        userId: x.userId,
        name: x.name,
        email: x.email === q ? x.email : mask(x.email),
        member: inIt.has(x.userId),
        invited: (a.invites ?? []).some((i) => i.userId === x.userId && isOpen(i)),
      }));
  }
  if (what === 'invites' && !id) {
    if (!manage) throw new DemoError(403, 'forbidden');
    const open = (a.invites ?? []).filter(isOpen);
    if (method === 'GET')
      return open.map((i) => {
        const who = DEMO_PEOPLE.find((x) => x.userId === i.userId);
        return {
          id: i.id,
          role: i.role,
          createdAt: i.createdAt,
          expiresAt: i.expiresAt,
          invitedBy: DEMO_NAME,
          hasAccount: !!who,
          inviteeName: who?.name ?? i.email,
          inviteeEmail: who ? mask(who.email) : i.email,
        };
      });
    if (method === 'POST') {
      const role = String(b.role ?? '');
      const may =
        a.role === 'owner' ? ['steward', 'contributor', 'viewer'] : ['contributor', 'viewer'];
      if (!['steward', 'contributor', 'viewer'].includes(role))
        throw new DemoError(400, 'bad_request');
      if (!may.includes(role)) throw new DemoError(403, 'forbidden');
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      const who =
        typeof b.userId === 'string'
          ? DEMO_PEOPLE.find((x) => x.userId === b.userId)
          : DEMO_PEOPLE.find((x) => x.email === email);
      if (typeof b.userId === 'string' && !who) throw new DemoError(404, null);
      if (!who && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new DemoError(400, 'bad_request');
      if (who && (a.members ?? []).some((m) => m.userId === who.userId))
        throw new DemoError(409, 'member');
      if (
        (a.invites ?? []).some(
          (i) => isOpen(i) && (who ? i.userId === who.userId : i.email === email),
        )
      )
        throw new DemoError(409, 'invited');
      const inv: DemoInvite = {
        id: uid(),
        ...(who ? { userId: who.userId } : { email }),
        role,
        createdAt: now(),
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      };
      a.invites = [...(a.invites ?? []), inv];
      persist();
      return {
        id: inv.id,
        role,
        createdAt: inv.createdAt,
        expiresAt: inv.expiresAt,
        hasAccount: !!who,
      };
    }
  }
  if (what === 'invites' && id && method === 'DELETE') {
    if (!manage) throw new DemoError(403, 'forbidden');
    const inv = (a.invites ?? []).find((i) => i.id === id && isOpen(i));
    if (!inv) throw new DemoError(404, null);
    inv.revokedAt = now();
    persist();
    return { revoked: true };
  }

  if (what === 'notes' && !id) {
    if (method === 'GET') return a.notes.map(summary);
    if (method === 'POST') {
      const title = checkFields(a, b);
      const n: DemoNote = {
        id: uid(),
        title,
        type: String(b.type ?? 'event'),
        body: String(b.body ?? ''),
        occurred: (b.occurred as string | null) ?? null,
        createdAt: now(),
        revised: now(),
      };
      a.notes.push(n);
      persist();
      return n;
    }
  }
  if (what === 'notes' && id && !sub) {
    const n = noteOf(a, id);
    if (method === 'GET') return n;
    if (method === 'PUT') {
      const title = checkFields(a, b, n.id);
      // a rename carries the links that named the old title along with it
      if (normalizeTitle(title) !== normalizeTitle(n.title)) {
        for (const other of a.notes) {
          other.body = other.body.replace(
            /\[\[([^\]|]*)(\|[^\]]*)?\]\]/g,
            (raw, t: string, alias?: string) =>
              normalizeTitle(t) === normalizeTitle(n.title) ? `[[${title}${alias ?? ''}]]` : raw,
          );
        }
      }
      Object.assign(n, {
        title,
        body: String(b.body ?? ''),
        occurred: (b.occurred as string | null) ?? null,
        revised: now(),
      });
      persist();
      return n;
    }
    if (method === 'DELETE') {
      a.notes = a.notes.filter((x) => x.id !== n.id);
      persist();
      return { id: n.id, deletedAt: now() };
    }
  }
  if (what === 'notes' && id && sub === 'backlinks') {
    const n = noteOf(a, id);
    const occ = links(a)
      .filter((l) => l.to.id === n.id)
      .map((l) => ({
        sourceId: l.from.id,
        sourceTitle: l.from.title,
        sourceOccurred: l.from.occurred,
        snippet: snippet(l.from.body, l.raw),
      }));
    return { occurrences: occ, total: occ.length, truncated: false };
  }
  if (what === 'notes' && id && sub === 'neighborhood') {
    const n = noteOf(a, id);
    const near = new Map<string, DemoNote>();
    for (const l of links(a)) {
      if (l.from.id === n.id) near.set(l.to.id, l.to);
      if (l.to.id === n.id) near.set(l.from.id, l.from);
    }
    return {
      nodes: [
        { id: n.id, title: n.title, type: n.type, depth: 0 },
        ...[...near.values()].map((x) => ({ id: x.id, title: x.title, type: x.type, depth: 1 })),
      ],
      edges: [...near.keys()].map((target) => ({ source: n.id, target })),
    };
  }
  /* ── who it is about (server/api/src/stories/profile-store.ts) ── */
  if (what === 'profile') {
    if ((a.kind ?? 'personal') !== 'personal') throw new DemoError(404, null);
    if (method === 'PUT') {
      if (!['owner', 'steward', 'contributor'].includes(a.role))
        throw new DemoError(403, 'forbidden');
      const fields = parseProfileInput(b);
      if (typeof fields === 'string') throw new DemoError(400, 'bad_request');
      a.profile = fields;
      persist();
    }
    return { noteId: null, name: a.subjectName, ...(a.profile ?? readProfile({})) };
  }
  if (what === 'people' && id && sub === 'profile' && method === 'PUT') {
    if (!['owner', 'steward', 'contributor'].includes(a.role))
      throw new DemoError(403, 'forbidden');
    const n = noteOf(a, id);
    if (n.type !== 'person') throw new DemoError(404, null);
    const fields = parseProfileInput(b);
    if (typeof fields === 'string') throw new DemoError(400, 'bad_request');
    n.profile = fields;
    persist();
    return { noteId: n.id, name: n.title, ...fields };
  }
  /* ── the graph (server/api/src/graph/): the demo's person, place and object notes, and the
     [[links]] its stories make to them; the demo tells no relationships ── */
  if (what === 'graph' && method === 'GET') return demoGraph(a);
  if (what === 'entities' && !id && method === 'GET') {
    const g = demoGraph(a);
    return g.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      noteId: n.noteId,
      subject: n.subject,
      aliases: [],
      stories: n.stories,
    }));
  }
  if (what === 'entities' && id && !sub && method === 'GET') {
    const n = noteOf(a, id);
    const type = ENTITY_TYPE[n.type];
    if (!type) throw new DemoError(404, null);
    const into = links(a).filter((l) => l.to.id === n.id && !ENTITY_TYPE[l.from.type]);
    const subject = normalizeTitle(n.title) === normalizeTitle(a.subjectName) && type === 'person';
    return {
      id: n.id,
      name: n.title,
      type,
      noteId: n.id,
      subject,
      aliases: [],
      description: '',
      profile: subject ? (a.profile ?? readProfile({})) : null,
      mentions: [...new Map(into.map((l) => [l.from.id, l])).values()].map((l) => ({
        storyId: l.from.id,
        storyTitle: l.from.title,
        occurred: l.from.occurred,
        words: [plainLabel(l.raw)],
        line: plainLinkText(snippet(l.from.body, l.raw)),
      })),
      relationships: [],
      graph: demoGraph(a, n.id),
    };
  }
  if (what === 'people' && method === 'GET') {
    const all2 = links(a);
    return a.notes
      .filter((n) => n.type === 'person')
      .sort((x, y) => x.title.localeCompare(y.title))
      .map((n) => ({
        id: n.id,
        title: n.title,
        type: n.type,
        backlinks: new Set(all2.filter((l) => l.to.id === n.id).map((l) => l.from.id)).size,
      }));
  }
  if (what === 'ask' && method === 'POST') {
    const q = typeof b.question === 'string' ? b.question.trim() : '';
    if (!q) throw new DemoError(400, null);
    return ask(a, q);
  }
  if (what === 'ingest-runs' && !id && method === 'GET') {
    return [...a.runs]
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
      .map((r) => {
        const alive = r.noteIds.filter((nid) => a.notes.some((n) => n.id === nid)).length;
        return {
          id: r.id,
          createdAt: r.createdAt,
          source: r.undone || alive === 0 ? null : r.source,
          mine: true,
          notes: alive,
          undone: r.undone,
        };
      });
  }
  if (what === 'ingest-runs' && id && sub === 'undo' && method === 'POST') {
    const r = a.runs.find((x) => x.id === id);
    if (!r) throw new DemoError(404, null);
    if (r.undone) return { erased: 0, kept: [], alreadyUndone: true };
    const before = a.notes.length;
    a.notes = a.notes.filter((n) => !r.noteIds.includes(n.id));
    r.undone = true;
    persist();
    return { erased: before - a.notes.length, kept: [], alreadyUndone: false };
  }
  if (what === 'transcription-token' && method === 'POST') {
    // the one demo call that leaves the browser: the dev server holds the Deepgram key
    const r = await fetch('/demo/transcription-token', { method: 'POST' });
    const out = (await r.json().catch(() => null)) as { code?: string } | null;
    if (!r.ok) throw new DemoError(r.status, out?.code ?? null);
    return out;
  }
  if (what === 'interview' && id === 'suggest' && method === 'POST') {
    // the dev server runs the API's own coach with the NVIDIA key from .env
    const r = await fetch('/demo/interview-suggest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = (await r.json().catch(() => null)) as { code?: string } | null;
    if (!r.ok) throw new DemoError(r.status, out?.code ?? null);
    return out;
  }
  if (what === 'graph' && id === 'build' && method === 'POST') {
    const job: DemoJob = {
      id: uid(),
      archiveId: a.id,
      polls: 0,
      source: null,
      memories: [],
      graph: true,
    };
    jobs.set(job.id, job);
    return jobView(job);
  }
  if (what === 'ingest' && !id && method === 'POST') {
    const transcript = typeof b.transcript === 'string' ? b.transcript : '';
    if (!transcript.trim()) throw new DemoError(400, 'empty');
    const source = typeof b.source === 'string' ? b.source : null;
    const memories = prepare(
      transcript,
      typeof b.teller === 'string' ? b.teller : undefined,
      source,
    );
    if (memories.length === 0) throw new DemoError(400, 'no_speech');
    const job: DemoJob = { id: uid(), archiveId: a.id, polls: 0, source, memories };
    jobs.set(job.id, job);
    return jobView(job);
  }
  if (what === 'ingest' && id) {
    const job = jobs.get(id);
    if (!job || job.archiveId !== a.id) throw new DemoError(404, null);
    if (method === 'GET' && !sub) {
      job.polls = Math.min(2, job.polls + 1);
      return jobView(job);
    }
    if (method === 'POST' && sub === 'cancel') {
      jobs.delete(id);
      return { ...jobView(job), status: 'cancelled', canCancel: false };
    }
    if (method === 'POST' && sub === 'save') {
      const patches = (Array.isArray(b.memories) ? b.memories : []) as Array<Body>;
      const saved: Array<{ id: string; title: string; index: number }> = [];
      job.memories.forEach((m, index) => {
        const patch = patches.find((x) => x.index === index) ?? {};
        if (patch.skip === true) return;
        let title =
          typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim() : m.title;
        while (a.notes.some((n) => normalizeTitle(n.title) === normalizeTitle(title)))
          title += ' (2)';
        const n: DemoNote = {
          id: uid(),
          title,
          type: 'event',
          body: typeof patch.body === 'string' ? patch.body : m.body,
          occurred: 'occurred' in patch ? ((patch.occurred as string | null) ?? null) : m.occurred,
          createdAt: now(),
          revised: now(),
        };
        a.notes.push(n);
        saved.push({ id: n.id, title: n.title, index });
      });
      if (saved.length === 0) throw new DemoError(400, 'cannot_save');
      const run: DemoRun = {
        id: uid(),
        createdAt: now(),
        source: job.source,
        noteIds: saved.map((s) => s.id),
        undone: false,
      };
      a.runs.push(run);
      job.saved = saved;
      job.runId = run.id;
      persist();
      return { ...(jobView(job).outcome as object), jobId: job.id };
    }
  }
  throw new DemoError(404, null);
}
