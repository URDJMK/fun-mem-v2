import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index';

describe('@funmem/core scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@funmem/core');
  });
});
