import { useId, useMemo, useRef, useState } from 'react';
import { COUNTRY_CODES } from '@funmem/core';

const NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

interface Country {
  code: string;
  name: string;
}

const ALL: Country[] = COUNTRY_CODES.map((code) => ({ code, name: NAMES.of(code) ?? code })).sort(
  (a, b) => a.name.localeCompare(b.name),
);

/** The country this browser says it is in (from en-US, de-AT…), if it says. */
export function browserCountry(): string | null {
  if (typeof navigator === 'undefined') return null;
  for (const tag of [...(navigator.languages ?? []), navigator.language]) {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      if (region && COUNTRY_CODES.includes(region)) return region;
    } catch {
      /* not a language tag: try the next */
    }
  }
  return null;
}

/** The country's name; a value that is not a region code (older projects stored any text) as it is. */
export const countryName = (code: string): string => {
  try {
    return NAMES.of(code) ?? code;
  } catch {
    return code;
  }
};

/** Matches by name or by code; names that start with what was typed come first. */
function search(q: string): Country[] {
  const s = q.trim().toLowerCase();
  if (!s) return ALL;
  const starts: Country[] = [];
  const contains: Country[] = [];
  for (const c of ALL) {
    const n = c.name.toLowerCase();
    if (c.code.toLowerCase() === s || n.startsWith(s)) starts.push(c);
    else if (n.includes(s)) contains.push(c);
  }
  return [...starts, ...contains];
}

/**
 * Choose a country from the official list: type part of its name (or its code) and pick it,
 * with the mouse or the arrow keys and Enter. Only a listed country can be chosen.
 */
export function CountryPicker({
  value,
  onChange,
  onDone,
}: {
  value: string | null;
  onChange: (code: string) => void;
  /** a country was picked, or Escape pressed */
  onDone?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useMemo(() => search(query), [query]);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();

  function pick(c: Country) {
    onChange(c.code);
    setQuery('');
    onDone?.();
  }

  function move(by: number) {
    const next = Math.max(0, Math.min(list.length - 1, active + by));
    setActive(next);
    listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
  }

  return (
    <div className="country-picker">
      <input
        id={`${id}-search`}
        className="input"
        role="combobox"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={list[active] ? `${id}-${list[active].code}` : undefined}
        aria-autocomplete="list"
        aria-label="Search for a country"
        autoFocus
        placeholder="Type a country"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            move(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            move(-1);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (list[active]) pick(list[active]);
          } else if (e.key === 'Escape') {
            onDone?.();
          }
        }}
      />
      <ul
        id={`${id}-list`}
        ref={listRef}
        className="country-list"
        role="listbox"
        aria-label="Countries"
      >
        {list.length === 0 && <li className="country-empty">No country by that name</li>}
        {list.map((c, i) => (
          <li
            key={c.code}
            id={`${id}-${c.code}`}
            role="option"
            aria-selected={c.code === value}
            data-active={i === active}
            onMouseEnter={() => setActive(i)}
            // mousedown, not click: picks before the input loses focus
            onMouseDown={(e) => {
              e.preventDefault();
              pick(c);
            }}
          >
            <span>{c.name}</span>
            <span className="country-code">{c.code}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
