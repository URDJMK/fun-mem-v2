import type { ProfileFields } from '@funmem/core';
import { SKIP_LOGIN } from './demo';
import { supabase } from './supabase';

/**
 * An answer from the API that was not a success: its status, its stable `code` if it sent one,
 * on a 429 how many seconds to wait before asking again, and (code `busy`) which import is in
 * the way and why, when the server named one.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly retryAfter: number | null = null,
    readonly jobId: string | null = null,
    readonly reason: string | null = null,
  ) {
    super(`api ${status}${code ? ` ${code}` : ''}`);
  }
}

/** Same-origin /v1 (the Vite proxy); the Bearer token is read from the live session at call time. */
async function apiFetch<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  // demo mode: answered in the browser from the sample archive (lib/demo-api.ts)
  if (SKIP_LOGIN) {
    const { demoFetch, DemoError } = await import('./demo-api');
    try {
      return (await demoFetch(method, path, body)) as T;
    } catch (e) {
      if (e instanceof DemoError) throw new ApiError(e.status, e.code);
      throw e;
    }
  }
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      code?: unknown;
      retryAfter?: unknown;
      jobId?: unknown;
      reason?: unknown;
    } | null;
    const wait =
      typeof payload?.retryAfter === 'number'
        ? payload.retryAfter
        : Number(res.headers.get('retry-after') ?? NaN);
    throw new ApiError(
      res.status,
      typeof payload?.code === 'string' ? payload.code : null,
      Number.isFinite(wait) ? wait : null,
      typeof payload?.jobId === 'string' ? payload.jobId : null,
      typeof payload?.reason === 'string' ? payload.reason : null,
    );
  }
  return (await res.json()) as T;
}

/** personal: about one person (subjectName is them); family: about everyone in it (the family's name) */
export type ProjectKind = 'personal' | 'family';

export interface ArchiveSummary {
  id: string;
  subjectName: string;
  kind: ProjectKind;
  /** ISO country code: whose privacy law the project follows; set once */
  jurisdiction: string;
  role: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  type: string;
  revised: string | null;
  occurred: string | null;
}

export interface Note extends NoteSummary {
  body: string;
  createdAt: string;
  /** the people, places and things a story names, for its page to underline */
  mentions?: Mention[];
}

/* ── the people, places and things graph (server/api/src/graph/) ── */

export type EntityType = 'person' | 'place' | 'thing';

export interface Mention {
  entityId: string;
  words: string[];
}

export interface GraphNode {
  id: string;
  name: string;
  type: EntityType;
  stories: number;
  subject: boolean;
  noteId: string | null;
}

export interface GraphView {
  nodes: GraphNode[];
  /** relationships told in the stories: solid lines */
  told: Array<{
    a: string;
    b: string;
    lines: Array<{ id: string; description: string; storyId: string; storyTitle: string }>;
  }>;
  /** named in the same stories: faint lines */
  together: Array<{ a: string; b: string; stories: number }>;
  more: number;
}

export interface EntitySummary {
  id: string;
  name: string;
  type: EntityType;
  noteId: string | null;
  subject: boolean;
  aliases: string[];
  stories: number;
}

export interface EntityDetail extends Omit<EntitySummary, 'stories'> {
  description: string;
  profile: { born: string | null; died: string | null; aliases: string[] } | null;
  mentions: Array<{
    storyId: string;
    storyTitle: string;
    occurred: string | null;
    words: string[];
    line: string;
  }>;
  relationships: Array<{
    id: string;
    description: string;
    storyId: string;
    storyTitle: string;
    other: { id: string; name: string; type: EntityType };
  }>;
  graph: GraphView;
}

export const getGraph = (archive: string) =>
  apiFetch<GraphView>('GET', `/archives/${archive}/graph`);

export const listEntities = (archive: string) =>
  apiFetch<EntitySummary[]>('GET', `/archives/${archive}/entities`);

/** by the entity's id, or the id of its note */
export const getEntity = (archive: string, id: string) =>
  apiFetch<EntityDetail>('GET', `/archives/${archive}/entities/${id}`);

/** a new name (the old one kept as an alias) or type; 409 `taken` names the entity to merge with */
export const changeEntity = (
  archive: string,
  id: string,
  change: { name?: string; type?: EntityType },
) => apiFetch<{ ok: true }>('PATCH', `/archives/${archive}/entities/${id}`, change);

