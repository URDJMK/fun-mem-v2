import { describe, expect, it } from 'vitest';
import { COUNTRY_CODES, countryCode } from '../src/countries';

describe('countryCode', () => {
  it('accepts a country in any case and stores it upper-case', () => {
    expect(countryCode('US')).toBe('US');
    expect(countryCode(' gb ')).toBe('GB');
  });

  it('refuses anything that is not an assigned country code', () => {
    for (const bad of ['USA', 'United States', 'ZZ', 'U', '', '  ', null, undefined]) {
      expect(countryCode(bad)).toBeNull();
    }
  });

  it('has every officially assigned code once', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
  });
});
