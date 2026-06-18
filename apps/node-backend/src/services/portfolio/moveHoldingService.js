/**
 * Move a holding between accounts (ADR-091) — an in-specie transfer that PRESERVES cost basis:
 * no sell/buy, no realized gain, and no cash leg (shares just change custodian).
 *
 * Whole move (units omitted, non-unit-based, or units ≥ net): re-point every lot of the
 * (investment, fromAccount) to the target — the full history moves.
 *
 * Partial move (unit-based, 0 < units < net) has two cost-basis strategies:
 *   - `fifo` (default): move buy/gift lots oldest-first; the single boundary lot is split
 *     pro-rata. The moved units carry the cost of the OLDEST lots.
 *   - `proportional` (average cost): split EVERY buy/gift lot by the same fraction, so the
 *     moved and remaining sides keep an identical per-unit cost basis (no lot selection).
 * Either way sells stay with the source and `units ≤ net` keeps the source non-negative.
 *
 * Inheritance-aware: account_id lives on portfolio_transactions_base (UPDATE cascades to the child
 * tables) while units/price live on the per-asset-class child table; the flat schema has both on
 * one table.
 */

import { withTransaction } from '../../database/connection.js';
import { NotFoundError, ValidationError } from '../../middleware/errorHandler.js';
import { toDecimal, toNumber, roundToCents } from '../../lib/money.js';
import { TRANSACTION_TABLE_BY_ASSET_CLASS, UNIT_BASED_ASSET_CLASSES } from '../../repositories/portfolioTxRepo.common.js';

const EPS = 1e-9;
const MOVE_STRATEGIES = new Set(['fifo', 'proportional']);

/**
 * Split a lot, leaving `stayUnits` on the source row and inserting a sibling row carrying
 * `moveUnits` on the target account. Amount/fees/taxes are divided pro-rata by `f` so per-unit
 * cost basis is identical on both sides.
 */
async function splitLotToTarget(client, { lot, moveUnits, stayUnits, fraction, inheritance, childTable, investmentId, fromAccountId, toAccountId }) {
  const splitVal = (col) => {
    const total = toDecimal(lot[col] || 0);
    const moved = total.times(fraction);
    return { moved: toNumber(roundToCents(moved)), stay: toNumber(roundToCents(total.minus(moved))) };
  };
  const amt = splitVal('amount');
  const fee = splitVal('fees');
  const tax = splitVal('taxes');

  if (inheritance) {
    await client.query('UPDATE portfolio_transactions_base SET amount = $1, fees = $2, taxes = $3 WHERE id = $4',
      [amt.stay, fee.stay, tax.stay, lot.id]);
    await client.query(`UPDATE ${childTable} SET units = $1 WHERE id = $2`, [toNumber(stayUnits), lot.id]);
    await client.query(
      `INSERT INTO ${childTable}
         (investment_id, type, date, amount, fees, taxes, currency, note, is_recurring, fx_rate_to_eur, account_id, units, price_per_unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10, $11, $12)`,
      [investmentId, lot.type, lot.date, amt.moved, fee.moved, tax.moved, lot.currency || 'EUR',
       `Transferred from account ${fromAccountId}`, lot.fx_rate_to_eur ?? null, toAccountId, toNumber(moveUnits), lot.price_per_unit ?? null],
    );
  } else {
    await client.query(
      'UPDATE portfolio_transactions SET amount = $1, fees = $2, taxes = $3, units = $4 WHERE id = $5',
      [amt.stay, fee.stay, tax.stay, toNumber(stayUnits), lot.id]);
    await client.query(
      `INSERT INTO portfolio_transactions
         (investment_id, type, date, amount, units, price_per_unit, fees, taxes, currency, note, is_recurring, fx_rate_to_eur, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, $11, $12)`,
      [investmentId, lot.type, lot.date, amt.moved, toNumber(moveUnits), lot.price_per_unit ?? null, fee.moved, tax.moved,
       lot.currency || 'EUR', `Transferred from account ${fromAccountId}`, lot.fx_rate_to_eur ?? null, toAccountId],
    );
  }
}

/**
 * @param {{ investmentId:number, fromAccountId:number, toAccountId:number, units?:number|null, strategy?:'fifo'|'proportional' }} args
 * @returns {Promise<{ investmentId:number, from:number, to:number, mode:'whole'|'partial', strategy:'fifo'|'proportional', movedUnits:number, lotsMoved:number, lotsSplit:number }>}
 */
