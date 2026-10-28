import { beforeEach, describe, expect, it } from 'vitest';
import { clearDrafts, readDraft, writeDraft, type Draft } from '../src/lib/interview';
import { countryName } from '../src/components/CountryPicker';

/**
 * An unfinished live interview is kept in the browser (one per project) until it is turned
 * into memories, discarded, or its project is gone. Losing it loses the recording: the words
 * exist nowhere else.
 */
class MemoryStorage {
  private readonly m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const draft = (words: string[]): Draft => ({
  mode: 'room',
  startedAt: '2026-10-26T09:00:00.000Z',
  segments: words.map((text, i) => ({ id: i, speaker: 'S1', text, start: i, end: i + 1 })),
});

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { localStorage: new MemoryStorage() };
});

describe('the live interview kept in the browser', () => {
  it('a new interview with no words yet does not erase the one waiting to be finished', () => {
    writeDraft('a1', draft(['We swam below the mill.']));
    writeDraft('a1', draft([]));
    expect(readDraft('a1')?.segments.map((s) => s.text)).toEqual(['We swam below the mill.']);
  });

  it('keeps who the interviewer said each voice is, so a reload does not ask again', () => {
    writeDraft('a1', { ...draft(['Tell me about the mill.']), voiceAnswers: { S1: 'asker' } });
    expect(readDraft('a1')?.voiceAnswers).toEqual({ S1: 'asker' });
  });

  it('is let go only when it is discarded, by name', () => {
    writeDraft('a1', draft(['We swam below the mill.']));
    writeDraft('a1', null);
    expect(readDraft('a1')).toBeNull();
  });

  it('signing out lets go of every project’s, and of nothing else', () => {
    writeDraft('a1', draft(['one']));
    writeDraft('a2', draft(['two']));
    window.localStorage.setItem('funmem-archive', 'a1');
    clearDrafts();
    expect(readDraft('a1')).toBeNull();
    expect(readDraft('a2')).toBeNull();
    expect(window.localStorage.getItem('funmem-archive')).toBe('a1');
  });
});

describe('countryName', () => {
  it('names a country by its code', () => {
    expect(countryName('US')).toBe('United States');
  });

  it('shows what an older project stored, rather than failing, when it is not a code', () => {
    expect(countryName('USA')).toBe('USA');
    expect(countryName('United States')).toBe('United States');
  });
});
