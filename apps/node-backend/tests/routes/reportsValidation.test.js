import { describe, expect, it } from 'vitest';
import { __parseReportBody } from '../../src/routes/reports.js';

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
});
