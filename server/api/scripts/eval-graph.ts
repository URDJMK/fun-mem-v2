/**
 * The Graph step against the real model (graph design 8): `pnpm --filter @funmem/api eval:graph`.
 * Needs NVIDIA_API_KEY. Writes nothing: it writes the stories of a sample interview with an
 * empty project (only the protagonist known), runs the Graph step, and prints the people,
 * places and things, the relationships, and the checks the design asks for.
 *
 *   eval:graph [name…]   only the named samples (noah, sunja)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matchKey } from '@funmem/core';
import { createNimChat } from '../src/nim';
import type { Profile } from '../src/stories/profile';
import { writeStories } from '../src/stories/workflow';
import { parseTranscript } from '../src/transcript';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
interface Sample {
  file: string;
  teller: string;
  profile: Profile;
  /** what "Done when" asks of it */
  expect: { nodes: string[]; joined: Array<[string, string]>; apart: Array<[string, string]> };
}
const SAMPLES: Record<string, Sample> = {
  noah: {
    file: here('../test/fixtures/stories/noah.txt'),
    teller: 'Noah',
    profile: { noteId: null, name: 'Noah Kim', born: '1971', died: null, aliases: ['Noah'] },
    expect: {
      // "a|b": either name will do (the interview calls the soup both)
      nodes: [
        'noah kim',
        'mother',
        'korea',
        'seaweed soup|miyeokguk',
        'kimchi soup',
        'sarah',
        'tom',
      ],
      joined: [
        ['sarah', 'tom'],
        ['sarah', 'noah kim'],
      ],
      apart: [['noah kim', 'tom']],
    },
  },
  sunja: {
    file: here('../../../docs/ingest/samples/grandma-sunja-en.txt'),
    teller: 'Sunja',
    profile: {
      noteId: null,
      name: 'Sunja Kim',
      born: '~1946',
      died: null,
      aliases: ['Grandma Sunja', 'Sunja'],
    },
    expect: {
      nodes: ['sunja kim', 'busan', 'minho', 'mrs han'],
      joined: [['minho', 'sunja kim']],
      apart: [],
    },
  },
};

const chat = createNimChat();
if (!chat) {
  console.error('NVIDIA_API_KEY is not set');
  process.exit(2);
}
const wanted = process.argv.slice(2);
let failed = 0;

for (const [name, sample] of Object.entries(SAMPLES)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const t0 = Date.now();
  const subject = {
    id: 'subject',
    name: sample.profile.name,
    type: 'person' as const,
    aliases: sample.profile.aliases,
  };
  const out = await writeStories(
    parseTranscript(readFileSync(sample.file, 'utf8')),
    { teller: sample.teller },
    {
      chat,
      lookup: { search: async () => [], read: async () => null },
      titles: [],
      profiles: [sample.profile],
      graph: { lookup: { find: async () => [], read: async () => null }, known: [subject] },
    },
  );
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  console.log(`\n══ ${name} ══ ${out.memories.length} stories in ${secs}s`);
  for (const m of out.memories) {
    console.log(`   ${m.id} ${m.title}`);
    console.log(
      `      ${m.body
        .split('\n\n')
        .filter((p) => !p.startsWith('>'))
        .join(' ')
        .slice(0, 400)}`,
    );
  }
  const g = out.graph;
  if (!g || g.pending) {
    console.log(`   GRAPH PENDING: ${g?.pending?.reason ?? 'not run'}`);
    failed++;
    continue;
  }
  console.log('\n   people, places and things:');
  for (const e of g.entities) {
    console.log(`   - ${e.name} (${e.type}, ${e.match.kind})`);
    for (const m of e.mentions)
      console.log(`       ${m.story} "${m.words.join('", "')}": ${m.line}`);
  }
  console.log('\n   relationships:');
  const nameOf = (ref: string) => g.entities.find((e) => e.ref === ref)?.name ?? ref;
  for (const r of g.relationships)
    console.log(`   - ${nameOf(r.a)} ↔ ${nameOf(r.b)}: ${r.description} (${r.story})`);

  // the checks of "Done when": a name matches when its key holds the expected words
  const has = (want: string) =>
    want.split('|').some((w) => g.entities.some((e) => matchKey(e.name).includes(w)));
  const joined = (a: string, b: string) =>
    g.relationships.some((r) => {
      const x = matchKey(nameOf(r.a));
      const y = matchKey(nameOf(r.b));
      return (x.includes(a) && y.includes(b)) || (x.includes(b) && y.includes(a));
    });
  console.log('\n   checks:');
  for (const n of sample.expect.nodes) {
    const ok = has(n);
    if (!ok) failed++;
    console.log(`   ${ok ? 'PASS' : 'FAIL'} a node for "${n}"`);
  }
  for (const [a, b] of sample.expect.joined) {
    const ok = joined(a, b);
    if (!ok) failed++;
    console.log(`   ${ok ? 'PASS' : 'FAIL'} ${a} — ${b} told`);
  }
  for (const [a, b] of sample.expect.apart) {
    const ok = !joined(a, b);
    if (!ok) failed++;
    console.log(`   ${ok ? 'PASS' : 'FAIL'} no ${a} — ${b} line (joined only through another)`);
  }
  const keys = g.entities.map((e) => `${e.type}:${matchKey(e.name)}`);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length) failed++;
  console.log(
    `   ${dupes.length ? 'FAIL' : 'PASS'} no duplicate names${dupes.length ? `: ${dupes.join(', ')}` : ''}`,
  );
  console.log(`   stories: ${JSON.stringify(out.stats.stories)}`);
  console.log(
    `   graph: ${g.stats?.calls} calls, ${g.stats?.proposed} proposed, ${g.stats?.dropped} left out`,
  );
  for (const l of g.stats?.left ?? []) console.log(`     left out ${l.what}: ${l.why}`);
}
console.log(`\n${failed === 0 ? 'ALL CHECKS PASS' : `${failed} CHECK(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
