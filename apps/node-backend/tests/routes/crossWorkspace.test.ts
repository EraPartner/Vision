/**
 * Cross-workspace route validation pins (ZOD-09).
 *
 * Pins the /rebalance body validation behavior across the zod swap: per-sleeve
 * non-negative Number() coercion, all-zero-sum rejection, model-key lookup,
 * and the model/targetWeights dispatch (a truthy non-object targetWeights is
 * IGNORED, falling through to the model branch).
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeAgent, errEnvelope } from '../helpers/routeApp.ts';

vi.mock('../../src/services/crossWorkspaceDataService.ts', () => ({
  assembleRebalanceInputs: vi.fn(),
}));

vi.mock('../../src/services/commitmentAwareCashService.ts', () => ({
  computeCommitmentAwareCash: vi.fn(),
}));

import { assembleRebalanceInputs } from '../../src/services/crossWorkspaceDataService.ts';
import { computeCommitmentAwareCash } from '../../src/services/commitmentAwareCashService.ts';

type RebalanceInputs = Awaited<ReturnType<typeof assembleRebalanceInputs>>;

const { default: crossWorkspaceRouter } = await import('../../src/routes/crossWorkspace.ts');

const api = routeAgent(crossWorkspaceRouter, { mountPath: '/api/cross-workspace' });
const rebalance = (body: object) => api.post('/api/cross-workspace/rebalance').send(body);

describe('POST /rebalance validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assembleRebalanceInputs).mockResolvedValue({
      actualValues: { stocks: 600, bonds: 400 },
      availableCash: 100,
      cashAccounts: [],
    } as Partial<RebalanceInputs> as RebalanceInputs);
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

    const withModel = await rebalance({ targetWeights: 'garbage', model: 'sixty_forty' }).expect(200);
    expect(withModel.body.data.targetWeights).toEqual({ stocks: 0.6, bonds: 0.4 });
  });

  it('gives explicit object targetWeights precedence over a model', async () => {
    const res = await rebalance({ targetWeights: {}, model: 'sixty_forty' }).expect(400);
    expect(res.body.error.message).toBe('targetWeights must include at least one positive weight');
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

describe('POST /commitment-aware-cash validation', () => {
  const cash = (body?: object) => {
    const request = api.post('/api/cross-workspace/commitment-aware-cash');
    return body === undefined ? request : request.send(body);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(computeCommitmentAwareCash).mockResolvedValue(
      {} as Awaited<ReturnType<typeof computeCommitmentAwareCash>>,
    );
  });

  it('defaults to EUR with no reserve floor', async () => {
    await cash().expect(200);
    await cash({ reserveFloor: null }).expect(200);
    expect(computeCommitmentAwareCash).toHaveBeenNthCalledWith(1, { currency: 'EUR', reserveFloor: 0 });
    expect(computeCommitmentAwareCash).toHaveBeenNthCalledWith(2, { currency: 'EUR', reserveFloor: 0 });
  });

  it('passes a valid currency and reserve floor through', async () => {
    await cash({ currency: 'usd', reserveFloor: 250 }).expect(200);
    expect(computeCommitmentAwareCash).toHaveBeenCalledWith({ currency: 'usd', reserveFloor: 250 });
  });

  it('rejects a negative or non-numeric reserve floor', async () => {
    const negative = await cash({ reserveFloor: -1 }).expect(400);
    expect(negative.body).toEqual(errEnvelope({
      code: 'VALIDATION_ERROR',
      message: 'reserveFloor: must be a non-negative finite number',
    }));
    const text = await cash({ reserveFloor: '100' }).expect(400);
    expect(text.body.error.message).toBe('reserveFloor: must be a non-negative finite number');
    expect(computeCommitmentAwareCash).not.toHaveBeenCalled();
  });

  it('rejects a currency that is not a three-letter code', async () => {
    for (const currency of ['EURO', 42, null]) {
      const res = await cash({ currency }).expect(400);
      expect(res.body.error.message).toBe('currency: must be a three-letter code');
    }
    expect(computeCommitmentAwareCash).not.toHaveBeenCalled();
  });
});