/** `from` merged into `keep`: its stories, relationships and names; then it is gone */
export const mergeEntity = (archive: string, keep: string, from: string) =>
  apiFetch<{ ok: true }>('POST', `/archives/${archive}/entities/${keep}/merge`, { from });

export const removeEntity = (archive: string, id: string) =>
  apiFetch<{ ok: true }>('DELETE', `/archives/${archive}/entities/${id}`);

export const removeRelationship = (archive: string, id: string) =>
  apiFetch<{ ok: true }>('DELETE', `/archives/${archive}/relationships/${id}`);

export interface Occurrence {
  sourceId: string;
  snippet: string;
  sourceTitle: string;
  sourceOccurred: string | null;
}

/** A bounded list, and the honest fact that it was bounded. */
export interface Backlinks {
  occurrences: Occurrence[];
  total: number;
  truncated: boolean;
}

export interface NoteFields {
  title: string;
  body: string;
  /** RAW fuzzy text ("1987", "1987-03", "~1948"); null clears the date */
  occurred: string | null;
}

export const listArchives = () => apiFetch<ArchiveSummary[]>('GET', '/archives');

export const provisionArchive = (
  subjectName: string,
  jurisdiction: string,
  kind: ProjectKind,
  profile?: ProfileFields,
) =>
  apiFetch<{ tenantId: string; archiveId: string }>('POST', '/provision', {
    subjectName,
    jurisdiction,
    kind,
    ...(profile ? { profile } : {}),
  });

/* ── who a project is about (server/api/src/stories/profile-store.ts) ── */

export type { ProfileFields };

/** A person's profile, kept on their person note (`noteId`; null until one is saved). */
export interface Profile extends ProfileFields {
  noteId: string | null;
  name: string;
}

/** a personal project's protagonist; a family project has none (404) */
export const getProfile = (archive: string) =>
  apiFetch<Profile>('GET', `/archives/${archive}/profile`);

export const putProfile = (archive: string, fields: ProfileFields) =>
  apiFetch<Profile>('PUT', `/archives/${archive}/profile`, fields);

/** a family narrator's profile, on their own person note */
export const putPersonProfile = (archive: string, noteId: string, fields: ProfileFields) =>
  apiFetch<Profile>('PUT', `/archives/${archive}/people/${noteId}/profile`, fields);

/* ── who is in a project, and inviting people (server/api/src/invites.ts) ── */

export type InviteRole = 'steward' | 'contributor' | 'viewer';

export interface Member {
  userId: string;
  name: string;
  role: string;
  joinedAt: string;
  you: boolean;
}

/** an invitation waiting for an answer, as those who look after the project see it */
export interface Invite {
  id: string;
  role: InviteRole;
  createdAt: string;
  expiresAt: string;
  invitedBy?: string;
  /** their name, or the email it was sent to; an account's email comes back mostly hidden */
  inviteeName: string;
  inviteeEmail: string;
  /** false: sent to an email with no account yet, waiting for them to sign in */
  hasAccount: boolean;
}

/** someone found by searching, to invite */
export interface PersonFound {
  userId: string;
  name: string;
  /** mostly hidden (the•••@gmail.com), unless the whole address was typed */
  email: string;
  member: boolean;
  invited: boolean;
}

/** an invitation to this person, from their projects page */
export interface MyInvite {
  id: string;
  role: InviteRole;
  createdAt: string;
  projectName: string;
  kind: ProjectKind;
  invitedBy: string;
}

export const listMembers = (archive: string) =>
  apiFetch<Member[]>('GET', `/archives/${archive}/members`);
export const removeMember = (archive: string, userId: string) =>
  apiFetch<{ removed: true }>('DELETE', `/archives/${archive}/members/${userId}`);
/** the owner changes what someone can do (never to or from owner) */
export const setMemberRole = (archive: string, userId: string, role: InviteRole) =>
  apiFetch<{ userId: string; role: InviteRole }>(
    'PATCH',
    `/archives/${archive}/members/${userId}`,
    { role },
  );
/** rename (owner, steward), or grow a personal project into a family one (owner) */
export const updateProject = (archive: string, change: { subjectName?: string; kind?: 'family' }) =>
  apiFetch<ArchiveSummary>('PATCH', `/archives/${archive}`, change);
/** the owner deletes it all; `confirm` is the project's name, typed out */
export const deleteProject = (archive: string, confirm: string) =>
  apiFetch<{ deleted: true }>('DELETE', `/archives/${archive}`, { confirm });
export const listInvites = (archive: string) =>
  apiFetch<Invite[]>('GET', `/archives/${archive}/invites`);
