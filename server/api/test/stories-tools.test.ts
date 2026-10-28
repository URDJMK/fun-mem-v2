import { describe, expect, it } from 'vitest';
import { ModelError, type ChatModel } from '../src/nim';
import { linesOf } from '../src/stories/lines';
import {
  planTools,
  readJson,
  runWithTools,
  writeTools,
  type StoryLookup,
} from '../src/stories/tools';

/**
 * The AI's steps use tools through a small JSON protocol over the ordinary chat call: each
 * answer is either {"tool": …, "args": …} or {"result": …}. These tests script the model.
 */
function scripted(answers: string[]): ChatModel & { users: string[]; systems: string[] } {
  const users: string[] = [];
  const systems: string[] = [];
  return {
    id: 'scripted',
    users,
    systems,
    complete: async (system, user) => {
      systems.push(system);
      users.push(user);
      const next = answers.shift();
      if (next === undefined) throw new Error('the script ran out');
      return next;
    },
  };
}

const echo = {
  name: 'echo',
  description: 'repeats its text',
  args: '{"text": string}',
  run: async (a: Record<string, unknown>) => `echo: ${String(a.text)}`,
};
const asNumber = (v: unknown) =>
  typeof v === 'object' && v !== null && typeof (v as { n?: unknown }).n === 'number'
    ? (v as { n: number }).n
    : 'give {"n": a number}';

describe('runWithTools', () => {
  it('takes the result straight away', async () => {
    const chat = scripted(['{"result": {"n": 4}}']);
    const out = await runWithTools(chat, {
      system: 'Count.',
      task: 'How many?',
      tools: [echo],
      maxToolCalls: 3,
      parse: asNumber,
    });
    expect(out).toEqual({ value: 4, calls: 1, toolCalls: 0 });
    expect(chat.systems[0]).toContain('echo');
    expect(chat.systems[0]).toContain('{"result"');
  });

  it('runs a tool and shows its answer on the next call', async () => {
    const chat = scripted([
      '```json\n{"tool": "echo", "args": {"text": "Busan"}}\n```',
      '{"result": {"n": 1}}',
    ]);
    const out = await runWithTools(chat, {
      system: 's',
      task: 'the task',
      tools: [echo],
      maxToolCalls: 3,
      parse: asNumber,
    });
    expect(out.toolCalls).toBe(1);
    expect(chat.users[1]).toContain('the task');
    expect(chat.users[1]).toContain('#1 echo({"text":"Busan"}) → echo: Busan');
  });

  it('accepts a result given without the {"result": …} wrapper', async () => {
    const chat = scripted(['{"n": 7}']);
    const out = await runWithTools(chat, {
      system: 's',
      task: 't',
      tools: [],
      maxToolCalls: 0,
      parse: asNumber,
    });
    expect(out.value).toBe(7);
  });

  it('asks again once for an answer that is not JSON, then gives up', async () => {
    const ok = scripted(['Sure! Here you go.', '{"result": {"n": 2}}']);
    expect(
      (
        await runWithTools(ok, {
          system: 's',
          task: 't',
          tools: [],
          maxToolCalls: 0,
          parse: asNumber,
        })
      ).value,
    ).toBe(2);
    expect(ok.users[1]).toContain('one JSON object');

    const bad = scripted(['no', 'still no']);
    await expect(
      runWithTools(bad, { system: 's', task: 't', tools: [], maxToolCalls: 0, parse: asNumber }),
    ).rejects.toMatchObject({ kind: 'bad_output' });
  });

  it('sends a result it cannot use back with the reason, and takes the corrected one', async () => {
    const chat = scripted(['{"result": {"n": "four"}}', '{"result": {"n": 4}}']);
    const out = await runWithTools(chat, {
      system: 's',
      task: 't',
      tools: [],
      maxToolCalls: 0,
      parse: asNumber,
    });
    expect(out.value).toBe(4);
    expect(chat.users[1]).toContain('give {"n": a number}');
  });

  it('after the tool budget, says "no more tools" and refuses another', async () => {
    const chat = scripted([
      '{"tool": "echo", "args": {"text": "a"}}',
      '{"tool": "echo", "args": {"text": "b"}}',
      '{"tool": "echo", "args": {"text": "c"}}',
    ]);
    await expect(
      runWithTools(chat, {
        system: 's',
        task: 't',
        tools: [echo],
        maxToolCalls: 1,
        parse: asNumber,
      }),
    ).rejects.toBeInstanceOf(ModelError);
    expect(chat.users[1]).toContain('No more tools');
  });

  it('answers an unknown tool without failing', async () => {
    const chat = scripted(['{"tool": "delete_everything", "args": {}}', '{"result": {"n": 0}}']);
    const out = await runWithTools(chat, {
      system: 's',
      task: 't',
      tools: [echo],
      maxToolCalls: 2,
      parse: asNumber,
    });
    expect(out.value).toBe(0);
    expect(chat.users[1]).toContain('unknown tool');
  });

  it('stops after its call budget', async () => {
    const chat = scripted(Array.from({ length: 10 }, () => '{"result": {"n": "x"}}'));
    await expect(
      runWithTools(chat, {
        system: 's',
        task: 't',
        tools: [],
        maxToolCalls: 0,
        maxCalls: 3,
        parse: asNumber,
      }),
    ).rejects.toMatchObject({ kind: 'bad_output' });
    expect(chat.users).toHaveLength(3);
  });
});

