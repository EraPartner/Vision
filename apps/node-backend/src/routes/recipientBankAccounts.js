/**
 * Recipient Bank Account routes.
 */

import { Router } from "express";
import recipientBankAccountService from "../services/recipientBankAccountService.js";
import { NotFoundError, ValidationError } from "../middleware/errorHandler.js";
import {
  validateIdParam,
  validateIntParam,
  assertMaxLength,
  assertIdParam,
} from "../middleware/validation.js";
import { withCreateOutcome } from "../lib/createOutcome.js";
import { parseBooleanQueryParam } from "../lib/httpParams.js";

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

const validateAccountIdParam = validateIntParam("accountId");

router.get(
  "/:id/bank-accounts",
  validateIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const recipientId = assertIdParam(req);
    const activeOnly = parseBooleanQueryParam(req.query.active, true);
    const accounts = await recipientBankAccountService.getByRecipientId(
      recipientId,
      activeOnly,
    );
    res.ok({ items: accounts, total: accounts.length });
  },
);

router.post(
  "/:id/bank-accounts",
  validateIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const recipientId = assertIdParam(req);
    const {
      account_number,
      bank_name,
      address,
      account_label,
      set_as_primary,
    } = req.body;

    if (!account_number)
      throw new ValidationError("Missing required field: account_number");
    // account_number is VARCHAR(34) (IBAN max width, migration 0001) — an
    // over-length value otherwise reached the column as a raw 22001 500.
    assertMaxLength(account_number, 34, "account_number");

    const { bankAccount, created } =
      await recipientBankAccountService.createOrGet({
        recipientId,
        accountNumber: account_number,
        bankName: bank_name || null,
        address: address || null,
        accountLabel: account_label || null,
        setAsPrimary: !!set_as_primary,
      });

    res.status(created ? 201 : 200);
    res.ok(withCreateOutcome(bankAccount, created));
  },
);

router.patch(
  "/:id/bank-accounts/:accountId",
  validateIdParam,
  validateAccountIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const accountId = assertIdParam(req, "accountId");
    const { bank_name, address, account_label } = req.body;
    const updated = await recipientBankAccountService.update(accountId, {
      bankName: bank_name,
      address,
      accountLabel: account_label,
    });
    if (!updated) throw new NotFoundError("Bank account not found");
    res.ok({ ...updated, links: [] });
  },
);

// Deactivation, not a hard delete: the row survives with is_active = false, so
// this returns the deactivated entity rather than 204 (docs/reference/code-patterns.md,
// "DELETE responses") — same shape as set-primary below.
router.delete(
  "/:id/bank-accounts/:accountId",
  validateIdParam,
  validateAccountIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const accountId = assertIdParam(req, "accountId");
    const deactivated = await recipientBankAccountService.softDelete(accountId);
    if (!deactivated) throw new NotFoundError("Bank account not found");
    const account = await recipientBankAccountService.getById(accountId);
    res.ok({ ...account, links: [] });
  },
);

router.post(
  "/:id/bank-accounts/:accountId/set-primary",
  validateIdParam,
  validateAccountIdParam,
  /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (
    req,
    res,
  ) => {
    const recipientId = assertIdParam(req);
    const accountId = assertIdParam(req, "accountId");
    const success = await recipientBankAccountService.setPrimary(
      accountId,
      recipientId,
    );
    if (!success)
      throw new NotFoundError(
        "Bank account not found or does not belong to this recipient",
      );
    const account = await recipientBankAccountService.getById(accountId);
    res.ok({ ...account, links: [] });
  },
);

export default router;
