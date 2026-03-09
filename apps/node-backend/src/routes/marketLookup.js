/**
 * Market Lookup routes — proxy Yahoo Finance for quote + sparkline data.
 * Avoids CORS issues by fetching server-side.
 */

import { Router } from 'express';
import { logger } from '../config/logger.js';

const router = Router();

// Realistic browser headers — Yahoo Finance blocks simple non-browser User-Agents
const YAHOO_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

const YAHOO_JSON_HEADERS = {
  ...YAHOO_HEADERS,
  'Accept': 'application/json',
};

/**
 * Yahoo Finance requires a cookie + crumb pair for authenticated API calls.
 * 1. GET https://fc.yahoo.com  → sets session cookies
 * 2. GET /v1/test/getcrumb with those cookies → returns the crumb string
 * 3. Append ?crumb=<crumb> to all quoteSummary / quote requests
 */
let _yfSession = { cookieHeader: '', crumb: '', exp: 0 };

async function getYahooSession() {
  if (_yfSession.crumb && Date.now() < _yfSession.exp) return _yfSession;

  try {
    // Step 1: get session cookies from Yahoo consent / auth endpoint
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: YAHOO_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const rawCookie = r1.headers.get('set-cookie') || '';
    // set-cookie is a single concatenated header; split on ", " before a new cookie name
    const cookieHeader = rawCookie.split(/,\s*(?=[A-Za-z_-]+=)/).map(c => c.split(';')[0]).join('; ');

    // Step 2: get the crumb token
    for (const host of ['query2', 'query1']) {
      try {
        const r2 = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, {
          headers: { ...YAHOO_JSON_HEADERS, Cookie: cookieHeader },
          signal: AbortSignal.timeout(5000),
        });
        console.log(`[DEBUG session] crumb from ${host}:`, r2.status);
        if (r2.ok) {
          const crumb = (await r2.text()).trim();
          console.log(`[DEBUG session] crumb value:`, crumb);
          if (crumb && crumb !== 'null' && crumb.length > 0) {
            _yfSession = { cookieHeader, crumb, exp: Date.now() + 3_600_000 };
            logger.info('Yahoo Finance session established');
            return _yfSession;
          }
        }
      } catch (_) { /* try next host */ }
    }
  } catch (e) {
    console.log('[DEBUG session] failed:', e.message);
  }

  logger.warn('Could not establish Yahoo Finance session — requests will be unauthenticated');
  return _yfSession;
}

/**
 * GET /api/market/search?q=apple
 * Search for tickers / companies.
 */
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) return res.json({ items: [] });

    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0&enableFuzzyQuery=false`;
    const response = await fetch(url, { headers: YAHOO_JSON_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Yahoo search error: ${response.status}`);
    const data = await response.json();

    const items = (data.quotes || [])
      .filter(q => q.symbol)
      .map(q => ({
        symbol: q.symbol,
        name: q.shortname || q.longname || q.symbol,
        type: q.quoteType || 'UNKNOWN',
        exchange: q.exchDisp || q.exchange || '',
      }));

    res.json({ items });
  } catch (err) {
    logger.error('Market search failed', { error: err.message });
    res.status(502).json({ detail: 'Market search unavailable' });
  }
});

// Extract a numeric value from Yahoo Finance's nested {raw, fmt} objects or plain numbers
function yfValue(obj, key) {
  if (!obj) return undefined;
  const v = obj[key];
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'object') return v.raw !== undefined ? v.raw : undefined;
  return typeof v === 'number' ? v : undefined;
}

/**
 * Fetch fundamentals using Yahoo Finance cookie+crumb authenticated quoteSummary.
 */
