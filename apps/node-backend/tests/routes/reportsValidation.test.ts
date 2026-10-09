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
