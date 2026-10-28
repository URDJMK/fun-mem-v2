import { readFileSync } from 'node:fs';
import { createNimChat } from '../src/nim';
import { GRAPH_SYSTEM } from '../src/graph/step';
import { writeStories } from '../src/stories/workflow';
import { parseTranscript } from '../src/transcript';
const base = createNimChat()!;
let n = 0;
const chat = {
  ...base,
  complete: async (system: string, user: string, o?: unknown) => {
    const t0 = Date.now();
    try {
      const out = await (base.complete as Function)(system, user, o);
      if (system.startsWith(GRAPH_SYSTEM)) {
        const { readJson } = await import('../src/stories/tools');
        const { parseGraph } = await import('../src/graph/step');
        const j = readJson(String(out)) as { result?: unknown } | undefined;
        const parsed =
          j === undefined
            ? 'NOT JSON'
            : parseGraph(
                j && typeof j === 'object' && 'result' in j ? j.result : j,
                new Set(['S1', 'S2', 'S3', 'S4']),
              );
        console.log(
          `GRAPH CALL ${++n} (${Date.now() - t0}ms) length ${String(out).length}: ${typeof parsed === 'string' ? parsed : 'parsed ' + parsed.entities.length + ' entities'}`,
        );
        if (typeof parsed === 'string' && String(out).length > 200) {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(
            `/tmp/claude-0/-home-user-fun-mem-v2/fb2abebe-4921-5b2b-aa26-6a36eff75c3c/scratchpad/graph-out-${n + 1}.txt`,
            String(out),
          );
          console.log('HEAD:', String(out).slice(0, 300));
        }
        if (n === 1) console.log('USER TAIL:', user.slice(-600));
      }
      return out;
    } catch (e) {
      if (system.startsWith(GRAPH_SYSTEM))
        console.log(`GRAPH CALL ${++n} FAILED after ${Date.now() - t0}ms: ${String(e)}`);
      throw e;
    }
  },
};
const out = await writeStories(
  parseTranscript(readFileSync('test/fixtures/stories/noah.txt', 'utf8')),
  { teller: 'Noah' },
  {
    chat: chat as never,
    lookup: { search: async () => [], read: async () => null },
    titles: [],
    profiles: [{ noteId: null, name: 'Noah Kim', born: '1971', died: null, aliases: ['Noah'] }],
    graph: {
      lookup: { find: async () => [], read: async () => null },
      known: [{ id: 'subject', name: 'Noah Kim', type: 'person', aliases: ['Noah'] }],
    },
  },
);
console.log(
  'PENDING',
  JSON.stringify(out.graph?.pending),
  'entities',
  out.graph?.entities.length,
  'calls',
  out.stats.stories?.calls,
);
