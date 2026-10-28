/**
 * Live transcription: the browser streams the interview's audio straight to Deepgram and
 * shows the words as they are said.
 *
 * What this server does is hand the browser a SHORT-LIVED token for that one stream. The
 * Deepgram key itself never leaves the process: a token minted from it expires in a minute
 * (it only has to be good when the socket opens; an open stream outlives it), and only a
 * member who may add memories to the archive gets one.
 *
 * When the interview ends, the browser sends the whole recording once more, through this
 * server, for a second transcription of the full file: told apart from start to finish, the
 * voices come out far more reliably than live, word by word. The audio is passed straight on
 * to Deepgram and never written anywhere.
 */
import { bodyLimit } from 'hono/body-limit';
import type { App, AppDeps } from './app';
import { memberRole, WRITE_ROLES } from './membership';

const GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';
const TTL_SECONDS = 60;

export class TranscriptionError extends Error {
  constructor(readonly code: 'not_configured' | 'upstream') {
    super(code === 'not_configured' ? 'live transcription is not set up' : 'Deepgram refused');
  }
}

/**
 * A temporary Deepgram token. Never echoes Deepgram's answer on failure: an error body is no
 * business of the browser's, and could name the key's project.
 */
export async function grantTranscriptionToken(
  key: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string; expiresIn: number }> {
  if (!key) throw new TranscriptionError('not_configured');
  let res: Response;
  try {
    res = await fetchImpl(GRANT_URL, {
      method: 'POST',
      headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: TTL_SECONDS }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new TranscriptionError('upstream');
  }
  if (!res.ok) throw new TranscriptionError('upstream');
  const body = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    expires_in?: unknown;
  } | null;
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new TranscriptionError('upstream');
  }
  return {
    token: body.access_token,
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : TTL_SECONDS,
  };
}

/** one stretch of speech in the full-file transcription, by voice */
export interface RecordedSegment {
  /** Deepgram's speaker number, or null when the voices were not told apart */
  speaker: number | null;
  start: number;
  end: number;
  text: string;
}

const LISTEN_URL = 'https://api.deepgram.com/v1/listen';
/** an interview runs to about ninety minutes; Opus at 32 kbit/s is about 22 MB of that */
export const MAX_RECORDING_BYTES = 200 * 1024 * 1024;

/**
 * The whole recording, transcribed at once. `diarize` tells the voices apart (one microphone in
 * the room); `keyterms` are the names to spell the archive's way, and the interviewer's notes.
 */
export async function transcribeRecording(
  key: string | null | undefined,
  audio: BodyInit,
  opts: { contentType: string; diarize: boolean; keyterms: string[]; signal?: AbortSignal },
  fetchImpl: typeof fetch = fetch,
): Promise<RecordedSegment[]> {
  if (!key) throw new TranscriptionError('not_configured');
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en',
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
  });
  if (opts.diarize) params.set('diarize_model', 'latest');
  for (const term of opts.keyterms.slice(0, 60)) params.append('keyterm', term);
  let res: Response;
  try {
    res = await fetchImpl(`${LISTEN_URL}?${params}`, {
      method: 'POST',
      headers: { authorization: `Token ${key}`, 'content-type': opts.contentType },
      body: audio,
      // a stream sent as a request body must say so (Node's fetch)
      ...(audio instanceof ReadableStream ? { duplex: 'half' } : {}),
      signal: opts.signal ?? AbortSignal.timeout(10 * 60_000),
    } as RequestInit);
  } catch {
    throw new TranscriptionError('upstream');
  }
  if (!res.ok) throw new TranscriptionError('upstream');
  const body = (await res.json().catch(() => null)) as {
    results?: { utterances?: unknown };
  } | null;
  const utterances = body?.results?.utterances;
  if (!Array.isArray(utterances)) throw new TranscriptionError('upstream');
  const out: RecordedSegment[] = [];
  for (const u of utterances as Array<Record<string, unknown>>) {
    const text = typeof u.transcript === 'string' ? u.transcript.trim() : '';
    if (!text || typeof u.start !== 'number' || typeof u.end !== 'number') continue;
    const speaker = opts.diarize && typeof u.speaker === 'number' ? u.speaker : null;
    out.push({ speaker, start: u.start, end: u.end, text });
  }
  return out;
}

