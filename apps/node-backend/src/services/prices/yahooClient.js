/**
 * Lazy, module-cached yahoo-finance2 client.
 *
 * yahoo-finance2 pulls a large dependency graph and costs ~100ms to import.
 * Three modules (routes/marketLookup, this directory's priceProviderRegistry,
 * and research/adapters/yahooAdapter) used to import it statically, so it loaded
 * as part of the pre-`listen()` import graph on every boot — before /health
 * could go green — even though most requests never touch Yahoo. This defers both
 * the dynamic import and the client construction to first actual use, mirroring
 * the puppeteer lazy pattern in services/reports/puppeteerRenderer.js.
 *
 * The client is created once and shared: `getYahooClient()` returns the same
 * cached promise on every call.
 */

/** @type {Promise<any> | null} */
let clientPromise = null;

/**
 * Resolve the shared yahoo-finance2 client, importing and constructing it on
 * first call and returning the cached instance thereafter.
 *
 * @returns {Promise<any>}
 */
export function getYahooClient() {
  if (!clientPromise) {
    clientPromise = import('yahoo-finance2').then(
      ({ default: YahooFinance }) => new YahooFinance({ suppressNotices: ['yahooSurvey'] }),
    );
  }
  return clientPromise;
}

/** Test-only: drop the cached client so a fresh mock can be wired between cases. */
export function __resetYahooClientForTests() {
  clientPromise = null;
}
