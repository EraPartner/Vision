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

import { z } from 'zod';
import { getJson, num } from './httpClient.js';
import { periodToMs, trimToRange } from './macroRange.js';
import { searchCatalog, catalogEntry } from './macroCatalog.js';
import { looseString, parseOr } from './schemas.js';

const BASE = 'https://api.db.nomics.world/v22/series';

// Envelope and doc are validated separately: doc PRESENCE keeps the existing
// "series not found" throw, while a truthy-but-malformed doc degrades to an
// empty series (as the old Array.isArray guards did).
const seriesEnvelopeSchema = z.looseObject({
  series: z.looseObject({ docs: z.array(z.any()).catch([]) }).catch({ docs: [] }),
});

const seriesDocSchema = z.looseObject({
  series_name: looseString,
  '@frequency': looseString,
  period_start_day: z.array(z.any()).catch([]),
  period: z.array(z.any()).catch([]),
  value: z.array(z.any()).catch([]),
});

const dbnomicsAdapter = {
  key: 'dbnomics',

  async macroSearch(query) {
    return { items: searchCatalog('dbnomics', query) };
  },

  async macroSeries(seriesId, { range = '5y' } = {}) {
    const data = await getJson(`${BASE}/${seriesId}?observations=1`);
    const docRaw = parseOr(seriesEnvelopeSchema, data, { series: { docs: [] } }).series.docs[0];
    if (!docRaw) throw new Error('dbnomics: series not found');
    const doc = parseOr(seriesDocSchema, docRaw, { period_start_day: [], period: [], value: [] });
    const { period_start_day: days, period: periods, value: values } = doc;
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
