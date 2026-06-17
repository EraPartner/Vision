/**
 * DBnomics macro adapter (ADR-082). Keyless.
 *
 * Fetches any series by fully-qualified id (`provider/dataset/series`) from the
 * DBnomics aggregation API — the path to ECB / OECD / IMF SDMX series without a
 * bespoke client. `period_start_day[]` is parallel to `value[]` (clean ISO
 * dates). Discovery is via the curated catalog (no DBnomics entries in v1 — its
 * `/search` returns datasets, not chartable series — but fetch-by-id is live and
 * the catalog is extensible).
 */

import { getJson, num } from './httpClient.js';
import { periodToMs, trimToRange } from './macroRange.js';
import { searchCatalog, catalogEntry } from './macroCatalog.js';

const BASE = 'https://api.db.nomics.world/v22/series';

const dbnomicsAdapter = {
  key: 'dbnomics',

  async macroSearch(query) {
    return { items: searchCatalog('dbnomics', query) };
  },

  async macroSeries(seriesId, { range = '5y' } = {}) {
    const data = await getJson(`${BASE}/${seriesId}?observations=1`);
    const doc = data?.series?.docs?.[0];
    if (!doc) throw new Error('dbnomics: series not found');
    const days = Array.isArray(doc.period_start_day) ? doc.period_start_day : [];
    const periods = Array.isArray(doc.period) ? doc.period : [];
    const values = Array.isArray(doc.value) ? doc.value : [];
    const points = [];
    for (let i = 0; i < values.length; i += 1) {
      const close = num(values[i]); // DBnomics encodes missing as "NA" → undefined
      if (close === undefined) continue;
      const time = days[i] ? Date.parse(days[i]) : periodToMs(periods[i]);
      if (!Number.isFinite(time)) continue;
      points.push({ time, close, high: undefined, low: undefined, volume: undefined });
    }
    points.sort((a, b) => a.time - b.time);
    const entry = catalogEntry('dbnomics', seriesId);
    return {
      provider: 'dbnomics',
      seriesId,
      title: entry?.title || doc.series_name || seriesId,
      units: entry?.units,
      frequency: entry?.frequency || doc['@frequency'],
      points: trimToRange(points, range),
    };
  },
};

export default dbnomicsAdapter;
