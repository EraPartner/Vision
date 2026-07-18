/**
 * Cross-workspace route validation pins (ZOD-09).
 *
 * Pins the /rebalance body validation behavior across the zod swap: per-sleeve
 * non-negative Number() coercion, all-zero-sum rejection, model-key lookup,
 * and the model/targetWeights dispatch (a truthy non-object targetWeights is
 * IGNORED, falling through to the model branch).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/services/crossWorkspaceDataService.js', () => ({
  assembleRebalanceInputs: vi.fn(),
}));

import { assembleRebalanceInputs } from '../../src/services/crossWorkspaceDataService.js';
import { ValidationError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/crossWorkspace.js');

const rebalance = (body) => routeHandlers['post:/rebalance']({ body }, createMockResponse());

describe('POST /rebalance validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assembleRebalanceInputs.mockResolvedValue({
      actualValues: { stocks: 600, bonds: 400 },
      availableCash: 100,
      cashAccounts: [],
    });
  });

  it('rejects a non-numeric or negative sleeve weight', async () => {
    await expect(rebalance({ targetWeights: { stocks: 'abc' } }))
      .rejects.toThrow('targetWeights.stocks must be a non-negative number');
    await expect(rebalance({ targetWeights: { stocks: 0.5, bonds: -0.1 } }))
      .rejects.toThrow('targetWeights.bonds must be a non-negative number');
  });

  it('rejects all-zero weights (and an empty record) with the zero-sum message', async () => {
    await expect(rebalance({ targetWeights: { stocks: 0, bonds: 0 } }))
      .rejects.toThrow('targetWeights must include at least one positive weight');
    await expect(rebalance({ targetWeights: {} }))
      .rejects.toThrow('targetWeights must include at least one positive weight');
  });

  it('rejects an unknown model with the preset list', async () => {
    await expect(rebalance({ model: 'yolo' })).rejects.toThrow(/Unknown model 'yolo'.*sixty_forty/);
  });

  it('requires either model or targetWeights', async () => {
    await expect(rebalance({})).rejects.toBeInstanceOf(ValidationError);
    await expect(rebalance({})).rejects.toThrow(/Provide either/);
  });

  it('ignores a truthy non-object targetWeights and falls through to the model branch', async () => {
    await expect(rebalance({ targetWeights: 'garbage' })).rejects.toThrow(/Provide either/);
  });

  it('coerces numeric-string weights and normalizes them to sum to 1', async () => {
    const res = createMockResponse();
    await routeHandlers['post:/rebalance']({ body: { targetWeights: { stocks: '3', bonds: 1 } } }, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.ok).toBe(true);
    expect(payload.data.targetWeights).toEqual({ stocks: 0.75, bonds: 0.25 });
  });

  it('accepts a classic model preset and folds unrepresentable sleeves', async () => {
    const res = createMockResponse();
    await routeHandlers['post:/rebalance']({ body: { model: 'three_fund' } }, res);
    const payload = res.json.mock.calls[0][0];
    // intl_stocks folds into stocks: 0.48 + 0.12 = 0.6
    expect(payload.data.targetWeights.stocks).toBeCloseTo(0.6, 10);
    expect(payload.data.targetWeights.bonds).toBeCloseTo(0.4, 10);
  });

  it('uppercases a string currency and defaults non-strings to EUR', async () => {
    const res = createMockResponse();
    await routeHandlers['post:/rebalance']({ body: { model: 'sixty_forty', currency: 'usd' } }, res);
    expect(res.json.mock.calls[0][0].data.currency).toBe('USD');
    expect(assembleRebalanceInputs).toHaveBeenCalledWith({ currency: 'USD' });

    const res2 = createMockResponse();
    await routeHandlers['post:/rebalance']({ body: { model: 'sixty_forty', currency: 42 } }, res2);
    expect(res2.json.mock.calls[0][0].data.currency).toBe('EUR');
  });
});
