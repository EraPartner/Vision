import { describe, expect, it } from 'vitest';
import { __parseReportBody } from '../../src/routes/reports.ts';

describe('Report exclusion id validation', () => {
  it.each(['excludedCategoryIds', 'excludedRecipientIds'])(
    'rejects %s values above the PostgreSQL int4 ceiling before report generation',
    (field) => {
      expect(() => __parseReportBody({ [field]: [2147483648] }))
        .toThrow(/Invalid report request/);
    }
  );

  it('accepts exclusion ids at the PostgreSQL int4 ceiling', async () => {
    expect(__parseReportBody({
      excludedCategoryIds: [2147483647],
      excludedRecipientIds: [2147483647],
    })).toEqual(expect.objectContaining({
      excludedCategoryIds: [2147483647],
      excludedRecipientIds: [2147483647],
    }));
  });

  it('accepts a household and its per-partner result, and validates the household', () => {
    const household = {
      version: 2,
      taxYear: 2025,
      profileConfigured: true,
      region: 'flanders',
      communalSurchargePercent: 7,
      partners: [
        {
          id: 'A',
          isDisabled: false,
          activities: [{ id: 'act_A_1', kind: 'employee', grossIncome: 50000 }],
          professionalExpenses: {},
          unionDues: 0,
          otherTaxableIncome: 0,
          alimonyPaid: 0,
          reductions: {
            personalPensionContributions: 0,
            lifeInsurancePremiums: 0,
            charitableDonations: 0,
            childcareCosts: 0,
            medicalExpenses: 0,
          },
        },
      ],
      relationship: { events: [] },
      dependents: { children: 0, otherPersons: 0 },
      home: { cadastralIncome: 0, mortgageInterestPaid: 0 },
    };
    const precomputedHousehold = {
      assessmentMode: 'single',
      partners: [{ partnerId: 'A', grossIncome: 50000, taxableIncome: 36000, totalPIT: 9000 }],
    };
    expect(__parseReportBody({ household, precomputedHousehold })).toEqual(
      expect.objectContaining({ household, precomputedHousehold }),
    );
    expect(() =>
      __parseReportBody({ household: { ...household, partners: [] } }),
    ).toThrow(/^Invalid report request: household\.partners/);
    expect(() =>
      __parseReportBody({
        precomputedHousehold: { ...precomputedHousehold, assessmentMode: 'shared' },
      }),
    ).toThrow(/precomputedHousehold\.assessmentMode/);
    const partner = precomputedHousehold.partners[0];
    expect(() =>
      __parseReportBody({
        precomputedHousehold: { ...precomputedHousehold, partners: [partner, partner] },
      }),
    ).toThrow(/precomputedHousehold\.partners: partner ids must be unique/);
  });

  it('reports a root-level issue without an empty path prefix', () => {
    expect(() => __parseReportBody(undefined)).toThrow(
      /^Invalid report request: Invalid input: expected object, received undefined$/
    );
  });

  it('prefixes field issues with their path', () => {
    expect(() => __parseReportBody({ currency: 'eur' })).toThrow(
      /^Invalid report request: currency: currency must be a 3-letter ISO code$/
    );
  });
});

describe('Shared report request contract', () => {
  it('uses the documented defaults for an empty body', () => {
    expect(__parseReportBody({})).toEqual({
      currency: 'EUR',
      period: { kind: 'rolling', months: 12 },
      sections: [],
      theme: { mode: 'light' },
      excludedCategoryIds: [],
      excludedRecipientIds: [],
    });
  });

  it('requires a bounded discriminated period rather than obsolete top-level dates', () => {
    expect(__parseReportBody({ start_date: '2020-01-01', end_date: '2020-12-31', year: 2020 }))
      .toEqual(__parseReportBody({}));
    for (const period of [
      { kind: 'rolling', months: 0 },
      { kind: 'rolling', months: 61 },
      { kind: 'rolling', months: 1.5 },
      { kind: 'year', year: 1999 },
      { kind: 'year', year: 2101 },
      { kind: 'custom', from: '2025-1-01', to: '2025-12-31' },
    ]) {
      expect(() => __parseReportBody({ period })).toThrow(/Invalid report request: period/);
    }
    // The current route validates shape, not calendar validity or ordering.
    const period = { kind: 'custom', from: '2025-99-99', to: '2024-01-01' };
    expect(__parseReportBody({ period }).period).toEqual(period);
  });

  it('accepts only HSL token triples and defaults the omitted theme mode', () => {
    expect(__parseReportBody({ theme: { primary: '158 62% 32%' } }).theme)
      .toEqual({ primary: '158 62% 32%', mode: 'light' });
    for (const primary of [
      'hsl(158 62% 32%)',
      '0 0% 0%; } body { background: url(https://example.invalid)',
    ]) {
      expect(() => __parseReportBody({ theme: { primary } })).toThrow(/theme.primary/);
    }
  });

  it('rejects explicit null for optional request fields', () => {
    for (const field of [
      'currency', 'period', 'sections', 'theme', 'excludedCategoryIds', 'excludedRecipientIds',
      'taxProfile', 'precomputedPIT', 'household', 'precomputedHousehold',
    ]) {
      expect(() => __parseReportBody({ [field]: null })).toThrow(/Invalid report request/);
    }
  });
});
