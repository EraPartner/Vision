import { describe, expect, it } from "vitest";
import {
  __parseWatchlistCreateBody as parseWatchlistCreateBody,
  __parseWatchlistUpdateBody as parseWatchlistUpdateBody,
} from "../src/routes/watchlist.js";

const validCreate = {
  name: "ETF Idea",
  asset_class: "etf",
  target_price: 100,
};

describe("watchlist currency validation without an HTTP listener", () => {
  it("rejects explicit null and empty currencies on create", () => {
    expect(() =>
      parseWatchlistCreateBody({ ...validCreate, currency: null }),
    ).toThrow(/currency must be a 3-letter ISO code/);
    expect(() =>
      parseWatchlistCreateBody({ ...validCreate, currency: "" }),
    ).toThrow(/currency must be a 3-letter ISO code/);
  });

  it("rejects explicit null and empty currencies on update", () => {
    expect(() => parseWatchlistUpdateBody({ currency: null })).toThrow(
      /currency must be a 3-letter ISO code/,
    );
    expect(() => parseWatchlistUpdateBody({ currency: "" })).toThrow(
      /currency must be a 3-letter ISO code/,
    );
  });

  it("preserves omission and normalizes valid codes", () => {
    expect(parseWatchlistCreateBody(validCreate).currency).toBeUndefined();
    expect(parseWatchlistUpdateBody({ currency: " usd " }).currency).toBe(
      "USD",
    );
  });
});
