import type { Decade } from '../lib/timeline';

/** The strip of decades: a dot per dated note (up to six), a dashed bar where nothing is known yet. */
export function Decades<T>({
  decades,
  hrefFor,
}: {
  decades: Decade<T>[];
  hrefFor?: (d: number) => string;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <ol className="decades" style={{ minWidth: Math.max(decades.length * 70, 280) }}>
        {decades.map((d) => {
          const gap = d.items.length === 0;
          const label = `${d.start}s`;
          const body = (
            <>
              <span className="decade-dots" aria-hidden="true">
                {d.items.slice(0, 6).map((_, i) => (
                  <span key={i} />
                ))}
              </span>
              <span className="decade-bar" aria-hidden="true" />
              <span className="decade-name">{label}</span>
              <span className="visually-hidden">
                {gap
                  ? ': nothing yet'
                  : `: ${d.items.length} ${d.items.length === 1 ? 'memory' : 'memories'}`}
              </span>
            </>
          );
          return (
            <li key={d.start}>
              {hrefFor && !gap ? (
                <a href={hrefFor(d.start)} className={`decade${gap ? ' gap' : ''}`}>
                  {body}
                </a>
              ) : (
                <span className={`decade${gap ? ' gap' : ''}`}>{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
