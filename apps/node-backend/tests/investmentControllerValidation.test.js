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
  pickInvestmentCreateFields: (body) => body,
}));
vi.mock('../src/repositories/portfolioTransactionRepository.js', () => ({ default: {} }));
vi.mock('../src/services/priceProviderService.js', () => ({
  fetchHistoricalPrices: vi.fn(),
  fetchLivePricesDetailed: vi.fn(),
  SUPPORTED_PROVIDERS: [],
}));
vi.mock('../src/services/quoteBackfillService.js', () => ({ refreshQuotesForInvestment: vi.fn() }));
vi.mock('../src/config/kinesisConfig.js', () => ({ getKinesisAssetConfig: vi.fn() }));
vi.mock('../src/services/info/cache.js', () => ({ invalidatePortfolioCaches: vi.fn() }));
vi.mock('../src/lib/urlSafety.js', () => ({ assertPublicHttpUrl: vi.fn() }));
vi.mock('../src/services/portfolio/fxResolve.js', () => ({ autoResolveFxRateToEur: vi.fn() }));

import investmentRepository from '../src/repositories/investmentRepository.js';
import { createInvestment, updateInvestment, parseDefaultListOptions } from '../src/controllers/investmentController.js';
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

// Pins for the zod swap (ZOD-04): exact boundary values, string-width caps,
// currency coercion, and unvalidated-field passthrough must survive byte-identical.
describe('createInvestment — numeric boundary pins', () => {
  it('accepts values exactly at the bounds', async () => {
    await createInvestment(createReq({
      current_price: 1e12, cadastral_income: 0,
      interest_rate: -100, municipality_tax_rate: 100,
    }), mockRes());
    expect(investmentRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      current_price: 1e12, cadastral_income: 0, interest_rate: -100, municipality_tax_rate: 100,
    }));
  });

  it('rejects values just past the bounds', async () => {
    await expect(createInvestment(createReq({ current_price: 1e12 + 1 }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(createInvestment(createReq({ interest_rate: 100.01 }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(createInvestment(createReq({ interest_rate: -100.01 }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(createInvestment(createReq({ municipality_tax_rate: -0.01 }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(createInvestment(createReq({ cadastral_income: -0.01 }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
    expect(investmentRepository.create).not.toHaveBeenCalled();
  });
});

describe('createInvestment — string width and currency pins', () => {
  it('accepts strings exactly at the column width and rejects one char over', async () => {
    const widths = [
      ['name', 200], ['symbol', 20], ['location', 300], ['municipality', 200],
      // Provider columns: URL shape is validated separately; the width guard
      // stops an over-length-but-valid value 22001-ing at the VARCHAR column.
      ['price_provider_id', 200],
      ['price_provider_url', 500], ['price_provider_latest_url', 500],
      ['price_provider_latest_path', 300], ['price_provider_history_url', 500],
      ['price_provider_history_path', 300], ['price_provider_history_ts_path', 300],
      ['price_provider_history_price_path', 300],
    ];
    for (const [field, max] of widths) {
      await createInvestment(createReq({ [field]: 'x'.repeat(max) }), mockRes());
      await expect(createInvestment(createReq({ [field]: 'x'.repeat(max + 1) }), mockRes()))
        .rejects.toBeInstanceOf(ValidationError);
    }
    expect(investmentRepository.create).toHaveBeenCalledTimes(widths.length);
  });

  it('uppercases a valid currency and rejects non-ISO shapes', async () => {
    await createInvestment(createReq({ currency: 'usd' }), mockRes());
    expect(investmentRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'USD' }),
    );
    await expect(createInvestment(createReq({ currency: 'euro' }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
    await expect(createInvestment(createReq({ currency: '€' }), mockRes()))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it("passes empty/null/absent currency through untouched (column default applies)", async () => {
    await createInvestment(createReq({ currency: '' }), mockRes());
    expect(investmentRepository.create.mock.calls[0][0].currency).toBe('');
    await createInvestment(createReq({ currency: null }), mockRes());
    expect(investmentRepository.create.mock.calls[1][0].currency).toBeNull();
    await createInvestment(createReq({}), mockRes());
    expect('currency' in investmentRepository.create.mock.calls[2][0]).toBe(false);
  });

  it('forwards unvalidated fields untouched (loose body)', async () => {
    await createInvestment(createReq({
      notes: '  keep me  ', price_provider_id: 'AAPL', maturity_date: '2030-01-01', is_active: true,
    }), mockRes());
    expect(investmentRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      notes: '  keep me  ', price_provider_id: 'AAPL', maturity_date: '2030-01-01', is_active: true,
    }));
  });
});

describe('updateInvestment — string field pins', () => {
  const req = (body) => ({ params: { id: '1' }, body });

  it('forwards a null string field (explicit clear) and a non-string value within width unchanged', async () => {
    await updateInvestment(req({ symbol: null, location: 12345 }), mockRes());
    expect(investmentRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ symbol: null, location: 12345 }),
    );
  });

  it("maps a cleared '' numeric field to null on update too", async () => {
    await updateInvestment(req({ cadastral_income: '' }), mockRes());
    expect(investmentRepository.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ cadastral_income: null }),
    );
  });
});

describe('parseDefaultListOptions — pagination clamp', () => {
  it('clamps an oversized limit down to the per-route maxLimit', () => {
    expect(parseDefaultListOptions({ limit: '999999' }).limit).toBe(1000);
  });

  it('falls back to the default limit for a falsy limit like "0"', () => {
    expect(parseDefaultListOptions({ limit: '0' }).limit).toBe(200);
    expect(parseDefaultListOptions({}).limit).toBe(200);
  });

  it('never lets offset go negative', () => {
    expect(parseDefaultListOptions({ offset: '-5' }).offset).toBe(0);
  });
});