describe('the story tools', () => {
  const lookup: StoryLookup = {
    search: async (q) => [{ id: 'n1', title: 'The harbour', type: 'event', snippet: `about ${q}` }],
    read: async (key) =>
      key === 'The harbour' || key === 'n1'
        ? { id: 'n1', title: 'The harbour', type: 'event', body: 'Boats came in at dawn.' }
        : null,
  };
  const lines = linesOf(
    [
      { index: 0, speaker: 'Q', start: null, end: null, text: 'Where?' },
      { index: 1, speaker: 'S', start: null, end: null, text: 'Busan.' },
    ],
    ['S'],
    [['S', 'Sunja']],
  );

  it('search_notes and read_note read the project', async () => {
    const [search, read] = planTools(lookup);
    expect(await search!.run({ query: 'Busan' })).toContain(
      'The harbour (event, id n1): about Busan',
    );
    expect(await read!.run({ note: 'The harbour' })).toContain('Boats came in at dawn.');
    expect(await read!.run({ note: 'Nowhere' })).toContain('no note');
  });

  it('read_lines reads the transcript by line numbers', async () => {
    const readLines = writeTools(lookup, lines).find((t) => t.name === 'read_lines')!;
    expect(await readLines.run({ lines: 'L1-L2' })).toBe('L1 Q (asking): Where?\nL2 Sunja: Busan.');
    expect(await readLines.run({ lines: 'L9' })).toContain('no such lines');
  });
});

describe('readJson', () => {
  it('reads the JSON in an answer, fenced or not, after any thinking', () => {
    expect(readJson('{"result": 1}')).toEqual({ result: 1 });
    expect(readJson('Sure.\n```json\n{"result": [1, 2]}\n```')).toEqual({ result: [1, 2] });
    expect(readJson('<think>{"draft": true}</think>{"result": 3}')).toEqual({ result: 3 });
    expect(readJson('no json here')).toBeUndefined();
  });

  it('closes what an answer left open: the model stops a brace short', () => {
    // measured on the real model: a long Graph step answer ending "]}" and "</think>"
    expect(readJson('{"result": {"entities": [{"a": "x}"}], "relationships": []}</think>')).toEqual(
      {
        result: { entities: [{ a: 'x}' }], relationships: [] },
      },
    );
    expect(readJson('{"result": {"list": [1, 2')).toEqual({ result: { list: [1, 2] } });
    // a cut in the middle of a string cannot be mended
    expect(readJson('{"result": "half a sen')).toBeUndefined();
  });
});
