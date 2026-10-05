import { describe, expect, it } from "vitest";
import { projectAssetTransferPartitions } from "@vision/shared-utils/portfolio";
import { toDecimal } from "@vision/shared-utils/money";

const methods = ["weighted_avg", "fifo", "lifo"];
const buy = (id, units, amount, fxMultiplier) => ({
  id,
  date: `2020-01-0${id}`,
  type: "buy",
  account_id: 1,
  units,
  amount,
  fxMultiplier,
  currency: "USD",
});
const buys = () => [
  buy(1, "0.21739", "100", "1.1"),
  buy(2, "0.19377", "400", "0.9"),
  buy(3, "0.17267", "200", "1.2"),
];
const transfer = (id, date, units, source = 1, destination = 2) => ({
  id,
  date,
  type: "asset_transfer",
  units,
  fee_units: "0",
  source_account_id: source,
  destination_account_id: destination,
});
const fee = (units = "0.00017285") => ({
  id: 6,
  date: "2020-03-01",
  type: "asset_adjustment",
  units,
  account_id: 2,
  adjustment_kind: "asset_fee",
  basis_policy: "carried",
});
const roundTrip = () => [
  ...buys(),
  transfer(4, "2020-02-01", "0.58383"),
  transfer(5, "2020-03-01", "0.58365715", 2, 1),
];
const sum = (lots, field) =>
  lots.reduce((total, lot) => total.plus(lot[field]), toDecimal(0));

describe("exact custody consumption across proportional lots", () => {
  it.each(methods)(
    "allows the exact final unit fee after a complete transfer and partial return under %s",
    (method) => {
      const partitions = projectAssetTransferPartitions(
        [...roundTrip(), fee()],
        method,
      );
      const returned = partitions.get(1).find((row) => row.id === 5);
      const consumed = partitions
        .get(2)
        .find((row) => row.type === "asset_fee");
      expect(sum(returned.transferredLots, "units").eq("0.58365715")).toBe(
        true,
      );
      expect(sum(consumed.consumedLots, "units").eq("0.00017285")).toBe(true);
      const spentBasis = sum(returned.transferredLots, "costBasis").plus(
        sum(consumed.consumedLots, "costBasis"),
      );
      const spentBasisConv = sum(
        returned.transferredLots,
        "costBasisConv",
      ).plus(sum(consumed.consumedLots, "costBasisConv"));
      expect(spentBasis.minus(700).abs().lt("0.00000001")).toBe(true);
      expect(spentBasisConv.minus(710).abs().lt("0.00000001")).toBe(true);
    },
  );

  it.each(methods)(
    "still rejects a genuine fee overdraw under %s",
    (method) => {
      expect(() =>
        projectAssetTransferPartitions(
          [...roundTrip(), fee("0.00017286")],
          method,
        ),
      ).toThrow("Asset fee exceeds source holdings");
    },
  );

  it.each(methods)(
    "still rejects a genuine transfer overdraw under %s",
    (method) => {
      expect(() =>
        projectAssetTransferPartitions(
          [...buys(), transfer(4, "2020-02-01", "0.58383001")],
          method,
        ),
      ).toThrow("Asset transfer exceeds source holdings");
    },
  );

  it("allocates an exact partial weighted withdrawal and can then consume the exact remainder", () => {
    const rows = [
      ...buys(),
      transfer(4, "2020-02-01", "0.28175913"),
      transfer(5, "2020-03-01", "0.30207087", 1, 3),
    ];
    const partitions = projectAssetTransferPartitions(rows, "weighted_avg");
    const first = partitions.get(2).find((row) => row.type === "transfer_in");
    const remaining = partitions
      .get(3)
      .find((row) => row.type === "transfer_in");
    expect(sum(first.transferredLots, "units").eq("0.28175913")).toBe(true);
    expect(sum(remaining.transferredLots, "units").eq("0.30207087")).toBe(true);
    expect(
      sum(first.transferredLots, "costBasis")
        .plus(sum(remaining.transferredLots, "costBasis"))
        .minus(700)
        .abs()
        .lt("0.00000001"),
    ).toBe(true);
    expect(
      sum(first.transferredLots, "costBasisConv")
        .plus(sum(remaining.transferredLots, "costBasisConv"))
        .minus(710)
        .abs()
        .lt("0.00000001"),
    ).toBe(true);
  });
});
