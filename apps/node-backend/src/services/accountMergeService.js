/**
 * Atomic account merge (ADR-088). Merges one or more SOURCE accounts into a TARGET
 * (survivor): every reference to a source account_id is repointed to the target, then
 * the source rows are deleted — so the accounts become one everywhere.
 *
 * Mirrors the recipient merge (ADR-014) pattern: single transaction, FOR UPDATE locks,
 * repoint-then-delete. The account_id FKs are ON DELETE RESTRICT, so deletion only
 * succeeds once every reference has moved — which is exactly the integrity guarantee.
 *
 * transactions / planned_transactions also get bank_account = target.name so the
 * dual-write trigger (migration 0051) keeps account_id at the target and a later edit
 * can't re-resolve the old name back into a fresh account (un-merge).
 */

import { withTransaction } from '../database/connection.js';
import { NotFoundError, ValidationError } from '../middleware/errorHandler.js';

/**
 * @param {number} targetId  the survivor
 * @param {number[]} sourceIds  accounts to merge into the target and delete
 * @returns {Promise<{ into:number, merged:number[], reassigned:{transactions:number,planned:number,portfolio:number,funding:number} }>}
 */
export async function mergeAccounts(targetId, sourceIds) {
  if (!Number.isInteger(targetId)) throw new ValidationError('target account id must be an integer');
  const ids = [...new Set((sourceIds || []).filter((id) => Number.isInteger(id) && id !== targetId))];
  if (!ids.length) throw new ValidationError('Provide at least one distinct source account to merge');

  return withTransaction(async (client) => {
    // Lock the survivor + sources so concurrent merges serialize.
    const tgt = await client.query('SELECT id, name FROM accounts WHERE id = $1 FOR UPDATE', [targetId]);
    if (!tgt.rows[0]) throw new NotFoundError(`Account ${targetId} not found`);
    const targetName = tgt.rows[0].name;

    const srcRows = await client.query('SELECT id FROM accounts WHERE id = ANY($1::int[]) FOR UPDATE', [ids]);
    const found = new Set(srcRows.rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new NotFoundError(`Account(s) not found: ${missing.join(', ')}`);

    const txRes = await client.query(
      `UPDATE transactions SET account_id = $1, bank_account = $2 WHERE account_id = ANY($3::int[])`,
      [targetId, targetName, ids],
    );
    const plannedRes = await client.query(
      `UPDATE planned_transactions SET account_id = $1, bank_account = $2 WHERE account_id = ANY($3::int[])`,
      [targetId, targetName, ids],
    );

    // Portfolio lots: account_id lives on the inheritance base (an UPDATE cascades to the child
    // tables) or, in the flat schema, on the table itself. (portfolio_transactions is a view in the
    // inheritance schema and is not updatable.)
    const baseReg = await client.query(`SELECT to_regclass('public.portfolio_transactions_base') AS r`);
    const portRes = baseReg.rows[0]?.r
      ? await client.query(
          `UPDATE portfolio_transactions_base SET account_id = $1 WHERE account_id = ANY($2::int[])`,
          [targetId, ids],
        )
      : await client.query(
          `UPDATE portfolio_transactions SET account_id = $1 WHERE account_id = ANY($2::int[])`,
          [targetId, ids],
        );

    // Accounts that used a merged source as their funding/settlement account.
    const fundRes = await client.query(
      `UPDATE accounts SET funding_account_id = $1 WHERE funding_account_id = ANY($2::int[])`,
      [targetId, ids],
    );

    await client.query('DELETE FROM accounts WHERE id = ANY($1::int[]) AND id <> $2', [ids, targetId]);

    return {
      into: targetId,
      merged: ids,
      reassigned: {
        transactions: txRes.rowCount ?? 0,
        planned: plannedRes.rowCount ?? 0,
        portfolio: portRes.rowCount ?? 0,
        funding: fundRes.rowCount ?? 0,
      },
    };
  });
}

export default { mergeAccounts };