/** by name or the start of an email; three letters at least. Only for owners and stewards. */
export const searchPeople = (archive: string, q: string, signal?: AbortSignal) =>
  apiFetch<PersonFound[]>(
    'GET',
    `/archives/${archive}/people-search?q=${encodeURIComponent(q)}`,
    undefined,
    signal,
  );
/** someone found by search, or an email address (which may not have an account yet) */
export const createInvite = (
  archive: string,
  role: InviteRole,
  who: { userId: string } | { email: string },
) =>
  apiFetch<{ id: string; role: InviteRole; hasAccount: boolean }>(
    'POST',
    `/archives/${archive}/invites`,
    { role, ...who },
  );
export const revokeInvite = (archive: string, inviteId: string) =>
  apiFetch<{ revoked: true }>('DELETE', `/archives/${archive}/invites/${inviteId}`);
export const myInvites = () => apiFetch<MyInvite[]>('GET', '/invites');
export const answerInvite = (inviteId: string, answer: 'accept' | 'decline') =>
  apiFetch<{ archiveId?: string; role?: string; declined?: true }>(
    'POST',
    `/invites/${inviteId}/${answer}`,
  );

export const listNotes = (archive: string) =>
  apiFetch<NoteSummary[]>('GET', `/archives/${archive}/notes`);

export const getNote = (archive: string, id: string) =>
  apiFetch<Note>('GET', `/archives/${archive}/notes/${id}`);

export const createNote = (archive: string, note: NoteFields & { type: string }) =>
  apiFetch<Note>('POST', `/archives/${archive}/notes`, note);

export const updateNote = (archive: string, id: string, fields: NoteFields) =>
  apiFetch<Note>('PUT', `/archives/${archive}/notes/${id}`, fields);

export const deleteNote = (archive: string, id: string) =>
  apiFetch<{ id: string; deletedAt: string }>('DELETE', `/archives/${archive}/notes/${id}`);

export const getBacklinks = (archive: string, id: string) =>
  apiFetch<Backlinks>('GET', `/archives/${archive}/notes/${id}/backlinks`);

/** A person note and how many notes link to it (`backlinks`): how often they come up. */
export interface PersonSummary {
  id: string;
  title: string;
  type: string;
  backlinks: number;
}

export const listPeople = (archive: string) =>
  apiFetch<PersonSummary[]>('GET', `/archives/${archive}/people`);

/** The notes linked to a note, and to those, up to `depth` steps; `depth` 0 is the note itself. */
export interface Neighborhood {
  nodes: Array<{ id: string; title: string; type: string; depth: number }>;
  edges: Array<{ source: string; target: string }>;
}

export const getNeighborhood = (archive: string, id: string, depth = 1) =>
  apiFetch<Neighborhood>('GET', `/archives/${archive}/notes/${id}/neighborhood?depth=${depth}`);

/* ── asking the archive ─────────────────────────────────────────────── */

export interface Claim {
  text: string;
  /** a sentence copied from a note, one put in other words, or one drawn from it */
  kind: 'quote' | 'paraphrase' | 'inference';
  citation: { noteId: string; anchor: string | null };
}

/** An answer is either claims, each pointing at the note it came from, or a refusal that says why. */
export interface AskAnswer {
  abstained: boolean;
  reason: string | null;
  message?: string;
  selfIdentification: string | null;
  claims: Claim[];
  sources?: string[];
  /** some claims were dropped because the notes did not bear them out */
  partial?: boolean;
  evidence: { relevant: number; fitted: number };
}

export const ask = (archive: string, question: string, turn: number) =>
  apiFetch<AskAnswer>('POST', `/archives/${archive}/ask`, { question, turn });

/* ── importing an interview (docs/ingest/api.md) ────────────────────── */

export interface ImportMemory {
  id: string;
  title: string;
  type: string;
  occurred: string | null;
  body: string;
  /** sentences for the reviewer, shown before saving */
  notes: string[];
  /** 'story': written from the interview, every sentence cited and checked (stories mode) */
  method: 'ai-grounded' | 'verbatim' | 'story';
  speaker: string;
  speakerName?: string;
  /** a story: when it ended, who told it, and where each sentence comes from */
  until?: string | null;
  tellers?: string[];
  sources?: StorySource[];
  /** a story: sentences more certain than the speaker was */
  flags?: string[];
  /** a story dated from an age said in it: "Sunja Kim was 18; born about 1946" */
  dateBasis?: string;
  startSec?: number | null;
  endSec?: number | null;
  conflicts?: Array<{
    claim: string;
    existing: string;
    source: { id: string; title: string } | null;
  }>;
}

