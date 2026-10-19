import { ENTITY_TYPES, type EntityType } from '@funmem/core';

/** What a note is about, in the words the app uses (v1's labels). */
export const TYPE_LABEL: Record<EntityType, string> = {
  person: '사람',
  place: '장소',
  event: '일',
  period: '시절',
  object: '물건',
  source: '자료',
};

export const TYPES: readonly EntityType[] = ENTITY_TYPES;

export function typeLabel(type: string): string {
  return (ENTITY_TYPES as readonly string[]).includes(type) ? TYPE_LABEL[type as EntityType] : type;
}

/**
 * The roles that may add or change memories. The server decides (server/api/src/membership.ts,
 * WRITE_ROLES); this only hides the buttons a reader could not use.
 */
const WRITE_ROLES = ['owner', 'steward', 'contributor'];

export const canWrite = (role: string): boolean => WRITE_ROLES.includes(role);
