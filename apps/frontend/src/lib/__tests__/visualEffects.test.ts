import { describe, it, expect } from 'vitest';
import { isLargeDisplay, resolveEffectiveTier, LARGE_DISPLAY_PHYSICAL_PX } from '@/lib/visualEffects';
import { migrateAppSettings, DEFAULT_APP_SETTINGS } from '@/stores/settingsStore';

describe('isLargeDisplay', () => {
  it('treats a 4K TV in HiDPI "looks like 1080p" mode as large', () => {
    expect(isLargeDisplay(1920, 1080, 2)).toBe(true); // 8.3M physical px
  });

  it('treats a 4K TV at native 1× scaling as large', () => {
    expect(isLargeDisplay(3840, 2160, 1)).toBe(true);
  });

  it('treats the MacBook Air built-in panel as not large', () => {
    expect(isLargeDisplay(1440, 900, 2)).toBe(false); // 5.2M physical px
    expect(isLargeDisplay(1280, 800, 2)).toBe(false);
  });

  it('treats 1080p and QHD externals at 1× as not large', () => {
    expect(isLargeDisplay(1920, 1080, 1)).toBe(false);
    expect(isLargeDisplay(2560, 1440, 1)).toBe(false);
  });

  it('threshold sits between the built-in panel and a 4K output', () => {
    expect(LARGE_DISPLAY_PHYSICAL_PX).toBeGreaterThan(1440 * 900 * 4);
    expect(LARGE_DISPLAY_PHYSICAL_PX).toBeLessThan(1920 * 1080 * 4);
  });
});

describe('resolveEffectiveTier', () => {
  it('caps any tier at reduced on a large display when auto-adapt is on', () => {
    expect(resolveEffectiveTier('enhanced', true, true)).toBe('reduced');
    expect(resolveEffectiveTier('standard', true, true)).toBe('reduced');
    expect(resolveEffectiveTier('reduced', true, true)).toBe('reduced');
  });

  it('keeps the chosen tier on a small display', () => {
    expect(resolveEffectiveTier('enhanced', true, false)).toBe('enhanced');
    expect(resolveEffectiveTier('standard', true, false)).toBe('standard');
  });

  it('respects the manual override when auto-adapt is off', () => {
    expect(resolveEffectiveTier('enhanced', false, true)).toBe('enhanced');
    expect(resolveEffectiveTier('standard', false, true)).toBe('standard');
  });
});

describe('resolveEffectiveTier — session override', () => {
  it('replaces the cap while the cap is active', () => {
    expect(resolveEffectiveTier('standard', true, true, 'enhanced')).toBe('enhanced');
    expect(resolveEffectiveTier('enhanced', true, true, 'standard')).toBe('standard');
  });

  it('lies dormant on a small display — the synced preference governs', () => {
    expect(resolveEffectiveTier('standard', true, false, 'enhanced')).toBe('standard');
  });

  it('lies dormant when auto-adapt is off', () => {
    expect(resolveEffectiveTier('standard', false, true, 'enhanced')).toBe('standard');
  });

  it('still caps at reduced when absent', () => {
    expect(resolveEffectiveTier('enhanced', true, true, undefined)).toBe('reduced');
  });
});

describe('migrateAppSettings', () => {
  it('returns defaults for a missing blob', () => {
    expect(migrateAppSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('maps legacy enhancedEffects=true to the enhanced tier and drops the key', () => {
    const migrated = migrateAppSettings({ enhancedEffects: true });
    expect(migrated.visualEffects).toBe('enhanced');
    expect('enhancedEffects' in migrated).toBe(false);
  });

  it('maps legacy enhancedEffects=false to the standard tier', () => {
    expect(migrateAppSettings({ enhancedEffects: false }).visualEffects).toBe('standard');
  });

  it('lets an explicit visualEffects win over the legacy key', () => {
    const migrated = migrateAppSettings({ enhancedEffects: true, visualEffects: 'reduced' });
    expect(migrated.visualEffects).toBe('reduced');
  });

  it('fills new fields from defaults on old blobs', () => {
    const migrated = migrateAppSettings({ enhancedEffects: true, defaultCurrency: 'USD' });
    expect(migrated.autoAdaptDisplay).toBe(true);
    expect(migrated.defaultCurrency).toBe('USD');
  });
});
