import { describe, expect, it } from 'vitest';
import { listenUrl } from '../src/lib/live';

/** The live transcription stream: what Deepgram is asked for, and what it is asked not to do. */
describe('listenUrl', () => {
  it('opts out of Deepgram keeping the audio and training on it', () => {
    const u = new URL(listenUrl(['Nell'], true));
    expect(u.searchParams.get('mip_opt_out')).toBe('true');
  });

  it('asks for nova-3, the names to listen for, and who spoke when one stream has many voices', () => {
    const u = new URL(listenUrl(['Grandma Nell', 'Nell', 'Duluth'], true));
    expect(u.origin + u.pathname).toBe('wss://api.deepgram.com/v1/listen');
    expect(u.searchParams.get('model')).toBe('nova-3');
    expect(u.searchParams.getAll('keyterm')).toEqual(['Grandma Nell', 'Nell', 'Duluth']);
    expect(u.searchParams.get('diarize_model')).toBe('latest');
    // a stream that is one person (a call's two sides) needs no telling apart
    expect(new URL(listenUrl([], false)).searchParams.has('diarize_model')).toBe(false);
  });
});
