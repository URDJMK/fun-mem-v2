export const PACKAGE_NAME = '@funmem/core';

export * from './types';
export { formatFuzzyDate, isIsoDateTime, parseFuzzyDate } from './dates';
export { noteFromMarkdown, noteToMarkdown } from './frontmatter';
export { ensureAnchor, extractAnchors, findDuplicateAnchors, type BlockAnchor } from './anchors';
export { extractWikilinks, type Wikilink } from './wikilink';
export {
  canonicalTitle,
  normalizeTitle,
  TitleResolver,
  validateFrontmatter,
  type ValidationResult,
} from './validate';
export { LinkIndex, type LinkOccurrence, type UnresolvedGroup } from './linkIndex';
export { renameLinkTargets, validateNoteTitle } from './rename';
export { chunkNote, type Chunk } from './chunk';
export { checkFragment, extractHeadingPaths } from './fragments';
export { DeterministicEmbeddingProvider, type EmbeddingProvider } from './embedding';
export { COUNTRY_CODES, countryCode } from './countries';
export { parseProfileInput, readProfile, saidDate, type ProfileFields } from './profile';
