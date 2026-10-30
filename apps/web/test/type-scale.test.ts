import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Five type roles and no others (DESIGN.md): display, title, heading, body and small, each exactly
 * one family, size, weight and line height, set as a `--type-*` token in styles.css. Every other
 * rule takes a role (`font: var(--type-body)`) or inherits one; nothing sets a size, weight, family,
 * line height or letter-spacing of its own, in a stylesheet or inline in a component.
 */
const src = join(__dirname, '..', 'src');
const ROLES = ['display', 'title', 'heading', 'body', 'small'];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** `--type-body: 400 20px/1.55 var(--font-text);` as its parts, or null when it isn't that shape */
export function role(value: string) {
  const m = /^(\d00) (\d+)px\/(\d+(?:\.\d+)?) var\(--font-(display|text)\)$/.exec(value.trim());
  return m
    ? { weight: Number(m[1]), size: Number(m[2]), lineHeight: Number(m[3]), family: m[4] }
    : null;
}

const css = files(src).filter((f) => f.endsWith('.css'));
const code = files(src).filter((f) => /\.tsx?$/.test(f));

describe('the type scale', () => {
  const root = readFileSync(join(src, 'styles.css'), 'utf8');
  const tokens = [...root.matchAll(/--type-([a-z]+):\s*([^;]+);/g)];

  it('has exactly the five roles, each one family, size, weight and line height', () => {
    expect(tokens.map((t) => t[1])).toEqual(ROLES);
    for (const [, name, value] of tokens) expect(role(value!), name).not.toBeNull();
  });

  it('sets type nowhere else in a stylesheet', () => {
    const stray: string[] = [];
    for (const file of css) {
      const text = readFileSync(file, 'utf8');
      const at = (i: number) => `${relative(src, file)}:${text.slice(0, i).split('\n').length}`;
      for (const m of text.matchAll(
        /(?<![\w-])(font-size|font-weight|font-family|line-height|letter-spacing)\s*:/g,
      ))
        stray.push(`${at(m.index)} ${m[1]}`);
      for (const m of text.matchAll(/(?<![\w-])font\s*:\s*([^;]+);/g))
        if (!/^(var\(--type-(display|title|heading|body|small)\)|inherit)$/.test(m[1]!.trim()))
          stray.push(`${at(m.index)} font: ${m[1]}`);
    }
    expect(stray).toEqual([]);
  });

  it('sets type nowhere inline in a component', () => {
    const stray: string[] = [];
    for (const file of code) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(
        /\b(fontSize|fontWeight|fontFamily|lineHeight|letterSpacing|font)\s*:/g,
      ))
        stray.push(`${relative(src, file)}:${text.slice(0, m.index).split('\n').length} ${m[1]}`);
    }
    expect(stray).toEqual([]);
  });

  it('reads a role the way it is written', () => {
    expect(role('400 20px/1.55 var(--font-text)')).toEqual({
      weight: 400,
      size: 20,
      lineHeight: 1.55,
      family: 'text',
    });
    expect(role('bold 20px var(--font-text)')).toBeNull();
  });
});
