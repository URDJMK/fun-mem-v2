/**
 * The mark's shapes, for drawing it at scale and moving it: the hand-cut glow and bowl of the
 * logo, and the pebbles a voice moves through (the landing page, and the interview's control).
 */
/**
 * A hand-cut pebble in a 256 box, the same family as the logo's glow: points around a circle,
 * each pushed in or out a little, joined by a smooth closed curve. The same seed always cuts the
 * same pebble, and every pebble has the same number of points, so any two morph cleanly.
 */
export function pebble(seed: number, wobble = 0.14, squash = 0.88, n = 9): string {
  let s = (seed * 7919) % 233280;
  const rand = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.35;
    const r = 96 * (1 + (rand() - 0.5) * 2 * wobble);
    return [128 + Math.cos(a) * r, 128 + Math.sin(a) * r * squash] as const;
  });
  const at = (i: number) => pts[(i + n) % n]!;
  const f = (v: number) => v.toFixed(1);
  let d = `M${f(at(0)[0])} ${f(at(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

/** the pebbles a voice moves through while it talks */
export const VOICE_SHAPES = [3, 11, 19, 27, 35].map((seed) => pebble(seed, 0.16));

/** the logo's glow and bowl, at full scale, for the scenes that start from the mark */
export const MARK_GLOW =
  'M188.9 106.6C186.5 119.8 174.4 134.5 162.9 142.4C151.4 150.3 133.9 155.3 119.8 153.9C105.7 152.6 86.7 144.9 78.1 134.3C69.5 123.7 65.5 103.7 68.1 90.5C70.6 77.2 82 63.2 93.4 54.9C104.8 46.7 122.5 39.7 136.5 41C150.5 42.4 168.8 52 177.5 63C186.3 73.9 191.3 93.4 188.9 106.6Z';
export const MARK_BOWL =
  'M29 147C30.6 151.5 34.7 161.8 39.2 168.3C43.6 174.7 49.4 180.7 55.7 185.7C62.1 190.8 69.5 195.1 77.2 198.5C84.8 202 93.3 204.6 101.8 206.3C110.3 208.1 119.3 209 128 209C136.7 209 145.7 208.1 154.2 206.3C162.7 204.6 171.2 202 178.8 198.5C186.5 195.1 193.9 190.8 200.3 185.7C206.6 180.7 212.4 174.7 216.8 168.3C221.3 161.8 225.4 151.5 227 147C228.7 142.5 227.5 142.9 226.8 141.3C226 139.7 224.2 138 222.6 137.4C220.9 136.8 218.4 136.9 216.8 137.7C215.2 138.4 215.3 138.8 213 141.9C210.6 145 206.7 152.2 202.5 156.3C198.3 160.4 193.1 163.7 187.6 166.6C182.1 169.5 176 171.7 169.6 173.6C163.2 175.4 156.3 176.7 149.3 177.6C142.4 178.5 135.1 179 128 179C120.9 179 113.6 178.5 106.7 177.6C99.7 176.7 92.8 175.4 86.4 173.6C80 171.7 73.9 169.5 68.4 166.6C62.9 163.7 57.7 160.4 53.5 156.3C49.3 152.2 45.4 145 43 141.9C40.7 138.8 40.8 138.4 39.2 137.7C37.6 136.9 35.1 136.8 33.4 137.4C31.8 138 30 139.7 29.2 141.3C28.5 142.9 27.3 142.5 29 147Z';

/** a path of absolute M and C commands, moved by (dx, dy) */
function shift(d: string, dx: number, dy: number): string {
  let i = 0;
  return d.replace(/-?\d+(?:\.\d+)?/g, (n) => (Number(n) + (i++ % 2 === 0 ? dx : dy)).toFixed(1));
}

/**
 * The glow alone, centred in its 256 box like the pebbles (in the mark it sits high, in the
 * bowl), so it can turn into them and back without drifting.
 */
export const GLOW_CENTRED = shift(MARK_GLOW, 0, 31);
