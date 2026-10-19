import {
  budgetEvidence,
  decideAbstention,
  DeterministicExtractiveAnswerProvider,
  distinctSources,
  interleaveBySource,
  selfIdentificationFor,
  validateDraft,
  type AnswerProvider,
  type EvidenceBlock,
} from '@funmem/persona';
import type { App, AppDeps } from './app';
import { isMember } from './membership';
import { hybridQuery } from './search';

/**
 * FM-026 — `POST /v1/archives/:archiveId/ask`.
 *
 * The pipeline is deliberately linear and each stage is refusable:
 *   ACL-filtered retrieval -> evidence assembly -> provider -> validator -> abstention
 *
 * Two orderings in that line are load-bearing rather than incidental.
 *
 * ACL comes FIRST, inside the retrieval query, never as a filter over the
 * answer. FM-027's named shortcut is "strip restricted citations
 * post-generation", and the reason that fails is not tidiness: a model that has
 * read a restricted note can paraphrase it into prose with no citation at all,
 * and there is then nothing left to strip. Restricted content must never reach
 * the prompt.
 *
 * The validator comes AFTER the provider and BEFORE the answer is shaped. Its
 * verdict is the input to abstention, so "citations existed but none checked
 * out" is a reason to decline rather than a reason to answer with fewer
 * citations.
 */

/** Top-N chunks that may enter a prompt, independent of search's MAX_K. */
const EVIDENCE_K = 15;
/** Tokens available for evidence, after the system rules and the question. */
const EVIDENCE_TOKEN_BUDGET = 6000;
const MAX_CLAIMS = 6;

function toEvidence(rows: Array<Record<string, unknown>>): EvidenceBlock[] {
  return rows
    .filter((r) => typeof r.chunk_id === 'string' && typeof r.content === 'string')
    .map((r) => ({
      chunkId: r.chunk_id as string,
      noteId: r.note_id as string,
      noteTitle: (r.title as string) ?? '',
      anchor: (r.anchor as string | null) ?? null,
      headingPath: (r.heading_path as string[]) ?? [],
      chunkIndex: Number(r.chunk_index ?? 0),
      content: r.content as string,
      legs: (r.legs as string[]) ?? [],
      ranks: (r.ranks as Record<string, number>) ?? {},
      score: Number(r.score ?? 0),
      contributor: (r.created_by as string | null) ?? null,
      recorded: (r.revised as string | null) ?? null,
      occurred: (r.occurred as string | null) ?? null,
    }));
}

export function registerAskRoutes(app: App, deps: AppDeps, provider?: AnswerProvider): void {
  // DI at exactly one call site, mirroring main.ts's selectProvider. The real
  // generator, when D-47 is decided, swaps in HERE — never as an env branch
  // inside the pipeline, where the acceptance tier could silently load it.
  const answerer: AnswerProvider = provider ?? new DeterministicExtractiveAnswerProvider();

  app.post('/v1/archives/:archiveId/ask', async (c) => {
    const archiveId = c.req.param('archiveId');
    const userId = c.get('userId');
    if (!archiveId || !(await isMember(deps.pool, userId, archiveId))) {
      return c.json({ error: 'not found' }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as { question?: string; turn?: number };
    const question = (body.question ?? '').trim();
    if (question === '') return c.json({ error: 'question is required' }, 400);
    const turnIndex = Number.isInteger(body.turn) ? (body.turn as number) : 0;

    const rows = await hybridQuery(deps, archiveId, userId, question, EVIDENCE_K, 'grounding');
    // FM-027: interleave by source note BEFORE budgeting, so a single verbose
    // note cannot consume the window and silently exclude a second relative who
    // remembers the same event differently. Strictly downstream of the `allowed`
    // CTE — selecting for diversity before the ACL resolves would leak which
    // restricted notes exist through which sources got represented.
    const retrieved = interleaveBySource(toEvidence(rows));
    const { fitted, relevant } = budgetEvidence(retrieved, EVIDENCE_TOKEN_BUDGET);

    const selfId = selfIdentificationFor(turnIndex);
    const draft = await answerer.answer({
      question,
      evidence: fitted,
      rules: { selfIdentification: selfId ?? '', maxClaims: MAX_CLAIMS },
      turnIndex,
    });

    const validation = validateDraft(draft, fitted);
    const decision = decideAbstention(fitted, fitted.length, relevant, validation, question);

    return c.json({
      // Recorded on every turn the way modelVersion is recorded on every
      // embedding row — an answer whose provider is unknown is unauditable.
      providerVersion: answerer.providerVersion,
      selfIdentification: selfId,
      abstained: decision.abstain,
      reason: decision.reason,
      ...(decision.abstain
        ? { message: decision.message, claims: [] }
        : {
            claims: validation.accepted.map((cl) => ({
              text: cl.text,
              kind: cl.kind,
              citation: cl.citation,
            })),
            // DoD 1, as amended by D-50: disagreement is a RESPONSE SHAPE, not
            // a UI. Claims stay separate and individually cited, and the count
            // of distinct source notes is reported so a client can show two
            // relatives' accounts side by side. The system never says which is
            // right — averaging them into one narrative is what spec §2.3
            // forbids, and detecting contradiction is not possible here at all.
            sources: distinctSources(validation.accepted.map((cl) => cl.citation.noteId)),
            // Stated, not hidden: an answer built from surviving claims when
            // others were dropped is PARTIAL, and FR-084's "unsupported
            // biographical details" is plural for a reason.
            partial: validation.rejected.length > 0,
          }),
      evidence: { relevant, fitted: fitted.length },
    });
  });
}
