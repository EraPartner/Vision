/**
 * Eurostat macro adapter (ADR-082). Keyless, first-party.
 *
 * Fetches a single series from the Eurostat dissemination API and parses its
 * JSON-stat payload. `parseJsonStat` is modeled on the proven HICP handling in
 * belgianInflationService but kept SEPARATE per the ADR-082 firewall: that
 * service feeds real-return/tax-adjacent math and is not modified here. Discovery
 * is via the curated MACRO_CATALOG so the highest-value EU/Belgian indicators are
 * keyless-searchable. seriesId = `<dataset>?<dimension-query>`.
 */

import { z } from 'zod';
import { getJson, num } from './httpClient.js';
import { periodToMs, trimToRange } from './macroRange.js';
import { searchCatalog, catalogEntry } from './macroCatalog.js';
import { parseOr } from './schemas.js';

const BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';

// JSON-stat 2.0 single-series shape. Both the time index and the observation
// map allow the sparse object form AND the dense array form (JSON-stat permits
// either); a payload that fails this shape degrades to an empty series.
const jsonStatSchema = z.looseObject({
  dimension: z.looseObject({
    time: z.looseObject({
      category: z.looseObject({
        index: z.union([z.record(z.string(), z.any()), z.array(z.any())]),
      }),
    }),
  }),
  value: z.union([z.record(z.string(), z.any()), z.array(z.any())]),
});

/**
 * Parse a Eurostat JSON-stat (2.0) single-series payload into time/value pairs.
 * When the pinned dimensions resolve to one series, `value` is a map keyed by the
 * flat index of the time dimension. Missing observations are skipped.
 * @param {any} payload
 * @returns {Array<{ period: string, time: number, value: number }>}
 */
 function parseJsonStat(payload) {
  const parsed = parseOr(jsonStatSchema, payload, undefined);
  if (!parsed) return [];
  const timeIndex = /** @type {Record<string, unknown>} */ (parsed.dimension.time.category.index);
  const values = /** @type {Record<string, unknown>} */ (parsed.value);
  const out = [];
  for (const [period, idx] of Object.entries(timeIndex)) {
    const idxKey = /** @type {string} */ (idx);
    const value = num(values[idxKey] ?? values[String(idxKey)]);
    if (value === undefined) continue;
    const time = periodToMs(period);
    if (time === undefined) continue;
    out.push({ period, time, value });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

const eurostatAdapter = {
  key: 'eurostat',

  /** @param {string} query */
  async macroSearch(query) {
    return { items: searchCatalog('eurostat', query) };
  },

  /**
   * @param {string} seriesId
   * @param {{ range?: string }} [opts]
   */
  async macroSeries(seriesId, { range = '5y' } = {}) {
    // seriesId already carries the `?dim=val&…` query; append directly to the
    // fixed Eurostat host (no user-supplied host — see macroCatalog shape guard).
    const data = await getJson(`${BASE}/${seriesId}`);
    const points = parseJsonStat(data).map((p) => ({
      time: p.time,
      close: p.value,
      high: /** @type {number | undefined} */ (undefined),
      low: /** @type {number | undefined} */ (undefined),
      volume: /** @type {number | undefined} */ (undefined),
    }));
    const entry = catalogEntry('eurostat', seriesId);
    return {
      provider: 'eurostat',
      seriesId,
      title: entry?.title || data?.label || seriesId,
      units: entry?.units,
      frequency: entry?.frequency,
      points: trimToRange(points, range),
    };
  },
};

export default eurostatAdapter;

export { parseJsonStat as __parseJsonStat };
