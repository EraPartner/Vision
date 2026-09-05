/** Portfolio-transaction write orchestration and domain policy. */

import {
  getAssetClassByInvestmentId,
  getById,
  getUnitEventIdsForImportBatch,
} from "../../repositories/portfolioTxRepo.reads.js";
import {
  hardDelete,
  insert,
  updateFields,
} from "../../repositories/portfolioTxRepo.writes.js";
import { makeValidationError } from "../../lib/repositoryErrors.js";
import {
  UNIT_BASED_ASSET_CLASSES,
  normalizeTransactionPayload,
  validatePortfolioUnitMutation,
} from "./portfolioTransactionRules.js";

/**
 * @param {import('./portfolioTransactionRules.js').PortfolioTransactionInput} input
 */
export async function create(input) {
  let assetClass = input.preloaded_asset_class;
  if (!assetClass) {
    assetClass = await getAssetClassByInvestmentId(input.investment_id);
  }
  if (!assetClass) throw makeValidationError("Investment not found");

  const payload = normalizeTransactionPayload(input, { assetClass });
  if (!payload.is_recurring) {
    payload.recurrence_interval = null;
    payload.recurrence_end_date = null;
  } else if (
    payload.recurrence_end_date &&
    payload.date &&
    String(payload.recurrence_end_date) < String(payload.date)
  ) {
    throw makeValidationError(
      "recurrence_end_date must be on or after the transaction date",
    );
  }

  await validatePortfolioUnitMutation({
    investmentId: payload.investment_id,
    assetClass,
    type: payload.type,
    date: payload.date,
    units: payload.units,
    accountId: payload.account_id,
    checkProjectedHistory: payload.type === "split",
  });
  return insert(payload);
}

/** @param {number} id @param {Record<string, any>} fields */
export async function update(id, fields) {
  const existing = await getById(id);
  if (!existing) return null;
  if (
    Object.prototype.hasOwnProperty.call(fields, "type") &&
    fields.type !== existing.type
  ) {
    throw makeValidationError("type cannot be changed");
  }

  const merged = { ...existing, ...fields };
  let assetClass = existing.asset_class;
  if (!assetClass) {
    assetClass = await getAssetClassByInvestmentId(existing.investment_id);
  }
  const hasAmount = Object.prototype.hasOwnProperty.call(fields, "amount");
  const hasUnits = Object.prototype.hasOwnProperty.call(fields, "units");
  const hasPrice = Object.prototype.hasOwnProperty.call(
    fields,
    "price_per_unit",
  );
  const patchCount = Number(hasAmount) + Number(hasUnits) + Number(hasPrice);
  const appliesUnitMath =
    (merged.type === "buy" || merged.type === "sell") &&
    Boolean(assetClass) &&
    UNIT_BASED_ASSET_CLASSES.has(assetClass);
  if (appliesUnitMath && patchCount === 1) {
    throw makeValidationError(
      "For buy/sell transaction updates, provide at least two of amount, units, and price_per_unit",
    );
  }

  const input = { ...merged };
  if (appliesUnitMath && patchCount === 2) {
    if (!hasAmount) input.amount = undefined;
    if (!hasUnits) input.units = undefined;
    if (!hasPrice) input.price_per_unit = undefined;
  }
  const normalized = normalizeTransactionPayload(input, { assetClass });
  const normalizedFields = { ...fields };
  const normalizeAll =
    (normalized.type === "buy" || normalized.type === "sell") &&
    Boolean(assetClass) &&
    UNIT_BASED_ASSET_CLASSES.has(assetClass);
  if (normalizeAll || fields.amount !== undefined)
    normalizedFields.amount = normalized.amount;
  if (normalizeAll || fields.units !== undefined)
    normalizedFields.units = normalized.units;
  if (normalizeAll || fields.price_per_unit !== undefined)
    normalizedFields.price_per_unit = normalized.price_per_unit;
  const applyDefaults = normalizeAll || normalized.type === "gift";
  if (applyDefaults || fields.fees !== undefined)
    normalizedFields.fees = normalized.fees;
  if (applyDefaults || fields.taxes !== undefined)
    normalizedFields.taxes = normalized.taxes;
  if (fields.fx_rate_to_eur === null) normalizedFields.fx_rate_to_eur = null;
  else if (fields.fx_rate_to_eur !== undefined)
    normalizedFields.fx_rate_to_eur = normalized.fx_rate_to_eur;
  if (fields.dividend_amount_convention !== undefined) {
    normalizedFields.dividend_amount_convention =
      normalized.dividend_amount_convention;
  }

  if (fields.is_recurring === false) {
    normalizedFields.recurrence_interval = null;
    normalizedFields.recurrence_end_date = null;
  } else {
    const touchesWindow =
      fields.recurrence_end_date !== undefined || fields.date !== undefined;
    if (
      touchesWindow &&
      merged.is_recurring &&
      merged.recurrence_end_date &&
      merged.date &&
      String(merged.recurrence_end_date) < String(merged.date)
    ) {
      throw makeValidationError(
        "recurrence_end_date must be on or after the transaction date",
      );
    }
  }

  const touchesPartitionHistory =
    ["account_id", "date", "units"].some((field) =>
      Object.prototype.hasOwnProperty.call(fields, field),
    ) && ["buy", "gift", "sell", "split"].includes(normalized.type);
  await validatePortfolioUnitMutation({
    investmentId: existing.investment_id,
    assetClass,
    type: normalized.type,
    date: normalized.date,
    units: normalized.units,
    accountId: normalized.account_id,
    excludeTransactionId: id,
    checkProjectedHistory: touchesPartitionHistory,
  });
  return updateFields(id, normalizedFields, existing);
}

/** Delete one row without allowing the remaining history to become more oversold. */
export async function remove(id) {
  const existing = await getById(id);
  if (!existing) return false;
  const assetClass =
    existing.asset_class ??
    (await getAssetClassByInvestmentId(existing.investment_id));
  await validatePortfolioUnitMutation({
    investmentId: existing.investment_id,
    assetClass,
    excludeTransactionId: id,
    omitCandidate: true,
    checkProjectedHistory: ["buy", "gift", "sell", "split"].includes(
      existing.type,
    ),
  });
  return hardDelete(id);
}

/** Validate one atomic import rollback as a complete removal set. */
export async function validateImportBatchRemoval(batchId, legacyRows = []) {
  const unitRows = await getUnitEventIdsForImportBatch(batchId);
  const idsByInvestment = new Map();
  for (const row of [...unitRows, ...legacyRows]) {
    if (row.investment_id == null) continue;
    const investmentId = Number(row.investment_id);
    const ids = idsByInvestment.get(investmentId) ?? [];
    ids.push(Number(row.id));
    idsByInvestment.set(investmentId, ids);
  }
  for (const [investmentId, ids] of idsByInvestment) {
    const assetClass = await getAssetClassByInvestmentId(investmentId);
    await validatePortfolioUnitMutation({
      investmentId,
      assetClass,
      excludeTransactionIds: ids,
      omitCandidate: true,
      checkProjectedHistory: true,
    });
  }
}

export default { create, update, remove, validateImportBatchRemoval };
