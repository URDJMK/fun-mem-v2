import type { Note } from './types';
import { normalizeTitle, TitleResolver } from './validate';
import { extractWikilinks } from './wikilink';

export interface LinkOccurrence {
  /** Source note UUID. */
  sourceId: string;
  /** Link target title as authored (trimmed); empty for self-references. */
  target: string;
  /** Resolved target note UUID, or null while unresolved. */
  resolvedId: string | null;
  heading?: string;
  blockId?: string;
  embed: boolean;
  /** UTF-16 indices into the source body (from extractWikilinks). */
  start: number;
  end: number;
  /** The containing line, trimmed. */
  snippet: string;
}

export interface UnresolvedGroup {
  /** Normalized title (the interview-prompt key, FR-026). */
  title: string;
  occurrences: LinkOccurrence[];
}

const byRowOrder = (a: LinkOccurrence, b: LinkOccurrence) =>
  a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.start - b.start;

function lineAt(body: string, offset: number): string {
  const from = body.lastIndexOf('\n', offset - 1) + 1;
  const nl = body.indexOf('\n', offset);
  return body.slice(from, nl === -1 ? body.length : nl).trim();
}

function push<K>(map: Map<K, LinkOccurrence[]>, key: K, occ: LinkOccurrence): void {
  const list = map.get(key);
  if (list) list.push(occ);
  else map.set(key, [occ]);
}

function drop<K>(map: Map<K, LinkOccurrence[]>, key: K, occ: LinkOccurrence): void {
  const list = map.get(key);
  if (!list) return;
  const next = list.filter((o) => o !== occ);
  if (next.length) map.set(key, next);
  else map.delete(key);
}

/**
 * Derived link layer (spec §9): always rebuildable from notes, never the source of truth.
 * Backlinks are the inversion of forward occurrences — computed, never stored as fact.
 */
export class LinkIndex {
  private notes = new Map<string, Note>();
  private resolver = new TitleResolver();
  private bySource = new Map<string, LinkOccurrence[]>();
  private byTarget = new Map<string, LinkOccurrence[]>();
  private unresolvedMap = new Map<string, LinkOccurrence[]>();

  /** Delete-and-reinsert this source's rows — the unit of the incremental law. */
  upsert(note: Note): void {
    const prev = this.notes.get(note.id);
    this.clearSource(note.id);
    if (prev && normalizeTitle(prev.title) !== normalizeTitle(note.title)) {
      this.resolver.unregister(prev.title, note.id);
      this.demoteIncoming(note.id);
    }
    this.notes.set(note.id, note);
    this.resolver.register(note.title, note.id);
    this.promoteUnresolved(note.title, note.id);

    for (const l of extractWikilinks(note.body)) {
      const occ: LinkOccurrence = {
        sourceId: note.id,
        target: l.target,
        resolvedId: l.target ? this.resolver.resolve(l.target) : note.id, // '' = self-reference
        embed: l.embed,
        start: l.start,
        end: l.end,
        snippet: lineAt(note.body, l.start),
      };
      if (l.heading !== undefined) occ.heading = l.heading;
      if (l.blockId !== undefined) occ.blockId = l.blockId;
      push(this.bySource, note.id, occ);
      if (occ.resolvedId) push(this.byTarget, occ.resolvedId, occ);
      else push(this.unresolvedMap, normalizeTitle(occ.target), occ);
    }
  }

  remove(id: string): void {
    const prev = this.notes.get(id);
    if (!prev) return;
    this.clearSource(id);
    this.notes.delete(id);
    this.resolver.unregister(prev.title, id);
    this.demoteIncoming(id);
  }

  backlinks(id: string): LinkOccurrence[] {
    return [...(this.byTarget.get(id) ?? [])].sort(byRowOrder);
  }

  unresolved(): UnresolvedGroup[] {
    return [...this.unresolvedMap.entries()]
      .map(([title, occ]) => ({ title, occurrences: [...occ].sort(byRowOrder) }))
      .sort((a, b) => (a.title < b.title ? -1 : 1));
  }

  /** Canonical sorted view — the content-equality basis for rebuild==incremental. */
  snapshot(): LinkOccurrence[] {
    return [...this.bySource.values()].flat().sort(byRowOrder);
  }

  static rebuild(notes: Iterable<Note>): LinkIndex {
    const idx = new LinkIndex();
    for (const n of notes) idx.upsert(n);
    return idx;
  }

  private clearSource(id: string): void {
    const rows = this.bySource.get(id) ?? [];
    this.bySource.delete(id);
    for (const occ of rows) {
      if (occ.resolvedId) drop(this.byTarget, occ.resolvedId, occ);
      else drop(this.unresolvedMap, normalizeTitle(occ.target), occ);
    }
  }

  private demoteIncoming(id: string): void {
    const rows = this.byTarget.get(id) ?? [];
    this.byTarget.delete(id);
    for (const occ of rows) {
      occ.resolvedId = null;
      push(this.unresolvedMap, normalizeTitle(occ.target), occ);
    }
  }

  private promoteUnresolved(title: string, id: string): void {
    const key = normalizeTitle(title);
    const rows = this.unresolvedMap.get(key);
    if (!rows) return;
    this.unresolvedMap.delete(key);
    for (const occ of rows) {
      occ.resolvedId = id;
      push(this.byTarget, id, occ);
    }
  }
}
