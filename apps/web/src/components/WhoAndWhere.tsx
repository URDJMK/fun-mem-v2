import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useNavigate } from 'react-router';
import { getGraph, type EntityType, type GraphNode, type GraphView } from '../lib/api';
import { inArchive } from '../lib/archive';
import { layout, type Point } from '../lib/graph-layout';
import { count, Failed, Loading } from './ui';

/**
 * Home's "Who and where" (graph design 6.1): the people, places and things of the project's
 * stories. Solid lines are relationships the stories tell; dashed lines are being named in the
 * same stories (never through the protagonist, who is in all of them). Someone with no line
 * stands on their own at the edge.
 */
const TYPES: Array<{ type: EntityType; label: string }> = [
  { type: 'person', label: 'People' },
  { type: 'place', label: 'Places' },
  { type: 'thing', label: 'Things' },
];

export function WhoAndWhere({ archiveId }: { archiveId: string }) {
  const [view, setView] = useState<GraphView | null | 'failed'>(null);

  useEffect(() => {
    let live = true;
    getGraph(archiveId)
      .then((v) => live && setView(v))
      .catch(() => live && setView('failed'));
    return () => {
      live = false;
    };
  }, [archiveId]);

  return (
    <section aria-labelledby="who-h" className="card stack wa" data-testid="who-and-where">
      <div className="spread" style={{ gap: 8 }}>
        <h2 id="who-h">Who and where</h2>
        <Link to={inArchive(archiveId, '/people')} className="small">
          People, places &amp; things
        </Link>
      </div>
      {view === null ? (
        <Loading what="Drawing the people and places…" />
      ) : view === 'failed' ? (
        <Failed>Could not draw the people and places just now.</Failed>
      ) : view.nodes.length <= 1 && view.told.length === 0 ? (
        <div className="stack" style={{ gap: 6 }}>
          <p className="muted">
            No people or places yet. They appear as interviews are brought in, or you can find them
            in the stories already saved.
          </p>
          <Link
            to={inArchive(archiveId, '/people?find=1')}
            className="btn btn-outline btn-sm"
            style={{ alignSelf: 'flex-start' }}
          >
            Find them in your stories
          </Link>
        </div>
      ) : (
        <GraphCanvas archiveId={archiveId} view={view} filters />
      )}
    </section>
  );
}

