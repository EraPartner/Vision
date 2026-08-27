// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { correlationHeatStyle, marketChangeHeatStyle } from '../marketHeat';

describe('market overview heat style', () => {
  it('uses the live gain token for non-negative changes', () => {
    const image = String(marketChangeHeatStyle(3).backgroundImage);
    expect(image).toContain('var(--gain)');
    expect(image).not.toContain('var(--loss)');
    expect(image).not.toContain('rgba(');
  });

  it('uses the live loss token for negative changes', () => {
    const image = String(marketChangeHeatStyle(-3).backgroundImage);
    expect(image).toContain('var(--loss)');
    expect(image).not.toContain('var(--gain)');
  });

  it('does not tint missing quotes', () => {
    expect(marketChangeHeatStyle(undefined)).toEqual({});
  });

  it('uses semantic gain/loss tokens for correlations', () => {
    expect(String(correlationHeatStyle(0.5).backgroundColor)).toContain('var(--gain)');
    expect(String(correlationHeatStyle(-0.5).backgroundColor)).toContain('var(--loss)');
    expect(correlationHeatStyle(null)).toEqual({});
  });
});
