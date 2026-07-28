/**
 * Cross-workspace route validation pins (ZOD-09).
 *
 * Pins the /rebalance body validation behavior across the zod swap: per-sleeve
 * non-negative Number() coercion, all-zero-sum rejection, model-key lookup,
 * and the model/targetWeights dispatch (a truthy non-object targetWeights is
 * IGNORED, falling through to the model branch).
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeAgent, errEnvelope } from '../helpers/routeApp.js';

vi.mock('../../src/services/crossWorkspaceDataService.js', () => ({
  assembleRebalanceInputs: vi.fn(),
}));

import { assembleRebalanceInputs } from '../../src/services/crossWorkspaceDataService.js';

const { default: crossWorkspaceRouter } = await import('../../src/routes/crossWorkspace.js');

const api = routeAgent(crossWorkspaceRouter, { mountPath: '/api/cross-workspace' });
const rebalance = (body) => api.post('/api/cross-workspace/rebalance').send(body);

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
    const res1 = await rebalance({ targetWeights: { stocks: 'abc' } }).expect(400);
    expect(res1.body).toEqual(errEnvelope({
      code: 'VALIDATION_ERROR',
      message: 'targetWeights.stocks must be a non-negative number',
    }));

    const res2 = await rebalance({ targetWeights: { stocks: 0.5, bonds: -0.1 } }).expect(400);
    expect(res2.body.error.message).toBe('targetWeights.bonds must be a non-negative number');
  });

  it('rejects all-zero weights (and an empty record) with the zero-sum message', async () => {
    const res1 = await rebalance({ targetWeights: { stocks: 0, bonds: 0 } }).expect(400);
    expect(res1.body.error.message).toBe('targetWeights must include at least one positive weight');

    const res2 = await rebalance({ targetWeights: {} }).expect(400);
    expect(res2.body.error.message).toBe('targetWeights must include at least one positive weight');
  });

  it('rejects an unknown model with the preset list', async () => {
    const res = await rebalance({ model: 'yolo' }).expect(400);
    expect(res.body.error.message).toMatch(/Unknown model 'yolo'.*sixty_forty/);
  });

  it('requires either model or targetWeights', async () => {
    const res = await rebalance({}).expect(400);
    expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    expect(res.body.error.message).toMatch(/Provide either/);
  });

  it('ignores a truthy non-object targetWeights and falls through to the model branch', async () => {
    const res = await rebalance({ targetWeights: 'garbage' }).expect(400);
    expect(res.body.error.message).toMatch(/Provide either/);
  });

  it('coerces numeric-string weights and normalizes them to sum to 1', async () => {
    const res = await rebalance({ targetWeights: { stocks: '3', bonds: 1 } }).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.targetWeights).toEqual({ stocks: 0.75, bonds: 0.25 });
  });

  it('accepts a classic model preset and folds unrepresentable sleeves', async () => {
    const res = await rebalance({ model: 'three_fund' }).expect(200);
    // intl_stocks folds into stocks: 0.48 + 0.12 = 0.6
    expect(res.body.data.targetWeights.stocks).toBeCloseTo(0.6, 10);
    expect(res.body.data.targetWeights.bonds).toBeCloseTo(0.4, 10);
  });

  it('uppercases a string currency and defaults non-strings to EUR', async () => {
    const res = await rebalance({ model: 'sixty_forty', currency: 'usd' }).expect(200);
    expect(res.body.data.currency).toBe('USD');
    expect(assembleRebalanceInputs).toHaveBeenCalledWith({ currency: 'USD' });

    const res2 = await rebalance({ model: 'sixty_forty', currency: 42 }).expect(200);
    expect(res2.body.data.currency).toBe('EUR');
  });
});