const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** the graph itself: Home's whole graph, or the one around an entity on its page */
export function GraphCanvas({
  archiveId,
  view,
  filters = false,
  height: tall = 440,
}: {
  archiveId: string;
  view: GraphView;
  /** People/Places/Things chips and the same-story switch */
  filters?: boolean;
  height?: number;
}) {
  const navigate = useNavigate();
  // drawn at the frame's own width (so names stay readable on a phone), taller when narrow
  const frame = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(720);
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setMeasured(Math.round(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = Math.max(300, Math.min(900, measured || 720));
  const height = width < 520 ? Math.max(360, Math.round(width * 1.15)) : tall;
  const [shown, setShown] = useState<Set<EntityType>>(new Set(['person', 'place', 'thing']));
  const [together, setTogether] = useState(true);
  const [picked, setPicked] = useState<{ node: string } | { line: string } | null>(null);
  const [box, setBox] = useState({ x: 0, y: 0, w: width, h: height });
  // a new frame size starts the view over
  useEffect(() => setBox({ x: 0, y: 0, w: width, h: height }), [width, height]);
  const drag = useRef<{ x: number; y: number; box: typeof box } | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  const visible = useMemo<GraphView>(() => {
    const keep = new Set(view.nodes.filter((n) => n.subject || shown.has(n.type)).map((n) => n.id));
    const within = (l: { a: string; b: string }) => keep.has(l.a) && keep.has(l.b);
    return {
      nodes: view.nodes.filter((n) => keep.has(n.id)),
      told: view.told.filter(within),
      together: together ? view.together.filter(within) : [],
      more: view.more,
    };
  }, [view, shown, together]);
  const at = useMemo(() => layout(visible, { width, height }), [visible, width, height]);
  const byId = new Map(visible.nodes.map((n) => [n.id, n]));

  const pickedNode = picked && 'node' in picked ? picked.node : null;
  const pickedLine = picked && 'line' in picked ? picked.line : null;
  const near = new Set<string>();
  if (pickedNode) {
    near.add(pickedNode);
    for (const l of [...visible.told, ...visible.together]) {
      if (l.a === pickedNode) near.add(l.b);
      if (l.b === pickedNode) near.add(l.a);
    }
  }
  const dim = (ids: string[]) => pickedNode !== null && !ids.every((i) => near.has(i));
  const open = (id: string) => void navigate(inArchive(archiveId, `/people/${id}`));

  function zoom(by: number) {
    setBox((b) => {
      const w = Math.min(width * 2, Math.max(width / 4, b.w * by));
      const h = (w / width) * height;
      return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
    });
  }
  function onDown(e: ReactPointerEvent<SVGSVGElement>) {
    if ((e.target as Element).closest('[data-node], [data-line]')) return;
    drag.current = { x: e.clientX, y: e.clientY, box };
    svg.current?.setPointerCapture(e.pointerId);
  }
  function onMove(e: ReactPointerEvent<SVGSVGElement>) {
    const d = drag.current;
    const el = svg.current;
    if (!d || !el) return;
    const scale = d.box.w / el.clientWidth;
    setBox({
      ...d.box,
      x: d.box.x - (e.clientX - d.x) * scale,
      y: d.box.y - (e.clientY - d.y) * scale,
    });
  }
  function onUp() {
    if (drag.current && drag.current.box === box) setPicked(null);
    drag.current = null;
  }

  const told = visible.told.find((l) => pairKey(l.a, l.b) === pickedLine);
  const shared = visible.together.find((l) => pairKey(l.a, l.b) === pickedLine);
  const node = pickedNode ? byId.get(pickedNode) : undefined;
  const summary = visible.nodes
    .map((n) => n.name)
    .slice(0, 12)
    .join(', ');

  return (
    <div className="stack" style={{ gap: 8 }}>
      {filters && (
        <div className="row" style={{ gap: 6 }}>
          {TYPES.map((t) => (
            <button
              key={t.type}
              type="button"
              className="chip"
              aria-pressed={shown.has(t.type)}
              onClick={() => {
                const next = new Set(shown);
                if (next.has(t.type)) next.delete(t.type);
                else next.add(t.type);
                setShown(next);
                setPicked(null);
              }}
            >
              {t.label}
            </button>
          ))}
          <label className="row small muted" style={{ gap: 5, marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={together}
              onChange={(e) => setTogether(e.target.checked)}
            />
            Same-story lines
          </label>
        </div>
      )}
      <div className="wa-frame" ref={frame}>
        <svg
          ref={svg}
          className="wa-svg"
          viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
          style={{ aspectRatio: `${width} / ${height}` }}
          role="img"
          aria-label={`People, places and things: ${summary}${visible.nodes.length > 12 ? ', and more' : ''}.`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => (drag.current = null)}
          onWheel={(e) => {
            // a pinch on a trackpad arrives as ctrl + wheel; plain scrolling scrolls the page
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            zoom(e.deltaY > 0 ? 1.1 : 0.9);
          }}
        >
          {visible.together.map((l) => {
            const a = at.get(l.a)!;
            const b = at.get(l.b)!;
            const k = pairKey(l.a, l.b);
            return (
              <g key={`t-${k}`} data-line className={dim([l.a, l.b]) ? 'wa-dim' : undefined}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="wa-together" />
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className="wa-hit"
                  onClick={() => setPicked({ line: k })}
                />
              </g>
            );
          })}
          {visible.told.map((l) => {
            const a = at.get(l.a)!;
            const b = at.get(l.b)!;
            const k = pairKey(l.a, l.b);
            return (
              <g key={`r-${k}`} data-line className={dim([l.a, l.b]) ? 'wa-dim' : undefined}>
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className={pickedLine === k ? 'wa-told wa-picked' : 'wa-told'}
                />
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className="wa-hit"
                  onClick={() => setPicked({ line: k })}
                />
              </g>
            );
          })}
          {visible.nodes.map((n) => (
            <NodeMark
              key={n.id}
              node={n}
              at={at.get(n.id)!}
              picked={pickedNode === n.id}
              dimmed={dim([n.id])}
              onPick={() => (pickedNode === n.id ? open(n.id) : setPicked({ node: n.id }))}
            />
          ))}
        </svg>
        <div className="wa-zoom">
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            aria-label="Zoom in"
            onClick={() => zoom(0.8)}
          >
            +
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            aria-label="Zoom out"
            onClick={() => zoom(1.25)}
          >
            −
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            onClick={() => setBox({ x: 0, y: 0, w: width, h: height })}
          >
            Reset
          </button>
        </div>
      </div>

      {node && (
        <div className="wa-card" role="status">
          <div className="spread" style={{ gap: 6 }}>
            <span>{node.name}</span>
            <Link
              to={inArchive(archiveId, `/people/${node.id}`)}
              className="btn btn-outline btn-sm"
            >
              Open
            </Link>
          </div>
          <span className="small muted">
            {typeLabel(node.type)}
            {node.stories > 0 ? ` · in ${count(node.stories, 'story', 'stories')}` : ''}
          </span>
          {visible.told
            .filter((l) => l.a === node.id || l.b === node.id)
            .flatMap((l) => l.lines)
            .slice(0, 4)
            .map((line) => (
              <span key={line.id} className="small">
                {line.description}
              </span>
            ))}
        </div>
      )}
      {(told || shared) && (
        <div className="wa-card" role="status">
          {told ? (
            told.lines.map((line) => (
              <span key={line.id} className="small">
                {line.description} ·{' '}
                <Link to={inArchive(archiveId, `/stories/${line.storyId}`)}>{line.storyTitle}</Link>
              </span>
            ))
          ) : shared ? (
            <span className="small">
              {byId.get(shared.a)?.name} and {byId.get(shared.b)?.name} are in{' '}
              {count(shared.stories, 'story', 'stories')} together.
            </span>
          ) : null}
        </div>
      )}

      <details className="wa-list">
        <summary className="small">Everyone in it, as a list</summary>
        <ul>
          {visible.nodes.map((n) => (
            <li key={n.id}>
              <Link to={inArchive(archiveId, `/people/${n.id}`)}>{n.name}</Link>{' '}
              <span className="muted small">
                {typeLabel(n.type)}
                {visible.told
                  .filter((l) => l.a === n.id || l.b === n.id)
                  .flatMap((l) => l.lines)
                  .slice(0, 2)
                  .map((l) => ` · ${l.description}`)
                  .join('')}
              </span>
            </li>
          ))}
        </ul>
      </details>
      {view.more > 0 && (
        <Link to={inArchive(archiveId, '/people')} className="small">
          and {view.more} more on People, places &amp; things
        </Link>
      )}
    </div>
  );
}

const typeLabel = (t: EntityType) =>
  t === 'person' ? 'A person' : t === 'place' ? 'A place' : 'A thing';

/** "Sarah Lee" → "SL"; a name made from a relationship by the relation: "Noah Kim's uncle Jae-won" → "UJ" */
const initials = (name: string) =>
  (/['’]s\s+(.+)$/u.exec(name)?.[1] ?? name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => Array.from(w)[0]!.toUpperCase())
    .join('');

function NodeMark({
  node,
  at,
  picked,
  dimmed,
  onPick,
}: {
  node: GraphNode;
  at: Point;
  picked: boolean;
  dimmed: boolean;
  onPick: () => void;
}) {
  // large enough for two initials at the 16px floor
  const r = Math.min(28, 18 + node.stories * 2) + (node.subject ? 4 : 0);
  const cls = `wa-node wa-${node.type}${node.subject ? ' wa-subject' : ''}${picked ? ' wa-picked' : ''}${dimmed ? ' wa-dim' : ''}`;
  return (
    <g
      data-node
      className={cls}
      transform={`translate(${at.x} ${at.y})`}
      onClick={onPick}
      tabIndex={0}
      role="button"
      aria-label={`${node.name}, ${typeLabel(node.type).toLowerCase()}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      }}
    >
      {node.type === 'place' ? (
        <path
          d={`M0 ${r} C ${-r * 0.9} ${r * 0.1}, ${-r} ${-r * 0.4}, ${-r * 0.7} ${-r * 0.75} A ${r} ${r} 0 0 1 ${r * 0.7} ${-r * 0.75} C ${r} ${-r * 0.4}, ${r * 0.9} ${r * 0.1}, 0 ${r} Z`}
        />
      ) : node.type === 'thing' ? (
        <rect x={-r * 0.8} y={-r * 0.8} width={r * 1.6} height={r * 1.6} rx={5} />
      ) : (
        <circle r={r} />
      )}
      <text className="wa-initials" textAnchor="middle" dy="0.35em">
        {initials(node.name)}
      </text>
      <text className="wa-name" textAnchor="middle" y={r + 18}>
        {node.name.length > 22 ? `${node.name.slice(0, 21)}…` : node.name}
      </text>
    </g>
  );
}
