import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/middleware/errorHandler.js';
import { resolveRebalanceTargetWeights } from '../src/services/portfolio/rebalanceTargets.js';

function expectValidationError(body, message) {
  expect(() => resolveRebalanceTargetWeights(body)).toThrowError(ValidationError);
  expect(() => resolveRebalanceTargetWeights(body)).toThrowError(message);
}

describe('resolveRebalanceTargetWeights', () => {
  it('coerces numeric strings, folds aliases, and normalizes the result', () => {
    const body = {
      targetWeights: { stocks: '48', intl_stocks: 12, gold: 7.5, commodities: '7.5', bonds: 25 },
    };

    expect(resolveRebalanceTargetWeights(body)).toEqual({ stocks: 0.6, gold: 0.15, bonds: 0.25 });
    expect(body.targetWeights).toEqual({ stocks: '48', intl_stocks: 12, gold: 7.5, commodities: '7.5', bonds: 25 });
  });

  it.each([
    [{ targetWeights: { stocks: 'abc' } }, 'targetWeights.stocks must be a non-negative number'],
    [{ targetWeights: { stocks: -1 } }, 'targetWeights.stocks must be a non-negative number'],
    [{ targetWeights: { stocks: Number.POSITIVE_INFINITY } }, 'targetWeights.stocks must be a non-negative number'],
    [{ targetWeights: {} }, 'targetWeights must include at least one positive weight'],
    [{ targetWeights: { stocks: 0, bonds: 0 } }, 'targetWeights must include at least one positive weight'],
  ])('rejects invalid explicit weights %#', (body, message) => {
    expectValidationError(body, message);
  });

  it('gives an explicit object target precedence over a model', () => {
    expectValidationError(
      { targetWeights: {}, model: 'sixty_forty' },
      'targetWeights must include at least one positive weight',
    );
  });

  it('lets a truthy non-object target fall through to a valid model', () => {
    expect(resolveRebalanceTargetWeights({ targetWeights: 'garbage', model: 'sixty_forty' }))
      .toEqual({ stocks: 0.6, bonds: 0.4 });
  });

  it('rejects an unknown model and a missing target with the existing messages', () => {
    expectValidationError(
      { model: 'yolo' },
      "Unknown model 'yolo' (expected one of: sixty_forty, all_weather, three_fund)",
    );
    expectValidationError({}, 'Provide either `model` or `targetWeights`');
  });
});
