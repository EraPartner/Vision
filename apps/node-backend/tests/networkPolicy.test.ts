import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __DEFAULT_NETWORK_POLICY as DEFAULT_NETWORK_POLICY,
  __NetworkBlockedError as NetworkBlockedError,
  __invalidateNetworkPolicy as invalidateNetworkPolicy,
  __parseNetworkPolicy as parseNetworkPolicy,
  __resetNetworkGuardForTests,
  aiEndpointGate,
  assertNetworkAllowed,
  installNetworkGuard,
} from "../src/lib/networkPolicy.ts";
import { __hasRoutableNetworkInterface as hasRoutableNetworkInterface } from "../src/lib/network.ts";

const assertAiEndpointAllowed = async (baseUrl: string) => {
  await aiEndpointGate(baseUrl);
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  __resetNetworkGuardForTests(originalFetch);
  globalThis.fetch = originalFetch;
});

describe("parseNetworkPolicy", () => {
  it("reads the defaults from anything that is not an object", () => {
    expect(parseNetworkPolicy(null)).toEqual(DEFAULT_NETWORK_POLICY);
    expect(parseNetworkPolicy([true])).toEqual(DEFAULT_NETWORK_POLICY);
    expect(parseNetworkPolicy("offline")).toEqual(DEFAULT_NETWORK_POLICY);
  });

  it("reads each field and falls back per field", () => {
    expect(
      parseNetworkPolicy({
        offlineMode: true,
        networkExchangeRates: false,
        networkInflation: "no",
        networkMarketData: false,
        priceRefresh: "daily",
        aiLocalOnly: true,
      }),
    ).toEqual({
      offlineMode: true,
      sources: { exchangeRates: false, inflation: true, marketData: false },
      priceRefresh: "daily",
      aiLocalOnly: true,
    });
    expect(parseNetworkPolicy({ priceRefresh: "weekly" }).priceRefresh).toBe(
      "hourly",
    );
  });
});

describe("network guard", () => {
  it("allows everything before the guard is installed", async () => {
    await expect(assertNetworkAllowed("marketData")).resolves.toBeUndefined();
  });

  it("blocks a switched-off source and leaves the others", async () => {
    installNetworkGuard(() => Promise.resolve({ networkMarketData: false }));
    await expect(assertNetworkAllowed("marketData")).rejects.toMatchObject({
      reason: "source_off",
      source: "marketData",
    });
    await expect(assertNetworkAllowed("exchangeRates")).resolves.toBeUndefined();
  });

  it("refuses every non-loopback fetch in offline mode and keeps loopback", async () => {
    const calls: string[] = [];
    globalThis.fetch = Object.assign(
      (input: Parameters<typeof fetch>[0]) => {
        calls.push(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        return Promise.resolve(new Response("ok"));
      },
      originalFetch,
    );
    let offline = true;
    installNetworkGuard(() => Promise.resolve({ offlineMode: offline }));

    await expect(fetch("https://query1.finance.yahoo.com/x")).rejects.toBeInstanceOf(
      NetworkBlockedError,
    );
    await expect(fetch("http://127.0.0.1:11434/api/tags")).resolves.toBeInstanceOf(
      Response,
    );
    expect(calls).toEqual(["http://127.0.0.1:11434/api/tags"]);

    offline = false;
    invalidateNetworkPolicy();
    await fetch("https://www.ecb.europa.eu/x");
    expect(calls).toContain("https://www.ecb.europa.eu/x");
  });

  it("keeps the last policy when a read fails", async () => {
    const read = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ offlineMode: true })
      .mockRejectedValue(new Error("database busy"));
    installNetworkGuard(read);
    await expect(assertNetworkAllowed()).rejects.toMatchObject({ reason: "offline" });
    invalidateNetworkPolicy();
    await expect(assertNetworkAllowed()).rejects.toMatchObject({ reason: "offline" });
  });

  it("limits AI to this Mac when asked, and always in offline mode", async () => {
    installNetworkGuard(() => Promise.resolve({ aiLocalOnly: true }));
    await expect(assertAiEndpointAllowed("http://127.0.0.1:11434")).resolves.toBeUndefined();
    await expect(assertAiEndpointAllowed("http://gpu-box.lan:11434")).rejects.toMatchObject({
      reason: "remote_ai",
    });
    installNetworkGuard(() => Promise.resolve({ offlineMode: true }));
    await expect(assertAiEndpointAllowed("http://gpu-box.lan:11434")).rejects.toMatchObject({
      reason: "offline",
    });
    installNetworkGuard(() => Promise.resolve({}));
    await expect(assertAiEndpointAllowed("http://gpu-box.lan:11434")).resolves.toBeUndefined();
  });
});

describe("hasRoutableNetworkInterface", () => {
  const address = (family: "IPv4" | "IPv6", value: string, internal = false) => ({
    address: value,
    netmask: "",
    family,
    mac: "00:00:00:00:00:00",
    internal,
    cidr: null,
    ...(family === "IPv6" ? { scopeid: 0 } : {}),
  });

  it("ignores loopback and link-local addresses", () => {
    expect(
      hasRoutableNetworkInterface({
        lo0: [address("IPv4", "127.0.0.1", true), address("IPv6", "::1", true)],
        utun0: [address("IPv6", "fe80::1")],
        en0: [address("IPv4", "169.254.3.4")],
      } as never),
    ).toBe(false);
  });

  it("counts a routable address", () => {
    expect(
      hasRoutableNetworkInterface({ en0: [address("IPv4", "192.168.1.20")] } as never),
    ).toBe(true);
    expect(
      hasRoutableNetworkInterface({ en0: [address("IPv6", "2a02:1810::5")] } as never),
    ).toBe(true);
  });
});
