import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/recurringDetectionService.js', () => ({
  detectRecurringPatterns: vi.fn(),
}));

import { detectRecurringPatterns } from '../src/services/recurringDetectionService.js';
import {
  __buildSubscriptionCreep as buildSubscriptionCreep,
  detectSubscriptionCreep,
} from '../src/services/subscriptionCreepService.js';

/** Recurring pattern as returned by detectRecurringPatterns (relevant fields). */
const pattern = (overrides = {}) => ({
  recipientId: 1,
  recipientName: 'Netflix',
  direction: 'expense',
  detectedPattern: 'monthly',
  intervalDays: 30,
  latestAmount: 15.99,
  averageAmount: 14.5,
  currency: 'EUR',
  predictedNext: '2026-08-10',
  confidence: 90,
  amountChanges: [],
  ...overrides,
});

/** A price change as found on a pattern's amountChanges array. */
const change = (overrides = {}) => ({
  date: '2026-07-10',
  previousAmount: 13.99,
  newAmount: 15.99,
  percentChange: 14.3,
  direction: 'increased',
  ...overrides,
});

describe('detectSubscriptionCreep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces an expense pattern without amountChanges in `new` only, with the contract fields', async () => {
    detectRecurringPatterns.mockResolvedValue({ patterns: [pattern()], total: 1 });

    const digest = await detectSubscriptionCreep();

    expect(digest).toEqual({
      new: [
        {
          recipientId: 1,
          recipientName: 'Netflix',
          findingType: 'new',
          latestAmount: 15.99,
          currency: 'EUR',
          detectedPattern: 'monthly',
          intervalDays: 30,
          predictedNext: '2026-08-10',
          confidence: 90,
        },
      ],
      priceChanges: [],
    });
    expect(detectRecurringPatterns).toHaveBeenCalledTimes(1);
  });

  it('surfaces an expense pattern WITH amountChanges in BOTH lists, using the LAST change', async () => {
    detectRecurringPatterns.mockResolvedValue({
      patterns: [
        pattern({
          amountChanges: [
            change({ date: '2026-05-10', previousAmount: 12.99, newAmount: 13.99, percentChange: 7.7 }),
            change(), // last element = the current change
          ],
        }),
      ],
      total: 1,
    });

    const digest = await detectSubscriptionCreep();

    expect(digest.new).toHaveLength(1);
    expect(digest.new[0]).toMatchObject({ recipientId: 1, findingType: 'new' });
    expect(digest.priceChanges).toEqual([
      {
        recipientId: 1,
        recipientName: 'Netflix',
        findingType: 'priceChange',
        previousAmount: 13.99,
        newAmount: 15.99,
        percentChange: 14.3,
        direction: 'increased',
        currency: 'EUR',
        confidence: 90,
      },
    ]);
  });

  it('excludes income patterns entirely — a recurring salary is never subscription creep', async () => {
    detectRecurringPatterns.mockResolvedValue({
      patterns: [
        pattern({
          recipientId: 7,
          recipientName: 'Employer BV',
          direction: 'income',
          latestAmount: 3200,
          // Even with amount changes, an income pattern must not surface.
          amountChanges: [change({ previousAmount: 3000, newAmount: 3200, percentChange: 6.7 })],
        }),
      ],
      total: 1,
    });

    const digest = await detectSubscriptionCreep();

    expect(digest).toEqual({ new: [], priceChanges: [] });
  });

  it("a 'new' dismissal removes the new finding but keeps the priceChange for the same recipient", async () => {
    detectRecurringPatterns.mockResolvedValue({
      patterns: [pattern({ amountChanges: [change()] })],
      total: 1,
    });

    const digest = await detectSubscriptionCreep({
      dismissRecords: [{ recipientId: 1, findingType: 'new' }],
    });

    expect(digest.new).toEqual([]);
    expect(digest.priceChanges).toHaveLength(1);
    expect(digest.priceChanges[0]).toMatchObject({ recipientId: 1, findingType: 'priceChange' });
  });

  it("a 'priceChange' dismissal removes the priceChange finding but keeps the new one", async () => {
    detectRecurringPatterns.mockResolvedValue({
      patterns: [pattern({ amountChanges: [change()] })],
      total: 1,
    });

    const digest = await detectSubscriptionCreep({
      dismissRecords: [{ recipientId: 1, findingType: 'priceChange' }],
    });

    expect(digest.priceChanges).toEqual([]);
    expect(digest.new).toHaveLength(1);
    expect(digest.new[0]).toMatchObject({ recipientId: 1, findingType: 'new' });
  });

  it('caps each list to the top 5 by confidence descending', async () => {
    // Seven expense patterns with confidences 60..90, all with a price change.
    const confidences = [70, 90, 60, 85, 75, 65, 80];
    detectRecurringPatterns.mockResolvedValue({
      patterns: confidences.map((confidence, i) =>
        pattern({
          recipientId: i + 1,
          recipientName: `Service ${i + 1}`,
          confidence,
          amountChanges: [change()],
        })
      ),
      total: confidences.length,
    });

    const digest = await detectSubscriptionCreep();

    expect(digest.new).toHaveLength(5);
    expect(digest.priceChanges).toHaveLength(5);
    // Highest confidence kept, sorted descending; 60 and 65 dropped.
    expect(digest.new.map((f) => f.confidence)).toEqual([90, 85, 80, 75, 70]);
    expect(digest.priceChanges.map((f) => f.confidence)).toEqual([90, 85, 80, 75, 70]);
  });

  it('returns empty lists when the detector finds no patterns', async () => {
    detectRecurringPatterns.mockResolvedValue({ patterns: [], total: 0 });

    const digest = await detectSubscriptionCreep();

    expect(digest).toEqual({ new: [], priceChanges: [] });
  });
});

describe('buildSubscriptionCreep', () => {
  it('is a pure diff/filter over the detection result with independent per-type dismissal', () => {
    const recurringResult = {
      patterns: [
        pattern({ recipientId: 1, recipientName: 'Netflix', amountChanges: [change()] }),
        pattern({ recipientId: 2, recipientName: 'Spotify', confidence: 80 }),
        pattern({ recipientId: 3, recipientName: 'Employer BV', direction: 'income' }),
      ],
      total: 3,
    };

    const digest = buildSubscriptionCreep(recurringResult, [
      { recipientId: 2, findingType: 'new' },
      { recipientId: 1, findingType: 'priceChange' },
    ]);

    // Spotify's 'new' dismissed; Netflix's stays. Netflix's priceChange
    // dismissed; nothing else has one. Income excluded throughout.
    expect(digest.new).toHaveLength(1);
    expect(digest.new[0]).toMatchObject({ recipientId: 1, findingType: 'new' });
    expect(digest.priceChanges).toEqual([]);
  });

  it('tolerates a missing patterns array and defaults dismissRecords to none', () => {
    expect(buildSubscriptionCreep({})).toEqual({ new: [], priceChanges: [] });
    expect(buildSubscriptionCreep(undefined)).toEqual({ new: [], priceChanges: [] });
  });
});
