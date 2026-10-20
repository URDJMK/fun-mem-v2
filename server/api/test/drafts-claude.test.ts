import { describe, expect, it } from 'vitest';
import {
  Gate,
  DraftCapacityError,
  coerceDraft,
  childEnv,
  sniffImageType,
  parseStream,
  ClaudeCliError,
} from '../src/drafts-claude';

const never = () => new Promise<void>(() => {});

describe('Gate', () => {
  it('429s a second concurrent draft from the same user; 503s a full queue; keeps FIFO', async () => {
    const g = new Gate(1, 1, 5_000);
    const order: string[] = [];
    const a = g.run('u1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 40));
      order.push('a-end');
      return 'a';
    });
    await new Promise((r) => setImmediate(r));
    await expect(g.run('u1', never)).rejects.toMatchObject({ status: 429 });
    const b = g.run('u2', async () => {
      order.push('b');
      return 'b';
    });
    await new Promise((r) => setImmediate(r));
    // queue is full (1 running, 1 queued) -> 503, not 429
    await expect(g.run('u3', never)).rejects.toMatchObject({ status: 503, retryAfterSec: 15 });
    expect(await a).toBe('a');
    expect(await b).toBe('b');
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('releases the per-user slot when the job throws', async () => {
    const g = new Gate(2, 2, 5_000);
    await expect(g.run('u1', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(g.run('u1', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('gives up on a queue wait rather than serving a contributor who left', async () => {
    const g = new Gate(1, 4, 30);
    const held = g.run('u1', async () => {
      await new Promise((r) => setTimeout(r, 200));
      return 1;
    });
    await new Promise((r) => setImmediate(r));
    await expect(g.run('u2', () => Promise.resolve(2))).rejects.toBeInstanceOf(DraftCapacityError);
    await held;
  });
});

describe('childEnv', () => {
  it('never hands the child the archive credentials or a redirected endpoint', () => {
    const env = childEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/x',
        FUNMEM_SERVICE_KEY: 'service-key',
        FUNMEM_DB_URL: 'postgres://u:p@h/db',
        ANTHROPIC_API_KEY: 'sk-x',
        ANTHROPIC_BASE_URL: 'https://evil.example',
        NODE_OPTIONS: '--require /tmp/x.js',
        SSH_AUTH_SOCK: '/tmp/agent',
        CLAUDE_CODE_MESSAGING_TOKEN: 't',
      },
      [],
    );
    for (const k of [
      'FUNMEM_SERVICE_KEY',
      'FUNMEM_DB_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'NODE_OPTIONS',
      'SSH_AUTH_SOCK',
      'CLAUDE_CODE_MESSAGING_TOKEN',
    ]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LC_ALL).toBe('en_US.UTF-8');
  });

  it('refuses to pass FUNMEM_* or an api key even when the operator names it', () => {
    const env = childEnv(
      { FUNMEM_SERVICE_KEY: 'k', ANTHROPIC_API_KEY: 'sk', CLAUDE_CONFIG_DIR: '/c' },
      ['FUNMEM_SERVICE_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'],
    );
    expect(env.FUNMEM_SERVICE_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe('/c');
  });
});

describe('parseStream', () => {
  it('classifies a logged-out CLI from its measured shape', () => {
    const line = JSON.stringify({
      type: 'result',
      is_error: true,
      subtype: 'success',
      terminal_reason: 'api_error',
      api_error_status: null,
      result: 'Not logged in · Please run /login',
    });
    try {
      parseStream(line + '\n', 1, '');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ClaudeCliError);
      expect((e as ClaudeCliError).failure).toBe('unauthenticated');
      expect((e as ClaudeCliError).terminal).toBe(true);
    }
  });
  it('treats a missing result line as a crash, not a hang', () => {
    expect(() => parseStream('{"type":"system","subtype":"init"}\n', 1, 'segfault')).toThrow(
      ClaudeCliError,
    );
  });
  it('survives a truncated json line', () => {
    const good = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '{"title":"Noodles"}',
      total_cost_usd: 0.01,
    });
    expect(parseStream(`{"type":"partial\n${good}\n`, 0, '').text).toBe('{"title":"Noodles"}');
  });
  it('notices a rate_limit_event without failing the call', () => {
    const good = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'x',
    });
    expect(parseStream(`{"type":"rate_limit_event"}\n${good}\n`, 0, '').throttleHint).toBe(true);
  });
  it('routes max-turns to model, not to the breaker-tripping classes', () => {
    const line = JSON.stringify({
      type: 'result',
      is_error: true,
      subtype: 'error_max_turns',
      result: '',
    });
    try {
      parseStream(line, 0, '');
    } catch (e) {
      expect((e as ClaudeCliError).failure).toBe('model');
      expect((e as ClaudeCliError).terminal).toBe(false);
    }
  });
});

describe('coerceDraft', () => {
  const req = { text: 'Grandma boiled noodles for us', media: null, titles: [] };
  it('reads a fenced object and keeps the contributor body when the model omits one', () => {
    const d = coerceDraft(
      '```json\n{"title":"Noodles","type":"nonsense","occurred":"1987-03"}\n```',
      req,
    )!;
    expect(d.title).toBe('Noodles');
    expect(d.type).toBe('event'); // unknown type is not trusted
    expect(d.occurred).toBe('1987-03'); // RAW; parseFuzzyDate is the arbiter downstream
    expect(d.body).toBe(req.text);
  });
  it('returns null rather than a half-draft on garbage', () => {
    expect(coerceDraft('Sorry, I cannot help with that.', req)).toBeNull();
  });
  it('strips smuggled codepoints out of a model title', () => {
    expect(coerceDraft('{"title":"Noo\u{200B}dles"}', req)!.title).toBe('Noodles');
  });
});

describe('sniffImageType', () => {
  it('reads the bytes, not the name', () => {
    expect(sniffImageType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]))).toBe(
      'image/png',
    );
    expect(sniffImageType(Buffer.from('%PDF-1.7 aaaa'))).toBeNull();
  });
});
