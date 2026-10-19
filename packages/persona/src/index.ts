export const PACKAGE_NAME = '@funmem/persona';
export * from './types';
export { buildGroundingPrompt, budgetEvidence, evidenceId, estimateTokens } from './evidence';
export { validateDraft, type ValidationResult } from './validate';
export { decideAbstention, type AbstentionDecision } from './abstain';
export { selfIdentificationFor, SELF_IDENTIFICATION } from './selfid';
export { DeterministicExtractiveAnswerProvider } from './provider-extractive';
export { stripInvisible, hasSmuggledCodepoints } from './sanitize';
export { interleaveBySource, distinctSources } from './diversity';
