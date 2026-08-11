/**
 * Contract pins for the aggregation routers' repeatable *id* query params
 * (`excluded_category_ids`, `excluded_recipient_ids`, `recipient_ids`,
 * `tag_ids`).
 *
 * These were the last id parser still silently dropping bad elements. The old
 * `parseNumericArrayQueryParam` was `.map(Number).filter(Number.isFinite)`, so
 * `?excluded_category_ids=12abc` yielded `[]` — the exclusion switched off
 * entirely and the endpoint answered with a *different* dataset than the caller
 * asked for, with nothing surfaced. `0x10` meanwhile decoded to 16 and `1e3` to
 * 1000, excluding a category nobody named. Every element now goes through
 * `validateIntArray` → `validateId`, and a bad one is a 400.
 *
 * The empty/absent case is deliberately NOT part of that: an empty exclusion
 * list is what every shipped caller sends when nothing is excluded, and it must
 * keep answering 200 with no exclusions applied. It is pinned here so a later
 * tightening cannot take it away by accident.
 *
 * Runs against the REAL router on a throwaway Express app (helpers/routeApp.js);
 * only the calc modules are mocked, so the parse, the error handler and the
 * envelope are all real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeAgent, errEnvelope } from '../helpers/routeApp.js';

const envelope = async () => ({ data: {}, meta: {} });

const monthlySpy = vi.fn(envelope);
const recipientInsightsSpy = vi.fn(envelope);
const cashflowComparisonSpy = vi.fn(envelope);
const forecastMethodsSpy = vi.fn(envelope);
const forecastRollingSpy = vi.fn(envelope);
const sankeySpy = vi.fn(envelope);
const categoryPivotSpy = vi.fn(envelope);
const recipientByYearSpy = vi.fn(envelope);
const recipientPivotSpy = vi.fn(envelope);
const tagPivotSpy = vi.fn(envelope);

vi.mock('../../src/services/calculations/aggregation/monthly.js', () => ({
  computeMonthlySummary: (...a) => monthlySpy(...a),
}));
vi.mock('../../src/services/calculations/aggregation/recipient.js', () => ({
  computeRecipientInsights: (...a) => recipientInsightsSpy(...a),
}));
vi.mock('../../src/services/calculations/aggregation/cashflow.js', () => ({
  computeCashflowComparison: (...a) => cashflowComparisonSpy(...a),
}));
vi.mock('../../src/services/calculations/forecast/index.js', () => ({
  computeCashflowForecast: (...a) => forecastMethodsSpy(...a),
  computeCashflowForecastRolling: (...a) => forecastRollingSpy(...a),
}));
vi.mock('../../src/services/calculations/aggregation/sankey.js', () => ({
  computeSankeyFlow: (...a) => sankeySpy(...a),
}));
vi.mock('../../src/services/calculations/aggregation/categoryPivot.js', () => ({
  computeCategoryPivot: (...a) => categoryPivotSpy(...a),
}));
vi.mock('../../src/services/calculations/aggregation/recipientByYear.js', () => ({
  computeRecipientByYear: (...a) => recipientByYearSpy(...a),
}));
vi.mock('../../src/services/calculations/aggregation/recipientPivot.js', () => ({
  computeRecipientPivot: (...a) => recipientPivotSpy(...a),
}));
vi.mock('../../src/services/calculations/aggregation/tagPivot.js', () => ({
  computeTagPivot: (...a) => tagPivotSpy(...a),
}));

const { default: aggregationsRouter } = await import('../../src/routes/aggregations.js');

const api = routeAgent(aggregationsRouter, { mountPath: '/api/aggregations' });

const get = (path, query = '') =>
  api.get(`/api/aggregations${path}${query ? `?${query}` : ''}`);

/**
 * Every endpoint that takes an id array, with the params it accepts and the
 * spy that receives the parsed values. The exclusion pair covers 8 endpoints;
 * recipient-pivot and tag-pivot take id *selection* lists through the same
 * parser, which the finding did not enumerate.
 */
