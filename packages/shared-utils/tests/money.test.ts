import { describe, expect, it } from "vitest";
import { asCurrencyCode } from "@vision/types/brands";
import {
  addMoney,
  CurrencyMismatchError,
  money,
  sumMoney,
} from "../src/money.ts";

const EUR = asCurrencyCode("EUR");
const USD = asCurrencyCode("USD");

describe("sumMoney", () => {
  it("adds amounts in one currency exactly", () => {
    const total = sumMoney([money("0.1", EUR), money("0.2", EUR)], EUR);
    expect(total.amount.toString()).toBe("0.3");
    expect(total.currency).toBe(EUR);
  });

  it("returns zero in the requested currency for no items", () => {
    const total = sumMoney([], USD);
    expect(total.amount.isZero()).toBe(true);
    expect(total.currency).toBe(USD);
  });

  it("refuses to add a different currency", () => {
    expect(() => sumMoney([money(10, EUR), money(10, USD)], EUR)).toThrow(
      CurrencyMismatchError,
    );
    expect(() => addMoney(money(1, USD), money(1, EUR))).toThrow(
      CurrencyMismatchError,
    );
  });
});

describe("asCurrencyCode", () => {
  it("rejects codes that are not three upper-case letters", () => {
    expect(() => asCurrencyCode("eur")).toThrow(TypeError);
    expect(() => asCurrencyCode("EURO")).toThrow(TypeError);
  });
});
