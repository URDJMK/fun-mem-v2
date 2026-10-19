import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index';

describe('@funmem/persona scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@funmem/persona');
  });
});
