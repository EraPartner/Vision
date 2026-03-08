/**
 * Recurring Transaction Detection Service.
 *
 * Analyses transaction history to detect recurring patterns:
 * - Groups transactions by recipient
 * - Detects regular intervals (weekly, monthly, quarterly, yearly)
 * - Flags amount changes
 * - Returns suggestions for planned transactions
 */

import { query } from '../database/connection.js';
import { logger } from '../config/logger.js';

const MIN_OCCURRENCES = 3; // Minimum transactions to consider a pattern
const INTERVAL_TOLERANCE = 0.25; // 25% tolerance for interval matching

// Known interval patterns (in days)
const INTERVAL_PATTERNS = [
  { name: 'weekly', days: 7, tolerance: 2 },
  { name: 'biweekly', days: 14, tolerance: 3 },
  { name: 'monthly', days: 30, tolerance: 5 },
  { name: 'quarterly', days: 91, tolerance: 10 },
  { name: 'yearly', days: 365, tolerance: 20 },
];

/**
 * Detect the most likely recurrence pattern from a series of intervals.
 */
function detectInterval(intervals) {
  if (intervals.length === 0) return null;

  const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const medianInterval = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)];

  // Try to match against known patterns using median (more robust to outliers)
  for (const pattern of INTERVAL_PATTERNS) {
    if (Math.abs(medianInterval - pattern.days) <= pattern.tolerance) {
      // Verify consistency: most intervals should be within tolerance
      const matching = intervals.filter(
        (i) => Math.abs(i - pattern.days) <= pattern.tolerance
      );
      const consistency = matching.length / intervals.length;
      if (consistency >= 0.6) {
        return {
          pattern: pattern.name,
          avgDays: Math.round(avgInterval),
          medianDays: Math.round(medianInterval),
          consistency: Math.round(consistency * 100),
        };
      }
    }
  }

  // Check for custom regular interval
  const stdDev = Math.sqrt(
    intervals.reduce((s, v) => s + Math.pow(v - avgInterval, 2), 0) / intervals.length
  );
  const cv = stdDev / avgInterval; // Coefficient of variation

  if (cv < INTERVAL_TOLERANCE && avgInterval >= 5) {
    return {
      pattern: 'custom',
      avgDays: Math.round(avgInterval),
      medianDays: Math.round(medianInterval),
      consistency: Math.round((1 - cv) * 100),
      customIntervalDays: Math.round(medianInterval),
    };
  }

  return null;
}

/**
 * Detect amount changes in a recurring pattern.
 */
function detectAmountChanges(transactions) {
  if (transactions.length < 2) return [];

  const changes = [];
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));

  // Calculate baseline (median of all amounts)
  const amounts = sorted.map((t) => Math.abs(parseFloat(t.amount)));
  const medianAmount = [...amounts].sort((a, b) => a - b)[Math.floor(amounts.length / 2)];

  // Check last few transactions for changes
  for (let i = Math.max(0, sorted.length - 3); i < sorted.length; i++) {
    const amt = Math.abs(parseFloat(sorted[i].amount));
    const pctChange = ((amt - medianAmount) / medianAmount) * 100;

    if (Math.abs(pctChange) > 5) {
      // More than 5% change from median
      changes.push({
        date: sorted[i].date,
        previousAmount: medianAmount,
        newAmount: amt,
        percentChange: Math.round(pctChange * 100) / 100,
        direction: pctChange > 0 ? 'increased' : 'decreased',
      });
    }
  }

  return changes;
}

/**
 * Main detection function - analyses all transactions and returns recurring patterns.
 */
export async function detectRecurringPatterns() {
  try {
    // Get transactions grouped by recipient, ordered by date
    const result = await query(`
      SELECT t.id, t.date, t.amount, t.currency, t.memo, t.bank_account,
             t.recipient_id, r.name AS recipient_name,
             t.category_id,
             COALESCE(c.general || ':' || c.detail, NULL) AS category_name
      FROM transactions t
      LEFT JOIN recipients r ON t.recipient_id = r.id
      LEFT JOIN categories c ON COALESCE(t.category_id, r.default_category_id) = c.id
      WHERE t.is_active = true
        AND t.recipient_id IS NOT NULL
      ORDER BY t.recipient_id, t.date
    `);

    if (result.rows.length === 0) return { patterns: [], total: 0 };

    // Group by recipient
    const byRecipient = {};
    for (const row of result.rows) {
      const key = row.recipient_id;
      if (!byRecipient[key]) {
        byRecipient[key] = {
          recipientId: row.recipient_id,
          recipientName: row.recipient_name || 'Unknown',
          transactions: [],
        };
      }
      byRecipient[key].transactions.push(row);
    }

    const patterns = [];

    for (const group of Object.values(byRecipient)) {
      const txns = group.transactions;

      if (txns.length < MIN_OCCURRENCES) continue;

      // Calculate intervals between consecutive transactions (in days)
      const intervals = [];
      for (let i = 1; i < txns.length; i++) {
        const d1 = new Date(txns[i - 1].date);
        const d2 = new Date(txns[i].date);
        const daysDiff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
        if (daysDiff > 0) intervals.push(daysDiff);
      }

      if (intervals.length < MIN_OCCURRENCES - 1) continue;

      const detected = detectInterval(intervals);
      if (!detected) continue;

      // Get amounts info
      const amounts = txns.map((t) => Math.abs(parseFloat(t.amount)));
      const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;
      const latestAmount = amounts[amounts.length - 1];
      const currency = txns[0].currency || 'EUR';

      // Check for amount changes
      const amountChanges = detectAmountChanges(txns);

      // Predict next occurrence
      const lastDate = new Date(txns[txns.length - 1].date);
      const nextDate = new Date(lastDate);
      nextDate.setDate(nextDate.getDate() + detected.medianDays);

      // Check if already tracked as planned transaction
      const existingPlanned = await query(
        `SELECT id FROM planned_transactions
         WHERE recipient_id = $1 AND is_active = true
         LIMIT 1`,
        [group.recipientId]
      );
      const isAlreadyPlanned = existingPlanned.rows.length > 0;

      patterns.push({
        recipientId: group.recipientId,
        recipientName: group.recipientName,
        detectedPattern: detected.pattern,
        intervalDays: detected.medianDays,
        consistency: detected.consistency,
        occurrences: txns.length,
        averageAmount: Math.round(avgAmount * 100) / 100,
        latestAmount: Math.round(latestAmount * 100) / 100,
        currency,
        categoryId: txns[txns.length - 1].category_id,
        categoryName: txns[txns.length - 1].category_name,
        bankAccount: txns[txns.length - 1].bank_account,
        firstSeen: txns[0].date,
        lastSeen: txns[txns.length - 1].date,
        predictedNext: nextDate.toISOString().split('T')[0],
        amountChanges,
        isAlreadyPlanned,
        // Confidence score (0-100)
        confidence: Math.min(
          100,
          Math.round(
            detected.consistency * 0.5 +
            Math.min(txns.length, 12) / 12 * 30 +
            (amountChanges.length === 0 ? 20 : 10)
          )
        ),
      });
    }

    // Sort by confidence descending
    patterns.sort((a, b) => b.confidence - a.confidence);

    return {
      patterns,
      total: patterns.length,
    };
  } catch (err) {
    logger.error('Error detecting recurring patterns', { error: err.message });
    throw err;
  }
}
