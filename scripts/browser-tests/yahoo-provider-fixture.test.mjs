import assert from "node:assert/strict";
import test from "node:test";
import YahooFinance from "../../apps/node-backend/node_modules/yahoo-finance2/esm/src/index.js";
import { yahooFixtureResponse } from "./yahoo-provider-fixture.mjs";
import {
  createFixtureFetch,
  fixtureBaseUrl,
} from "./yahoo-provider-preload.mjs";

const flags = {
  VISION_BROWSER_PROVIDER_FIXTURES: "1",
  VISION_DISPOSABLE_NATIVE_STACK: "1",
  VISION_BROWSER_PROVIDER_URL: "http://127.0.0.1:49152",
};

test("fixture activation requires both flags and a literal loopback origin", () => {
  assert.equal(fixtureBaseUrl(flags), flags.VISION_BROWSER_PROVIDER_URL);
  for (const key of [
    "VISION_BROWSER_PROVIDER_FIXTURES",
    "VISION_DISPOSABLE_NATIVE_STACK",
  ]) {
    assert.throws(() => fixtureBaseUrl({ ...flags, [key]: "0" }));
  }
  for (const url of [
    "http://localhost:1234",
    "http://127.1:1234",
    "http://2130706433:1234",
    "https://127.0.0.1:1234",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:80",
    "http://127.0.0.1:1234/",
    "http://127.0.0.1:1234?q=x",
    "http://user@127.0.0.1:1234",
    "http://127.0.0.1:1234#x",
  ]) {
    assert.throws(
      () => fixtureBaseUrl({ ...flags, VISION_BROWSER_PROVIDER_URL: url }),
      url,
    );
  }
});

test("unknown Yahoo requests fail closed and other providers retain their original fetch", async () => {
  const calls = [];
  const fetch = createFixtureFetch(flags, async (...args) => {
    calls.push(args);
    return new Response("delegated");
  });
  for (const url of [
    "https://guce.yahoo.com/consent",
    "https://query2.finance.yahoo.com/unknown",
    "https://query2.finance.yahoo.com/v7/finance/quote?symbols=REAL",
    "https://query2.finance.yahoo.com/v1/finance/search?q=REAL",
    "https://query2.finance.yahoo.com/v8/finance/chart/REAL",
    "https://query2.finance.yahoo.com/v10/finance/quoteSummary/REAL",
  ]) {
    await assert.rejects(fetch(url));
  }
  await assert.rejects(
    fetch(
      "https://query2.finance.yahoo.com/v7/finance/quote?symbols=LAYOUTQUOTE",
      { method: "POST" },
    ),
  );
  assert.equal(calls.length, 0);
  const input = new Request("https://example.com/resource");
  const init = { headers: { "x-test": "retained" } };
  await fetch(input, init);
  assert.equal(calls[0][0], input);
  assert.equal(calls[0][1], init);
  const controller = new AbortController();
  await fetch(
    "https://query2.finance.yahoo.com/v7/finance/quote?symbols=LAYOUTQUOTE",
    { signal: controller.signal },
  );
  assert.equal(new URL(calls[1][0]).origin, flags.VISION_BROWSER_PROVIDER_URL);
  assert.equal(calls[1][1].signal, controller.signal);
  assert.equal(calls[1][1].redirect, "error");
});

test("installed Yahoo client transforms synthetic raw envelopes through its real protocol", async () => {
  const seen = [];
  const fixtureFetch = createFixtureFetch(flags, async (input) => {
    const transport = new URL(input);
    assert.equal(transport.origin, flags.VISION_BROWSER_PROVIDER_URL);
    const original = transport.searchParams.get("url");
    seen.push(new URL(original));
    return yahooFixtureResponse(original);
  });
  const client = new YahooFinance({
    fetch: fixtureFetch,
    suppressNotices: ["yahooSurvey"],
  });
  const options = { validateResult: false };
  const quote = await client.quote("LAYOUTQUOTE", {}, options);
  assert.equal(quote.regularMarketPrice, 10);
  assert.equal(quote.currency, "EUR");
  assert.equal(quote.shortName, "Synthetic market layout");
  const search = await client.search(
    "LAYOUTQUOTE",
    { quotesCount: 8, newsCount: 0 },
    options,
  );
  assert.equal(search.quotes[0].symbol, "LAYOUTQUOTE");
  const news = await client.search(
    "LAYOUTQUOTE",
    { quotesCount: 0, newsCount: 20 },
    options,
  );
  assert.deepEqual(news.news, []);
  assert.deepEqual(news.quotes, []);
  const summary = await client.quoteSummary(
    "LAYOUTQUOTE",
    {
      modules: [
        "price",
        "summaryDetail",
        "financialData",
        "recommendationTrend",
        "upgradeDowngradeHistory",
        "defaultKeyStatistics",
      ],
    },
    options,
  );
  assert.equal(summary.price.currency, "EUR");
  const chart = await client.chart(
    "LAYOUTQUOTE",
    { period1: "2026-01-01", period2: "2026-02-01" },
    options,
  );
  assert.deepEqual(chart.quotes, []);
  assert.equal(chart.meta.currency, "EUR");
  assert.ok(
    seen.some(
      (url) =>
        url.hostname === "finance.yahoo.com" && url.pathname === "/quote/AAPL",
    ),
  );
  assert.ok(seen.some((url) => url.pathname === "/v1/test/getcrumb"));
});