export async function moveHolding({ investmentId, fromAccountId, toAccountId, units = null, strategy = 'fifo' }) {
  if (!Number.isInteger(investmentId)) throw new ValidationError('investmentId must be an integer');
  if (!Number.isInteger(fromAccountId) || !Number.isInteger(toAccountId)) {
    throw new ValidationError('fromAccountId and toAccountId must be integers');
  }
  if (fromAccountId === toAccountId) throw new ValidationError('Cannot move a holding to the same account');
  const strat = MOVE_STRATEGIES.has(strategy) ? strategy : 'fifo';
  const requested = units == null ? null : Number(units);
  if (requested != null && (!Number.isFinite(requested) || requested <= 0)) {
    throw new ValidationError('units must be a positive number');
  }

  return withTransaction(async (client) => {
    const accChk = await client.query('SELECT id FROM accounts WHERE id = ANY($1::int[])', [[fromAccountId, toAccountId]]);
    const have = new Set(accChk.rows.map((r) => r.id));
    for (const id of [fromAccountId, toAccountId]) {
      if (!have.has(id)) throw new NotFoundError(`Account ${id} not found`);
    }

    const inv = await client.query('SELECT asset_class FROM investments WHERE id = $1', [investmentId]);
    if (!inv.rows[0]) throw new NotFoundError(`Investment ${investmentId} not found`);
    const assetClass = inv.rows[0].asset_class;
    const unitBased = UNIT_BASED_ASSET_CLASSES.has(assetClass);

    const baseReg = await client.query("SELECT to_regclass('public.portfolio_transactions_base') AS r");
    const inheritance = !!baseReg.rows[0]?.r;

    const lotsRes = await client.query(
      `SELECT id, type, date, amount, units, price_per_unit, fees, taxes, currency, fx_rate_to_eur
         FROM portfolio_transactions
        WHERE investment_id = $1 AND account_id = $2
        ORDER BY date ASC, id ASC`,
      [investmentId, fromAccountId],
    );
    const lots = lotsRes.rows;
    if (!lots.length) throw new ValidationError('No holdings for that investment in the source account');

    const netUnits = lots.reduce((n, l) => {
      const u = Number(l.units) || 0;
      if (l.type === 'buy' || l.type === 'gift') return n + u;
      if (l.type === 'sell') return n - u;
      return n;
    }, 0);

    const repoint = async (ids) => {
      if (!ids.length) return;
      const rel = inheritance ? 'portfolio_transactions_base' : 'portfolio_transactions';
      await client.query(`UPDATE ${rel} SET account_id = $1 WHERE id = ANY($2::int[])`, [toAccountId, ids]);
    };

    // Explicit unit count on a unit-based asset can't exceed what's held.
    if (unitBased && requested != null && requested > netUnits + EPS) {
      throw new ValidationError(`Cannot move ${requested} units; only ${netUnits} held in the source account`);
    }

    // ── Whole move ───────────────────────────────────────────────────────────
    if (requested == null || !unitBased || requested >= netUnits - EPS) {
      const ids = lots.map((l) => l.id);
      await repoint(ids);
      return { investmentId, from: fromAccountId, to: toAccountId, mode: 'whole', strategy: strat, movedUnits: netUnits, lotsMoved: ids.length, lotsSplit: 0 };
    }

    // ── Partial move (unit-based, 0 < requested < net) ───────────────────────
    const childTable = TRANSACTION_TABLE_BY_ASSET_CLASS[assetClass];
    const buyLots = lots.filter((l) => l.type === 'buy' || l.type === 'gift');

    // ── Proportional / average-cost: split every buy/gift lot by the same fraction ──
    if (strat === 'proportional') {
      const totalBuyUnits = buyLots.reduce((s, l) => s.plus(toDecimal(l.units || 0)), toDecimal(0));
      if (totalBuyUnits.lte(0)) throw new ValidationError('No buy lots to move');
      const fraction = toDecimal(requested).dividedBy(totalBuyUnits);

      let lotsSplit = 0;
      for (const lot of buyLots) {
        const lotUnits = toDecimal(lot.units || 0);
        if (lotUnits.lte(0)) continue;
        const moveUnits = lotUnits.times(fraction);
        const stayUnits = lotUnits.minus(moveUnits);
        await splitLotToTarget(client, { lot, moveUnits, stayUnits, fraction, inheritance, childTable, investmentId, fromAccountId, toAccountId });
        lotsSplit += 1;
      }
      return { investmentId, from: fromAccountId, to: toAccountId, mode: 'partial', strategy: strat, movedUnits: requested, lotsMoved: 0, lotsSplit };
    }

    // ── FIFO (default): move whole lots oldest-first, split the boundary lot ──
    let remaining = toDecimal(requested);
    const fullMoveIds = [];
    let lotsSplit = 0;

    for (const lot of buyLots) {
      if (remaining.lte(EPS)) break;
      const lotUnits = toDecimal(lot.units || 0);
      if (lotUnits.lte(0)) continue;

      if (lotUnits.lte(remaining)) {
        fullMoveIds.push(lot.id);
        remaining = remaining.minus(lotUnits);
        continue;
      }

      // Boundary lot: move `remaining` units, splitting cost pro-rata.
      const fraction = remaining.dividedBy(lotUnits);
      await splitLotToTarget(client, {
        lot, moveUnits: remaining, stayUnits: lotUnits.minus(remaining), fraction,
        inheritance, childTable, investmentId, fromAccountId, toAccountId,
      });
      remaining = toDecimal(0);
      lotsSplit = 1;
      break;
    }

    await repoint(fullMoveIds);

    if (remaining.gt(EPS)) {
      // Defensive: validated requested ≤ net ≤ buy units, so this should be unreachable.
      throw new ValidationError('Not enough buy lots to move the requested units');
    }

    return { investmentId, from: fromAccountId, to: toAccountId, mode: 'partial', strategy: strat, movedUnits: requested, lotsMoved: fullMoveIds.length, lotsSplit };
  });
}

export default { moveHolding };
