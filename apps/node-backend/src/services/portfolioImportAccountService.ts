import accountService from "./accountService.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import type { AccountRow } from "../types/rows.ts";

const PORTFOLIO_ACCOUNT_TYPES = new Set([
  "brokerage",
  "crypto_exchange",
  "wallet",
]);

export function isValidPortfolioImportAccount(
  account: Pick<AccountRow, "is_active" | "type"> | null | undefined,
): boolean {
  return Boolean(
    account?.is_active && PORTFOLIO_ACCOUNT_TYPES.has(account.type),
  );
}

/** Validate routing before staging or changing a reviewed batch. */
export async function assertPortfolioImportAccount(
  accountId: number | null | undefined,
): Promise<AccountRow | undefined> {
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
export async function getPortfolioImportAccountForPreview(
  accountId: number | null | undefined,
): Promise<AccountRow | undefined> {
  if (accountId == null) return undefined;
  try {
    return await accountService.get(accountId);
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "NOT_FOUND"
    )
      return undefined;
    throw err;
  }
}

export function buildPortfolioImportPreviewRouting(
  batch: { account_id?: number | null },
  account: AccountRow | undefined,
) {
  return {
    account_id: batch.account_id ?? null,
    account_name: account ? account.display_name || account.name : null,
    account_valid: isValidPortfolioImportAccount(account),
  };
}
