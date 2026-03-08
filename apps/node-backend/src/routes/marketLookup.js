/**
 * Market Lookup routes — proxy Yahoo Finance for quote + sparkline data.
 * Avoids CORS issues by fetching server-side.
 */

import { Router } from 'express';
import { logger } from '../config/logger.js';

const router = Router();

const YAHOO_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'VaultVoyager/1.0',
};

/**
 * GET /api/market/search?q=apple
 * Search for tickers / companies.
 */
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) return res.json({ items: [] });

    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0&enableFuzzyQuery=false`;
    const response = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8000) });
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

/**
 * GET /api/market/quote?symbols=AAPL,MSFT
 * Get detailed quotes for one or more symbols.
 */
router.get('/quote', async (req, res) => {
  try {
    const { symbols } = req.query;
    if (!symbols) return res.status(400).json({ detail: 'symbols parameter required' });

    // Try v6 endpoint first (more reliable), fall back to v7
    let quotes = [];
    const symbolList = symbols.split(',').map(s => s.trim()).filter(Boolean);

    for (const sym of symbolList) {
      try {
        // v6 per-symbol endpoint
        const url6 = `https://query2.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(sym)}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketDayHigh,regularMarketDayLow,regularMarketVolume,regularMarketPreviousClose,regularMarketOpen,fiftyTwoWeekHigh,fiftyTwoWeekLow,marketCap,shortName,longName,currency,quoteType,exchange,fullExchangeName,averageDailyVolume3Month,trailingPE,forwardPE,dividendYield,epsTrailingTwelveMonths`;
        const r6 = await fetch(url6, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8000) });
        if (r6.ok) {
          const d6 = await r6.json();
          const results = d6?.quoteResponse?.result || [];
          if (results.length > 0) {
            quotes.push(...results);
            continue;
          }
        }
      } catch (_) { /* fall through */ }

      try {
        // v7 fallback
        const url7 = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}`;
        const r7 = await fetch(url7, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8000) });
        if (r7.ok) {
          const d7 = await r7.json();
          const results = d7?.quoteResponse?.result || [];
          if (results.length > 0) {
            quotes.push(...results);
            continue;
          }
        }
      } catch (_) { /* fall through */ }

      // v8 chart endpoint as last resort for basic price data
      try {
        const url8 = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
        const r8 = await fetch(url8, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8000) });
        if (r8.ok) {
          const d8 = await r8.json();
          const meta = d8?.chart?.result?.[0]?.meta;
          if (meta) {
            quotes.push({
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
            });
          }
        }
      } catch (_) { /* give up on this symbol */ }
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
    const response = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(10000) });
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
      const response = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8000) });
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
