import yahooFinance from 'yahoo-finance2';

const SYMBOL = 'AAPL';

console.log('=== yahoo-finance2: quote ===');
try {
    const quote = await yahooFinance.quote(SYMBOL);
    console.log('price:', quote.regularMarketPrice);
    console.log('marketCap:', quote.marketCap);
    console.log('trailingPE:', quote.trailingPE);
    console.log('forwardPE:', quote.forwardPE);
    console.log('dividendYield:', quote.dividendYield);
    console.log('epsTrailingTwelveMonths:', quote.epsTrailingTwelveMonths);
    console.log('fiftyTwoWeekHigh:', quote.fiftyTwoWeekHigh);
    console.log('fiftyTwoWeekLow:', quote.fiftyTwoWeekLow);
    console.log('shortName:', quote.shortName);
    console.log('fullExchangeName:', quote.fullExchangeName);
    console.log('bookValue:', quote.bookValue);
    console.log('priceToBook:', quote.priceToBook);
    console.log('averageDailyVolume3Month:', quote.averageDailyVolume3Month);
} catch (e) {
    console.log('quote error:', e.message);
}

console.log('\n=== yahoo-finance2: quoteSummary (summaryDetail + defaultKeyStatistics + price) ===');
try {
    const summary = await yahooFinance.quoteSummary(SYMBOL, {
        modules: ['summaryDetail', 'defaultKeyStatistics', 'price', 'financialData'],
    });
    const s = summary.summaryDetail;
    const k = summary.defaultKeyStatistics;
    const p = summary.price;
    const f = summary.financialData;
    console.log('summaryDetail.marketCap:', s?.marketCap);
    console.log('summaryDetail.trailingPE:', s?.trailingPE);
    console.log('summaryDetail.forwardPE:', s?.forwardPE);
    console.log('summaryDetail.dividendYield:', s?.dividendYield);
    console.log('summaryDetail.beta:', s?.beta);
    console.log('price.epsTrailingTwelveMonths:', p?.epsTrailingTwelveMonths);
    console.log('defaultKeyStatistics.trailingEps:', k?.trailingEps);
    console.log('defaultKeyStatistics.forwardPE:', k?.forwardPE);
    console.log('defaultKeyStatistics.priceToBook:', k?.priceToBook);
    console.log('financialData.revenueGrowth:', f?.revenueGrowth);
} catch (e) {
    console.log('quoteSummary error:', e.message);
}
