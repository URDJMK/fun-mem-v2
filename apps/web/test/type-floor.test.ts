import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Text never goes below 16px (DESIGN.md): the people Firepit is for read it with older eyes.
 * Every font size written in the app's stylesheets and components is held to that, so a new
 * 13px label fails here instead of shipping.
 */
const FLOOR = 16;
const src = join(__dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** a CSS length in px, at the browser's 16px root; null for anything relative to its parent */
function px(value: string): number | null {
  const m = /^(-?\d*\.?\d+)(px|rem)$/.exec(value.trim());
  if (!m) return null;
  return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
}

/** every size a font-size declaration can come out at: a clamp's smallest, or the value itself */
function sizes(value: string): number[] {
  const clamp = /^clamp\(([^,]+),/.exec(value.trim());
  const min = px(clamp ? clamp[1]! : value);
  return min === null ? [] : [min];
}

function tooSmall(): string[] {
  const out: string[] = [];
  for (const file of files(src)) {
    const text = readFileSync(file, 'utf8');
    const where = (i: number) => `${relative(src, file)}:${text.slice(0, i).split('\n').length}`;
    if (file.endsWith('.css')) {
      for (const m of text.matchAll(/font-size:\s*([^;]+);/g))
        for (const size of sizes(m[1]!)) if (size < FLOOR) out.push(`${where(m.index)} ${m[0]}`);
    }
    if (file.endsWith('.tsx') || file.endsWith('.ts')) {
      for (const m of text.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)\b/g))
        if (Number(m[1]) < FLOOR) out.push(`${where(m.index)} ${m[0]}`);
      for (const m of text.matchAll(/fontSize:\s*'([^']+)'/g))
        for (const size of sizes(m[1]!)) if (size < FLOOR) out.push(`${where(m.index)} ${m[0]}`);
    }
  }
  return out;
}

describe('the type floor', () => {
  it('sets no text below 16px, in any stylesheet or component', () => {
    expect(tooSmall()).toEqual([]);
  });

  it('reads the sizes it checks the way a browser would', () => {
    expect(sizes('13px')).toEqual([13]);
    expect(sizes('0.75rem')).toEqual([12]);
    expect(sizes('clamp(14px, 3vw, 34px)')).toEqual([14]);
    expect(sizes('inherit')).toEqual([]);
  });
});
