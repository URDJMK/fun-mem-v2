/**
 * The story workflow against the real model (PRD 10): `pnpm --filter @funmem/api eval:stories`.
 * Needs NVIDIA_API_KEY. Writes nothing anywhere: it reads the sample transcripts, runs the
 * workflow with an empty project, and prints each story and the numbers PRD 10.2 asks for.
 * Exits 1 if any story it wrote has a sentence without a citation.
 *
 *   eval:stories [name…]   only the named samples (sunja, nell, whisperx)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createNimChat } from '../src/nim';
import type { Profile } from '../src/stories/profile';
import { writeStories } from '../src/stories/workflow';
import { parseTranscript } from '../src/transcript';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SAMPLES: Record<
  string,
  { file: string; opts: Record<string, unknown>; subject?: string; profiles?: Profile[] }
> = {
  sunja: {
    file: here('../../../docs/ingest/samples/grandma-sunja-en.txt'),
    opts: { teller: 'Sunja' },
    // "At eighteen" in "The tin of savings" should become ~1964 (PRD 7.5)
    profiles: [
      {
        noteId: null,
        name: 'Sunja Kim',
        born: '~1946',
        died: null,
        aliases: ['Grandma Sunja', 'Sunja'],
      },
    ],
  },
  nell: { file: here('../test/fixtures/stories/nell.txt'), opts: { teller: 'Nell' } },
  whisperx: {
    file: here('../../../docs/ingest/sample-whisperx.json'),
    opts: {},
    subject: 'Grandma Mae',
  },
};

const chat = createNimChat();
if (!chat) {
  console.error('NVIDIA_API_KEY is not set');
  process.exit(2);
}
const empty = { search: async () => [], read: async () => null };
const wanted = process.argv.slice(2);
const summary: Record<string, unknown> = {};
let uncited = 0;

for (const [name, sample] of Object.entries(SAMPLES)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const raw = readFileSync(sample.file, 'utf8');
  const t0 = Date.now();
  const out = await writeStories(
    parseTranscript(sample.file.endsWith('.json') ? JSON.parse(raw) : raw),
    sample.opts,
    {
      chat,
      lookup: empty,
      titles: [],
      subject: sample.subject ?? null,
      profiles: sample.profiles ?? [],
    },
  );
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  console.log(
    `\n══ ${name} ══ ${out.memories.length} stories in ${secs}s · interview “${out.interviewName ?? '?'}”`,
  );
  if (out.pending) console.log(`   PENDING: ${out.pending.reason}`);
  for (const m of out.memories) {
    console.log(
      `\n── ${m.title}${m.occurred ? ` (${m.occurred}${m.until ? `–${m.until}` : ''}${m.dateBasis ? `: ${m.dateBasis}` : ''})` : ''} · told by ${(m.tellers ?? []).join(', ')}`,
    );
    console.log(m.body.replace(/^/gm, '   '));
    for (const n of m.notes) console.log(`   ! ${n}`);
    uncited += (m.sources ?? []).filter((s) => s.from < 1).length;
  }
  const s = out.stats.stories!;
  const firstTry = s.sentences + s.removed > 0 ? s.sentences / (s.sentences + s.removed) : 1;
  console.log(
    `\n   planned ${s.planned} · written ${s.written} · dropped ${s.dropped} · first-pass stories ${s.firstPass}` +
      ` · sentences ${s.sentences} · removed ${s.removed} · flagged ${s.flagged} · calls ${s.calls}` +
      `\n   problems found in drafts: ${JSON.stringify(s.problems ?? {})}`,
  );
  summary[name] = {
    ...s,
    seconds: secs,
    keptShare: Math.round(firstTry * 100) / 100,
    pending: out.pending?.reason ?? null,
  };
}
console.log(`\nSUMMARY ${JSON.stringify(summary)}`);
process.exit(uncited > 0 ? 1 : 0);
