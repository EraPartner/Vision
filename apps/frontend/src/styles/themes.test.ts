import { describe, expect, test } from 'vitest';
import {
  THEME_VARIANTS,
  TOKEN_KEYS,
  isThemeVariant,
  themes,
} from './themes';

describe('theme variants', () => {
  test('exposes every declared variant', () => {
    for (const variant of THEME_VARIANTS) {
      expect(themes[variant]).toBeDefined();
      expect(themes[variant].light).toBeDefined();
      expect(themes[variant].dark).toBeDefined();
    }
  });

  test('every variant × mode palette defines identical token keys', () => {
    const expected = [...TOKEN_KEYS].sort();
    for (const variant of THEME_VARIANTS) {
      for (const mode of ['light', 'dark'] as const) {
        const keys = Object.keys(themes[variant][mode]).sort();
        expect(keys).toEqual(expected);
      }
    }
  });

  test('every token value is a non-empty string', () => {
    for (const variant of THEME_VARIANTS) {
      for (const mode of ['light', 'dark'] as const) {
        const palette = themes[variant][mode];
        for (const key of TOKEN_KEYS) {
          const value = palette[key];
          expect(typeof value).toBe('string');
          expect(value.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('isThemeVariant narrows unknown input safely', () => {
    expect(isThemeVariant('default')).toBe(true);
    expect(isThemeVariant('dracula')).toBe(true);
    expect(isThemeVariant('matrix-green')).toBe(false);
    expect(isThemeVariant(undefined)).toBe(false);
    expect(isThemeVariant(null)).toBe(false);
    expect(isThemeVariant(42)).toBe(false);
  });
});
