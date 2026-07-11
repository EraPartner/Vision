import { describe, it, expect, vi, beforeEach } from 'vitest';

// Numeric-guard tests for investment create/update (TODO E5): previously
// current_price / interest_rate / cadastral_income / municipality_tax_rate
// went into the INSERT/UPDATE unchecked — non-numeric garbage became a pg
// cast error (500 instead of 400) and negatives / 1e15 / "Infinity" inserted
// cleanly into the valuation and Belgian property-tax math.

vi.mock('../src/repositories/investmentRepository.js', () => ({
  default: {
    create: vi.fn().mockResolvedValue({ id: 1 }),
    update: vi.fn().mockResolvedValue({ id: 1 }),
    getById: vi.fn(),
  },
}));
vi.mock('../src/repositories/portfolioTransactionRepository.js', () => ({ default: {} }));
vi.mock('../src/services/priceProviderService.js', () => ({
  fetchHistoricalPrices: vi.fn(),
  fetchLivePricesDetailed: vi.fn(),
  SUPPORTED_PROVIDERS: [],
}));
vi.mock('../src/services/quoteBackfillService.js', () => ({ refreshQuotesForInvestment: vi.fn() }));
vi.mock('../src/config/kinesisConfig.js', () => ({ getKinesisAssetConfig: vi.fn() }));
vi.mock('../src/routes/info/_cache.js', () => ({ invalidatePortfolioCaches: vi.fn() }));
vi.mock('../src/lib/urlSafety.js', () => ({ assertPublicHttpUrl: vi.fn() }));
vi.mock('../src/services/portfolio/fxResolve.js', () => ({ autoResolveFxRateToEur: vi.fn() }));
vi.mock('../src/services/portfolio/tradeCashLegService.js', () => ({
  createTradeCashLeg: vi.fn(),
  deleteTradeCashLegs: vi.fn(),
}));
vi.mock('../src/services/portfolio/moveHoldingService.js', () => ({ moveHolding: vi.fn() }));

import investmentRepository from '../src/repositories/investmentRepository.js';
import { createInvestment, updateInvestment } from '../src/controllers/investmentController.js';
import { ValidationError } from '../src/middleware/errorHandler.js';

function mockRes() {
  return { ok: vi.fn(), status: vi.fn().mockReturnThis(), send: vi.fn() };
}

function createReq(bodyOverrides = {}) {
  return { body: { name: 'Test', asset_class: 'stock', ...bodyOverrides } };
}

beforeEach(() => {
  vi.clearAllMocks();
  investmentRepository.create.mockResolvedValue({ id: 1 });
  investmentRepository.update.mockResolvedValue({ id: 1 });
});

describe('createInvestment — numeric field guards', () => {
  it('rejects a non-numeric current_price with a 400, not a pg cast error', async () => {
    await expect(createInvestment(createReq({ current_price: 'banana' }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
    expect(investmentRepository.create).not.toHaveBeenCalled();
  });

  it('rejects negative cadastral_income', async () => {
    await expect(createInvestment(createReq({ cadastral_income: -500 }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a 5000% municipality_tax_rate', async () => {
    await expect(createInvestment(createReq({ municipality_tax_rate: 5000 }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects absurd magnitudes and JSON "Infinity"', async () => {
    await expect(createInvestment(createReq({ current_price: '1e15' }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(createInvestment(createReq({ interest_rate: 'Infinity' }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('coerces numeric strings and accepts negative interest rates', async () => {
    const res = mockRes();
    await createInvestment(createReq({ current_price: '12.5', interest_rate: '-0.5' }), res);
    expect(investmentRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ current_price: 12.5, interest_rate: -0.5 }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("treats a cleared '' field as no value, not 0", async () => {
    await createInvestment(createReq({ current_price: '' }), mockRes());
    expect(investmentRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ current_price: null }),
    );
  });
});

describe('updateInvestment — numeric field guards', () => {
  const req = (body) => ({ params: { id: '1' }, body });

  it('applies the same guards as create', async () => {
    await expect(updateInvestment(req({ municipality_tax_rate: 'high' }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(updateInvestment(req({ current_price: -1 }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
    expect(investmentRepository.update).not.toHaveBeenCalled();
  });

  it('passes valid coerced values and explicit nulls through', async () => {
    const res = mockRes();
    await updateInvestment(req({ current_price: '99.99', interest_rate: null }), res);
    expect(investmentRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ current_price: 99.99, interest_rate: null }),
    );
    expect(res.ok).toHaveBeenCalled();
  });
});