/** One sentence of a story, and the interview lines it comes from. */
export interface StorySource {
  sentence: string;
  from: number;
  to: number;
  start: number | null;
  end: number | null;
  text: string;
}

export interface ImportOutcome {
  status: 'previewed' | 'saved' | 'needs_confirmation' | 'duplicate';
  /** 'graph' identifies the button's run, even when an import has no accepted stories. */
  format?: string;
  memories: ImportMemory[];
  /** the stories could not be written yet; the interview keeps its transcript */
  pending?: { reason: string };
  interviewId?: string;
  interviewees: string[];
  speakers: Array<{ id: string; turns: number; role: 'interviewee' | 'interviewer' }>;
  saved?: Array<{ id: string; title: string; index: number }>;
  runId?: string | null;
  duplicateOf?: { createdAt: string; source: string | null };
  degraded: { windows: number };
  /** the people, places and things in the stories, and the relationships told */
  graph?: GraphProposal;
}

/** What an import proposes for the graph (server/api/src/graph/types.ts). */
export interface GraphProposal {
  entities: ProposedEntity[];
  relationships: ProposedRelationship[];
  /** it could not be found yet; the stories are unaffected */
  pending?: { reason: string };
}

export interface ProposedEntity {
  ref: string;
  name: string;
  type: EntityType;
  match:
    | { kind: 'new' }
    | { kind: 'existing'; entityId: string; name: string }
    | { kind: 'ask'; candidates: Array<{ entityId: string; name: string }> };
  /** `story` is a memory id ("m1"), or a note id when built from saved stories */
  mentions: Array<{ story: string; words: string[]; line: string }>;
  aliases?: string[];
  ways?: string[];
  description?: Array<{ text: string; sources: GraphSource[] }>;
  note?: { kind: 'new' } | { kind: 'existing'; noteId: string; title: string };
  subject?: boolean;
}

/** Interview lines, or a saved story's sentence, cited by a checked description. */
export type GraphSource =
  { interviewId: string | null; from: number; to: number } | { noteId: string; sentence: number };

export interface ProposedRelationship {
  ref: string;
  a: string;
  b: string;
  description: string;
  story: string | null;
}

/** the reviewer's choices: refs left out, renamed, or the same as an entity already here */
export interface GraphPatch {
  leave?: string[];
  rename?: Record<string, string>;
  same?: Record<string, string>;
  leaveParagraph?: string[];
}

export interface ImportJob {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  stage: 'reading' | 'organizing' | 'checking' | 'saving' | 'done';
  progress: { done: number; total: number };
  canCancel: boolean;
  outcome?: ImportOutcome;
  error?: { code: string; message: string; reason?: string };
}

export interface ImportRequest {
  transcript: string;
  teller?: string;
  source?: string;
  interviewees?: string[];
  confirm?: boolean;
  force?: boolean;
}

/** A one-minute Deepgram token for one live recording (the key itself stays on the server). */
export const transcriptionToken = (archive: string) =>
  apiFetch<{ token: string; expiresIn: number }>(
    'POST',
    `/archives/${archive}/transcription-token`,
  );

/** One move for the interviewer to make next (server/api/src/interview-coach.ts). */
export interface CoachSuggestion {
  move: 'wait' | 'follow_up' | 'change_topic' | 'break' | 'close';
  kind: 'detail' | 'meaning' | 'restate' | 'who_when' | 'reflect' | null;
  question: string;
  reason: string;
  threads: string[];
  topic: string | null;
}

export interface CoachRequest {
  narrator: string;
  interviewer: string | null;
  topics: string[];
  minutes: number;
  transcript: Array<{ who: string; text: string }>;
  threads: string[];
  asked: string[];
  want?: Exclude<CoachSuggestion['move'], 'wait'> | null;
  /** what the interviewer has written down; its spellings are the right ones */
  notes?: string[];
}

export const coachSuggest = (archive: string, req: CoachRequest, signal?: AbortSignal) =>
  apiFetch<CoachSuggestion>('POST', `/archives/${archive}/interview/suggest`, req, signal);

/** A topic in the interviewer's own words, with one open question to begin it. */
export interface FreeTopic {
  label: string;
  opener: string;
}

/** Today's topics, read out of what the interviewer said; none means the whole life. */
export const interviewTopics = (
  archive: string,
  req: { narrator: string; about: string },
  signal?: AbortSignal,
) =>
  apiFetch<{ topics: FreeTopic[] }>('POST', `/archives/${archive}/interview/topics`, req, signal);

