/**
 * Recipient Bank Account Repository - data access for recipient_bank_accounts table.
 *
 *
 * Provides CRUD operations for managing bank accounts linked to recipients.
 */

import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';
import { withTransaction } from '../database/connection.ts';
import { checkedRow, checkedRows, db } from '../database/db.ts';
import {
  recipientBankAccountRowSchema,
  requireRow,
} from '../database/rows/catalog.ts';

import type { RecipientBankAccountRow } from '../types/rows.ts';
import type { RecipientId } from '@vision/types/brands';

export type { RecipientBankAccountRow };

/** `= ANY($n::int[])`: one array parameter however many ids there are. */
function anyRecipientId(ids: RecipientId[]): RawBuilder<RecipientId> {
  return sql<RecipientId>`ANY(${ids}::int[])`;
}

/** Clear the recipient's current primary account. */
async function clearPrimary(recipientId: RecipientId | null): Promise<void> {
  await db
    .updateTable('recipient_bank_accounts')
    .set({ is_primary: false, updated_at: sql<Date>`NOW()` })
    .where('recipient_id', '=', recipientId)
    .where('is_primary', '=', true)
    .execute();
}

export const recipientBankAccountRepository = {
  async getById(id: number): Promise<RecipientBankAccountRow | null> {
    const row = await checkedRow(
      recipientBankAccountRowSchema,
      db.selectFrom('recipient_bank_accounts').selectAll().where('id', '=', id),
    );
    return row ?? null;
  },

  async getByAccountNumber(
    accountNumber: string | null | undefined,
  ): Promise<RecipientBankAccountRow | null> {
    if (!accountNumber) return null;
    const row = await checkedRow(
      recipientBankAccountRowSchema,
      db
        .selectFrom('recipient_bank_accounts')
        .selectAll()
        .where('account_number', '=', accountNumber.trim().toUpperCase()),
    );
    return row ?? null;
  },

  async getByRecipientId(
    recipientId: RecipientId,
    activeOnly = true,
  ): Promise<RecipientBankAccountRow[]> {
    let builder = db
      .selectFrom('recipient_bank_accounts')
      .selectAll()
      .where('recipient_id', '=', recipientId);
    if (activeOnly) builder = builder.where('is_active', '=', true);

    return checkedRows(
      recipientBankAccountRowSchema,
      builder.orderBy('is_primary', 'desc').orderBy('created_at', 'asc'),
    );
  },

  async getPrimaryAccount(
    recipientId: RecipientId,
  ): Promise<RecipientBankAccountRow | null> {
    const row = await checkedRow(
      recipientBankAccountRowSchema,
      db
        .selectFrom('recipient_bank_accounts')
        .selectAll()
        .where('recipient_id', '=', recipientId)
        .where('is_primary', '=', true)
        .where('is_active', '=', true)
        .limit(1),
    );
    return row ?? null;
  },

  /**
   * Create or get a bank account, enriching existing accounts with missing metadata.
   */
  async createOrGet({
    recipientId,
    accountNumber,
    bankName = null,
    address = null,
    accountLabel = null,
    setAsPrimary = false,
  }: {
    recipientId: RecipientId;
    accountNumber: string;
    bankName?: string | null;
    address?: string | null;
    accountLabel?: string | null;
    setAsPrimary?: boolean;
  }): Promise<{
    bankAccount: RecipientBankAccountRow | null;
    created: boolean;
  }> {
    if (!accountNumber) throw new Error('Account number is required');

    const existing = await this.getByAccountNumber(accountNumber);
    if (existing) {
      // Enrich with missing metadata.
      const updates = {
        ...(bankName && !existing.bank_name && { bank_name: bankName }),
        ...(address && existing.address !== address && { address }),
        ...(accountLabel && !existing.account_label && { account_label: accountLabel }),
      };

      if (Object.keys(updates).length > 0) {
        await db
          .updateTable('recipient_bank_accounts')
          .set({ ...updates, updated_at: sql<Date>`NOW()` })
          .where('id', '=', existing.id)
          .execute();
      }

      if (setAsPrimary && !existing.is_primary) {
        await this.setPrimary(existing.id, existing.recipient_id);
      }

      const refreshed = await this.getById(existing.id);
      return { bankAccount: refreshed, created: false };
    }

    // Check if first account for this recipient — count ALL accounts including
    // soft-deleted ones, so a recipient whose only accounts were deactivated
    // doesn't get a surprise new primary.
    const existingAccounts = await this.getByRecipientId(recipientId, false);
    const isFirst = existingAccounts.length === 0;
    const willBePrimary = setAsPrimary || isFirst;

    // Unset the current primary and insert the new one in a single
    // transaction — doing the insert-as-primary then a separate setPrimary()
    // left a brief window where the recipient had two primary accounts.
    const created = await withTransaction<RecipientBankAccountRow>(async () => {
      if (willBePrimary) await clearPrimary(recipientId);
      const row = await checkedRow(
        recipientBankAccountRowSchema,
        db
          .insertInto('recipient_bank_accounts')
          .values({
            recipient_id: recipientId,
            account_number: accountNumber.trim().toUpperCase(),
            bank_name: bankName,
            address,
            account_label: accountLabel,
            is_primary: willBePrimary,
            is_active: true,
          })
          .returningAll(),
      );
      return requireRow(row, 'recipient bank account insert');
    });

    return { bankAccount: created, created: true };
  },

  async update(
    id: number,
    {
      bankName,
      address,
      accountLabel,
    }: {
      bankName?: string | null | undefined;
      address?: string | null | undefined;
      accountLabel?: string | null | undefined;
    },
  ): Promise<RecipientBankAccountRow | null> {
    // undefined fields are skipped.
    const updates = {
      ...(bankName !== undefined && { bank_name: bankName }),
      ...(address !== undefined && { address }),
      ...(accountLabel !== undefined && { account_label: accountLabel }),
    };

    if (Object.keys(updates).length === 0) return this.getById(id);

    const row = await checkedRow(
      recipientBankAccountRowSchema,
      db
        .updateTable('recipient_bank_accounts')
        .set({ ...updates, updated_at: sql<Date>`NOW()` })
        .where('id', '=', id)
        .returningAll(),
    );
    return row ?? null;
  },

  /** @returns true if a row was deactivated */
  async softDelete(id: number): Promise<boolean> {
    const row = await db
      .updateTable('recipient_bank_accounts')
      .set({ is_active: false, updated_at: sql<Date>`NOW()` })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  },

  /**
   * Recipient merge: drop alias bank accounts that would collide with one the
   * primary already owns on uq_rba_account_number (migration 0029). The
   * primary's row is kept and the alias's deleted, rather than reassigned.
   * Must run BEFORE repointRecipient().
   * @returns rows deleted
   */
  async deleteMergeDuplicates(
    primaryId: RecipientId,
    aliasIds: RecipientId[],
  ): Promise<number> {
    const result = await db
      .deleteFrom('recipient_bank_accounts as rba')
      .using('recipient_bank_accounts as keep')
      .where('rba.recipient_id', '=', anyRecipientId(aliasIds))
      .where('keep.recipient_id', '=', primaryId)
      .whereRef('keep.account_number', '=', 'rba.account_number')
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  },

  /**
   * Repoint surviving alias bank accounts onto the merge primary.
   * @returns rows repointed
   */
  async repointRecipient(primaryId: RecipientId, aliasIds: RecipientId[]): Promise<number> {
    const result = await db
      .updateTable('recipient_bank_accounts')
      .set({ recipient_id: primaryId })
      .where('recipient_id', '=', anyRecipientId(aliasIds))
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  },

  /** @returns true if the account was made primary */
  async setPrimary(
    bankAccountId: number,
    recipientId: RecipientId | null,
  ): Promise<boolean> {
    return withTransaction(async () => {
      await clearPrimary(recipientId);
      const row = await db
        .updateTable('recipient_bank_accounts')
        .set({ is_primary: true, updated_at: sql<Date>`NOW()` })
        .where('id', '=', bankAccountId)
        .where('recipient_id', '=', recipientId)
        .returning('id')
        .executeTakeFirst();
      return row !== undefined;
    });
  },
};

export default recipientBankAccountRepository;
