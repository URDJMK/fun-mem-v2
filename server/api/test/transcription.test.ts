import { describe, expect, it } from 'vitest';
import { grantTranscriptionToken, TranscriptionError } from '../src/transcription';

const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('grantTranscriptionToken', () => {
  it('trades the key for a short-lived token, sending the key only to Deepgram', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ access_token: 'tmp-123', expires_in: 60 }));
    }) as unknown as typeof fetch;

    expect(await grantTranscriptionToken('dg-key', fetchImpl)).toEqual({
      token: 'tmp-123',
      expiresIn: 60,
    });
    expect(seen!.url).toBe('https://api.deepgram.com/v1/auth/grant');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Token dg-key');
    expect(JSON.parse(seen!.init.body as string)).toEqual({ ttl_seconds: 60 });
  });

  it('says it is not set up when there is no key, without calling out', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    await expect(grantTranscriptionToken('', fetchImpl)).rejects.toMatchObject({
      code: 'not_configured',
    });
    expect(called).toBe(false);
  });

  it('never passes on what Deepgram said when it refuses', async () => {
    const e = await grantTranscriptionToken(
      'bad',
      answer(401, { err_msg: 'Invalid credentials for project 1234' }),
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(TranscriptionError);
    expect((e as TranscriptionError).code).toBe('upstream');
    expect((e as Error).message).not.toContain('1234');
  });

  it('treats an answer with no token, or a dropped connection, as a failure', async () => {
    await expect(grantTranscriptionToken('k', answer(200, {}))).rejects.toMatchObject({
      code: 'upstream',
    });
    const dropped = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(grantTranscriptionToken('k', dropped)).rejects.toMatchObject({
      code: 'upstream',
    });
  });
});
