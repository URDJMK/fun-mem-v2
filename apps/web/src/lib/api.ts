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
async function apiFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { code?: unknown } | null;
    throw new ApiError(res.status, typeof payload?.code === 'string' ? payload.code : null);
  }
  return (await res.json()) as T;
}

export interface ArchiveSummary {
  id: string;
  subjectName: string;
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

export const provisionArchive = (subjectName: string, jurisdiction: string) =>
  apiFetch<{ tenantId: string; archiveId: string }>('POST', '/provision', {
    subjectName,
    jurisdiction,
  });

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
