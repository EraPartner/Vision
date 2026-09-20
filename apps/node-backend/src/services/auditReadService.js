import { withTransaction } from "../database/connection.js";
import { readAuditSegment } from "../repositories/auditChainRepository.js";
import { verifyAuditHistory } from "./auditVerificationService.js";

/**
 * Read one bounded page from the same database snapshot that was verified.
 * The checkpoint must come from the Electron main process's external receipt.
 * A database-local checkpoint is never accepted as independent evidence.
 * @param {{trustedCheckpoint?: {sequence:number, hash:string}, afterSequence?:number,
 *   limit?:number, transact?:typeof withTransaction,
 *   verify?:typeof verifyAuditHistory, readSegment?:typeof readAuditSegment}} [options]
 */
export async function readVerifiedAuditPage({
  trustedCheckpoint,
  afterSequence = 0,
  limit = 100,
  transact = withTransaction,
  verify = verifyAuditHistory,
  readSegment = readAuditSegment,
} = {}) {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new RangeError("afterSequence must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError("limit must be between 1 and 500");
  }
  return transact(async (client) => {
    await client.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await client.query("SET LOCAL statement_timeout = '9s'");
    const verification = await verify({ trustedCheckpoint });
    if (!["verified", "partially_verified"].includes(verification.status)) {
      return { verification, entries: [], hasMore: false };
    }
    if (
      !("anchoredThrough" in verification) ||
      typeof verification.anchoredThrough !== "number"
    ) {
      return {
        verification: { status: "failed", code: "invalid_verification_result" },
        entries: [],
        hasMore: false,
      };
    }
    const effectiveAfter = Math.max(
      afterSequence,
      verification.retentionThrough ?? 0,
    );
    if (effectiveAfter >= verification.sequence) {
      return { verification, entries: [], hasMore: false };
    }
    const rows = await readSegment({
      afterSequence: effectiveAfter,
      limit: limit + 1,
    });
    const entries = rows.slice(0, limit).map((entry) => ({
      ...entry,
      anchorStatus:
        entry.sequence <= verification.anchoredThrough
          ? "anchored"
          : "pending_anchor",
    }));
    return {
      verification,
      entries,
      hasMore: rows.length > limit,
    };
  });
}

export default { readVerifiedAuditPage };