async function fetchFundamentals(symbol) {
  const session = await getYahooSession();
  const crumbQ = session.crumb ? `&crumb=${encodeURIComponent(session.crumb)}` : '';
  const authHeaders = { ...YAHOO_JSON_HEADERS, Cookie: session.cookieHeader };

  const modules = 'summaryDetail,price,financialData,defaultKeyStatistics';

  for (const host of ['query2', 'query1']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}${crumbQ}`;
      const r = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(6000) });
      console.log(`[DEBUG fundamentals] ${host} v10 status for ${symbol}:`, r.status);

      if (!r.ok) {
        const t = await r.text();
        console.log(`[DEBUG fundamentals] ${host} v10 body:`, t.slice(0, 300));
        continue;
      }

      const data = await r.json();
      const result = data?.quoteSummary?.result?.[0];
      if (!result) continue;

      const summary = result.summaryDetail || {};
      const financial = result.financialData || {};
      const stats = result.defaultKeyStatistics || {};
      const price = result.price || {};

      const fundamentals = {
        marketCap: yfValue(price, 'marketCap') ?? yfValue(summary, 'marketCap') ?? yfValue(financial, 'marketCap'),
        trailingPE: yfValue(summary, 'trailingPE') ?? yfValue(stats, 'trailingPE') ?? yfValue(price, 'trailingPE'),
        forwardPE: yfValue(summary, 'forwardPE') ?? yfValue(stats, 'forwardPE') ?? yfValue(financial, 'currentPrice'), // forwardPE in summaryDetail
        dividendYield: yfValue(summary, 'dividendYield') ?? yfValue(price, 'dividendYield'),
        epsTrailingTwelveMonths: yfValue(price, 'epsTrailingTwelveMonths') ?? yfValue(stats, 'trailingEps'),
      };
      // fix forwardPE — don't use currentPrice as forwardPE
      fundamentals.forwardPE = yfValue(summary, 'forwardPE') ?? yfValue(stats, 'forwardPE');

      const count = Object.values(fundamentals).filter(v => v != null).length;
      console.log(`[DEBUG fundamentals] ${host} resolved ${count} fields for ${symbol}:`, fundamentals);
      if (count > 0) {
        logger.info(`quoteSummary (${host}) got ${count} fundamentals for ${symbol}`);
        return fundamentals;
      }
    } catch (err) {
      console.log(`[DEBUG fundamentals] ${host} exception:`, err.message);
    }
  }

  logger.warn(`No fundamentals from quoteSummary for ${symbol}`);
  return {};
}

/**
 * GET /api/market/quote?symbols=AAPL,MSFT
 * Get detailed quotes for one or more symbols.
 */
router.get('/quote', async (req, res) => {
  try {
    const { symbols } = req.query;
    if (!symbols) return res.status(400).json({ detail: 'symbols parameter required' });

    let quotes = [];
    const symbolList = symbols.split(',').map(s => s.trim()).filter(Boolean);

    for (const sym of symbolList) {
      let baseQuote = null;

      // Try authenticated quote endpoints (v6/v7) with session cookie+crumb
      const session = await getYahooSession();
      const crumbQ = session.crumb ? `&crumb=${encodeURIComponent(session.crumb)}` : '';
      const authHeaders = { ...YAHOO_JSON_HEADERS, Cookie: session.cookieHeader };

      for (const [host, ver] of [['query1', 'v6'], ['query2', 'v6'], ['query1', 'v7'], ['query2', 'v7']]) {
        if (baseQuote) break;
        try {
          const url = `https://${host}.finance.yahoo.com/${ver}/finance/quote?symbols=${encodeURIComponent(sym)}${crumbQ}`;
          const r = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(8000) });
          console.log(`[DEBUG quote] ${host}/${ver} status for ${sym}:`, r.status);
          if (!r.ok) continue;
          const d = await r.json();
          const results = d?.quoteResponse?.result || [];
          if (results.length > 0) {
            baseQuote = results[0];
            console.log(`[DEBUG quote] ${host}/${ver} keys for ${sym}:`, Object.keys(baseQuote).join(', '));
            console.log(`[DEBUG quote] ${host}/${ver} fundamentals:`, {
              marketCap: baseQuote.marketCap,
              trailingPE: baseQuote.trailingPE,
              forwardPE: baseQuote.forwardPE,
              dividendYield: baseQuote.dividendYield,
              epsTrailingTwelveMonths: baseQuote.epsTrailingTwelveMonths,
            });
          }
        } catch (e) {
          console.log(`[DEBUG quote] ${host}/${ver} exception:`, e.message);
        }
      }

      // Fallback to v8 chart endpoint for basic price data
      if (!baseQuote) {
        try {
          const url8 = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
          const r8 = await fetch(url8, { headers: YAHOO_JSON_HEADERS, signal: AbortSignal.timeout(8000) });
          if (r8.ok) {
            const d8 = await r8.json();
            const meta = d8?.chart?.result?.[0]?.meta;
            if (meta) {
              baseQuote = {
                symbol: meta.symbol || sym,
                shortName: meta.shortName || sym,
                regularMarketPrice: meta.regularMarketPrice,
                regularMarketChange: meta.regularMarketPrice - (meta.chartPreviousClose || meta.previousClose || 0),
                regularMarketChangePercent: meta.chartPreviousClose ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100 : 0,
                currency: meta.currency || 'USD',
                exchange: meta.exchangeName || meta.exchange || '',
                fullExchangeName: meta.fullExchangeName || meta.exchangeName || '',
                quoteType: meta.instrumentType || 'UNKNOWN',
                regularMarketDayHigh: meta.regularMarketDayHigh,
                regularMarketDayLow: meta.regularMarketDayLow,
                regularMarketPreviousClose: meta.chartPreviousClose || meta.previousClose,
                regularMarketOpen: meta.regularMarketOpen,
                regularMarketVolume: meta.regularMarketVolume,
                fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
                fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
              };
            }
          }
        } catch (_) { /* give up on this symbol */ }
      }

      if (baseQuote) {
        // Fetch fundamentals from quoteSummary endpoints
        const fundamentals = await fetchFundamentals(sym);

        // For each field, prefer the quoteSummary value but fall back to what the
        // v6/v7 quote endpoint already includes. This avoids undefined values from
        // fundamentals silently overwriting valid data from baseQuote.
        const marketCap = fundamentals.marketCap ?? baseQuote.marketCap;
        const trailingPE = fundamentals.trailingPE ?? baseQuote.trailingPE ?? baseQuote.peRatio;
        const forwardPE = fundamentals.forwardPE ?? baseQuote.forwardPE;
        const dividendYield = fundamentals.dividendYield ?? baseQuote.dividendYield;
        const epsTrailingTwelveMonths = fundamentals.epsTrailingTwelveMonths ?? baseQuote.epsTrailingTwelveMonths ?? baseQuote.epsCurrentYear;

        const resolvedFundamentals = { marketCap, trailingPE, forwardPE, dividendYield, epsTrailingTwelveMonths };
        const resolvedCount = Object.values(resolvedFundamentals).filter(v => v != null).length;
        logger.info(`Fundamentals resolved for ${sym}: ${resolvedCount} fields`, resolvedFundamentals);

        quotes.push({ ...baseQuote, ...resolvedFundamentals });
      }
    }

    const mapped = quotes.map(q => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChange,
      changePercent: q.regularMarketChangePercent,
      currency: q.currency || 'USD',
      exchange: q.fullExchangeName || q.exchange,
      type: q.quoteType,
      open: q.regularMarketOpen,
      dayHigh: q.regularMarketDayHigh,
      dayLow: q.regularMarketDayLow,
      prevClose: q.regularMarketPreviousClose,
      volume: q.regularMarketVolume,
      avgVolume: q.averageDailyVolume3Month,
      high52w: q.fiftyTwoWeekHigh,
      low52w: q.fiftyTwoWeekLow,
      marketCap: q.marketCap,
      pe: q.trailingPE,
      forwardPE: q.forwardPE,
      dividendYield: q.dividendYield,
      eps: q.epsTrailingTwelveMonths,
    }));

    res.json({ quotes: mapped });
  } catch (err) {
    logger.error('Market quote failed', { error: err.message });
    res.status(502).json({ detail: 'Market quote unavailable' });
  }
});

