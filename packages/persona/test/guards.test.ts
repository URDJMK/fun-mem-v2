import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { block } from './fixtures';
import { selfIdentificationFor } from '../src/selfid';
import { DeterministicExtractiveAnswerProvider } from '../src/provider-extractive';
import { validateDraft } from '../src/validate';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/**
 * Comments are stripped before scanning. The guard is about what the package
 * DOES, and this file's own documentation names `reindexChunks` while
 * explaining why chunk ids are not durable — a comment describing a write path
 * we deliberately avoid is the opposite of a violation. Scanning raw text would
 * have made the guard silenceable by rewording a comment, which is the worst of
 * both worlds: noisy and weak.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sources = () =>
  fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, text: stripComments(fs.readFileSync(path.join(SRC, f), 'utf8')) }));

describe('FM-026 behaviour guards', () => {
  it('the AI self-identifies on the first turn', () => {
    // spec §8.1 / FR-085. The string is injected by CODE on caller-supplied
    // turn state — asking the model to volunteer it makes the guarantee
    // depend on the thing being guarded against.
    const first = selfIdentificationFor(0);
    expect(first, 'no self-identification on the first turn').toBeTruthy();
    expect(first!.length).toBeGreaterThan(4);

    // later turns need not repeat it, but turn 0 always carries it
    expect(selfIdentificationFor(0)).toBe(first);
    expect(selfIdentificationFor(5)).toBeNull();
  });

  it('the persona package cannot write notes revisions or chunks', () => {
    // DoD 5 is a GUARANTEE, and there is no database backstop for it: the
    // append-only trigger fires on update/delete only, and RLS is inert on the
    // API's connection path (one pool, one fixed role, no request.jwt.claims).
    // So the guarantee is structural — no producer exists — and this test is
    // what keeps it that way as the package grows.
    const forbidden = [
      /\binsert\s+into\b/i,
      /\bupdate\s+public\./i,
      /\bdelete\s+from\b/i,
      /appendRevision/,
      /reindexChunks/,
      /reindexLinks/,
    ];
    for (const { file, text } of sources()) {
      for (const re of forbidden) {
        expect(re.test(text), `${file} contains a write path (${re})`).toBe(false);
      }
    }

    // the package must not even import the api's write helpers
    for (const { file, text } of sources()) {
      expect(/from '.*server\/api/.test(text), `${file} imports server/api`).toBe(false);
    }
  });

  it("a prior answer cannot enter a later turn's evidence set", () => {
    // This is how model output launders itself into a "grounded" citation:
    // answer turn 1, store it, retrieve it in turn 2, cite it as testimony.
    // Evidence blocks are supplied per turn by the caller and the validator
    // only ever checks membership in THAT set, so a claim citing a previous
    // answer has nothing to match.
    const turn1Answer = {
      chunkId: 'answer-1',
      noteId: 'answer-note',
      anchor: null,
      grain: 'chunk' as const,
    };
    const draft = {
      selfIdentification: null,
      abstained: false,
      claims: [{ text: '이전 답변에서 말했듯이', kind: 'quote' as const, citation: turn1Answer }],
    };
    // turn 2's evidence contains only real archive chunks
    const r = validateDraft(draft, [block()]);
    expect(r.accepted, 'a prior answer was citable as evidence').toHaveLength(0);
  });

  it('the deterministic provider cites only what it was given', () => {
    // It is a real implementation, not a mock: it selects spans from admitted
    // evidence, so its citations are correct BY CONSTRUCTION. That is what
    // makes it a legitimate default for the acceptance tier.
    const p = new DeterministicExtractiveAnswerProvider();
    const evidence = [block()];
    return p
      .answer({
        question: '할머니는 어디서 태어나셨나요?',
        evidence,
        rules: { selfIdentification: 'AI', maxClaims: 3 },
        turnIndex: 0,
      })
      .then((d) => {
        expect(d.claims.length).toBeGreaterThan(0);
        const v = validateDraft(d, evidence);
        expect(v.rejected, 'the deterministic provider emitted an invalid citation').toHaveLength(
          0,
        );
        expect(v.accepted.length).toBe(d.claims.length);

        // deterministic: same input, same output
        return p
          .answer({
            question: '할머니는 어디서 태어나셨나요?',
            evidence,
            rules: { selfIdentification: 'AI', maxClaims: 3 },
            turnIndex: 0,
          })
          .then((again) => {
            expect(JSON.stringify(again)).toBe(JSON.stringify(d));
          });
      });
  });
});
