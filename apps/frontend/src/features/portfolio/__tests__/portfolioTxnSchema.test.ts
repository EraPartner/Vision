import { describe, expect, test } from "vitest";
import {
  addPortfolioTxnSchema,
  editPortfolioTxnSchema,
  parseNonNegative,
} from "../portfolioTxnSchema";

/** Blank form-field baseline; spread overrides per case. */
const blank = {
  date: "2026-08-03",
  amount: "",
  units: "",
  pricePerUnit: "",
  fees: "",
  taxes: "",
  fxRateToEur: "",
};

function firstIssue(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? undefined : result.error!.issues[0].message;
}

describe("parseNonNegative", () => {
  test("empty/garbage/negative → undefined; 0 and positives parse", () => {
    expect(parseNonNegative("")).toBeUndefined();
    expect(parseNonNegative("  ")).toBeUndefined();
    expect(parseNonNegative("abc")).toBeUndefined();
    expect(parseNonNegative("-1")).toBeUndefined();
    expect(parseNonNegative("0")).toBe(0);
    expect(parseNonNegative("12,5")).toBe(12.5);
  });
});

describe("addPortfolioTxnSchema", () => {
  const buy = { isBuySell: true, isGift: false };
  const dividend = { isBuySell: false, isGift: false };
  const gift = { isBuySell: false, isGift: true };

  test("buy with units + price derives the amount", () => {
    const result = addPortfolioTxnSchema(buy).safeParse({ ...blank, units: "10", pricePerUnit: "90" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(900);
      expect(result.data.units).toBe(10);
      expect(result.data.pricePerUnit).toBe(90);
      expect(result.data.fees).toBeUndefined();
      expect(result.data.taxes).toBeUndefined();
      expect(result.data.fxRateToEur).toBeUndefined();
    }
  });

  test("buy with only one of the three fields fails with two-of-three, even when fees are also bad", () => {
    const result = addPortfolioTxnSchema(buy).safeParse({ ...blank, units: "10", fees: "-1" });
    expect(firstIssue(result)).toBe("addPortTxn.error.twoOfThreeRequired");
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });

  test("non-buy/sell types require an amount; zero counts as missing on Add", () => {
    expect(firstIssue(addPortfolioTxnSchema(dividend).safeParse(blank))).toBe(
      "addPortTxn.error.amountRequired",
    );
    expect(firstIssue(addPortfolioTxnSchema(dividend).safeParse({ ...blank, amount: "0" }))).toBe(
      "addPortTxn.error.amountRequired",
    );
  });

  test("gift requires units, forces amount/fees/taxes to 0", () => {
    expect(firstIssue(addPortfolioTxnSchema(gift).safeParse(blank))).toBe(
      "addPortTxn.error.unitsRequired",
    );
    const result = addPortfolioTxnSchema(gift).safeParse({ ...blank, units: "3", fees: "2", taxes: "1" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(0);
      expect(result.data.fees).toBe(0);
      expect(result.data.taxes).toBe(0);
    }
  });

  test("negative fees, garbage taxes, and a 0 FX rate all fail with the invalid-number key (20481c8)", () => {
    const valid = { ...blank, amount: "50" };
    for (const bad of [{ fees: "-1" }, { taxes: "abc" }, { fxRateToEur: "0" }]) {
      expect(firstIssue(addPortfolioTxnSchema(dividend).safeParse({ ...valid, ...bad }))).toBe(
        "addPortTxn.error.invalidNumber",
      );
    }
  });

  test("valid fees/taxes/FX parse; empty ones stay undefined (omitted from the POST)", () => {
    const result = addPortfolioTxnSchema(dividend).safeParse({
      ...blank,
      amount: "50",
      fees: "1,25",
      fxRateToEur: "1.08",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fees).toBe(1.25);
      expect(result.data.taxes).toBeUndefined();
      expect(result.data.fxRateToEur).toBe(1.08);
    }
  });

  test("the Add dialog does not require a date (never clearable in its UI)", () => {
    const result = addPortfolioTxnSchema(dividend).safeParse({ ...blank, date: "", amount: "50" });
    expect(result.success).toBe(true);
  });
});

describe("editPortfolioTxnSchema", () => {
  const buy = { isBuySell: true, isGift: false };
  const dividend = { isBuySell: false, isGift: false };
  const gift = { isBuySell: false, isGift: true };

  test("consistent buy passes and keeps all three values", () => {
    const result = editPortfolioTxnSchema(buy).safeParse({
      ...blank,
      amount: "900",
      units: "10",
      pricePerUnit: "90",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(900);
      expect(result.data.fees).toBe(0);
      expect(result.data.taxes).toBe(0);
      expect(result.data.fxRateToEur).toBeNull();
    }
  });

  test("inconsistent buy fails with two-of-three", () => {
    const result = editPortfolioTxnSchema(buy).safeParse({
      ...blank,
      amount: "500",
      units: "10",
      pricePerUnit: "90",
    });
    expect(firstIssue(result)).toBe("addPortTxn.error.twoOfThreeRequired");
  });

  test("a non-gift amount of 0 is rejected on Edit (stricter than Add's parser path)", () => {
    expect(firstIssue(editPortfolioTxnSchema(dividend).safeParse({ ...blank, amount: "0" }))).toBe(
      "addPortTxn.error.amountRequired",
    );
  });

  test("a cleared date is rejected, after the amount rule", () => {
    expect(firstIssue(editPortfolioTxnSchema(dividend).safeParse({ ...blank, date: "" }))).toBe(
      "addPortTxn.error.amountRequired",
    );
    expect(
      firstIssue(editPortfolioTxnSchema(dividend).safeParse({ ...blank, date: "", amount: "50" })),
    ).toBe("plannedPage.link.pickDate");
  });

  test("gift with units passes; amount may stay undefined and fees/taxes are forced to 0", () => {
    const result = editPortfolioTxnSchema(gift).safeParse({ ...blank, units: "3", fees: "2" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.units).toBe(3);
      expect(result.data.amount).toBeUndefined();
      expect(result.data.fees).toBe(0);
      expect(result.data.taxes).toBe(0);
    }
  });

  test("cleared fees/taxes become 0 and cleared FX becomes null (PATCH must send the clear)", () => {
    const result = editPortfolioTxnSchema(dividend).safeParse({ ...blank, amount: "50" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fees).toBe(0);
      expect(result.data.taxes).toBe(0);
      expect(result.data.fxRateToEur).toBeNull();
    }
  });

  test("garbage fees and a 0 FX rate fail with the invalid-number key", () => {
    for (const bad of [{ fees: "abc" }, { taxes: "-2" }, { fxRateToEur: "0" }]) {
      expect(
        firstIssue(editPortfolioTxnSchema(dividend).safeParse({ ...blank, amount: "50", ...bad })),
      ).toBe("addPortTxn.error.invalidNumber");
    }
  });
});
