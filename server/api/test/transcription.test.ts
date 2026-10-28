import { describe, expect, it } from 'vitest';
import {
  grantTranscriptionToken,
  readRecordingQuery,
  transcribeRecording,
  TranscriptionError,
} from '../src/transcription';

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

describe('transcribeRecording', () => {
  it('sends the whole file with the voices told apart and the names, and reads the turns', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({
          results: {
            utterances: [
              { speaker: 0, start: 0, end: 2.5, transcript: 'Tell me about your school.' },
              { speaker: 1, start: 3.9, end: 6.4, transcript: 'I went to NLCS in London.' },
              { speaker: 1, start: 7, end: 7.2, transcript: ' ' },
            ],
          },
        }),
      );
    }) as unknown as typeof fetch;
    const out = await transcribeRecording(
      'dg-key',
      new Blob(['audio']),
      { contentType: 'audio/webm', diarize: true, keyterms: ['NLCS', 'Nell'] },
      fetchImpl,
    );
    expect(out).toEqual([
      { speaker: 0, start: 0, end: 2.5, text: 'Tell me about your school.' },
      { speaker: 1, start: 3.9, end: 6.4, text: 'I went to NLCS in London.' },
    ]);
    const url = new URL(seen!.url);
    expect(url.searchParams.get('diarize_model')).toBe('latest');
    expect(url.searchParams.get('utterances')).toBe('true');
    expect(url.searchParams.getAll('keyterm')).toEqual(['NLCS', 'Nell']);
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Token dg-key');
  });

  it('does not tell voices apart on a call channel, and fails plainly upstream', async () => {
    let url = '';
    const ok = (async (u: string) => {
      url = u;
      return new Response(
        JSON.stringify({
          results: { utterances: [{ speaker: 0, start: 1, end: 2, transcript: 'Hi.' }] },
        }),
      );
    }) as unknown as typeof fetch;
    const out = await transcribeRecording(
      'k',
      new Blob(['a']),
      { contentType: 'audio/webm', diarize: false, keyterms: [] },
      ok,
    );
    expect(out[0]!.speaker).toBeNull();
    expect(new URL(url).searchParams.has('diarize_model')).toBe(false);
    await expect(
      transcribeRecording(
        'k',
        new Blob(['a']),
        { contentType: 'audio/webm', diarize: true, keyterms: [] },
        answer(500, {}),
      ),
    ).rejects.toBeInstanceOf(TranscriptionError);
  });

  it('reads the upload’s query', () => {
    expect(
      readRecordingQuery(new URLSearchParams('diarize=false&keyterm=NLCS&keyterm=%20')),
    ).toEqual({ diarize: false, keyterms: ['NLCS'] });
  });
});
