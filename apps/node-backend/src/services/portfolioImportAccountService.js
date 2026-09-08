import accountService from "./accountService.js";
import { ValidationError } from "../middleware/errorHandler.js";

const PORTFOLIO_ACCOUNT_TYPES = new Set([
  "brokerage",
  "crypto_exchange",
  "wallet",
]);

export function isValidPortfolioImportAccount(account) {
  return Boolean(
    account?.is_active && PORTFOLIO_ACCOUNT_TYPES.has(account.type),
  );
}

/** Validate routing before staging or changing a reviewed batch. */
export async function assertPortfolioImportAccount(accountId) {
  if (accountId == null) return undefined;
  const account = await accountService.get(accountId);
  if (!isValidPortfolioImportAccount(account)) {
    throw new ValidationError(
      "account_id must reference an active portfolio account",
    );
  }
  return account;
}

/** Missing accounts are repairable review state; infrastructure failures are not. */
export async function getPortfolioImportAccountForPreview(accountId) {
  if (accountId == null) return undefined;
  try {
    return await accountService.get(accountId);
  } catch (err) {
    if (err?.code === "NOT_FOUND") return undefined;
    throw err;
  }
}

export function buildPortfolioImportPreviewRouting(batch, account) {
  return {
    account_id: batch.account_id ?? null,
    account_name: account ? account.display_name || account.name : null,
    account_valid: isValidPortfolioImportAccount(account),
  };
}
