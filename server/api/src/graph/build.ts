import type { AppDeps } from '../app';
import type { IngestResult, StoriesPendingReason } from '../ingest-pipeline';
import { asModelError, type ChatModel } from '../nim';
import { PROFILE_LINE, type Line, type Range } from '../stories/lines';
import { profileBlock, profileLine } from '../stories/profile';
import { profilesFor } from '../stories/profile-store';
import { DEFAULT_STORY_DEADLINE_MS, interviewLines } from '../stories/workflow';
import { parseTranscript } from '../transcript';
import { graphStep, type StoryForGraph } from './step';
import { ensureGraph, entityLookup, knownFor, plainWords } from './store';
import type { GraphProposal } from './types';

/**
 * "Find people, places and things" (graph design 4.4): the Graph step over the project's saved
 * stories, for the same review as an import. A story from an interview is read with its
 * interview's lines, as when it was written; a story written by hand, with its own sentences as
 * its lines. Only what is not in the graph yet is proposed. Nothing is written here.
 */
const CALL_CAP = 200;
/** stories written by hand, read together in batches this size */
const BATCH = 8;

interface SavedStory {
  id: string;
  title: string;
  body: string;
  contributors: string[] | null;
  interview_id: string | null;
  sources: Array<{ sentence: string; from: number; to: number }> | null;
}

class BudgetSpent extends Error {}

