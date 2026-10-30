import { ModelError, type ChatModel } from '../nim';
import { parseCite, renderLines, type Line } from './lines';

/**
 * Tools for the AI's steps, over the ordinary chat call (`ChatModel.complete`), so the NVIDIA
 * client's retries, slot limiter and timeouts apply to every turn. The protocol is plain JSON:
 * each answer is either {"tool": name, "args": {…}} or {"result": …}. Each call sends the task
 * again with the tool calls made so far: the API keeps no conversation, so a native tool-call
 * history would be sent again just the same.
 *
 * Every tool only READS (PRD D10): nothing the AI does here can change the archive.
 */
export interface Tool {
  name: string;
  description: string;
  /** the argument shape, shown to the model, e.g. '{"query": string}' */
  args: string;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface ToolLoopResult<T> {
  value: T;
  /** model calls made */
  calls: number;
  toolCalls: number;
}

/** What the tools read of the project: the archive in a job, a fake in tests, nothing in the evaluation. */
export interface StoryLookup {
  search(
    query: string,
  ): Promise<Array<{ id: string; title: string; type: string; snippet: string }>>;
  read(
    idOrTitle: string,
  ): Promise<{ id: string; title: string; type: string; body: string } | null>;
}

/** a tool's answer, as the model sees it, is cut to this */
const RESULT_CHARS = 4000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The JSON object in an answer, fenced or not; undefined when there is none. Thinking is left
 * out, and a lone "</think>" too: the real model sometimes ends its answer with one. An answer
 * that stops with something still open (measured: a long one a brace short) is closed.
 */
export function readJson(text: string): unknown {
  const t = text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\/?think>/g, '')
    .trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fenced ? fenced[1]!.trim() : t;
  const from = body.indexOf('{');
  if (from < 0) return undefined;
  const to = body.lastIndexOf('}');
  if (to > from) {
    try {
      return JSON.parse(body.slice(from, to + 1)) as unknown;
    } catch {
      // perhaps left open: below
    }
  }
  return closed(body.slice(from));
}

/** JSON that stops with objects or lists still open, closed; never mends a cut string */
function closed(s: string): unknown {
  const open: string[] = [];
  let inString = false;
  let escaped = false;
  let end = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') open.push('}');
    else if (c === '[') open.push(']');
    else if (c === '}' || c === ']') {
      open.pop();
      if (open.length === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (inString) return undefined;
  const text = s.slice(0, end).replace(/[\s,]+$/, '') + open.reverse().join('');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function protocol(tools: readonly Tool[]): string {
  const list = tools.length
    ? tools.map((t) => `- ${t.name}(${t.args}): ${t.description}`).join('\n')
    : '(none)';
  return `Answer with ONE JSON object and nothing else:
  {"tool": "<name>", "args": {...}}   to use a tool, or
  {"result": <your result>}           when you are done.
Tools (they only read; use them when they help, not by habit):
${list}`;
}

const badOutput = (why: string) => new ModelError(why, 'bad_output', false);

export async function runWithTools<T>(
  chat: ChatModel,
  o: {
    system: string;
    task: string;
    tools: readonly Tool[];
    maxToolCalls: number;
    /** the value, or a sentence saying what is wrong with it (sent back to the model) */
    parse: (v: unknown) => T | string;
    signal?: AbortSignal;
    temperature?: number;
    /** model calls in all; default `maxToolCalls + 4` */
    maxCalls?: number;
  },
): Promise<ToolLoopResult<T>> {
  const system = `${o.system}\n\n${protocol(o.tools)}`;
  const maxCalls = o.maxCalls ?? o.maxToolCalls + 4;
  const history: string[] = [];
  let calls = 0;
  let toolCalls = 0;
  let notJson = 0;
  let refusedTools = 0;
  let feedback: string | null = null;
  while (calls < maxCalls) {
    const noMore = toolCalls >= o.maxToolCalls;
    const user = [
      o.task,
      history.length > 0 ? `Tool calls so far:\n${history.join('\n')}` : '',
      feedback ? `Your last answer could not be used: ${feedback}` : '',
      noMore && o.tools.length > 0 ? 'No more tools: give your result now.' : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    calls++;
    const text = await chat.complete(system, user, {
      signal: o.signal,
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
    });
    const json = readJson(text);
    if (json === undefined) {
      if (++notJson >= 2) throw badOutput('the AI did not answer with JSON');
      feedback = 'it was not one JSON object. Answer with one JSON object and nothing else.';
      continue;
    }
    notJson = 0;
    if (isObj(json) && typeof json.tool === 'string') {
      if (noMore) {
        if (++refusedTools >= 2) throw badOutput('the AI kept asking for tools after its budget');
        feedback = 'no more tools are allowed. Give your result.';
        continue;
      }
      const args = isObj(json.args) ? json.args : {};
      const tool = o.tools.find((t) => t.name === json.tool);
      let out: string;
      try {
        out = tool ? await tool.run(args) : `unknown tool "${json.tool}"`;
      } catch (e) {
        out = `the tool failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      toolCalls++;
      history.push(
        `#${toolCalls} ${json.tool}(${JSON.stringify(args).slice(0, 300)}) → ${out.slice(0, RESULT_CHARS)}`,
      );
      feedback = null;
      continue;
    }
    // a result, wrapped as asked or given bare
    const raw = isObj(json) && 'result' in json ? json.result : json;
    const parsed = o.parse(raw);
    if (typeof parsed === 'string') {
      feedback = parsed;
      continue;
    }
    return { value: parsed, calls, toolCalls };
  }
  throw badOutput('the AI did not finish within its calls');
}

/** search_notes and read_note: what the project already holds. */
export function planTools(lookup: StoryLookup): Tool[] {
  return [
    {
      name: 'search_notes',
      description: "searches the project's existing notes (stories, people, places)",
      args: '{"query": string}',
      run: async (a) => {
        const q = typeof a.query === 'string' ? a.query.trim() : '';
        if (!q) return 'give a query';
        const hits = await lookup.search(q);
        return hits.length
          ? hits.map((h) => `- ${h.title} (${h.type}, id ${h.id}): ${h.snippet}`).join('\n')
          : 'nothing found';
      },
    },
    readNote(lookup),
  ];
}

/** read_lines and read_note: the transcript around a story, and a note it mentions. */
export function writeTools(lookup: StoryLookup, lines: readonly Line[]): Tool[] {
  return [
    {
      name: 'read_lines',
      description: 'reads transcript lines, e.g. "L12-L20"',
      args: '{"lines": string}',
      run: async (a) => {
        const r = parseCite(a.lines);
        const shown = r ? lines.filter((l) => l.n >= r.from && l.n <= r.to).slice(0, 200) : [];
        return shown.length ? renderLines(shown) : 'no such lines';
      },
    },
    readNote(lookup),
  ];
}

function readNote(lookup: StoryLookup): Tool {
  return {
    name: 'read_note',
    description: 'reads one note of the project, by its title or id',
    args: '{"note": string}',
    run: async (a) => {
      const key = typeof a.note === 'string' ? a.note.trim() : '';
      const n = key ? await lookup.read(key) : null;
      return n ? `${n.title} (${n.type}, id ${n.id})\n${n.body}` : `no note "${key}"`;
    },
  };
}
