/**
 * Network policy (Settings › Privacy, ADR-271).
 *
 * The one place that decides whether the backend may reach the internet and
 * which data sources it may use. The choices live in the `app_settings` blob
 * (`offlineMode`, `networkExchangeRates`, `networkInflation`,
 * `networkMarketData`, `priceRefresh`, `aiLocalOnly`); both apps write that
 * blob, and the Swift backend reads the same fields (`NetworkPolicy.swift`).
 *
 * Two layers enforce it:
 *  - `assertNetworkAllowed(source)` at each data source's fetch helpers
 *    (FX, inflation, market data), so a switched-off source is never called;
 *  - `installNetworkGuard()` wraps the global `fetch` once at boot, so in
 *    offline mode no request leaves the Mac, whatever module makes it.
 *    Loopback hosts (the local Ollama, the app itself) stay reachable.
 *
 * The policy is re-read from the database at most every
 * {@link POLICY_TTL_MS}: the Swift app writes `app_settings` in-process
 * without passing through this backend, so a write-side cache could go stale.
 * Until `installNetworkGuard()` runs (unit tests, scripts) the policy reads as
 * the defaults and touches no database.
 */

import { logger } from "../config/logger.ts";
import { isLoopbackHost } from "../middleware/hostGuard.ts";

/** A data source the user can switch off on its own. */
export type NetworkSource = "exchangeRates" | "inflation" | "marketData";

/** How often holdings' prices are fetched without the user asking. */
export type PriceRefresh = "hourly" | "daily" | "manual";

export interface NetworkPolicy {
  /** Nothing leaves the Mac; loopback stays allowed. */
  offlineMode: boolean;
  sources: Record<NetworkSource, boolean>;
  priceRefresh: PriceRefresh;
  /** Refuse an Ollama endpoint that is not on this Mac. */
  aiLocalOnly: boolean;
}

/** Defaults keep today's behaviour: everything on, hourly prices. */
const DEFAULT_NETWORK_POLICY: NetworkPolicy = Object.freeze({
  offlineMode: false,
  sources: Object.freeze({
    exchangeRates: true,
    inflation: true,
    marketData: true,
  }),
  priceRefresh: "hourly",
  aiLocalOnly: false,
});

const SOURCE_FIELDS: Record<NetworkSource, string> = {
  exchangeRates: "networkExchangeRates",
  inflation: "networkInflation",
  marketData: "networkMarketData",
};

const PRICE_REFRESH: readonly PriceRefresh[] = ["hourly", "daily", "manual"];

