/**
 * Recipient Bank Account routes.
 */

import { Router } from "express";
import { z } from "zod";
import recipientBankAccountService from "../services/recipientBankAccountService.ts";
import { NotFoundError } from "../middleware/errorHandler.ts";
import { withCreateOutcome } from "../lib/createOutcome.ts";
import { parseInput } from "../lib/zodInput.ts";
import {
  booleanQuery,
  idParams,
  idSchema,
  requiredString,
} from "./_requestSchemas.ts";

const router = Router();

const accountParams = z.object({ id: idSchema(), accountId: idSchema() });

const listQuery = z.object({ active: booleanQuery(true) });

const optionalText = z.string().nullable().optional();

const createBody = z.object({
  // account_number is VARCHAR(34) (IBAN max width, migration 0001) — an
  // over-length value otherwise reached the column as a raw 22001 500.
  account_number: requiredString.max(34, "must be at most 34 characters"),
  bank_name: optionalText,
  address: optionalText,
  account_label: optionalText,
  set_as_primary: z.boolean().nullable().optional(),
});

const updateBody = z.object({
  bank_name: optionalText,
  address: optionalText,
  account_label: optionalText,
});

router.get("/:id/bank-accounts", async (req, res) => {
  const { id: recipientId } = parseInput(idParams, req.params);
  const { active: activeOnly } = parseInput(listQuery, req.query);
  const accounts = await recipientBankAccountService.getByRecipientId(
    recipientId,
    activeOnly,
  );
  res.ok({ items: accounts, total: accounts.length });
});

router.post("/:id/bank-accounts", async (req, res) => {
  const { id: recipientId } = parseInput(idParams, req.params);
  const { account_number, bank_name, address, account_label, set_as_primary } =
    parseInput(createBody, req.body);

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
  res.ok(withCreateOutcome(bankAccount ?? {}, created));
});

router.patch("/:id/bank-accounts/:accountId", async (req, res) => {
  const { accountId } = parseInput(accountParams, req.params);
  const { bank_name, address, account_label } = parseInput(
    updateBody,
    req.body,
  );
  const updated = await recipientBankAccountService.update(accountId, {
    bankName: bank_name,
    address,
    accountLabel: account_label,
  });
  if (!updated) throw new NotFoundError("Bank account not found");
  res.ok({ ...updated, links: [] });
});

// Deactivation, not a hard delete: the row survives with is_active = false, so
// this returns the deactivated entity rather than 204 (docs/reference/code-patterns.md,
// "DELETE responses") — same shape as set-primary below.
router.delete("/:id/bank-accounts/:accountId", async (req, res) => {
  const { accountId } = parseInput(accountParams, req.params);
  const deactivated = await recipientBankAccountService.softDelete(accountId);
  if (!deactivated) throw new NotFoundError("Bank account not found");
  const account = await recipientBankAccountService.getById(accountId);
  res.ok({ ...account, links: [] });
});

router.post("/:id/bank-accounts/:accountId/set-primary", async (req, res) => {
  const { id: recipientId, accountId } = parseInput(accountParams, req.params);
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
});

export default router;
