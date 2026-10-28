import { useEffect, useState } from 'react';
import {
  listEntities,
  type EntitySummary,
  type EntityType,
  type GraphPatch,
  type GraphProposal,
  type ProposedEntity,
} from '../lib/api';

/**
 * The people, places and things an import found, to read over with its stories (graph design
 * 5.1). Everything is kept unless left out; a new one can be renamed ("Noah's mother" → "Mina
 * Kim"), or said to be someone already here. What came only from a story left out is greyed:
 * it goes with that story.
 */
export interface GraphChoices {
  out: Set<string>;
  rename: Record<string, string>;
  same: Record<string, string>;
}

export const NO_CHOICES: GraphChoices = { out: new Set(), rename: {}, same: {} };

export const patchOf = (c: GraphChoices): GraphPatch => ({
  ...(c.out.size ? { leave: [...c.out] } : {}),
  ...(Object.keys(c.rename).length ? { rename: c.rename } : {}),
  ...(Object.keys(c.same).length ? { same: c.same } : {}),
});

const TYPE: Record<EntityType, string> = { person: 'Person', place: 'Place', thing: 'Thing' };

/** how many entities would be saved, given the choices and the stories kept */
export function keptCount(
  graph: GraphProposal,
  choices: GraphChoices,
  storyKept: (story: string) => boolean,
): number {
  return graph.entities.filter(
    (e) => !choices.out.has(e.ref) && e.mentions.some((m) => storyKept(m.story)),
  ).length;
}

export function GraphReview({
  archiveId,
  graph,
  storyTitle,
  storyKept,
  choices,
  onChange,
  standalone = false,
}: {
  archiveId: string;
  /** the button's run, with no stories of its own to save */
  standalone?: boolean;
  graph: GraphProposal;
  storyTitle: (story: string) => string;
  storyKept: (story: string) => boolean;
  choices: GraphChoices;
  onChange: (c: GraphChoices) => void;
}) {
  const [known, setKnown] = useState<EntitySummary[]>([]);
  useEffect(() => {
    let live = true;
    listEntities(archiveId)
      .then((l) => live && setKnown(l))
      .catch(() => {
        /* "same as…" then offers only the AI's candidates */
      });
    return () => {
      live = false;
    };
  }, [archiveId]);

  if (graph.pending) {
    return (
      <section className="card stack" style={{ gap: 6, padding: 13 }} data-testid="graph-review">
        <h2 style={{ fontSize: 16 }}>People, places and things</h2>
        <p className="muted">
          {standalone
            ? 'Could not look through the stories just now. Try again in a few minutes.'
            : 'Not found yet. The stories are saved without them; you can find them later from People, places & things.'}
        </p>
      </section>
    );
  }
  if (graph.entities.length === 0) return null;

  const byRef = new Map(graph.entities.map((e) => [e.ref, e]));
  const nameOf = (ref: string) => choices.rename[ref] ?? byRef.get(ref)?.name ?? '';
  const gone = (e: ProposedEntity) =>
    choices.out.has(e.ref) || !e.mentions.some((m) => storyKept(m.story));
  const toggle = (ref: string) => {
    const out = new Set(choices.out);
    if (out.has(ref)) out.delete(ref);
    else out.add(ref);
    onChange({ ...choices, out });
  };

  return (
    <section
      aria-labelledby="graph-review-h"
      className="card stack"
      style={{ gap: 10, padding: 13 }}
      data-testid="graph-review"
    >
      <div className="stack" style={{ gap: 2 }}>
        <h2 id="graph-review-h" style={{ fontSize: 16 }}>
          People, places and things
        </h2>
        <p className="small muted">
          Found in these stories, and how they relate. They join the project’s graph when you save;
          leave out any that are wrong.
        </p>
      </div>
      <ul className="stack gr-list">
        {graph.entities.map((e) => (
          <EntityRow
            key={e.ref}
            entity={e}
            name={nameOf(e.ref)}
            gone={gone(e)}
            left={choices.out.has(e.ref)}
            same={choices.same[e.ref]}
            known={known.filter((k) => k.type === e.type)}
            storyTitle={storyTitle}
            storyKept={storyKept}
            onToggle={() => toggle(e.ref)}
            onRename={(name) => {
              const rename = { ...choices.rename };
              if (name && name !== e.name) rename[e.ref] = name;
              else delete rename[e.ref];
              onChange({ ...choices, rename });
            }}
            onSame={(id) => {
              const same = { ...choices.same };
              if (id) same[e.ref] = id;
              else delete same[e.ref];
              onChange({ ...choices, same });
            }}
          />
        ))}
      </ul>
      {graph.relationships.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          <h3 style={{ fontSize: 14 }}>How they relate</h3>
          <ul className="stack gr-list">
            {graph.relationships.map((r) => {
              const a = byRef.get(r.a)!;
              const b = byRef.get(r.b)!;
              const off = gone(a) || gone(b) || !storyKept(r.story);
              const left = choices.out.has(r.ref);
              return (
                <li key={r.ref} className={`gr-row${off || left ? ' gr-gone' : ''}`}>
                  <span className="stack" style={{ gap: 1, flex: 1, minWidth: 0 }}>
                    <span>
                      {nameOf(r.a)} — {nameOf(r.b)}
                    </span>
                    <span className="small muted">
                      {r.description} · from “{storyTitle(r.story)}”
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
  known,
  storyTitle,
  storyKept,
  onToggle,
  onRename,
  onSame,
}: {
  entity: ProposedEntity;
  name: string;
  gone: boolean;
  left: boolean;
  same: string | undefined;
  known: EntitySummary[];
  storyTitle: (story: string) => string;
  storyKept: (story: string) => boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onSame: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const chosen = same ? known.find((k) => k.id === same) : undefined;
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
            {TYPE[e.type]} · {status}
          </span>
        </span>
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
              onRename(draft.trim());
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
            <button type="submit" className="btn btn-sm" disabled={!draft.trim()}>
              Rename
            </button>
          </form>
        )}
      </span>
      {!gone || left ? (
        <span className="row" style={{ gap: 4 }}>
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