function boolField(
  fields: Record<string, unknown>,
  name: string,
  fallback: boolean,
): boolean {
  const value = fields[name];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * The policy held in an `app_settings` value. Untrusted JSON: a field of the
 * wrong type reads as its default, and a value that is not an object reads as
 * the defaults.
 */
function parseNetworkPolicy(appSettings: unknown): NetworkPolicy {
  if (
    appSettings === null ||
    typeof appSettings !== "object" ||
    Array.isArray(appSettings)
  )
    return DEFAULT_NETWORK_POLICY;
  const fields = appSettings as Record<string, unknown>;
  const defaults = DEFAULT_NETWORK_POLICY;
  const refresh = fields.priceRefresh;
  return {
    offlineMode: boolField(fields, "offlineMode", defaults.offlineMode),
    sources: {
      exchangeRates: boolField(
        fields,
        SOURCE_FIELDS.exchangeRates,
        defaults.sources.exchangeRates,
      ),
      inflation: boolField(
        fields,
        SOURCE_FIELDS.inflation,
        defaults.sources.inflation,
      ),
      marketData: boolField(
        fields,
        SOURCE_FIELDS.marketData,
        defaults.sources.marketData,
      ),
    },
    priceRefresh: PRICE_REFRESH.includes(refresh as PriceRefresh)
      ? (refresh as PriceRefresh)
      : defaults.priceRefresh,
    aiLocalOnly: boolField(fields, "aiLocalOnly", defaults.aiLocalOnly),
  };
}

const POLICY_TTL_MS = 2_000;

type PolicyReader = () => Promise<unknown>;

let reader: PolicyReader | null = null;
let cached: { policy: NetworkPolicy; at: number } | null = null;
/** The last policy read successfully; survives {@link invalidateNetworkPolicy}. */
let lastRead: NetworkPolicy = DEFAULT_NETWORK_POLICY;
let inflight: Promise<NetworkPolicy> | null = null;

/**
 * The current policy. A failed read keeps the last policy read (defaults
 * before the first), so a database hiccup never flips offline mode off.
 */
export async function getNetworkPolicy(): Promise<NetworkPolicy> {
  const read = reader;
  if (!read) return DEFAULT_NETWORK_POLICY;
  if (cached && Date.now() - cached.at < POLICY_TTL_MS) return cached.policy;
  inflight ??= read()
    .then((value) => {
      lastRead = parseNetworkPolicy(value);
      return lastRead;
    })
    .catch((err: unknown) => {
      logger.warn("Could not read the network policy; keeping the last one", {
        error: err instanceof Error ? err.message : String(err),
      });
      return lastRead;
    })
    .then((policy) => {
      cached = { policy, at: Date.now() };
      return policy;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Drop the cached policy so the next check reads the database. */
function invalidateNetworkPolicy(): void {
  cached = null;
}

/** Why a request was not made. */
export type NetworkBlockReason = "offline" | "source_off" | "remote_ai";

class NetworkBlockedError extends Error {
  readonly code = "NETWORK_BLOCKED";
  readonly reason: NetworkBlockReason;
  readonly source: NetworkSource | undefined;

  constructor(reason: NetworkBlockReason, source?: NetworkSource) {
    super(
      reason === "offline"
        ? "Offline mode is on (Settings › Privacy)"
        : reason === "remote_ai"
          ? "AI is limited to this Mac (Settings › Privacy)"
          : `The ${source ?? "data"} source is switched off (Settings › Privacy)`,
    );
    this.name = "NetworkBlockedError";
    this.reason = reason;
    this.source = source;
  }
}

/** True when the policy lets the backend use `source` (or any internet when omitted). */
export async function isNetworkAllowed(source?: NetworkSource): Promise<boolean> {
  return !blockFor(await getNetworkPolicy(), source);
}

function blockFor(
  policy: NetworkPolicy,
  source: NetworkSource | undefined,
): NetworkBlockedError | undefined {
  if (policy.offlineMode) return new NetworkBlockedError("offline", source);
  if (source && !policy.sources[source])
    return new NetworkBlockedError("source_off", source);
  return undefined;
}

/** The policy when it is known without a read: no reader yet, or a fresh cache. */
function knownPolicy(): NetworkPolicy | undefined {
  if (!reader) return DEFAULT_NETWORK_POLICY;
  if (cached && Date.now() - cached.at < POLICY_TTL_MS) return cached.policy;
  return undefined;
}

/**
 * The policy check for `source`: `undefined` when the request may go ahead
 * and that is already known, otherwise a promise that rejects with
 * {@link NetworkBlockedError} or resolves once the policy read allows it.
 * Callers await it only when it is a promise (`if (gate) await gate`), so an
 * allowed request is not delayed by a microtask.
 */
export function networkGate(source?: NetworkSource): Promise<void> | undefined {
  const policy = knownPolicy();
  if (policy) {
    const blocked = blockFor(policy, source);
    return blocked ? Promise.reject(blocked) : undefined;
  }
  return getNetworkPolicy().then((current) => {
    const blocked = blockFor(current, source);
    if (blocked) throw blocked;
  });
}

/** Throws {@link NetworkBlockedError} when the policy forbids `source`. */
export async function assertNetworkAllowed(source?: NetworkSource): Promise<void> {
  await networkGate(source);
}

/** `fetch` for a data source: refused by the policy before any byte is sent. */
export function policyFetch(
  source: NetworkSource,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const gate = networkGate(source);
  return gate ? gate.then(() => fetch(input, init)) : fetch(input, init);
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** True for an http(s) URL whose host is this Mac (localhost, 127.0.0.0/8, ::1). */
function isLoopbackUrl(url: string): boolean {
  return isLoopbackHost(hostnameOf(url));
}

function aiBlockFor(policy: NetworkPolicy): NetworkBlockedError | undefined {
  if (policy.offlineMode) return new NetworkBlockedError("offline");
  if (policy.aiLocalOnly) return new NetworkBlockedError("remote_ai");
  return undefined;
}

/**
 * The check for the AI endpoint at `baseUrl`, shaped like {@link networkGate}:
 * in offline mode or with "AI on this Mac only" set, only a loopback endpoint
 * is allowed.
 */
export function aiEndpointGate(baseUrl: string): Promise<void> | undefined {
  if (isLoopbackUrl(baseUrl)) return undefined;
  const policy = knownPolicy();
  if (policy) {
    const blocked = aiBlockFor(policy);
    return blocked ? Promise.reject(blocked) : undefined;
  }
  return getNetworkPolicy().then((current) => {
    const blocked = aiBlockFor(current);
    if (blocked) throw blocked;
  });
}


function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

let installedFetch: typeof fetch | null = null;

/**
 * Start enforcing the policy: read it from `app_settings`, and wrap the
 * global `fetch` so that offline mode refuses every non-loopback request.
 * Idempotent. `read` is for tests.
 */
export function installNetworkGuard(
  // Imported lazily: the repository pulls in the database layer, which unit
  // tests of the fetch helpers mock or leave unconfigured.
  read: PolicyReader = async () =>
    (await import("../repositories/settingsRepository.ts")).default.get(
      "app_settings",
    ),
): void {
  reader = read;
  cached = null;
  lastRead = DEFAULT_NETWORK_POLICY;
  if (installedFetch) return;
  const original = globalThis.fetch;
  const guarded = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    if (!isLoopbackUrl(requestUrl(input))) {
      const policy = await getNetworkPolicy();
      if (policy.offlineMode) throw new NetworkBlockedError("offline");
    }
    return original(input, init);
  };
  installedFetch = Object.assign(guarded, original);
  globalThis.fetch = installedFetch;
}

/** Test-only: stop enforcing and restore the global `fetch`. */
export function __resetNetworkGuardForTests(original?: typeof fetch): void {
  reader = null;
  cached = null;
  lastRead = DEFAULT_NETWORK_POLICY;
  inflight = null;
  if (installedFetch && original) globalThis.fetch = original;
  installedFetch = null;
}

export {
  DEFAULT_NETWORK_POLICY as __DEFAULT_NETWORK_POLICY,
  NetworkBlockedError as __NetworkBlockedError,
  invalidateNetworkPolicy as __invalidateNetworkPolicy,
  parseNetworkPolicy as __parseNetworkPolicy,
};
