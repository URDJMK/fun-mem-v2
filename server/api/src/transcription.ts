/**
 * Live transcription: the browser streams the interview's audio straight to Deepgram and
 * shows the words as they are said. The audio never passes through this server.
 *
 * What this server does is hand the browser a SHORT-LIVED token for that one stream. The
 * Deepgram key itself never leaves the process: a token minted from it expires in a minute
 * (it only has to be good when the socket opens; an open stream outlives it), and only a
 * member who may add memories to the archive gets one.
 */
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

export function registerTranscriptionRoutes(app: App, deps: AppDeps): void {
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
    try {
      return c.json(await grantTranscriptionToken(deps.transcriptionKey));
    } catch (e) {
      if (e instanceof TranscriptionError && e.code === 'not_configured') {
        return c.json({ error: e.message, code: e.code }, 503);
      }
      return c.json({ error: 'could not reach the transcription service', code: 'upstream' }, 502);
    }
  });
}
