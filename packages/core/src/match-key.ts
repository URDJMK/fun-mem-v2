/**
 * The key two names are compared by (graph design 3.2): "Mrs. Han" and "Mrs Han" are one
 * person, "The sewing machine" and "sewing machine" one thing. Unicode NFC, lowercase,
 * everything but letters, digits and their marks read as a space, spacing collapsed, and a
 * leading "the " dropped. Every script is kept as it is.
 */
export function matchKey(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .replace(/^the /, '');
}
