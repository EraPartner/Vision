import http from "node:http";
import { pathToFileURL } from "node:url";

export function requireFixtureFlags(env) {
  if (
    env.VISION_BROWSER_PROVIDER_FIXTURES !== "1" ||
    env.VISION_DISPOSABLE_NATIVE_STACK !== "1"
  ) {
    throw new Error(
      "Yahoo fixtures require explicit fixture and disposable-stack flags",
    );
  }
}

const symbol = "LAYOUTQUOTE";
const name = "Synthetic market layout";
const quote = {
  symbol,
  shortName: name,
  longName: name,
  quoteType: "EQUITY",
  currency: "EUR",
  regularMarketPrice: 10,
  exchange: "TEST",
};

// Only raw external-provider envelopes belong here. Vision routes and services stay real.
export function yahooFixtureResponse(input, method = "GET") {
  const url = new URL(input);
  if (
    method.toUpperCase() !== "GET" ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error("Unsupported Yahoo fixture request");
  }
  if (url.hostname === "finance.yahoo.com" && url.pathname === "/quote/AAPL") {
    return new Response("<html>Disposable Yahoo cookie fixture</html>", {
      headers: {
        "content-type": "text/html",
        "set-cookie":
          "A3=disposable-fixture; Domain=.yahoo.com; Path=/; Secure; Max-Age=3600",
      },
    });
  }
  if (
    url.hostname === "query1.finance.yahoo.com" &&
    url.pathname === "/v1/test/getcrumb"
  ) {
    return new Response("disposable-fixture-crumb", {
      headers: { "content-type": "text/plain" },
    });
  }
  if (
    !["query1.finance.yahoo.com", "query2.finance.yahoo.com"].includes(
      url.hostname,
    )
  ) {
    throw new Error("Unsupported Yahoo fixture host");
  }
  let payload;
  if (
    url.pathname === "/v1/finance/search" &&
    url.searchParams.get("q") === symbol
  ) {
    payload = {
      quotes:
        url.searchParams.get("quotesCount") === "0"
          ? []
          : [
              {
                symbol,
                shortname: name,
                longname: name,
                quoteType: "EQUITY",
                exchDisp: "Synthetic exchange",
                exchange: "TEST",
              },
            ],
      news: [],
    };
  } else if (
    url.pathname === "/v7/finance/quote" &&
    url.searchParams.get("symbols") === symbol
  ) {
    payload = { quoteResponse: { result: [quote], error: null } };
  } else if (url.pathname === `/v10/finance/quoteSummary/${symbol}`) {
    payload = {
      quoteSummary: {
        result: [
          {
            summaryDetail: {},
            defaultKeyStatistics: {},
            price: { currency: "EUR", shortName: name },
            financialData: {},
            recommendationTrend: { trend: [] },
            upgradeDowngradeHistory: { history: [] },
          },
        ],
        error: null,
      },
    };
  } else if (url.pathname === `/v8/finance/chart/${symbol}`) {
    payload = {
      chart: {
        result: [
          {
            meta: { symbol, currency: "EUR", regularMarketPrice: 10 },
            timestamp: [],
            indicators: {
              quote: [{ open: [], high: [], low: [], close: [], volume: [] }],
            },
          },
        ],
        error: null,
      },
    };
  } else {
    throw new Error("Unsupported Yahoo fixture endpoint or symbol");
  }
  return Response.json(payload);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  requireFixtureFlags(process.env);
  const server = http.createServer(async (req, res) => {
    try {
      const local = new URL(req.url, "http://127.0.0.1");
      if (
        local.pathname !== "/" ||
        local.searchParams.size !== 1 ||
        !local.searchParams.has("url")
      )
        throw new Error("Unsupported fixture transport");
      const response = yahooFixtureResponse(
        local.searchParams.get("url"),
        req.method,
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Unsupported synthetic provider request");
    }
  });
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => server.close(() => process.exit(0)));
}
