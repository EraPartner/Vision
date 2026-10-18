import {
  requireFixtureFlags,
  yahooFixtureResponse,
} from "./yahoo-provider-fixture.mjs";

export function fixtureBaseUrl(env) {
  requireFixtureFlags(env);
  const input = env.VISION_BROWSER_PROVIDER_URL;
  if (
    typeof input !== "string" ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(input)
  )
    throw new Error("Fixture URL must be a literal loopback origin");
  const url = new URL(input);
  if (Number(url.port) > 65535 || !url.port)
    throw new Error("Invalid fixture port");
  return input;
}

export function createFixtureFetch(env, originalFetch) {
  const base = fixtureBaseUrl(env);
  return async (input, init) => {
    const requestUrl = new URL(
      input instanceof Request ? input.url : String(input),
    );
    if (
      requestUrl.hostname !== "yahoo.com" &&
      !requestUrl.hostname.endsWith(".yahoo.com")
    )
      return originalFetch(input, init);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    // Validate before transport. Unsupported Yahoo requests never reach the network.
    yahooFixtureResponse(requestUrl, method);
    return originalFetch(
      `${base}/?url=${encodeURIComponent(requestUrl.href)}`,
      {
        method: "GET",
        signal:
          init?.signal ?? (input instanceof Request ? input.signal : undefined),
        redirect: "error",
      },
    );
  };
}

if (
  process.env.VISION_BROWSER_PROVIDER_FIXTURES !== undefined ||
  process.env.VISION_BROWSER_PROVIDER_URL !== undefined
) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createFixtureFetch(process.env, originalFetch);
}
