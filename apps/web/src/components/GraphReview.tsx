import { useEffect, useState } from 'react';
import {
  listEntities,
  type EntitySummary,
  type EntityType,
  type GraphProposal,
  type ProposedEntity,
} from '../lib/api';
import {
  cleanRename,
  entityKept,
  renameConflict,
  reviewedGraph,
  type GraphChoices,
} from '../lib/graph-review';
export { keptCount, NO_CHOICES, patchOf, type GraphChoices } from '../lib/graph-review';

/**
 * The people, places and things an import found, to read over with its stories (graph design
 * 5.1). Everything is kept unless left out; a new one can be renamed ("Noah's mother" → "Mina
 * Kim"), or said to be someone already here. An import's notes stay when a story is left out;
 * the older button's entities go with their last story.
 */
const TYPE: Record<EntityType, string> = { person: 'Person', place: 'Place', thing: 'Thing' };

export function GraphReview({
  archiveId,
  graph,
  storyTitle,
  storyKept,
  choices,
  onChange,
  standalone = false,
  knownEntities,
  noteTitles,
}: {
  archiveId: string;
  /** the button's run, with no stories of its own to save */
  standalone?: boolean;
  knownEntities?: EntitySummary[];
  noteTitles?: ReadonlyMap<string, string>;
  graph: GraphProposal;
  storyTitle: (story: string) => string;
  storyKept: (story: string) => boolean;
  choices: GraphChoices;
  onChange: (c: GraphChoices) => void;
}) {
  const [known, setKnown] = useState<EntitySummary[]>([]);
  useEffect(() => {
    if (knownEntities) return;
    let live = true;
    listEntities(archiveId)
      .then((l) => live && setKnown(l))
      .catch(() => {
        /* "same as…" then offers only the AI's candidates */
      });
    return () => {
      live = false;
    };
  }, [archiveId, knownEntities]);

  if (graph.pending) {
    return (
      <section className="card stack" style={{ gap: 6, padding: 13 }} data-testid="graph-review">
        <h2>People, places and things</h2>
        <p className="muted">
          {standalone
            ? 'Could not look through the stories just now. Try again in a few minutes.'
            : 'Not found yet. The stories are saved without them; you can find them later from People, places & things.'}
        </p>
      </section>
    );
  }
  if (!graph.entities.some((e) => !e.subject)) return null;

  const available = knownEntities ?? known;
  const byRef = new Map(graph.entities.map((e) => [e.ref, e]));
  const reviewed = new Map(
    reviewedGraph(graph, choices, storyKept).entities.map((e) => [e.ref, e]),
  );
  const nameOf = (ref: string) => reviewed.get(ref)?.name ?? byRef.get(ref)?.name ?? '';
  const gone = (e: ProposedEntity) => !entityKept(e, choices, storyKept);
  const toggle = (ref: string) => {
    const out = new Set(choices.out);
    if (out.has(ref)) out.delete(ref);
    else out.add(ref);
    onChange({ ...choices, out });
  };
  const toggleParagraph = (ref: string) => {
    const paragraphOut = new Set(choices.paragraphOut);
    if (paragraphOut.has(ref)) paragraphOut.delete(ref);
    else paragraphOut.add(ref);
    onChange({ ...choices, paragraphOut });
  };

  return (
    <section
      aria-labelledby="graph-review-h"
      className="card stack"
      style={{ gap: 10, padding: 13 }}
      data-testid="graph-review"
    >
      <div className="stack" style={{ gap: 2 }}>
        <h2 id="graph-review-h">People, places and things</h2>
        <p className="small muted">
          Found in these stories, and how they relate. They join the project’s graph when you save;
          leave out any that are wrong.
        </p>
      </div>
      <ul className="stack gr-list">
        {graph.entities
          .filter((e) => !e.subject)
          .map((e) => (
            <EntityRow
              key={e.ref}
              entity={e}
              name={nameOf(e.ref)}
              gone={gone(e)}
              left={choices.out.has(e.ref)}
              same={choices.same[e.ref]}
              paragraphOut={choices.paragraphOut.has(e.ref)}
              known={available.filter((k) => k.type === e.type)}
              noteTitles={noteTitles}
              requestedName={choices.rename[e.ref]}
              conflictFor={(name) => renameConflict(e, graph, choices, storyKept, name)}
              storyTitle={storyTitle}
              storyKept={storyKept}
              onToggle={() => toggle(e.ref)}
              onParagraphToggle={() => toggleParagraph(e.ref)}
              onRename={(name) => {
                const rename = { ...choices.rename };
                const cleaned = cleanRename(name);
                if (cleaned && cleaned !== e.name) rename[e.ref] = cleaned;
                else delete rename[e.ref];
                onChange({ ...choices, rename });
              }}
              onSame={(id) => {
                const same = { ...choices.same };
                if (id) same[e.ref] = id;
                else delete same[e.ref];
                // the paragraph choice belonged to the note picked before
                const paragraphOut = new Set(choices.paragraphOut);
                paragraphOut.delete(e.ref);
                onChange({ ...choices, same, paragraphOut });
              }}
            />
          ))}
      </ul>
      {graph.relationships.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <h3>How they relate</h3>
          <ul className="stack gr-list">
            {graph.relationships.map((r) => {
              const a = byRef.get(r.a);
              const b = byRef.get(r.b);
              if (!a || !b) return null;
              const storyLeft = r.story !== null && !storyKept(r.story);
              const fromInterview = r.story === null || (storyLeft && !!a.note);
              const off = gone(a) || gone(b) || (storyLeft && !a.note);
              const left = choices.out.has(r.ref);
              return (
                <li key={r.ref} className={`gr-row${off || left ? ' gr-gone' : ''}`}>
                  <span className="stack" style={{ gap: 1, flex: 1, minWidth: 0 }}>
                    <span>
                      {nameOf(r.a)} — {nameOf(r.b)}
                    </span>
                    <span className="small muted">
                      {r.description} ·{' '}
                      {fromInterview ? 'from the interview' : `from “${storyTitle(r.story!)}”`}
                    </span>
                  </span>
                  {!off && (
                    <button
                      type="button"
                      className="btn btn-quiet btn-sm"
                      aria-pressed={left}
                      onClick={() => toggle(r.ref)}
                    >
                      {left ? 'Keep it' : 'Leave it out'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function EntityRow({
  entity: e,
  name,
  gone,
  left,
  same,
  paragraphOut,
  known,
  noteTitles,
  requestedName,
  conflictFor,
  storyTitle,
  storyKept,
  onToggle,
  onParagraphToggle,
  onRename,
  onSame,
}: {
  entity: ProposedEntity;
  name: string;
  gone: boolean;
  left: boolean;
  same: string | undefined;
  paragraphOut: boolean;
  known: EntitySummary[];
  noteTitles?: ReadonlyMap<string, string>;
  requestedName?: string;
  conflictFor: (name: string | undefined) => ProposedEntity | undefined;
  storyTitle: (story: string) => string;
  storyKept: (story: string) => boolean;
  onToggle: () => void;
  onParagraphToggle: () => void;
  onRename: (name: string) => void;
  onSame: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(requestedName ?? name);
  const chosen = same ? known.find((k) => k.id === same) : undefined;
  const noteTitle = chosen?.noteId
    ? (noteTitles?.get(chosen.noteId) ?? chosen.name)
    : !same && e.note?.kind === 'existing'
      ? e.note.title
      : undefined;
  const hasDescription = (e.description?.length ?? 0) > 0;
  const canParagraph = !!e.note && !!noteTitle && hasDescription && !chosen?.subject;
  const badge = e.note
    ? noteTitle
      ? `${hasDescription && !paragraphOut ? 'Adds to' : 'Links to'} “${noteTitle}”`
      : 'New note'
    : undefined;
  const conflict = conflictFor(renaming ? draft : requestedName);
  const attempted = cleanRename(renaming ? draft : requestedName);
  const status = chosen
    ? `The same as “${chosen.name}”`
    : e.match.kind === 'existing'
      ? `Already here as “${e.match.name}”`
      : e.match.kind === 'ask'
        ? `Is this ${e.match.candidates.map((c) => `“${c.name}”`).join(' or ')}?`
        : 'New';
  const options = [
    ...(e.match.kind === 'ask'
      ? e.match.candidates.map((c) => ({ id: c.entityId, name: c.name }))
      : []),
    ...known.map((k) => ({ id: k.id, name: k.name })),
  ].filter((o, i, all) => all.findIndex((x) => x.id === o.id) === i);

  return (
    <li className={`gr-row${gone ? ' gr-gone' : ''}`} data-testid="graph-entity">
      <span className="stack" style={{ gap: 2, flex: 1, minWidth: 0 }}>
        <span className="row" style={{ gap: 6 }}>
          <strong>{name}</strong>
          <span className={`pill ${e.match.kind === 'new' && !chosen ? 'pill-keep' : 'pill-sage'}`}>
            {TYPE[e.type]} · {badge ?? status}
          </span>
        </span>
        {hasDescription && (
          <span className={`small muted${canParagraph && paragraphOut ? ' gr-paragraph-out' : ''}`}>
            {e.description!.map((s) => s.text).join(' ')}
          </span>
        )}
        {left && e.note?.kind === 'new' && (
          <span className="small">Its links in the stories become plain words</span>
        )}
        {conflict && (
          <span className="small" role="alert">
            “{attempted}” is also the name of a kept {TYPE[conflict.type].toLowerCase()}. This
            rename will be ignored.
          </span>
        )}
        {e.mentions.map((m) => (
          <span key={m.story} className={`small${storyKept(m.story) ? '' : ' muted'}`}>
            “{m.words.join('”, “')}” in {storyTitle(m.story)}
            {m.line ? `: ${m.line}` : ''}
          </span>
        ))}
        {renaming && (
          <form
            className="row"
            style={{ gap: 6 }}
            onSubmit={(ev) => {
              ev.preventDefault();
              onRename(cleanRename(draft));
              setRenaming(false);
            }}
          >
            <input
              className="input"
              style={{ flex: '1 1 160px' }}
              aria-label={`A new name for ${name}`}
              value={draft}
              onChange={(ev) => setDraft(ev.target.value)}
              autoFocus
            />
            <button type="submit" className="btn btn-sm" disabled={!cleanRename(draft)}>
              Rename
            </button>
          </form>
        )}
      </span>
      {!gone || left ? (
        <span className="row" style={{ gap: 4 }}>
          {!left && canParagraph && (
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              aria-pressed={paragraphOut}
              onClick={onParagraphToggle}
            >
              {paragraphOut ? 'Keep the paragraph' : 'Leave the paragraph out'}
            </button>
          )}
          {!left && e.match.kind !== 'existing' && (
            <>
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                onClick={() => setRenaming(!renaming)}
              >
                Rename
              </button>
              {options.length > 0 && (
                <select
                  className="input gr-same"
                  aria-label={`${name} is the same as`}
                  value={same ?? ''}
                  onChange={(ev) => onSame(ev.target.value)}
                >
                  <option value="">{e.match.kind === 'ask' ? 'Someone new' : 'Same as…'}</option>
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            aria-pressed={left}
            onClick={onToggle}
          >
            {left ? 'Keep it' : 'Leave it out'}
          </button>
        </span>
      ) : null}
    </li>
  );
}
