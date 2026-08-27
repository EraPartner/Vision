/**
 * Research route validation pins (ZOD-09).
 *
 * Pins the query/body parameter guards across the zod swap: single() array/
 * scalar normalization, per-endpoint symbol requireds, key_type set + default,
 * instrument_key/query requireds, positiveInt coercion, and the macro
 * provider/series_id guards.
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js). main.js:330 also mounts `marketRateLimiter`
 * before this router — deliberately not reproduced here (module-level counter
 * shared across the whole worker; see routeApp.js's fidelity map).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeAgent, errEnvelope } from '../helpers/routeApp.js';

vi.mock('../../src/services/research/researchAggregator.js', () => ({
  researchAggregator: {
    fetch: vi.fn(),
    fetchFundamentals: vi.fn(),
    searchMacro: vi.fn(),
    fetchMacroSeries: vi.fn(),
  },
}));

vi.mock('../../src/services/research/researchMappingService.js', () => ({
  researchMappingService: {
    list: vi.fn(),
    resolve: vi.fn(),
    save: vi.fn(),
    audit: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../src/services/research/researchProviderKeyService.js', () => ({
  listKeyStatuses: vi.fn(),
  setKey: vi.fn(),
  clearKey: vi.fn(),
}));

vi.mock('../../src/services/research/projection/portfolioProjection.js', () => ({
  runPortfolioForecast: vi.fn(),
}));

vi.mock('../../src/services/research/fundamentalsScorecard.js', () => ({
  fundamentalsScorecard: vi.fn(() => ({ score: 1 })),
}));

import { researchAggregator } from '../../src/services/research/researchAggregator.js';
import { researchMappingService } from '../../src/services/research/researchMappingService.js';
import { clearKey, listKeyStatuses } from '../../src/services/research/researchProviderKeyService.js';
import { runPortfolioForecast } from '../../src/services/research/projection/portfolioProjection.js';

const { default: researchRouter } = await import('../../src/routes/research.js');

const api = routeAgent(researchRouter, { mountPath: '/api/research' });
const BASE = '/api/research';

describe('Research route parameter guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    researchAggregator.fetch.mockResolvedValue({ provider: 'yahoo', source: 'live', data: { x: 1 } });
    researchAggregator.fetchMacroSeries.mockResolvedValue({ provider: 'fred', source: 'live', data: { points: [] } });
    researchMappingService.list.mockResolvedValue([]);
    researchMappingService.resolve.mockResolvedValue({ ok: true });
    researchMappingService.save.mockResolvedValue([]);
  });

  describe('symbol requireds', () => {
    it.each(['/quote', '/chart', '/analyst', '/news'])(
      'GET %s rejects a missing/empty symbol',
      async (path) => {
        const res1 = await api.get(`${BASE}${path}`).expect(400);
        expect(res1.body.error.message).toBe('symbol parameter required');

        const res2 = await api.get(`${BASE}${path}`).query({ symbol: '   ' }).expect(400);
        expect(res2.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      },
    );

    it('uses the first entry of an array-valued symbol and trims scalars', async () => {
      await api.get(`${BASE}/quote?symbol=AAPL&symbol=MSFT`).expect(200);
      expect(researchAggregator.fetch).toHaveBeenCalledWith('quote', expect.objectContaining({ symbol: 'AAPL' }));

      await api.get(`${BASE}/news`).query({ symbol: '  TSLA  ' }).expect(200);
      expect(researchAggregator.fetch).toHaveBeenLastCalledWith('news', { symbol: 'TSLA' });
    });
  });

  describe('macro series guards', () => {
    it('rejects an unknown provider with the provider list', async () => {
      const res = await api.get(`${BASE}/macro/series`).query({ provider: 'nope', series_id: 'CPIAUCSL' }).expect(400);
      expect(res.body.error.message).toBe('provider must be one of: fred, eurostat, dbnomics');
    });

    it('rejects a series_id that fails the provider shape', async () => {
      const res1 = await api.get(`${BASE}/macro/series`).query({ provider: 'fred', series_id: 'a/b/c' }).expect(400);
      expect(res1.body.error.message).toBe('valid series_id required for the given provider');

      const res2 = await api.get(`${BASE}/macro/series`).query({ provider: 'fred' }).expect(400);
      expect(res2.body.error.message).toBe('valid series_id required for the given provider');
    });

    it('fetches with defaulted range for a valid provider/series pair', async () => {
      await api.get(`${BASE}/macro/series`).query({ provider: 'fred', series_id: 'CPIAUCSL' }).expect(200);
      expect(researchAggregator.fetchMacroSeries).toHaveBeenCalledWith({
        provider: 'fred', seriesId: 'CPIAUCSL', range: '5y',
      });
    });
  });

  describe('mapping guards', () => {
    it('GET /mappings requires instrument_key and defaults key_type to isin', async () => {
      const res = await api.get(`${BASE}/mappings`).expect(400);
      expect(res.body.error.message).toBe('instrument_key required');

      await api.get(`${BASE}/mappings`).query({ instrument_key: 'US0378331005' }).expect(200);
      expect(researchMappingService.list).toHaveBeenCalledWith('US0378331005', 'isin');
    });

    it('rejects an unknown key_type', async () => {
      const res = await api.get(`${BASE}/mappings`).query({ instrument_key: 'X', key_type: 'weird' }).expect(400);
      expect(res.body.error.message).toBe("key_type must be 'isin' or 'internal'");
    });

    // This test used to be named "…coerces investment_id via parseInt" and
    // pinned `investment_id: 'abc'` → 200 with investmentId undefined. That was
    // a description of the implementation, not of an intended contract: it is
    // the silent-drop shape, and the parseInt behind it also had the retarget
    // shape — '12abc' parsed to 12, so `resolve` pre-seeded its proposals from
    // holding 12, a record nobody named, with nothing surfaced. The happy path
    // (a digit string parses) is kept verbatim; the drop is now a 400.
    it('POST /mappings/resolve requires query and validates investment_id strictly', async () => {
      const res = await api.post(`${BASE}/mappings/resolve`).send({ instrument_key: 'X', query: '' }).expect(400);
      expect(res.body.error.message).toBe('query required');

      await api.post(`${BASE}/mappings/resolve`)
        .send({ instrument_key: 'X', key_type: 'internal', query: 'apple', investment_id: '5' })
        .expect(200);
      expect(researchMappingService.resolve).toHaveBeenCalledWith(expect.objectContaining({
        instrumentKey: 'X', keyType: 'internal', query: 'apple', investmentId: 5,
      }));

      for (const investment_id of ['abc', '12abc', '1e3', '12.5', 0, -4, true, {}]) {
        const bad = await api.post(`${BASE}/mappings/resolve`)
          .send({ instrument_key: 'X', query: 'apple', investment_id })
          .expect(400);
        expect(bad.body.error.message).toBe('investment_id must be a positive integer');
      }
      expect(researchMappingService.resolve).toHaveBeenCalledTimes(1);
    });

    it('POST /mappings/resolve keeps an absent investment_id absent', async () => {
      // undefined, missing and JSON null all mean "no holding to seed from",
      // which `resolve` distinguishes with `investmentId !== undefined`.
      for (const body of [
        { instrument_key: 'X', query: 'apple' },
        { instrument_key: 'X', query: 'apple', investment_id: null },
        { instrument_key: 'X', query: 'apple', investment_id: '' },
      ]) {
        await api.post(`${BASE}/mappings/resolve`).send(body).expect(200);
        expect(researchMappingService.resolve).toHaveBeenLastCalledWith(
          expect.objectContaining({ investmentId: undefined }),
        );
      }
    });

    it('POST /mappings rejects a missing or empty mappings array', async () => {
      for (const mappings of [undefined, 'x', []]) {
        const res = await api.post(`${BASE}/mappings`).send({ instrument_key: 'X', mappings }).expect(400);
        expect(res.body.error.message).toBe('mappings must be a non-empty array');
      }
    });

    // This used to pin `DELETE /mappings/12abc` → 204 (removing mapping 12).
    // That was a behaviour-preservation pin for the parseInt-based validateId,
    // not an intended contract: openapi.yaml types this param `integer`, and
    // deleting record 12 because the client asked for "12abc" is a silent hit
    // on a record nobody named. validateId is now a strict digit-string parse,
    // so trailing garbage is a 400 like any other malformed id.
    it('DELETE /mappings/:id rejects a trailing-garbage id instead of coercing it', async () => {
      researchMappingService.remove.mockResolvedValue(true);
      const res = await api.delete(`${BASE}/mappings/12abc`).expect(400);
      expect(res.body.error.message).toBe('id must be a positive integer');
      expect(researchMappingService.remove).not.toHaveBeenCalled();

      const res2 = await api.delete(`${BASE}/mappings/abc`).expect(400);
      expect(res2.body.error.message).toBe('id must be a positive integer');

      const res3 = await api.delete(`${BASE}/mappings/12`).expect(204);
      expect(researchMappingService.remove).toHaveBeenCalledWith(12);
      expect(res3.text).toBe('');
    });

    // Idempotent: an already-removed mapping is still 204, not 404.
    it('DELETE /mappings/:id answers 204 when nothing was removed', async () => {
      researchMappingService.remove.mockResolvedValue(false);
      const res = await api.delete(`${BASE}/mappings/5`).expect(204);
      expect(res.text).toBe('');
    });
  });

  describe('DELETE /provider-keys/:provider', () => {
    it('clears the key and answers 204 with no body', async () => {
      clearKey.mockResolvedValue(true);
      const res = await api.delete(`${BASE}/provider-keys/finnhub`).expect(204);

      expect(clearKey).toHaveBeenCalledWith('finnhub');
      // The statuses are refetched by the caller — the delete must not re-read them.
      expect(listKeyStatuses).not.toHaveBeenCalled();
      expect(res.text).toBe('');
    });

    it('answers 204 when the provider key was already unset', async () => {
      clearKey.mockResolvedValue(false);
      const res = await api.delete(`${BASE}/provider-keys/finnhub`).expect(204);

      expect(clearKey).toHaveBeenCalledWith('finnhub');
      expect(listKeyStatuses).not.toHaveBeenCalled();
      expect(res.text).toBe('');
    });
  });

  // The route has no body schema, so an unknown key is ignored rather than
  // rejected: a camelCase spelling now reaches runPortfolioForecast as
  // `undefined` and the projection service applies its own defaults.
  describe('POST /portfolio-forecast body casing', () => {
    it('reads the snake_case spellings', async () => {
      runPortfolioForecast.mockResolvedValue({ bands: [] });
      const res = await api.post(`${BASE}/portfolio-forecast`).send({
        horizon_months: 24,
        monthly_contribution: 250,
        paths: 500,
        forward_blend: 0.5,
        target_value: 100000,
      }).expect(200);

      expect(runPortfolioForecast).toHaveBeenCalledWith(expect.objectContaining({
        horizonMonths: 24,
        monthlyContribution: 250,
        paths: 500,
        forwardBlend: 0.5,
        targetValue: 100000,
      }));
      expect(res.body.data).toEqual({ bands: [] });
    });

    it('no longer accepts the camelCase spellings', async () => {
      runPortfolioForecast.mockResolvedValue({ bands: [] });
      await api.post(`${BASE}/portfolio-forecast`).send({
        horizonMonths: 24,
        monthlyContribution: 250,
        forwardBlend: 0.5,
        targetValue: 100000,
      }).expect(200);

      expect(runPortfolioForecast).toHaveBeenCalledWith(expect.objectContaining({
        horizonMonths: undefined,
        monthlyContribution: undefined,
        forwardBlend: undefined,
        targetValue: undefined,
      }));
    });

    it('does not fall back to camelCase when the snake_case key is absent', async () => {
      runPortfolioForecast.mockResolvedValue({ bands: [] });
      await api.post(`${BASE}/portfolio-forecast`).send({
        horizon_months: 12, monthlyContribution: 999,
      }).expect(200);

      expect(runPortfolioForecast).toHaveBeenCalledWith(expect.objectContaining({
        horizonMonths: 12,
        monthlyContribution: undefined,
      }));
    });
  });

  describe('search empty-q short-circuit', () => {
    it('returns an empty payload without calling the aggregator', async () => {
      const res = await api.get(`${BASE}/search`).expect(200);
      expect(researchAggregator.fetch).not.toHaveBeenCalled();
      expect(res.body.data).toEqual({ items: [] });
    });
  });
});