const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?]["”’)]?)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

const storyText = (body: string) =>
  plainWords(
    body
      .split('\n\n')
      .filter((p) => !p.trim().startsWith('>'))
      .join(' '),
  );

/** the button's preview is of this format: how its save is told from an import's */
export const GRAPH_FORMAT = 'graph';
/** the button's preview (`req.graph`): only the graph, on stories already saved */
export const isGraphOnly = (o: { format?: string }): boolean => o.format === GRAPH_FORMAT;

export async function buildGraph(
  deps: AppDeps,
  archiveId: string,
  userId: string,
  o: { signal?: AbortSignal; onProgress?: (p: { done: number; total: number }) => void } = {},
): Promise<IngestResult> {
  const pool = deps.pool;
  await ensureGraph(deps, archiveId);
  // the stories every member can read: what they propose is shared with all of them
  const rows = (
    await pool.query(
      `select n.id, n.title, n.body, n.contributors, n.extra->>'interviewId' as interview_id,
              case when jsonb_typeof(n.extra->'sources') = 'array' then n.extra->'sources' end as sources
         from public.notes n
        where n.archive_id = $1 and n.type in ('event', 'period')
          and coalesce((select a.kind from public.audiences a where a.note_id = n.id),
                       'archive-members') <> 'private-to-author'
        order by n.created_at, n.id`,
      [archiveId],
    )
  ).rows as SavedStory[];
  const tellers = [...new Set(rows.flatMap((r) => r.contributors ?? []))];
  const profiles = await profilesFor(pool, archiveId, userId, tellers);
  const profile = profileBlock(profiles);
  const profileRow: Line[] = profiles.length
    ? [
        {
          n: PROFILE_LINE,
          speaker: 'profile',
          name: 'Profile',
          teller: false,
          start: null,
          end: null,
          text: profileLine(profiles),
        },
      ]
    : [];
  const known = await knownFor(pool, archiveId, userId, tellers);
  const lookup = entityLookup(pool, archiveId, userId);
  const project = (
    await pool.query(`select subject_name, kind::text as kind from public.archives where id = $1`, [
      archiveId,
    ])
  ).rows[0] as { subject_name: string; kind: string };

  // groups: one per interview, and the hand-written stories in batches
  const byInterview = new Map<string, SavedStory[]>();
  const byHand: SavedStory[] = [];
  for (const r of rows) {
    if (r.interview_id && r.sources?.length) {
      const list = byInterview.get(r.interview_id) ?? [];
      list.push(r);
      byInterview.set(r.interview_id, list);
    } else {
      byHand.push(r);
    }
  }
  const groups: Array<() => Promise<Parameters<typeof graphStep>[0] | null>> = [];
  for (const [interviewId, stories] of byInterview) {
    groups.push(async () => {
      const i = (
        await pool.query(`select transcript, options from public.interviews where id = $1`, [
          interviewId,
        ])
      ).rows[0] as { transcript: string; options: Record<string, unknown> } | undefined;
      if (!i) return null;
      let raw: unknown = i.transcript;
      if (/^\s*[{[]/.test(i.transcript)) {
        try {
          raw = JSON.parse(i.transcript) as unknown;
        } catch {
          /* a text transcript that starts with a bracket */
        }
      }
      const { lines, names } = interviewLines(
        parseTranscript(raw),
        i.options,
        project.kind === 'personal' ? project.subject_name : null,
      );
      return {
        ...common(),
        stories: stories.map((s): StoryForGraph => {
          const cites = s.sources!.map((x) => ({ from: x.from, to: x.to }));
          return {
            ref: s.id,
            title: s.title,
            text: storyText(s.body),
            sentences: s.sources!.map((x) => ({
              text: x.sentence,
              cites: [{ from: x.from, to: x.to }],
            })),
            ranges: [
              {
                from: Math.max(1, Math.min(...cites.map((c) => c.from)) - 1),
                to: Math.max(...cites.map((c) => c.to)),
              },
            ],
            tellers: s.contributors ?? [],
          };
        }),
        lines: [...profileRow, ...lines],
        names: [...names.map(([, n]) => n), ...lines.map((l) => l.name)],
        sourceOf: (r: Range) => [{ interviewId, from: r.from, to: r.to }],
      };
    });
  }
  for (let at = 0; at < byHand.length; at += BATCH) {
    const batch = byHand.slice(at, at + BATCH);
    groups.push(async () => {
      // each story's sentences are its lines, numbered on from the last story's
      const lines: Line[] = [];
      const where = new Map<number, { noteId: string; sentence: number }>();
      const stories = batch.map((s): StoryForGraph => {
        const text = storyText(s.body);
        const from = lines.length + 1;
        const sentences = sentencesOf(text).map((t, k) => {
          const n = lines.length + 1;
          lines.push({
            n,
            speaker: 'story',
            name: s.title,
            teller: true,
            start: null,
            end: null,
            text: t,
          });
          where.set(n, { noteId: s.id, sentence: k });
          return { text: t, cites: [{ from: n, to: n }] };
        });
        return {
          ref: s.id,
          title: s.title,
          text,
          sentences,
          ranges: [{ from, to: Math.max(from, lines.length) }],
          tellers: s.contributors ?? [],
        };
      });
      return {
        ...common(),
        stories: stories.filter((s) => s.sentences.length > 0),
        lines: [...profileRow, ...lines],
        names: [],
        sourceOf: (r: Range) => {
          const out: Array<{ noteId: string; sentence: number }> = [];
          for (let n = r.from; n <= r.to; n++) {
            const w = where.get(n);
            if (w) out.push(w);
          }
          return out;
        },
      };
    });
  }

  // one budget and one deadline for the whole run, as an import's
  const stop = new AbortController();
  let outOfTime = false;
  const timer = setTimeout(() => {
    outOfTime = true;
    stop.abort();
  }, DEFAULT_STORY_DEADLINE_MS);
  timer.unref?.();
  const onCancel = () => stop.abort();
  o.signal?.addEventListener('abort', onCancel, { once: true });
  let calls = 0;
  const counted = (m: ChatModel): ChatModel => ({
    id: m.id,
    queued: m.queued,
    complete: async (system, user, opts) => {
      if (calls >= CALL_CAP) throw new BudgetSpent();
      calls++;
      return m.complete(system, user, opts);
    },
  });
  function common() {
    const chat = counted(deps.chat!);
    return {
      chat,
      judge: chat,
      profile,
      known,
      lookup,
      signal: stop.signal,
    };
  }

  const all: GraphProposal = {
    entities: [],
    relationships: [],
    stats: { calls: 0, proposed: 0, dropped: 0, left: [] },
  };
  let pending: StoriesPendingReason | undefined;
  try {
    if (!deps.chat) {
      pending = 'no_model';
    } else {
      let done = 0;
      o.onProgress?.({ done, total: groups.length });
      for (const group of groups) {
        const input = await group();
        if (input && input.stories.length > 0) {
          const p = await graphStep(input);
          const fresh = await onlyNew(pool, archiveId, p);
          const shift = all.entities.length;
          const ref = (r: string) => `e${Number(r.slice(1)) + shift}`;
          all.entities.push(...fresh.entities.map((e) => ({ ...e, ref: ref(e.ref) })));
          all.relationships.push(
            ...fresh.relationships.map((r, k) => ({
              ...r,
              ref: `r${all.relationships.length + k + 1}`,
              a: ref(r.a),
              b: ref(r.b),
            })),
          );
          all.stats!.proposed += p.stats?.proposed ?? 0;
          all.stats!.dropped += p.stats?.dropped ?? 0;
          all.stats!.left!.push(...(p.stats?.left ?? []));
        }
        o.onProgress?.({ done: ++done, total: groups.length });
      }
    }
  } catch (e) {
    if (o.signal?.aborted) throw e;
    pending =
      e instanceof BudgetSpent
        ? 'budget'
        : outOfTime
          ? 'deadline'
          : (() => {
              const kind = asModelError(e).kind;
              return kind === 'auth'
                ? 'auth'
                : kind === 'bad_output' || kind === 'truncated'
                  ? 'bad_plan'
                  : 'unavailable';
            })();
    // what earlier groups found still stands
    if (all.entities.length > 0) pending = undefined;
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onCancel);
  }
  all.stats!.calls = calls;
  if (pending) all.pending = { reason: pending };
  return {
    format: GRAPH_FORMAT,
    providerVersion: deps.chat?.id ?? 'no-model',
    interviewee: '',
    interviewees: [],
    speakers: [],
    roles: { source: 'sender', confidence: 'high', reasons: [], needsConfirmation: false },
    warnings: [],
    degraded: { windows: 0, reasons: [] },
    source: 'People, places and things',
    sourceHash: '',
    memories: [],
    graph: all,
    stats: {
      turns: 0,
      intervieweeTurns: 0,
      windows: groups.length,
      failedWindows: 0,
      rounds: 0,
      retried: 0,
      exit: pending === 'no_model' ? 'no_model' : 'converged',
      coverage: { covered: 0, total: 0 },
    },
  };
}

/**
 * What the graph does not hold yet: a mention of an entity already in a story is not proposed
 * again, nor a relationship between two entities already told by that story.
 */
async function onlyNew(
  pool: AppDeps['pool'],
  archiveId: string,
  p: GraphProposal,
): Promise<GraphProposal> {
  const existing = (e: GraphProposal['entities'][number]) =>
    e.match.kind === 'existing' ? e.match.entityId : null;
  const ids = p.entities.map(existing).filter((x): x is string => x !== null);
  const mentioned = new Set(
    (
      await pool.query(
        `select entity_id || ':' || note_id as k from public.graph_mentions
          where archive_id = $1 and entity_id = any($2::uuid[])`,
        [archiveId, ids],
      )
    ).rows.map((r: { k: string }) => r.k),
  );
  const told = new Set(
    (
      await pool.query(
        `select least(a_id, b_id) || ':' || greatest(a_id, b_id) || ':' || note_id as k
           from public.graph_relationships
          where archive_id = $1 and a_id = any($2::uuid[]) and b_id = any($2::uuid[])`,
        [archiveId, ids],
      )
    ).rows.map((r: { k: string }) => r.k),
  );
  const entities = p.entities
    .map((e) => {
      const id = existing(e);
      return id
        ? { ...e, mentions: e.mentions.filter((m) => !mentioned.has(`${id}:${m.story}`)) }
        : e;
    })
    // an entity already here with nothing new to say is left out; its relationships may stay
    .filter(
      (e) => e.mentions.length > 0 || p.relationships.some((r) => r.a === e.ref || r.b === e.ref),
    );
  const kept = new Map(entities.map((e) => [e.ref, existing(e)]));
  const relationships = p.relationships.filter((r) => {
    if (!kept.has(r.a) || !kept.has(r.b)) return false;
    const a = kept.get(r.a);
    const b = kept.get(r.b);
    if (!a || !b) return true;
    return !told.has(`${a < b ? a : b}:${a < b ? b : a}:${r.story}`);
  });
  // an entity already here kept only for a relationship no longer proposed goes too
  const needed = new Set(relationships.flatMap((r) => [r.a, r.b]));
  return {
    ...p,
    entities: entities.filter((e) => e.mentions.length > 0 || needed.has(e.ref)),
    relationships,
  };
}