/** A word the transcript misheard, in one line, as the interviewer's notes spell it. */
export interface Correction {
  id: number;
  from: string;
  to: string;
}

export const interviewCorrections = (
  archive: string,
  req: { notes: string[]; lines: Array<{ id: number; text: string }> },
  signal?: AbortSignal,
) =>
  apiFetch<{ fixes: Correction[] }>(
    'POST',
    `/archives/${archive}/interview/corrections`,
    req,
    signal,
  );

/** one stretch of speech in the full-recording transcription (server/api/src/transcription.ts) */
export interface RecordedSegment {
  speaker: number | null;
  start: number;
  end: number;
  text: string;
}

/**
 * The whole recording, transcribed again at once, for voices told apart from start to finish.
 * The audio goes through the API to Deepgram and is not kept (in demo mode, the dev server).
 */
export async function transcribeRecording(
  archive: string,
  audio: Blob,
  opts: { diarize: boolean; keyterms: string[] },
  signal?: AbortSignal,
): Promise<RecordedSegment[]> {
  const q = new URLSearchParams({ diarize: String(opts.diarize) });
  for (const t of opts.keyterms) q.append('keyterm', t);
  let url = `/v1/archives/${archive}/interview/transcribe?${q}`;
  const headers: Record<string, string> = { 'content-type': audio.type || 'audio/webm' };
  if (SKIP_LOGIN) url = `/demo/interview-transcribe?${q}`;
  else {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(url, { method: 'POST', headers, body: audio, signal });
  const payload = (await res.json().catch(() => null)) as {
    segments?: RecordedSegment[];
    code?: unknown;
  } | null;
  if (!res.ok || !Array.isArray(payload?.segments)) {
    throw new ApiError(res.status, typeof payload?.code === 'string' ? payload.code : null);
  }
  return payload.segments;
}

/** Always a preview, always a job: the person reads every memory before anything is saved. */
export const startImport = (archive: string, req: ImportRequest) =>
  apiFetch<ImportJob>('POST', `/archives/${archive}/ingest`, { ...req, save: false, async: true });

/** "Find people, places and things": a job with no transcript, over the saved stories */
export const startGraphBuild = (archive: string) =>
  apiFetch<ImportJob>('POST', `/archives/${archive}/graph/build`, { async: true });

export const getImport = (archive: string, job: string) =>
  apiFetch<ImportJob>('GET', `/archives/${archive}/ingest/${job}`);

export const cancelImport = (archive: string, job: string) =>
  apiFetch<ImportJob>('POST', `/archives/${archive}/ingest/${job}/cancel`);

export interface MemoryPatch {
  index: number;
  skip?: boolean;
  title?: string;
  body?: string;
  occurred?: string | null;
}

export const saveImport = (
  archive: string,
  job: string,
  memories: MemoryPatch[],
  graph?: GraphPatch,
) =>
  apiFetch<ImportOutcome>('POST', `/archives/${archive}/ingest/${job}/save`, {
    memories,
    ...(graph ? { graph } : {}),
  });

/** One import already in the archive; `source` is null once it is undone or its notes are gone. */
export interface ImportRun {
  id: string;
  createdAt: string;
  source: string | null;
  mine: boolean;
  notes: number;
  undone: boolean;
}

/** An interview kept with its transcript (stories mode). */
export interface InterviewSummary {
  id: string;
  name: string;
  recordedAt: string;
  status: 'pending' | 'written';
  mine: boolean;
  stories: number;
}

export interface InterviewDetail extends InterviewSummary {
  transcript: string;
  options: { teller?: string; interviewee?: string; interviewees?: string[] };
  turns: Array<{ speaker: string; start: number | null; text: string }>;
}

export const listInterviews = (archive: string) =>
  apiFetch<InterviewSummary[]>('GET', `/archives/${archive}/interviews`);

export const getInterview = (archive: string, id: string) =>
  apiFetch<InterviewDetail>('GET', `/archives/${archive}/interviews/${id}`);

export const listImports = (archive: string) =>
  apiFetch<ImportRun[]>('GET', `/archives/${archive}/ingest-runs`);

export const undoImport = (archive: string, run: string) =>
  apiFetch<{
    erased: number;
    restored?: number;
    kept: Array<{ id: string; title: string; reason: string }>;
  }>('POST', `/archives/${archive}/ingest-runs/${run}/undo`);
