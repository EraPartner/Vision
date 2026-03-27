/**
 * Market Lookup routes — powered by yahoo-finance2 library.
 */

import { Router } from 'express';
import YahooFinance from 'yahoo-finance2';
import { logger } from '../config/logger.js';

const router = Router();

function normalizeThumbnailUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice(7)}`;
  if (trimmed.startsWith('https://')) return trimmed;
  return null;
}

function pickBestThumbnail(thumbnail) {
  const resolutions = Array.isArray(thumbnail?.resolutions) ? thumbnail.resolutions : [];
  for (let i = resolutions.length - 1; i >= 0; i -= 1) {
    const candidate = normalizeThumbnailUrl(resolutions[i]?.url);
    if (candidate) return candidate;
  }
  return null;
}
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

/**
 * Convert a range string (e.g. '1mo', '5y') to a Date for period1.
 */
function rangeToDate(range) {
  const now = new Date();
  switch (range) {
    case '1d': return new Date(now - 1 * 24 * 60 * 60 * 1000);
    case '5d': return new Date(now - 5 * 24 * 60 * 60 * 1000);
    case '1mo': return new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    case '3mo': return new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    case '6mo': return new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    case '1y': return new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    case '2y': return new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
    case '5y': return new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
    case 'max': return new Date('1970-01-01');
    default: return new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
  }
}

/**
 * GET /api/market/search?q=apple
 * Search for tickers / companies.
 */
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 1) return res.json({ items: [] });

    const results = await yahooFinance.search(q, { quotesCount: 8, newsCount: 0 });

    const items = (results.quotes || [])
      .filter(r => r.symbol)
      .map(r => ({
        symbol: r.symbol,
        name: r.shortname || r.longname || r.symbol,
        type: r.quoteType || 'UNKNOWN',
        exchange: r.exchDisp || r.exchange || '',
      }));

    res.json({ items });
  } catch (err) {
    logger.error('Market search failed', { error: err.message });
    res.status(502).json({ detail: 'Market search unavailable' });
  }
});

/**
 * GET /api/market/quote?symbols=AAPL,MSFT
 * Get detailed quotes and fundamentals for one or more symbols.
 */
router.get('/quote', async (req, res) => {
  try {
    const { symbols } = req.query;
    if (!symbols) return res.status(400).json({ detail: 'symbols parameter required' });

    const symbolList = symbols.split(',').map(s => s.trim()).filter(Boolean);

    const quoteResults = await Promise.allSettled(
      symbolList.map(async (sym) => {
        // Fetch basic quote and fundamentals in parallel
        const [quote, summary] = await Promise.allSettled([
          yahooFinance.quote(sym),
          yahooFinance.quoteSummary(sym, {
            modules: [
              'summaryDetail',
              'defaultKeyStatistics',
              'price',
              'financialData',
              'recommendationTrend',
              'upgradeDowngradeHistory',
            ],
          }),
        ]);

        if (quote.status === 'rejected') {
          logger.warn(`Quote fetch failed for ${sym}`, { error: quote.reason?.message });
          return null;
        }

        const q = quote.value;
        const s = summary.status === 'fulfilled' ? summary.value : null;

        const sd = s?.summaryDetail || {};
        const ks = s?.defaultKeyStatistics || {};
        const pr = s?.price || {};

        // Prefer quoteSummary values (more complete) over quote fields
        const marketCap = sd.marketCap ?? pr.marketCap ?? q.marketCap;
        const trailingPE = sd.trailingPE ?? ks.trailingPE ?? q.trailingPE;
        const forwardPE = sd.forwardPE ?? ks.forwardPE ?? q.forwardPE;
        const dividendYield = sd.dividendYield ?? pr.dividendYield ?? q.dividendYield;
        const eps = pr.epsTrailingTwelveMonths ?? ks.trailingEps ?? q.epsTrailingTwelveMonths;
        const beta = sd.beta ?? ks.beta ?? q.beta;
        const priceToBook = ks.priceToBook ?? q.priceToBook;

        // Analyst consensus — current month bucket (period "0m")
        const trendBuckets = s?.recommendationTrend?.trend || [];
        const currentTrend = trendBuckets.find(t => t.period === '0m') || trendBuckets[0] || null;
        const analystConsensus = currentTrend
          ? {
            strongBuy: currentTrend.strongBuy ?? 0,
            buy: currentTrend.buy ?? 0,
            hold: currentTrend.hold ?? 0,
            sell: currentTrend.sell ?? 0,
            strongSell: currentTrend.strongSell ?? 0,
          }
          : null;

        // Recent analyst upgrades / downgrades (latest 10)
        const recentAnalystActions = (s?.upgradeDowngradeHistory?.history || [])
          .slice(0, 10)
          .map(h => ({
            date: h.epochGradeDate,
            firm: h.firm,
            toGrade: h.toGrade,
            fromGrade: h.fromGrade || null,
            action: h.action,
            priceTarget: h.currentPriceTarget ?? null,
          }));

        return {
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
          marketCap,
          pe: trailingPE,
          forwardPE,
          dividendYield,
          eps,
          beta,
          priceToBook,
          analystConsensus,
          recentAnalystActions,
        };
      })
    );

    const mapped = quoteResults
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

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

    const result = await yahooFinance.chart(symbol, {
      period1: rangeToDate(range),
      interval,
      includePrePost: false,
    });

    if (!result) return res.json({ points: [] });

    const points = (result.quotes || [])
      .filter(p => p.close != null)
      .map(p => ({
        time: new Date(p.date).getTime(),
        close: p.close,
        high: p.high,
        low: p.low,
        volume: p.volume,
      }));

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
    const querySymbols = symbols || 'SPY,QQQ,DIA';
    const newsCount = Math.min(parseInt(count, 10) || 20, 50);

    const newsResults = await Promise.allSettled(
      querySymbols.split(',').slice(0, 10).map(async (sym) => {
        const results = await yahooFinance.search(sym.trim(), {
          quotesCount: 0,
          newsCount,
        });
        return (results.news || []).map(n => ({
          title: n.title,
          link: n.link,
          publisher: n.publisher,
          publishedAt: n.providerPublishTime ? new Date(n.providerPublishTime).getTime() : null,
          thumbnail: pickBestThumbnail(n.thumbnail),
          relatedSymbols: [sym.trim()],
        }));
      })
    );

    const allNews = newsResults
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);

    const seen = new Set();
    const unique = allNews
      .filter(n => {
        if (seen.has(n.title)) return false;
        seen.add(n.title);
        return true;
      })
      .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
      .slice(0, newsCount);

    res.json({ articles: unique });
  } catch (err) {
    logger.error('Market news failed', { error: err.message });
    res.status(502).json({ detail: 'Market news unavailable' });
  }
});

export default router;
