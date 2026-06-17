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

import { getJson, num } from './httpClient.js';
import { periodToMs, trimToRange } from './macroRange.js';
import { searchCatalog, catalogEntry } from './macroCatalog.js';

const BASE = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data';

/**
 * Parse a Eurostat JSON-stat (2.0) single-series payload into time/value pairs.
 * When the pinned dimensions resolve to one series, `value` is a map keyed by the
 * flat index of the time dimension. Missing observations are skipped.
 * @param {any} payload
 * @returns {Array<{ period: string, time: number, value: number }>}
 */
export function parseJsonStat(payload) {
  const timeIndex = payload?.dimension?.time?.category?.index;
  const values = payload?.value;
  if (!timeIndex || typeof timeIndex !== 'object' || !values || typeof values !== 'object') {
    return [];
  }
  const out = [];
  for (const [period, idx] of Object.entries(timeIndex)) {
    const value = num(values[idx] ?? values[String(idx)]);
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

  async macroSearch(query) {
    return { items: searchCatalog('eurostat', query) };
  },

  async macroSeries(seriesId, { range = '5y' } = {}) {
    // seriesId already carries the `?dim=val&…` query; append directly to the
    // fixed Eurostat host (no user-supplied host — see macroCatalog shape guard).
    const data = await getJson(`${BASE}/${seriesId}`);
    const points = parseJsonStat(data).map((p) => ({
      time: p.time,
      close: p.value,
      high: undefined,
      low: undefined,
      volume: undefined,
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
