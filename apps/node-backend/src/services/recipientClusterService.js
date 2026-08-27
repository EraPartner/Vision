/**
 * Recipient Cluster Service
 *
 * Detects groups of recipients that share a long common prefix (LCP)
 * and the same default_category_id (or both null). These are candidates
 * for merge + pattern creation via the RecipientsPage cleanup card.
 *
 * The approach mirrors suggestPatternFromNames in recipientPatternService.js:
 * recipients are uppercased and compared pairwise within a bucket whose key
 * is formed from the first N characters of the normalized name + category.
 */

import { query } from '../database/connection.js';
import { suggestPatternFromNames } from './recipientPatternService.js';

const MIN_LCP_LENGTH = 8;
const BUCKET_PREFIX_LENGTH = 4;
const MAX_CLUSTERS = 50;
// Keep the service's in-memory scan bounded on unusually large recipient sets.
// The ordering makes the truncated window deterministic and API-documentable.
const MAX_RECIPIENT_SCAN = 10_000;

/**
 * Returns candidate recipient clusters: groups of 2+ active primary recipients
 * that share a meaningful common prefix and an identical (or both-null) default
 * category, and for which a pattern suggestion can be built.
 *
 * @param {{ minCount?: number }} [opts]
 * @returns {Promise<Array<{
 *   lcp: string,
 *   confidence: 'high'|'medium'|'low',
 *   recipientIds: number[],
 *   recipientNames: string[],
 *   categoryId: number|null,
 *   suggestedPattern: string,
 *   suggestedKind: string,
 * }>>}
 */
export async function findRecipientClusters({ minCount = 2 } = {}) {
  /** @type {{ rows: Array<{ id: number, name: string, default_category_id: number|null }> }} */
  const { rows } = await query(
    `SELECT id, name, default_category_id
       FROM recipients
      WHERE is_active = true
        AND primary_recipient_id IS NULL
      ORDER BY name, id
      LIMIT $1`,
    [MAX_RECIPIENT_SCAN],
  );

  /** @type {Map<string, Array<{ id: number, name: string, default_category_id: number|null }>>} */
  const buckets = new Map();
  for (const recipient of rows) {
    const upper = recipient.name.trim().toUpperCase();
    const bucketKey = `${upper.slice(0, BUCKET_PREFIX_LENGTH)}::${recipient.default_category_id ?? 'null'}`;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(recipient);
  }

  const clusters = [];

  for (const group of buckets.values()) {
    const names = group.map((r) => r.name);
    const suggestion = suggestPatternFromNames(names);
    if (!suggestion || suggestion.pattern.length < MIN_LCP_LENGTH) continue;

    const lcp = suggestion.pattern;

    // Only include recipients whose name actually starts with the LCP (case-insensitive).
    const matching = group.filter((r) =>
      r.name.trim().toUpperCase().startsWith(lcp),
    );
    if (matching.length < minCount) continue;

    clusters.push({
      lcp,
      confidence: suggestion.confidence,
      recipientIds: matching.map((r) => r.id),
      recipientNames: matching.map((r) => r.name),
      categoryId: matching[0].default_category_id ?? null,
      suggestedPattern: lcp,
      suggestedKind: suggestion.kind,
    });

    if (clusters.length >= MAX_CLUSTERS) break;
  }

  return clusters;
}
