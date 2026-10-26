import { SKIP_LOGIN } from './demo';
import { supabase } from './supabase';

/** An answer from the API that was not a success: its status, and its stable `code` if it sent one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
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
    const payload = (await res.json().catch(() => null)) as { code?: unknown } | null;
    throw new ApiError(res.status, typeof payload?.code === 'string' ? payload.code : null);
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
}

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

export const provisionArchive = (subjectName: string, jurisdiction: string, kind: ProjectKind) =>
  apiFetch<{ tenantId: string; archiveId: string }>('POST', '/provision', {
    subjectName,
    jurisdiction,
    kind,
  });

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
  method: 'ai-grounded' | 'verbatim';
  speaker: string;
  speakerName?: string;
  conflicts?: Array<{
    claim: string;
    existing: string;
    source: { id: string; title: string } | null;
  }>;
}

export interface ImportOutcome {
  status: 'previewed' | 'saved' | 'needs_confirmation' | 'duplicate';
  memories: ImportMemory[];
  interviewees: string[];
  speakers: Array<{ id: string; turns: number; role: 'interviewee' | 'interviewer' }>;
  saved?: Array<{ id: string; title: string; index: number }>;
  runId?: string | null;
  duplicateOf?: { createdAt: string; source: string | null };
  degraded: { windows: number };
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
}

export const coachSuggest = (archive: string, req: CoachRequest, signal?: AbortSignal) =>
  apiFetch<CoachSuggestion>('POST', `/archives/${archive}/interview/suggest`, req, signal);

/** Always a preview, always a job: the person reads every memory before anything is saved. */
export const startImport = (archive: string, req: ImportRequest) =>
  apiFetch<ImportJob>('POST', `/archives/${archive}/ingest`, { ...req, save: false, async: true });

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

export const saveImport = (archive: string, job: string, memories: MemoryPatch[]) =>
  apiFetch<ImportOutcome>('POST', `/archives/${archive}/ingest/${job}/save`, { memories });

/** One import already in the archive; `source` is null once it is undone or its notes are gone. */
export interface ImportRun {
  id: string;
  createdAt: string;
  source: string | null;
  mine: boolean;
  notes: number;
  undone: boolean;
}

export const listImports = (archive: string) =>
  apiFetch<ImportRun[]>('GET', `/archives/${archive}/ingest-runs`);

export const undoImport = (archive: string, run: string) =>
  apiFetch<{ erased: number; kept: Array<{ id: string; title: string; reason: string }> }>(
    'POST',
    `/archives/${archive}/ingest-runs/${run}/undo`,
  );
