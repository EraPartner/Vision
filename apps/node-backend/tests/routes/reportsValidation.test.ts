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
