import { epochMsToUtcYmd } from "../lib/dateFormat.js";
import { assertPublicHttpUrl } from "../lib/urlSafety.js";
import settings from "../config/config.js";
import { tryReserveDay } from "../repositories/providerQuotaRepository.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_QUERY_CHARS = 300;
const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const BLOCKED_QUERY_PATTERNS = [
  /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/i,
  /\b\d{6,}\b/,
  /\b(?:account|transaction|recipient|salary|rent payment|broker balance)\b/i,
  /(?:€|\$|£)\s*\d|\b\d+(?:[.,]\d{2})\s*(?:EUR|USD|GBP)\b/i,
  /\bsecret[_-]?canary\b/i,
];

export class WebResearchError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "WebResearchError";
    this.code = code;
    this.status = status;
  }
}

function assertPublicResearchQuery(value) {
  const query = typeof value === "string" ? value.trim() : "";
  if (!query || query.length > MAX_QUERY_CHARS)
    throw new WebResearchError(
      "INVALID_QUERY",
      `Public search queries must contain 1 to ${MAX_QUERY_CHARS} characters`,
    );
  if (BLOCKED_QUERY_PATTERNS.some((pattern) => pattern.test(query)))
    throw new WebResearchError(
      "PRIVATE_QUERY_BLOCKED",
      "The query appears to contain private financial data; rewrite it as a public topic",
    );
  return query;
}

export { assertPublicResearchQuery as __assertPublicResearchQuery };

/**
 * @param {{query:string,count?:number}} input
 * @param {{fetchImpl?:typeof fetch,reserve?:Function,now?:()=>number,enabled?:boolean,apiKey?:string,signal?:AbortSignal}} [options]
 */
export async function searchPublicWeb(
  { query, count = 5 },
  {
    fetchImpl = globalThis.fetch,
    reserve = tryReserveDay,
    now = () => Date.now(),
    enabled = settings.aiResearch.web.enabled,
    apiKey = settings.aiResearch.web.braveApiKey,
    signal,
  } = {},
) {
  if (!enabled)
    throw new WebResearchError(
      "WEB_RESEARCH_DISABLED",
      "Internet research is disabled",
      503,
    );
  if (!apiKey)
    throw new WebResearchError(
      "SEARCH_PROVIDER_UNAVAILABLE",
      "BRAVE_SEARCH_API_KEY is not configured",
      503,
    );
  const publicQuery = assertPublicResearchQuery(query);
  const boundedCount = Math.min(Math.max(Number(count) || 5, 1), 5);
  const used = await reserve("brave_search", epochMsToUtcYmd(now()), 900, 1);
  if (used === null)
    throw new WebResearchError(
      "SEARCH_QUOTA_EXHAUSTED",
      "The local daily web-search ceiling is exhausted",
      429,
    );
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", publicQuery);
  url.searchParams.set("count", String(boundedCount));
  url.searchParams.set("safesearch", "moderate");
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new WebResearchError(
      "SEARCH_UNAVAILABLE",
      `Web search failed: ${error.message}`,
      502,
    );
  }
  if (response.status === 429)
    throw new WebResearchError(
      "SEARCH_QUOTA_EXHAUSTED",
      "The search provider quota is exhausted",
      429,
    );
  if (!response.ok)
    throw new WebResearchError(
      "SEARCH_UNAVAILABLE",
      `Search provider returned ${response.status}`,
      502,
    );
  const data = await boundedBody(response, MAX_SEARCH_RESPONSE_BYTES)
    .then((body) => JSON.parse(body))
    .catch(() => null);
  if (!data || !Array.isArray(data.web?.results))
    throw new WebResearchError(
      "INVALID_PROVIDER_RESPONSE",
      "Search provider returned invalid JSON",
      502,
    );
  return {
    results: data.web.results.slice(0, boundedCount).map((item) => ({
      title: String(item.title || "Untitled").slice(0, 500),
      url: String(item.url || ""),
      snippet: String(item.description || "").slice(0, 1500),
      publishedAt: item.page_age || item.age || null,
      trust: "untrusted-evidence",
    })),
    meta: {
      provider: "brave-search",
      transient: true,
      persisted: false,
      requestCount: 1,
      localDailyUsed: used,
      fetchedAt: new Date(now()).toISOString(),
    },
  };
}

function extractPageText(html) {
  const title =
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "Untitled page";
  const text = html
    .replace(/<(script|style|noscript|iframe|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title: title
      .replace(/<[^>]+>/g, " ")
      .trim()
      .slice(0, 500),
    text: text.slice(0, 100_000),
  };
}

async function boundedBody(response, maxBytes) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes)
      throw new WebResearchError(
        "PAGE_TOO_LARGE",
        "Page exceeds the 2 MiB limit",
        413,
      );
    return buffer.toString("utf8");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new WebResearchError(
          "PAGE_TOO_LARGE",
          "Page exceeds the 2 MiB limit",
          413,
        );
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * @param {{url:string}} input
 * @param {{fetchImpl?:typeof fetch,assertUrl?:typeof assertPublicHttpUrl,enabled?:boolean,signal?:AbortSignal}} [options]
 */
export async function fetchPublicWebPage(
  { url },
  {
    fetchImpl = globalThis.fetch,
    assertUrl = assertPublicHttpUrl,
    enabled = settings.aiResearch.web.enabled,
    signal,
  } = {},
) {
  if (!enabled)
    throw new WebResearchError(
      "WEB_RESEARCH_DISABLED",
      "Internet research is disabled",
      503,
    );
  let current = await assertUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        headers: {
          Accept: "text/html,text/plain;q=0.9",
          "User-Agent": "VisionResearch/1.0",
        },
        redirect: "manual",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new WebResearchError(
        "PAGE_UNAVAILABLE",
        `Page retrieval failed: ${error.message}`,
        502,
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === MAX_REDIRECTS)
        throw new WebResearchError(
          "TOO_MANY_REDIRECTS",
          "Page exceeded the redirect limit",
          502,
        );
      const location = response.headers.get("location");
      if (!location)
        throw new WebResearchError(
          "INVALID_REDIRECT",
          "Page redirect has no destination",
          502,
        );
      current = await assertUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok)
      throw new WebResearchError(
        response.status === 401 || response.status === 403
          ? "PAGE_RESTRICTED"
          : "PAGE_UNAVAILABLE",
        `Page returned ${response.status}`,
        response.status,
      );
    const mediaType = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!["text/html", "text/plain"].includes(mediaType))
      throw new WebResearchError(
        "UNSUPPORTED_PAGE_TYPE",
        `Unsupported page type: ${mediaType || "unknown"}`,
        415,
      );
    const body = await boundedBody(response, MAX_PAGE_BYTES);
    const extracted =
      mediaType === "text/html"
        ? extractPageText(body)
        : { title: current.hostname, text: body.slice(0, 100_000) };
    return {
      url: current.toString(),
      ...extracted,
      fetchedAt: new Date().toISOString(),
      mediaType,
      trust: "untrusted-evidence",
      instructionPolicy: "never-execute",
      truncated: body.length > extracted.text.length,
    };
  }
  throw new WebResearchError("PAGE_UNAVAILABLE", "Page retrieval failed", 502);
}