const ID_ARRAY_ENDPOINTS = [
  { path: '/monthly-summary', params: ['excluded_category_ids', 'excluded_recipient_ids'], spy: () => monthlySpy },
  { path: '/recipient-insights', params: ['excluded_category_ids', 'excluded_recipient_ids'], spy: () => recipientInsightsSpy },
  { path: '/cashflow-comparison', params: ['excluded_category_ids', 'excluded_recipient_ids'], spy: () => cashflowComparisonSpy },
  { path: '/cashflow-forecast-methods', params: ['excluded_category_ids', 'excluded_recipient_ids'], spy: () => forecastMethodsSpy },
  { path: '/cashflow-forecast-rolling', params: ['excluded_category_ids', 'excluded_recipient_ids'], spy: () => forecastRollingSpy },
  { path: '/sankey', params: ['excluded_category_ids', 'excluded_recipient_ids'], spy: () => sankeySpy },
  { path: '/category-pivot', params: ['excluded_category_ids', 'excluded_recipient_ids'], spy: () => categoryPivotSpy },
  { path: '/recipient-by-year', params: ['excluded_category_ids', 'excluded_recipient_ids'], spy: () => recipientByYearSpy },
  { path: '/recipient-pivot', params: ['excluded_recipient_ids', 'recipient_ids'], spy: () => recipientPivotSpy },
  { path: '/tag-pivot', params: ['tag_ids'], spy: () => tagPivotSpy },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('aggregation id query params — malformed elements are rejected, not dropped', () => {
  for (const { path, params, spy } of ID_ARRAY_ENDPOINTS) {
    for (const param of params) {
      it(`GET ${path} 400s on ${param}=12abc instead of silently ignoring it`, async () => {
        const res = await get(path, `${param}=12abc`).expect(400);
        expect(res.body).toEqual(errEnvelope({
          code: 'VALIDATION_ERROR',
          message: `${param} contains invalid value: 12abc`,
        }));
        // The whole request is refused: no aggregation is computed and answered
        // with an unrequested filter set.
        expect(spy()).not.toHaveBeenCalled();
      });

      it(`GET ${path} still answers 200 with no ${param} filter when the param is absent`, async () => {
        await get(path).expect(200);
        expect(spy()).toHaveBeenCalledTimes(1);
      });

      it(`GET ${path} treats an empty ${param}= as "no filter", not as an error`, async () => {
        await get(path, `${param}=`).expect(200);
        expect(spy()).toHaveBeenCalledTimes(1);
      });
    }
  }
});

describe('aggregation id query params — accept set', () => {
  // Same accept set as validateId: a plain base-10 digit string (leading zeros
  // allowed) or an integer number, 1..2^31-1.
  const ACCEPTED = [
    ['5', 5],
    ['007', 7],
    ['2147483647', 2147483647],
  ];

  const REJECTED = [
    '12abc',              // trailing garbage — the headline case, was dropped
    '0x10',               // hex — was decoded to 16, a category nobody named
    '1e3',                // exponent — was decoded to 1000
    '1.5',                // float — reached the query as a non-integer id
    '-1',                 // negative — survived the isFinite filter
    '0',                  // no row has id 0
    '+5',
    ' 5 ',
    '1_0',
    'NaN',
    'Infinity',
    '٥',                  // non-ASCII digits
    '2147483648',         // past int4
  ];

  for (const [raw, parsed] of ACCEPTED) {
    it(`accepts excluded_category_ids=${raw} and passes ${parsed} to the calc module`, async () => {
      await get('/monthly-summary', `excluded_category_ids=${encodeURIComponent(raw)}`).expect(200);
      expect(monthlySpy.mock.calls[0][0].excludedCategoryIds).toEqual([parsed]);
    });
  }

  for (const raw of REJECTED) {
    it(`rejects excluded_category_ids=${raw}`, async () => {
      const res = await get('/monthly-summary', `excluded_category_ids=${encodeURIComponent(raw)}`).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toBe(`excluded_category_ids contains invalid value: ${raw}`);
      expect(monthlySpy).not.toHaveBeenCalled();
    });
  }

  it('parses a repeated param into the full list in order', async () => {
    await get('/monthly-summary', 'excluded_category_ids=5&excluded_category_ids=007&excluded_recipient_ids=9')
      .expect(200);
    expect(monthlySpy.mock.calls[0][0].excludedCategoryIds).toEqual([5, 7]);
    expect(monthlySpy.mock.calls[0][0].excludedRecipientIds).toEqual([9]);
  });

  it('rejects the whole list when one of several elements is bad — no partial filter set', async () => {
    const res = await get('/monthly-summary', 'excluded_category_ids=5&excluded_category_ids=12abc&excluded_category_ids=9')
      .expect(400);
    expect(res.body.error.message).toBe('excluded_category_ids contains invalid value: 12abc');
    expect(monthlySpy).not.toHaveBeenCalled();
  });

  it('rejects an empty element inside a repeated param (distinct from an empty param)', async () => {
    await get('/monthly-summary', 'excluded_category_ids=5&excluded_category_ids=').expect(400);
    expect(monthlySpy).not.toHaveBeenCalled();
  });

  it('absent params reach the calc module as empty lists, exactly as before', async () => {
    await get('/monthly-summary').expect(200);
    expect(monthlySpy.mock.calls[0][0].excludedCategoryIds).toEqual([]);
    expect(monthlySpy.mock.calls[0][0].excludedRecipientIds).toEqual([]);
  });
});

describe('mc_percentiles keeps the lenient numeric parser', () => {
  // Deliberate, not an oversight: percentiles are distribution parameters in
  // 0..100, not record ids — fractional values are legitimate and a bad one
  // costs a band on a chart, not a wrong row set. Pinned so the next reader
  // does not "converge" it onto the id parser.
  it('accepts fractional percentiles and drops unparseable ones', async () => {
    await get('/cashflow-forecast-methods', 'mc_percentiles=2.5&mc_percentiles=97.5').expect(200);
    expect(forecastMethodsSpy.mock.calls[0][0].mcPercentiles).toEqual([2.5, 97.5]);

    await get('/cashflow-forecast-rolling', 'mc_percentiles=abc').expect(200);
    expect(forecastRollingSpy.mock.calls[0][0].mcPercentiles).toEqual([10, 50, 90]);
  });
});
