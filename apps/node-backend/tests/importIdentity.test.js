import { describe, expect, it } from "vitest";

import {
  IMPORT_FINGERPRINT_VERSION,
  assignImportIdentities,
  budgetingIdentityBase,
  computeSourceRecordHash,
  portfolioIdentityBase,
} from "../src/services/importIdentity.js";

const budgetRow = (overrides = {}) => ({
  tx_date: "2026-09-09",
  amount: "-12.5000",
  currency: "eur",
  bank_account: "be12 345",
  recipient_raw: " Shop  Name ",
  recipient_account: "BE99",
  memo: "coffee",
  raw_data: '"coffee",-12.50',
  source_id: null,
  ...overrides,
});

describe("versioned import identity", () => {
  it("keeps source hashes byte-sensitive and dedup identity format-insensitive", () => {
    const a = budgetRow();
    const b = budgetRow({ raw_data: "coffee,-12.5000\r" });
    const [ia] = assignImportIdentities([a], (row) =>
      budgetingIdentityBase(row, "vision"),
    );
    const [ib] = assignImportIdentities([b], (row) =>
      budgetingIdentityBase(row, "vision"),
    );
    expect(ia.sourceRecordHash).not.toBe(ib.sourceRecordHash);
    expect(ia.fingerprint).toBe(ib.fingerprint);
    expect(ia.version).toBe(IMPORT_FINGERPRINT_VERSION);
  });

  it("assigns a stable occurrence set without collapsing identical records", () => {
    const identities = assignImportIdentities(
      [budgetRow(), budgetRow(), budgetRow()],
      (row) => budgetingIdentityBase(row, "revolut"),
    );
    expect(identities.map((identity) => identity.occurrence)).toEqual([
      1, 2, 3,
    ]);
    expect(
      new Set(identities.map((identity) => identity.fingerprint)).size,
    ).toBe(3);
  });

  it("gives an immutable source id precedence over mutable parsed fields", () => {
    const rows = [
      budgetRow({ source_id: "tx-7", memo: "old" }),
      budgetRow({ source_id: "tx-7", memo: "new", recipient_raw: "Other" }),
    ];
    const identities = assignImportIdentities(rows, (row) =>
      budgetingIdentityBase(row, "wise"),
    );
    expect(identities[0].fingerprint).toBe(identities[1].fingerprint);
  });

  it("isolates portfolio routes, accounts and currencies", () => {
    const row = {
      tx_date: "2026-09-09",
      type: "buy",
      route: "portfolio",
      symbol_raw: "ABC",
      units: "2.0",
      price_per_unit: "10",
      amount: "20",
      currency: "EUR",
      raw_data: "row",
    };
    const fingerprint = (overrides, accountIdentity = "acct-a") =>
      assignImportIdentities([{ ...row, ...overrides }], (candidate) =>
        portfolioIdentityBase(candidate, {
          adapterName: "generic",
          accountIdentity,
        }),
      )[0].fingerprint;
    expect(fingerprint({ route: "cash" })).not.toBe(fingerprint({}));
    expect(fingerprint({}, "acct-b")).not.toBe(fingerprint({}));
    expect(fingerprint({ currency: "USD" })).not.toBe(fingerprint({}));
  });

  it("hashes an empty literal record but not an absent record", () => {
    expect(computeSourceRecordHash("")).toMatch(/^[0-9a-f]{64}$/);
    expect(computeSourceRecordHash(null)).toBeNull();
  });

  it("does not make identity depend on the selected adapter path", () => {
    const [builtIn] = assignImportIdentities([budgetRow()], (row) =>
      budgetingIdentityBase(row, "wise"),
    );
    const [generic] = assignImportIdentities([budgetRow()], (row) =>
      budgetingIdentityBase(row, "renamed custom parser"),
    );
    expect(builtIn.fingerprint).toBe(generic.fingerprint);
  });
});
