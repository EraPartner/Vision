/**
 * FRED (Federal Reserve Economic Data) macro adapter (ADR-082).
 *
 * Keyed via FRED_API_KEY (free, ~120 req/min). The open-ended discovery engine
 * for the macro vertical: `/series/search` returns chartable series directly,
 * covering US + many global indicators — CPI, policy/market rates (incl. ECB
 * `ECBMRRFR`/`ECBDFR`), GDP, unemployment, and regional-Fed business surveys
 * (the free PMI proxies). Provider-pinned: a FRED seriesId is fetched only here.
 */

import { getJson, num } from './httpClient.js';
import { providerKey } from '../providerKeys.js';
import { trimToRange } from './macroRange.js';

const BASE = 'https://api.stlouisfed.org/fred';

function key() {
  const k = providerKey('fred');
  if (!k) throw new Error('FRED_API_KEY not configured');
  return k;
}

const fredAdapter = {
  key: 'fred',

  async macroSearch(query) {
    const url =
      `${BASE}/series/search?search_text=${encodeURIComponent(query)}` +
      `&api_key=${key()}&file_type=json&limit=15&order_by=popularity&sort_order=desc`;
    const data = await getJson(url);
    const items = (data?.seriess || [])
      .filter((s) => s?.id)
      .map((s) => ({
        provider: 'fred',
        seriesId: s.id,
        title: s.title || s.id,
        units: s.units_short || s.units || undefined,
        frequency: s.frequency || s.frequency_short || undefined,
        region: undefined,
        source: 'FRED',
      }));
    return { items };
  },

  async macroSeries(seriesId, { range = '5y' } = {}) {
    const k = key();
    const enc = encodeURIComponent(seriesId);
    // Fetch the full series and trim client-side anchored on the last point — see
    // macroRange. FRED series are compact (a daily series is still well under the
    // httpClient 5 MB cap), and the result is cached for 12 h.
    const obsUrl = `${BASE}/series/observations?series_id=${enc}&api_key=${k}&file_type=json&sort_order=asc`;
    const metaUrl = `${BASE}/series?series_id=${enc}&api_key=${k}&file_type=json`;
    const [obs, meta] = await Promise.all([
      getJson(obsUrl),
      getJson(metaUrl).catch(() => undefined),
    ]);
    const points = (obs?.observations || [])
      .map((o) => ({
        time: Date.parse(o?.date),
        close: num(o?.value), // FRED encodes missing as "." → num() → undefined
      }))
      .filter((p) => Number.isFinite(p.time) && p.close !== undefined)
      .map((p) => ({ time: p.time, close: p.close, high: undefined, low: undefined, volume: undefined }));
    const m = meta?.seriess?.[0];
    return {
      provider: 'fred',
      seriesId,
      title: m?.title || seriesId,
      units: m?.units_short || m?.units || undefined,
      frequency: m?.frequency || undefined,
      points: trimToRange(points, range),
    };
  },
};

export default fredAdapter;
