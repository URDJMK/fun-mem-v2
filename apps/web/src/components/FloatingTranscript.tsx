import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Segment } from '../lib/live';
import { turnsOf } from '../lib/interview';
import { Icon } from './ui';
import { Transcript } from './Transcript';

const SPOT_KEY = 'firepit-transcript-spot';
const OPEN_KEY = 'firepit-transcript-open';

/**
 * Where the box sits: its left edge, and the gap under its bottom edge. Anchored at the bottom
 * so that opening it, and the words that keep arriving, grow it upward, never off the screen.
 */
interface Spot {
  x: number;
  b: number;
}

function readSpot(): Spot | null {
  try {
    const p = JSON.parse(window.localStorage.getItem(SPOT_KEY) ?? 'null') as Spot | null;
    return p && Number.isFinite(p.x) && Number.isFinite(p.b) ? p : null;
  } catch {
    return null;
  }
}

/**
 * The transcript, out of the way: a small box that floats over the page and can be dragged
 * anywhere by its top bar, or folded down to a pill that shows only the latest words. Where it
 * was left, and whether it was open, is remembered in this browser.
 */
export function FloatingTranscript({
  segments,
  names,
  partials,
  live,
}: {
  segments: Segment[];
  names: Map<string, string>;
  partials: Array<{ speaker: string; text: string }>;
  live: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState(readSpot);
  const [open, setOpen] = useState(() => {
    try {
      // folded by default: the words are there when wanted, the assistant is what to look at
      return window.localStorage.getItem(OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch {
      /* not remembered: fine */
    }
  }, [open]);

  // after every change of size (opened, more words, a smaller window) it stays on screen
  useLayoutEffect(() => {
    if (!spot) return;
    const fitted = fit(spot, box.current);
    if (fitted.x !== spot.x || fitted.b !== spot.b) setSpot(fitted);
  });
  useEffect(() => {
    const onResize = () => setSpot((s) => (s ? fit(s, box.current) : s));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function onDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    const r = box.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onMove(e: React.PointerEvent) {
    if (!drag.current || !box.current) return;
    const h = box.current.offsetHeight;
    const top = e.clientY - drag.current.dy;
    setSpot(fit({ x: e.clientX - drag.current.dx, b: window.innerHeight - top - h }, box.current));
  }
  function onUp() {
    if (!drag.current) return;
    drag.current = null;
    try {
      if (spot) window.localStorage.setItem(SPOT_KEY, JSON.stringify(spot));
    } catch {
      /* not remembered: fine */
    }
  }

  const last = turnsOf(segments).at(-1);
  const latest = partials[0] ?? (last ? { speaker: last.speaker, text: last.text } : null);
  const style = spot ? { left: spot.x, bottom: spot.b, right: 'auto', top: 'auto' } : undefined;

  return (
    <div
      ref={box}
      className={open ? 'float-transcript' : 'float-transcript float-transcript-closed'}
      style={style}
      role="region"
      aria-label="Transcript"
    >
      <div
        className="float-head"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <span className={live ? 'float-dot float-dot-live' : 'float-dot'} aria-hidden="true" />
        {open ? (
          <span className="float-title">Transcript</span>
        ) : (
          <span className="float-latest">
            {latest ? (
              <>
                <b>{names.get(latest.speaker) ?? 'Someone'}:</b>{' '}
                {latest.text.split(' ').slice(-14).join(' ')}
              </>
            ) : (
              'Listening…'
            )}
          </span>
        )}
        <button
          type="button"
          className="float-toggle"
          aria-expanded={open}
          aria-label={open ? 'Fold the transcript away' : 'Open the transcript'}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={open ? 'down' : 'up'} size={14} />
        </button>
      </div>
      {open && (
        <div className="float-body" ref={scroller}>
          <Transcript
            segments={segments}
            names={names}
            partials={partials}
            scroller={scroller}
            empty="Listening. Everything said appears here."
          />
        </div>
      )}
    </div>
  );
}

/** Keeps the whole box at least 8 px inside the window. */
function fit(s: Spot, el: HTMLElement | null): Spot {
  const w = el?.offsetWidth ?? 360;
  const h = el?.offsetHeight ?? 48;
  return {
    x: Math.round(Math.min(Math.max(8, s.x), window.innerWidth - w - 8)),
    b: Math.round(Math.min(Math.max(8, s.b), window.innerHeight - h - 8)),
  };
}