/**
 * GET /api/market/chart?symbol=AAPL&range=1mo&interval=1d
 * Get historical price chart data.
 */
router.get('/chart', async (req, res) => {
  try {
    const { symbol, range = '1mo', interval = '1d' } = req.query;
    if (!symbol) return res.status(400).json({ detail: 'symbol parameter required' });

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
    const response = await fetch(url, { headers: YAHOO_JSON_HEADERS, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Yahoo chart error: ${response.status}`);
    const data = await response.json();

    const result = data?.chart?.result?.[0];
    if (!result) return res.json({ points: [] });

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const highs = result.indicators?.quote?.[0]?.high || [];
    const lows = result.indicators?.quote?.[0]?.low || [];
    const volumes = result.indicators?.quote?.[0]?.volume || [];

    const points = timestamps.map((ts, i) => ({
      time: ts * 1000, // ms
      close: closes[i],
      high: highs[i],
      low: lows[i],
      volume: volumes[i],
    })).filter(p => p.close != null);

    res.json({
      symbol: result.meta?.symbol,
      currency: result.meta?.currency,
      points,
    });
  } catch (err) {
    logger.error('Market chart failed', { error: err.message });
    res.status(502).json({ detail: 'Market chart unavailable' });
  }
});

/**
 * GET /api/market/news?symbols=AAPL,MSFT&count=20
 * Get news articles for one or more symbols.
 */
router.get('/news', async (req, res) => {
  try {
    const { symbols, count = '20' } = req.query;

    // If symbols provided, fetch news for those; otherwise general market news
    const querySymbols = symbols || 'SPY,QQQ,DIA';
    const newsCount = Math.min(parseInt(count, 10) || 20, 50);

    // Use Yahoo Finance v1 search endpoint which returns news for symbols
    const newsPromises = querySymbols.split(',').slice(0, 10).map(async (sym) => {
      const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(sym.trim())}&quotesCount=0&newsCount=${newsCount}&listsCount=0`;
      const response = await fetch(url, { headers: YAHOO_JSON_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.news || []).map(n => ({
        title: n.title,
        link: n.link,
        publisher: n.publisher,
        publishedAt: n.providerPublishTime ? n.providerPublishTime * 1000 : null,
        thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
        relatedSymbols: [sym.trim()],
      }));
    });

    const allNews = (await Promise.all(newsPromises)).flat();

    // Deduplicate by title and sort by date
    const seen = new Set();
    const unique = allNews.filter(n => {
      if (seen.has(n.title)) return false;
      seen.add(n.title);
      return true;
    }).sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)).slice(0, newsCount);

    res.json({ articles: unique });
  } catch (err) {
    logger.error('Market news failed', { error: err.message });
    res.status(502).json({ detail: 'Market news unavailable' });
  }
});

export default router;