const AUDIO_TYPE = /^audio\/(?:webm|ogg|mp4|mpeg|wav)(?:;[\w=.,\s-]*)?$/i;

/** The query of a recording upload: whether to tell voices apart, and the names to listen for. */
export function readRecordingQuery(q: URLSearchParams): { diarize: boolean; keyterms: string[] } {
  const keyterms = q
    .getAll('keyterm')
    .map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 60);
  return { diarize: q.get('diarize') !== 'false', keyterms };
}

/**
 * Tokens one person may have in a minute. A recording takes one (two on a call) and one more
 * each time its connection drops; this is far above that, and far below running up a bill.
 */
const TOKENS_PER_MINUTE = 10;

export function registerTranscriptionRoutes(app: App, deps: AppDeps): void {
  const handed = new Map<string, number[]>();
  app.post('/v1/archives/:archiveId/transcription-token', async (c) => {
    const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
    const role = await memberRole(deps.pool, c.get('userId'), archiveId);
    // a stranger learns nothing, not even whether transcription is set up
    if (role === null) return c.json({ error: 'not found' }, 404);
    if (!WRITE_ROLES.includes(role)) {
      return c.json(
        {
          error: 'only an owner, steward or contributor can record interviews',
          code: 'forbidden',
          reason: 'role',
        },
        403,
      );
    }
    const userId = c.get('userId');
    const now = Date.now();
    const recent = (handed.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= TOKENS_PER_MINUTE) {
      return c.json(
        { error: 'too many recordings started; wait a minute', code: 'rate_limited' },
        429,
        {
          'retry-after': '60',
        },
      );
    }
    recent.push(now);
    handed.set(userId, recent);
    try {
      return c.json(await grantTranscriptionToken(deps.transcriptionKey));
    } catch (e) {
      if (e instanceof TranscriptionError && e.code === 'not_configured') {
        return c.json({ error: e.message, code: e.code }, 503);
      }
      return c.json({ error: 'could not reach the transcription service', code: 'upstream' }, 502);
    }
  });

  app.post(
    '/v1/archives/:archiveId/interview/transcribe',
    bodyLimit({
      maxSize: MAX_RECORDING_BYTES,
      onError: (c) => c.json({ error: 'the recording is too large', code: 'too_large' }, 413),
    }),
    async (c) => {
      const archiveId = (c.req.param('archiveId') ?? '').toLowerCase();
      const role = await memberRole(deps.pool, c.get('userId'), archiveId);
      if (role === null) return c.json({ error: 'not found' }, 404);
      if (!WRITE_ROLES.includes(role)) {
        return c.json(
          {
            error: 'only an owner, steward or contributor can record interviews',
            code: 'forbidden',
          },
          403,
        );
      }
      const contentType = c.req.header('content-type') ?? '';
      if (!AUDIO_TYPE.test(contentType) || !c.req.raw.body) {
        return c.json({ error: 'expected an audio recording', code: 'bad_request' }, 400);
      }
      const query = readRecordingQuery(new URL(c.req.url).searchParams);
      try {
        const segments = await transcribeRecording(deps.transcriptionKey, c.req.raw.body, {
          contentType,
          ...query,
        });
        return c.json({ segments });
      } catch (e) {
        if (e instanceof TranscriptionError && e.code === 'not_configured') {
          return c.json({ error: e.message, code: e.code }, 503);
        }
        return c.json(
          { error: 'could not reach the transcription service', code: 'upstream' },
          502,
        );
      }
    },
  );
}
