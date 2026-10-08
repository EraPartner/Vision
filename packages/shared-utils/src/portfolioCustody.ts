/** Dated custody moves are replay events, never acquisitions or disposals. */
import Decimal from "decimal.js";
import { toDecimal } from "./money.ts";
import type {
  CostBasisMethod,
  CustodyLot,
  PartitionedTxnLike,
  ProjectedCustodyTxn,
} from "./portfolio.ts";

type PartitionKey = number | null;

const ZERO = toDecimal(0);
const keyOf = (row: PartitionedTxnLike): PartitionKey =>
  row.account_id == null ? null : Number(row.account_id);
const chronological = (a: PartitionedTxnLike, b: PartitionedTxnLike): number =>
  a.date.localeCompare(b.date) || Number(a.id ?? 0) - Number(b.id ?? 0);
const acquisitionOrder = (a: CustodyLot, b: CustodyLot): number =>
  a.acquiredDate.localeCompare(b.acquiredDate) ||
  Number(a.acquisitionId) - Number(b.acquisitionId);

/**
 * Project one investment's canonical events into account streams. Temporary
 * transfer legs carry remaining original lots; they are never stored/editable.
 * Amount/fees are zero on legs, so transfers contribute no income or capital.
 */
export function projectAssetTransferPartitions(
  txns: readonly PartitionedTxnLike[],
  method: CostBasisMethod = "weighted_avg",
  opts: { defaultFxMultiplier?: number | string | Decimal } = {},
): Map<PartitionKey, ProjectedCustodyTxn[]> {
  const partitions = new Map<PartitionKey, ProjectedCustodyTxn[]>();
  const custody = new Map<PartitionKey, CustodyLot[]>();
  const lotsAt = (key: PartitionKey): CustodyLot[] => {
    if (!custody.has(key)) custody.set(key, []);
    // Set just above when missing.
    return custody.get(key)!;
  };
  const push = (key: PartitionKey, row: ProjectedCustodyTxn): void => {
    if (!partitions.has(key)) partitions.set(key, []);
    partitions.get(key)!.push(row);
  };
  const held = (lots: readonly CustodyLot[]): Decimal =>
    lots.reduce((sum, lot) => sum.plus(lot.units), ZERO);
  const consume = (
    key: PartitionKey,
    requested: Decimal,
    predicate: (lot: CustodyLot) => boolean = () => true,
  ): CustodyLot[] => {
    const lots = lotsAt(key);
    const eligible = lots.filter(predicate);
    const total = held(eligible);
    const taken: CustodyLot[] = [];
    let remaining = Decimal.min(requested, total);
    if (method === "weighted_avg") {
      const ratio = total.gt(0) ? remaining.div(total) : ZERO;
      for (const [index, lot] of eligible.entries()) {
        // Proportional multiplication can leave a Decimal residual. Assign it
        // to the final lot so a later exact transfer or fee sees exact holdings.
        const units =
          index === eligible.length - 1
            ? remaining
            : Decimal.min(remaining, lot.units.times(ratio));
        const lotRatio = lot.units.gt(0) ? units.div(lot.units) : ZERO;
        const part: CustodyLot = {
          ...lot,
          units,
          costBasis: lot.costBasis.times(lotRatio),
          costBasisConv: lot.costBasisConv.times(lotRatio),
        };
        if (part.units.gt(0)) taken.push(part);
        lot.units = lot.units.minus(part.units);
        lot.costBasis = lot.costBasis.minus(part.costBasis);
        lot.costBasisConv = lot.costBasisConv.minus(part.costBasisConv);
        remaining = remaining.minus(units);
      }
    } else {
      const order = method === "lifo" ? [...eligible].reverse() : eligible;
      for (const lot of order) {
        if (remaining.lte(0)) break;
        if (lot.units.lte(0)) continue;
        const units = Decimal.min(remaining, lot.units);
        const ratio = units.div(lot.units);
        const part: CustodyLot = {
          ...lot,
          units,
          costBasis: lot.costBasis.times(ratio),
          costBasisConv: lot.costBasisConv.times(ratio),
        };
        taken.push(part);
        lot.units = lot.units.minus(units);
        lot.costBasis = lot.costBasis.minus(part.costBasis);
        lot.costBasisConv = lot.costBasisConv.minus(part.costBasisConv);
        remaining = remaining.minus(units);
      }
    }
    custody.set(
      key,
      lots.filter((lot) => lot.units.gt(0)),
    );
    return taken;
  };

  for (const row of [...txns].sort(chronological)) {
    const key = keyOf(row);
    const units = toDecimal(row.units || 0);
    if (row.type === "buy" || row.type === "gift") {
      const cost = toDecimal(row.amount || 0)
        .plus(row.fees || 0)
        .plus(row.taxes || 0);
      lotsAt(key).push({
        units,
        costBasis: cost.times(row.nativeFxMultiplier ?? 1),
        costBasisConv: cost.times(
          row.fxMultiplier ?? opts.defaultFxMultiplier ?? 1,
        ),
        acquiredDate: row.date,
        acquisitionId: row.id ?? 0,
        acquisitionType: row.type,
        sourceRecordHash: row.source_record_hash,
        currency: row.nativeCurrency ?? row.currency,
        fxResolved:
          row.currency === "EUR" ||
          (row.fxMultiplier != null && toDecimal(row.fxMultiplier).gt(0)),
      });
      lotsAt(key).sort(acquisitionOrder);
      push(key, row);
    } else if (row.type === "sell") {
      consume(key, units);
      push(key, row);
    } else if (row.type === "asset_adjustment") {
      // Number.isInteger(key) rules out null before the comparison runs.
      if (!Number.isInteger(key) || (key as number) <= 0 || !units.gt(0))
        throw new Error(
          "Asset adjustment requires an account and positive units",
        );
      const reversal = row.adjustment_kind === "yield_reversal";
      if (
        (reversal && row.basis_policy !== "zero_yield_only") ||
        (!reversal &&
          (row.adjustment_kind !== "asset_fee" ||
            row.basis_policy !== "carried"))
      )
        throw new Error("Asset adjustment basis policy is unresolved");
      const eligibleHashes = new Set<string | undefined>(
        row.eligible_source_record_hashes || [],
      );
      const eligible = (lot: CustodyLot): boolean =>
        !reversal ||
        (lot.acquisitionType === "gift" &&
          lot.costBasis.eq(0) &&
          lot.costBasisConv.eq(0) &&
          eligibleHashes.has(lot.sourceRecordHash));
      if (units.gt(held(lotsAt(key).filter(eligible))))
        throw new Error(
          reversal
            ? "Yield reversal exceeds source-proven zero-basis yield holdings"
            : "Asset fee exceeds source holdings",
        );
      const removed = consume(key, units, eligible);
      const basis = removed.reduce((sum, lot) => sum.plus(lot.costBasis), ZERO);
      const basisConv = removed.reduce(
        (sum, lot) => sum.plus(lot.costBasisConv),
        ZERO,
      );
      push(key, {
        ...row,
        type: reversal ? "unit_reversal" : "asset_fee",
        amount: 0,
        fees: 0,
        taxes: 0,
        transferredBasis: basis,
        transferredBasisConv: basisConv,
        assetFeeBasis: reversal ? ZERO : basis,
        assetFeeBasisConv: reversal ? ZERO : basisConv,
        consumedLots: removed,
      });
    } else if (row.type === "asset_transfer") {
      const source = Number(row.source_account_id);
      const destination = Number(row.destination_account_id);
      if (
        !Number.isInteger(source) ||
        source <= 0 ||
        !Number.isInteger(destination) ||
        destination <= 0 ||
        source === destination ||
        !units.gt(0)
      ) {
        throw new Error(
          "Asset transfer requires distinct accounts and positive units",
        );
      }
      const feeUnits = toDecimal(row.fee_units || 0);
      if (feeUnits.lt(0) || feeUnits.gte(units))
        throw new Error("Asset transfer fee units are invalid");
      if (units.gt(held(lotsAt(source))))
        throw new Error("Asset transfer exceeds source holdings");
      const moved = consume(source, units);
      const transferredBasis = moved.reduce(
        (sum, lot) => sum.plus(lot.costBasis),
        ZERO,
      );
      const transferredBasisConv = moved.reduce(
        (sum, lot) => sum.plus(lot.costBasisConv),
        ZERO,
      );
      const receivedUnits = units.minus(feeUnits);
      const ratio = receivedUnits.div(units);
      const received = moved.map((lot): CustodyLot => ({
        ...lot,
        units: lot.units.times(ratio),
        costBasis: lot.costBasis.times(ratio),
        costBasisConv: lot.costBasisConv.times(ratio),
      }));
      const feeLots = moved.map((lot): CustodyLot => ({
        ...lot,
        units: lot.units.times(feeUnits.div(units)),
        costBasis: lot.costBasis.times(feeUnits.div(units)),
        costBasisConv: lot.costBasisConv.times(feeUnits.div(units)),
      }));
      const receivedBasis = transferredBasis.times(ratio);
      const receivedBasisConv = transferredBasisConv.times(ratio);
      const leg: ProjectedCustodyTxn = {
        ...row,
        amount: 0,
        fees: 0,
        taxes: 0,
        transferredBasis,
        transferredBasisConv,
        transferredLots: received.map((lot) => ({ ...lot })),
      };
      push(source, {
        ...leg,
        type: "transfer_out",
        account_id: source,
        assetFeeBasis: transferredBasis.minus(receivedBasis),
        assetFeeBasisConv: transferredBasisConv.minus(receivedBasisConv),
        assetFeeLots: feeLots,
      });
      push(destination, {
        ...leg,
        type: "transfer_in",
        account_id: destination,
        units: receivedUnits,
        transferredBasis: receivedBasis,
        transferredBasisConv: receivedBasisConv,
      });
      lotsAt(destination).push(...received);
      lotsAt(destination).sort(acquisitionOrder);
    } else if (row.type === "split") {
      const total = [...custody.values()].reduce(
        (sum, lots) => sum.plus(held(lots)),
        ZERO,
      );
      if (total.gt(0) && units.gt(0)) {
        const ratio = units.div(total);
        for (const [account, lots] of custody) {
          const local = held(lots);
          if (local.lte(0)) continue;
          for (const lot of lots) lot.units = lot.units.times(ratio);
          push(account, {
            ...row,
            units: local.times(ratio),
            fees: 0,
            taxes: 0,
          });
        }
      }
      if (!toDecimal(row.fees || 0).eq(0) || !toDecimal(row.taxes || 0).eq(0))
        push(key, { ...row, units: 0 });
    } else if (row.type === "return_of_capital") {
      const total = [...custody.values()].reduce(
        (sum, lots) => sum.plus(held(lots)),
        ZERO,
      );
      const perUnit = total.gt(0)
        ? toDecimal(row.amount || 0).div(total)
        : ZERO;
      const perUnitNative = perUnit.times(row.nativeFxMultiplier ?? 1);
      for (const [account, lots] of custody) {
        const local = held(lots);
        if (local.lte(0)) continue;
        const basis = lots.reduce((sum, lot) => sum.plus(lot.costBasis), ZERO);
        const weightedFactor = basis.gt(0)
          ? Decimal.max(0, basis.minus(perUnitNative.times(local))).div(basis)
          : ZERO;
        for (const lot of lots) {
          if (method === "weighted_avg") {
            lot.costBasis = lot.costBasis.times(weightedFactor);
            lot.costBasisConv = lot.costBasisConv.times(weightedFactor);
            continue;
          }
          const reduced = Decimal.max(
            0,
            lot.costBasis.minus(perUnitNative.times(lot.units)),
          );
          lot.costBasisConv = lot.costBasis.gt(0)
            ? lot.costBasisConv.times(reduced.div(lot.costBasis))
            : ZERO;
          lot.costBasis = reduced;
        }
        push(account, {
          ...row,
          amount: perUnit.times(local),
          fees: 0,
          taxes: 0,
        });
      }
      if (!toDecimal(row.fees || 0).eq(0) || !toDecimal(row.taxes || 0).eq(0))
        push(key, { ...row, amount: 0 });
    } else push(key, row);
  }
  return partitions;
}
