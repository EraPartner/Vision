/**
 * Wise Bank Adapter Tests
 */

import { describe, it, expect } from 'vitest';
import { createAdapter } from '../src/services/bankAdapters.js';

import { useTempCSV } from './helpers/tempFile.js';

const writeTempCSV = useTempCSV('wise');

describe('WiseAdapter', () => {
  let tmpPath;
  const parse = createAdapter('wise');

  it('filters non-COMPLETED rows', async () => {
    const csv = `Status,Finished on,Created on,Direction,Target amount (after fees),Source amount (after fees),Target currency,Source currency,Target name,Source name,Reference,Category,Note,Source fee amount,Source fee currency,Exchange rate,ID,Batch
COMPLETED,2026-03-01 10:00:00,,OUT,10.00,10.00,EUR,EUR,Coffee Shop,My Account,Ref,Food,Note,0,EUR,0,wise-1,batch-1
PENDING,2026-03-02 10:00:00,,OUT,20.00,20.00,EUR,EUR,Pending Shop,My Account,Ref,Food,Note,0,EUR,0,wise-2,batch-2
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(1);
    expect(txns[0].recipient).toBe('COFFEE SHOP');
  });

  it('applies direction sign logic and recipient source-target switch', async () => {
    const csv = `Status,Finished on,Created on,Direction,Target amount (after fees),Source amount (after fees),Target currency,Source currency,Target name,Source name,Reference,Category,Note,Source fee amount,Source fee currency,Exchange rate,ID,Batch
COMPLETED,2026-03-01 10:00:00,,OUT,25.00,25.00,EUR,EUR,Target Person,Source Person,Ref,Cat,Note,0,EUR,0,wise-3,batch-3
COMPLETED,2026-03-02 10:00:00,,IN,50.00,50.00,EUR,EUR,Target In,Source In,Ref,Cat,Note,0,EUR,0,wise-4,batch-4
COMPLETED,2026-03-03 10:00:00,,NEUTRAL,-7.25,-7.25,EUR,EUR,Neutral Target,Neutral Source,Ref,Cat,Note,0,EUR,0,wise-5,batch-5
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(3);
    expect(txns[0].amount).toBe(-25.0);
    expect(txns[0].recipient).toBe('TARGET PERSON');
    expect(txns[1].amount).toBe(50.0);
    expect(txns[1].recipient).toBe('SOURCE IN');
    expect(txns[2].amount).toBe(-7.25);
  });

  it('uses currency fallback and formats bankAccount as WISE <CUR>', async () => {
    const csv = `Status,Finished on,Created on,Direction,Target amount (after fees),Source amount (after fees),Target currency,Source currency,Target name,Source name,Reference,Category,Note,Source fee amount,Source fee currency,Exchange rate,ID,Batch
COMPLETED,2026-03-04 10:00:00,,OUT,,12.50,,GBP,Fallback Currency,Source Fallback,,,,0,GBP,0,wise-6,batch-6
COMPLETED,2026-03-05 10:00:00,,OUT,5.00,5.00,,,No Currency Name,Source Empty,,,,0,,0,wise-7,batch-7
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(2);
    expect(txns[0].currency).toBe('GBP');
    expect(txns[0].bankAccount).toBe('WISE GBP');
    expect(txns[1].currency).toBe('USD');
    expect(txns[1].bankAccount).toBe('WISE USD');
  });

  it('builds comment branches and applies default memo fallback', async () => {
    const csv = `Status,Finished on,Created on,Direction,Target amount (after fees),Source amount (after fees),Target currency,Source currency,Target name,Source name,Reference,Category,Note,Source fee amount,Source fee currency,Exchange rate,ID,Batch
COMPLETED,2026-03-06 10:00:00,,OUT,90.00,100.00,EUR,USD,Target Full,Source Full,,,,2.50,USD,1.12,wise-8,batch-8
COMPLETED,2026-03-07 10:00:00,,OUT,15.00,15.00,EUR,EUR,Simple Target,Simple Source,,,,0,EUR,0,wise-9,
`;

    tmpPath = writeTempCSV(csv);
    const txns = await parse(tmpPath);

    expect(txns).toHaveLength(2);
    expect(txns[0].comment).toContain('ID: wise-8');
    expect(txns[0].comment).toContain('Direction: OUT');
    expect(txns[0].comment).toContain('Fee: 2.50 USD');
    expect(txns[0].comment).toContain('Rate: 1.12');
    expect(txns[0].comment).toContain('100.00 USD → 90.00 EUR');
    expect(txns[0].comment).toContain('Batch: batch-8');
    expect(txns[0].memo).toBe('WISE TRANSFER');

    expect(txns[1].comment).toContain('ID: wise-9');
    expect(txns[1].comment).toContain('Direction: OUT');
    expect(txns[1].comment).not.toContain('Fee:');
    expect(txns[1].comment).not.toContain('Rate:');
    expect(txns[1].comment).not.toContain('→');
    expect(txns[1].comment).not.toContain('Batch:');
    expect(txns[1].memo).toBe('WISE TRANSFER');
  });
});
