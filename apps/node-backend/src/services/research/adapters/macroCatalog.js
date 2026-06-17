/**
 * Curated macro series catalog (ADR-082).
 *
 * FRED offers open-ended series search, but it needs an API key and carries no
 * euro-area equivalent (DBnomics has no FRED provider). This curated set makes
 * the highest-value EU / Belgian indicators discoverable KEYLESS via Eurostat,
 * so the macro search box returns useful results before any FRED key is set.
 *
 * Each entry resolves to exactly ONE time series. Extend freely — keep ids
 * verified against the live API.
 *
 * seriesId formats:
 *   eurostat: `<dataset>?<dimension-query>` (one value per dimension → one series)
 *   dbnomics: `<provider>/<dataset>/<series>`
 *   fred:     `<series_id>` (open search means FRED rarely needs catalog entries)
 */

const SOURCE_LABEL = Object.freeze({ fred: 'FRED', eurostat: 'Eurostat', dbnomics: 'DBnomics' });

/** Recognised macro providers (provider-pinned; never raced). */
export const MACRO_PROVIDERS = Object.freeze(['fred', 'eurostat', 'dbnomics']);

/**
 * Per-provider seriesId shape guards. seriesId is appended to a fixed provider
 * host (no SSRF surface — see httpClient), but validating the shape rejects junk
 * early and documents the expected format.
 */
const SERIES_ID_PATTERN = Object.freeze({
  fred: /^[A-Za-z0-9_.@-]{1,64}$/,
  dbnomics: /^[A-Za-z0-9_]+\/[A-Za-z0-9_]+\/[A-Za-z0-9_.:+-]+$/,
  eurostat: /^[a-z0-9_]+\?[A-Za-z0-9_=&%.,:+-]+$/,
});

export const MACRO_CATALOG = Object.freeze([
  {
    provider: 'eurostat',
    seriesId: 'prc_hicp_midx?geo=BE&coicop=CP00&unit=I15',
    title: 'HICP — All items, Belgium (2015=100)',
    region: 'BE',
    units: 'Index 2015=100',
    frequency: 'monthly',
    keywords: ['inflation', 'cpi', 'hicp', 'consumer prices', 'belgium', 'inflatie', 'prijzen'],
  },
  {
    provider: 'eurostat',
    seriesId: 'prc_hicp_midx?geo=EA&coicop=CP00&unit=I15',
    title: 'HICP — All items, Euro area (2015=100)',
    region: 'EA',
    units: 'Index 2015=100',
    frequency: 'monthly',
    keywords: ['inflation', 'cpi', 'hicp', 'consumer prices', 'euro area', 'eurozone'],
  },
  {
    provider: 'eurostat',
    seriesId: 'une_rt_m?geo=BE&s_adj=SA&sex=T&age=TOTAL&unit=PC_ACT',
    title: 'Unemployment rate, Belgium (% of active pop.)',
    region: 'BE',
    units: '% of active population',
    frequency: 'monthly',
    keywords: ['unemployment', 'jobless', 'labour market', 'belgium', 'werkloosheid'],
  },
  {
    provider: 'eurostat',
    seriesId: 'une_rt_m?geo=EU27_2020&s_adj=SA&sex=T&age=TOTAL&unit=PC_ACT',
    title: 'Unemployment rate, European Union (% of active pop.)',
    region: 'EU',
    units: '% of active population',
    frequency: 'monthly',
    // une_rt_m publishes no euro-area (EA*) aggregate under these dims — only the
    // EU-wide series carries values (verified against the live API, 2026-06).
    keywords: ['unemployment', 'jobless', 'labour market', 'european union', 'eu', 'europe'],
  },
  {
    provider: 'eurostat',
    seriesId: 'namq_10_gdp?geo=BE&na_item=B1GQ&unit=CLV_PCH_PRE&s_adj=SCA',
    title: 'Real GDP growth, Belgium (% q/q)',
    region: 'BE',
    units: '% change on previous quarter',
    frequency: 'quarterly',
    keywords: ['gdp', 'growth', 'economy', 'output', 'belgium', 'bbp', 'groei'],
  },
  {
    provider: 'eurostat',
    seriesId: 'namq_10_gdp?geo=EA20&na_item=B1GQ&unit=CLV_PCH_PRE&s_adj=SCA',
    title: 'Real GDP growth, Euro area (% q/q)',
    region: 'EA',
    units: '% change on previous quarter',
    frequency: 'quarterly',
    keywords: ['gdp', 'growth', 'economy', 'output', 'euro area', 'eurozone', 'bbp'],
  },
]);

/** Normalise a catalog entry to the wire `MacroSeriesItem` shape. */
function toItem(e) {
  return {
    provider: e.provider,
    seriesId: e.seriesId,
    title: e.title,
    region: e.region,
    units: e.units,
    frequency: e.frequency,
    source: SOURCE_LABEL[e.provider] ?? e.provider,
  };
}

/**
 * Case-insensitive AND-match of `query` terms over a provider's catalog entries
 * (title + region + keywords). Returns wire-shaped items.
 * @param {string} provider
 * @param {string} query
 * @returns {Array<object>}
 */
export function searchCatalog(provider, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  return MACRO_CATALOG
    .filter((e) => e.provider === provider)
    .filter((e) => {
      const hay = `${e.title} ${e.region} ${e.keywords.join(' ')}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .map(toItem);
}

/**
 * The raw catalog entry for a (provider, seriesId), or undefined.
 * @param {string} provider
 * @param {string} seriesId
 */
export function catalogEntry(provider, seriesId) {
  return MACRO_CATALOG.find((e) => e.provider === provider && e.seriesId === seriesId);
}

/**
 * True if `seriesId` matches the provider's expected shape.
 * @param {string} provider
 * @param {string} seriesId
 * @returns {boolean}
 */
export function isValidSeriesId(provider, seriesId) {
  const re = SERIES_ID_PATTERN[provider];
  return Boolean(re && typeof seriesId === 'string' && re.test(seriesId));
}
