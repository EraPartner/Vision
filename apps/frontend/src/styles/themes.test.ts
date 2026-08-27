import { describe, expect, test } from 'vitest';
import {
  THEME_VARIANTS,
  TOKEN_KEYS,
  isThemeVariant,
  themes,
} from './themes';

function hslToRgb(value: string): [number, number, number] {
  const [h, saturation, lightness] = value.split(/\s+/).map((part) => Number.parseFloat(part));
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const offset = l - chroma / 2;
  const [r, g, b] = h < 60 ? [chroma, x, 0]
    : h < 120 ? [x, chroma, 0]
      : h < 180 ? [0, chroma, x]
        : h < 240 ? [0, x, chroma]
          : h < 300 ? [x, 0, chroma]
            : [chroma, 0, x];
  return [r + offset, g + offset, b + offset];
}

function relativeLuminance(value: string): number {
  const channels = hslToRgb(value).map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

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

  test('keeps the info voice distinct from success and warning in every palette', () => {
    for (const variant of THEME_VARIANTS) {
      for (const mode of ['light', 'dark'] as const) {
        const palette = themes[variant][mode];
        expect(palette.info).not.toBe(palette.success);
        expect(palette.info).not.toBe(palette.warning);
      }
    }
  });

  test('keeps semantic info and warning text AA-readable on cards', () => {
    for (const variant of THEME_VARIANTS) {
      for (const mode of ['light', 'dark'] as const) {
        const palette = themes[variant][mode];
        for (const surface of ['card', 'background'] as const) {
          expect(contrastRatio(palette.info, palette[surface]), `${variant}/${mode} info/${surface}`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(palette.warning, palette[surface]), `${variant}/${mode} warning/${surface}`).toBeGreaterThanOrEqual(4.5);
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
