/**
 * Subscription-Creep Digest Service.
 *
 * Builds a "subscription creep" digest on top of the EXISTING recurring-pattern
 * detector — this service is a pure diff/filter layer and performs no DB access
 * or detection of its own:
 * - Restricts to `direction === 'expense'` patterns (outflows only; a recurring
 *   salary must never surface as a "new subscription")
 * - `new` findings: every undismissed recurring expense pattern. Per the
 *   backlog spec there is deliberately NO recency/snapshot check — a pattern
 *   counts as "new" until the user dismisses it.
 * - `priceChanges` findings: undismissed expense patterns whose
 *   `amountChanges` is non-empty, reporting the LAST (most recent) change
 * - Each list is capped to the top 5 by confidence descending so a long gap
 *   since last viewed does not dump a wall of items
 *
 * Dismiss suppression is applied as a pure post-filter keyed by
 * {recipientId, findingType} — a 'new' dismissal never clears a 'priceChange'
 * finding for the same recipient, and vice-versa. Unlike category outliers
 * there is NO time window: a dismissal is a permanent suppression. Persistence
 * of dismiss records lives elsewhere (UI layer owns it).
 *
 * No caching here: detectRecurringPatterns already memoises its result in a
 * short-TTL cache, and the diff/filter work on top of it is trivial.
 */

import { detectRecurringPatterns } from './recurringDetectionService.js';

// Each list ("new" and "priceChanges") is capped to this many findings,
// highest confidence first.
const MAX_FINDINGS_PER_LIST = 5;

/**
 * Suppression key for a dismiss record or finding: `recipientId:findingType`.
 *
 * @param {number|string} recipientId
 * @param {'new'|'priceChange'} findingType
 * @returns {string}
 */
function dismissKey(recipientId, findingType) {
  return `${recipientId}:${findingType}`;
}

/**
 * Build the Set of suppression keys from dismiss records, ignoring malformed
 * entries instead of throwing.
 *
 * @param {Array<{ recipientId: number, findingType: 'new'|'priceChange' }>} [dismissRecords]
 * @returns {Set<string>}
 */
function buildDismissedSet(dismissRecords) {
  const dismissed = new Set();
  if (!Array.isArray(dismissRecords)) return dismissed;
  for (const rec of dismissRecords) {
    if (!rec || rec.recipientId == null || !rec.findingType) continue;
    dismissed.add(dismissKey(rec.recipientId, rec.findingType));
  }
  return dismissed;
}

/**
 * Sort findings by confidence descending and cap the list.
 *
 * @param {any[]} findings
 * @returns {any[]} the top {@link MAX_FINDINGS_PER_LIST} findings
 */
function topByConfidence(findings) {
  return [...findings]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_FINDINGS_PER_LIST);
}

/**
 * Pure builder: diff/filter the recurring-detection result into the
 * subscription-creep digest.
 *
 * All amounts are passed through as the plain JSON numbers already present on
 * the pattern objects — no Decimal wrapping happens here.
 *
 * @param {{ patterns?: any[] }} recurringResult Result of detectRecurringPatterns.
 * @param {Array<{ recipientId: number, findingType: 'new'|'priceChange' }>} [dismissRecords]
 * @returns {{ new: any[], priceChanges: any[] }}
 */
export function buildSubscriptionCreep(recurringResult, dismissRecords = []) {
  const patterns = Array.isArray(recurringResult?.patterns)
    ? recurringResult.patterns
    : [];
  const dismissed = buildDismissedSet(dismissRecords);

  const newFindings = [];
  const priceChangeFindings = [];

  for (const pattern of patterns) {
    if (!pattern || pattern.direction !== 'expense') continue; // outflows only

    if (!dismissed.has(dismissKey(pattern.recipientId, 'new'))) {
      newFindings.push({
        recipientId: pattern.recipientId,
        recipientName: pattern.recipientName,
        findingType: 'new',
        latestAmount: pattern.latestAmount,
        currency: pattern.currency,
        detectedPattern: pattern.detectedPattern,
        intervalDays: pattern.intervalDays,
        predictedNext: pattern.predictedNext,
        confidence: pattern.confidence,
      });
    }

    const changes = pattern.amountChanges;
    if (
      Array.isArray(changes) &&
      changes.length > 0 &&
      !dismissed.has(dismissKey(pattern.recipientId, 'priceChange'))
    ) {
      // The LAST element is the most recent change — that is the current one.
      const change = changes[changes.length - 1];
      priceChangeFindings.push({
        recipientId: pattern.recipientId,
        recipientName: pattern.recipientName,
        findingType: 'priceChange',
        previousAmount: change.previousAmount,
        newAmount: change.newAmount,
        percentChange: change.percentChange,
        direction: change.direction,
        currency: pattern.currency,
        confidence: pattern.confidence,
      });
    }
  }

  return {
    new: topByConfidence(newFindings),
    priceChanges: topByConfidence(priceChangeFindings),
  };
}

/**
 * Main digest function — reuses the recurring-pattern detector (which caches
 * internally) and diffs/filters its result into the subscription-creep slice
 * of the insights digest.
 *
 * Findings are JSON-serializable plain objects:
 * - `new`: `{ recipientId, recipientName, findingType: 'new', latestAmount,
 *   currency, detectedPattern, intervalDays, predictedNext, confidence }`
 * - `priceChanges`: `{ recipientId, recipientName, findingType: 'priceChange',
 *   previousAmount, newAmount, percentChange, direction, currency, confidence }`
 *
 * Each list is sorted by confidence descending and capped to 5 entries.
 *
 * @param {{ dismissRecords?: Array<{ recipientId: number, findingType: 'new'|'priceChange' }> }} [options]
 * @returns {Promise<{ new: any[], priceChanges: any[] }>}
 */
export async function detectSubscriptionCreep({ dismissRecords = [] } = {}) {
  const recurringResult = await detectRecurringPatterns();
  return buildSubscriptionCreep(recurringResult, dismissRecords);
}
