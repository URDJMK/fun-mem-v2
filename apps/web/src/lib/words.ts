import { ENTITY_TYPES, type EntityType } from '@funmem/core';

/** What a note is about, in the words the app shows. */
export const TYPE_LABEL: Record<EntityType, string> = {
  person: 'Person',
  place: 'Place',
  event: 'Event',
  period: 'Period',
  object: 'Object',
  source: 'Source',
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
