/**
 * Dev only (main.tsx loads it under `vite dev`): `?landing=16` swaps the landing page for the
 * redesign in progress (directions/landing/), kept for the tab; `?landing=none` goes back.
 */
const LANDINGS = ['16'];
const KEY = 'firepit-landing';

function chosen(): string | null {
  const asked = new URLSearchParams(window.location.search).get('landing');
  try {
    if (asked === 'none') window.sessionStorage.removeItem(KEY);
    else if (asked) window.sessionStorage.setItem(KEY, asked);
    return asked === 'none' ? null : (asked ?? window.sessionStorage.getItem(KEY));
  } catch {
    return asked === 'none' ? null : asked;
  }
}

const landing = chosen();
if (landing && LANDINGS.includes(landing)) document.documentElement.dataset.landing = landing;

export {};
