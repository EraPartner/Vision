/**
 * A candidate spending/investing cap from current spendable cash and dated,
 * unexecuted planned obligations. It is an end-of-day projection, not a promise
 * that scheduled income arrives or that unplanned expenses do not occur.
 */
import { toDecimal, roundToCents, toNumber } from "../lib/money.js";

/**
 * @param {{ currentCash: number, reserveFloor: number, today: string,
 *   horizonEnd: string, occurrences: Array<{ date: string, amount: number }> }} input
 */
export function projectCommitmentAwareCash({
  currentCash,
  reserveFloor,
  today,
  horizonEnd,
  occurrences,
}) {
  const starting = toDecimal(currentCash);
  const floor = toDecimal(reserveFloor);
  if (!starting.isFinite() || !floor.isFinite() || floor.lt(0)) {
    throw new RangeError(
      "Current cash and reserve floor must be finite; reserve floor cannot be negative",
    );
  }

  const byDay = new Map();
  for (const occurrence of occurrences) {
    if (occurrence.date > horizonEnd) continue;
    const day = occurrence.date < today ? today : occurrence.date;
    const amount = toDecimal(occurrence.amount);
    if (!amount.isFinite())
      throw new RangeError("Planned amount must be finite");
    byDay.set(day, (byDay.get(day) ?? toDecimal(0)).plus(amount));
  }

  let balance = starting;
  let minimum = starting;
  let minimumDate = today;
  for (const [day, amount] of [...byDay.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    balance = balance.plus(amount);
    if (balance.lt(minimum)) {
      minimum = balance;
      minimumDate = day;
    }
  }

  const room = minimum.minus(floor);
  return {
    currentCash: toNumber(roundToCents(starting)),
    reserveFloor: toNumber(roundToCents(floor)),
    minimumProjectedBalance: toNumber(roundToCents(minimum)),
    minimumDate,
    candidateCashCap: toNumber(roundToCents(room.gt(0) ? room : toDecimal(0))),
    occurrenceCount: occurrences.length,
  };
}
