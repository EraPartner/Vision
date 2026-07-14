/**
 * Account Service — business logic + orchestration for accounts (ADR-088).
 *
 * Sits between routes and accountRepository so route files never reach the
 * data-access layer directly (vision-local/no-repo-direct-from-route, ADR-067).
 */

import accountRepository from '../repositories/accountRepository.js';
import { NotFoundError, ValidationError, ConflictError } from '../middleware/errorHandler.js';

// Enum value sets — mirror migration 0050. Their semantics are activated in ADR-089.
export const ACCOUNT_TYPES = ['checking', 'savings', 'brokerage', 'crypto_exchange', 'wallet', 'pension', 'liability'];
export const LIQUIDITY_CLASSES = ['liquid', 'semi_liquid', 'illiquid'];
export const TAX_WRAPPERS = ['none', 'pension', 'tax_advantaged'];
export const ACCOUNT_OWNERS = ['me', 'partner', 'joint'];

const BOOLEAN_FIELDS = ['spendable', 'in_net_worth', 'multi_currency_cash', 'has_cash_sleeve', 'is_active'];
// Matches the 12-integer-digit ceiling of the money columns (NUMERIC(18,6)).
const MAX_STATEMENT_BALANCE = 1e12;
const ENUM_FIELDS = {
  type: ACCOUNT_TYPES,
  liquidity_class: LIQUIDITY_CLASSES,
  tax_wrapper: TAX_WRAPPERS,
  owner: ACCOUNT_OWNERS,
};

/**
 * Validate + normalize an account payload. On create, name is required; on
 * update every field is optional. Returns only the fields that were provided.
 */
function sanitize(body, { requireName }) {
  const out = {};

  if (body.name !== undefined || requireName) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new ValidationError('name is required and must be a non-empty string');
    }
    out.name = body.name.trim();
  }

  // Explicit null means "clear this field" and must survive to the repository
  // as SQL NULL — mapping it to undefined made PATCH-to-clear a silent no-op
  // (the repository skips undefined when building SET).
  for (const key of ['display_name', 'institution']) {
    if (body[key] !== undefined) {
      if (body[key] !== null && typeof body[key] !== 'string') {
        throw new ValidationError(`${key} must be a string`);
      }
      out[key] = body[key] === null ? null : body[key].trim();
    }
  }

  if (body.currency !== undefined) {
    const c = String(body.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new ValidationError('currency must be a 3-letter ISO code');
    out.currency = c;
  }

  for (const [key, allowed] of Object.entries(ENUM_FIELDS)) {
    if (body[key] !== undefined) {
      if (!allowed.includes(body[key])) {
        throw new ValidationError(`${key} must be one of: ${allowed.join(', ')}`);
      }
      out[key] = body[key];
    }
  }

  for (const key of BOOLEAN_FIELDS) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') throw new ValidationError(`${key} must be a boolean`);
      out[key] = body[key];
    }
  }

  if (body.funding_account_id !== undefined) {
    if (body.funding_account_id === null) {
      out.funding_account_id = null;
    } else {
      const fid = Number(body.funding_account_id);
      if (!Number.isInteger(fid) || fid <= 0) throw new ValidationError('funding_account_id must be a positive integer');
      out.funding_account_id = fid;
    }
  }

  if (body.statement_balance !== undefined) {
    if (body.statement_balance === null) {
      out.statement_balance = null;
    } else {
      const bal = Number(body.statement_balance);
      if (!Number.isFinite(bal)) throw new ValidationError('statement_balance must be a number');
      // Bound it like the money columns (NUMERIC 12-integer-digit ceiling): an
      // unbounded 1e15 / JSON "Infinity" otherwise slid past the finite check
      // and 500'd at the DB. Balances can be negative (liability), so bound the
      // magnitude.
      if (Math.abs(bal) > MAX_STATEMENT_BALANCE) {
        throw new ValidationError(`statement_balance must be between -${MAX_STATEMENT_BALANCE} and ${MAX_STATEMENT_BALANCE}`);
      }
      out.statement_balance = bal;
    }
  }

  if (body.statement_balance_date !== undefined) {
    if (body.statement_balance_date === null) {
      out.statement_balance_date = null;
    } else {
      const d = String(body.statement_balance_date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new ValidationError('statement_balance_date must be an ISO date (YYYY-MM-DD)');
      out.statement_balance_date = d;
    }
  }

  return out;
}

/**
 * A statement balance is only meaningful with its as-of date (ADR-094 drift
 * anchors on it). Enforced here for a friendly 4xx; migration 0065's CHECK
 * (ck_accounts_statement_balance_has_date) backstops at the DB.
 */
function assertStatementBalanceHasDate(balance, date) {
  if (balance != null && date == null) {
    throw new ValidationError('statement_balance_date is required when statement_balance is set');
  }
}

/**
 * A funding account must exist and cannot be the account itself (a self-funding
 * cycle). `sanitize` only checks the value is a positive integer; this verifies
 * the reference. The DB FK (fk_accounts_funding_account) backstops races, but a
 * nonexistent id would otherwise surface as a raw 23503 → 500; we 400 here.
 *
 * @param {number|null|undefined} fundingAccountId
 * @param {number|null} selfId  the account being updated (null on create)
 */
async function assertFundingAccountValid(fundingAccountId, selfId) {
  if (fundingAccountId == null) return;
  if (selfId != null && fundingAccountId === Number(selfId)) {
    throw new ValidationError('funding_account_id cannot reference the account itself');
  }
  const funding = await accountRepository.getById(fundingAccountId);
  if (!funding) {
    throw new ValidationError(`funding_account_id ${fundingAccountId} does not reference an existing account`);
  }
}

export const accountService = {
  /** List accounts (active=true|false|null for all). */
  async list({ active = null } = {}) {
    return accountRepository.getAll({ active });
  },

  async get(id) {
    const account = await accountRepository.getById(id);
    if (!account) throw new NotFoundError(`Account ${id} not found`);
    return account;
  },

  async create(body) {
    const fields = sanitize(body, { requireName: true });
    assertStatementBalanceHasDate(fields.statement_balance, fields.statement_balance_date);
    await assertFundingAccountValid(fields.funding_account_id, null);
    try {
      return await accountRepository.create(fields);
    } catch (err) {
      if (err?.code === '23505') throw new ConflictError(`An account named "${fields.name}" already exists`);
      // FK violation (e.g. funding_account_id lost a race with a delete) → 400.
      if (err?.code === '23503') throw new ValidationError('funding_account_id does not reference an existing account');
      throw err;
    }
  },

  async update(id, body) {
    const fields = sanitize(body, { requireName: false });
    await assertFundingAccountValid(fields.funding_account_id, id);
    const touchesStatement = 'statement_balance' in fields || 'statement_balance_date' in fields;
    let current;
    if (touchesStatement || 'is_active' in fields) {
      current = await accountRepository.getById(id);
      if (!current) throw new NotFoundError(`Account ${id} not found`);
    }
    // Partial PATCH: validate the merged state, not just the provided keys —
    // e.g. setting a balance while the stored date is NULL must still fail.
    if (touchesStatement) {
      assertStatementBalanceHasDate(
        'statement_balance' in fields ? fields.statement_balance : current.statement_balance,
        'statement_balance_date' in fields ? fields.statement_balance_date : current.statement_balance_date,
      );
    }
    // Lifecycle (ADR-088 addendum, D5): closing stamps closed_at once (a
    // redundant re-archive keeps the original timestamp); reactivating clears
    // it. Server-stamped only — sanitize() never accepts closed_at from the body.
    if (fields.is_active === false && current.is_active) {
      fields.closed_at = new Date();
    } else if (fields.is_active === true) {
      fields.closed_at = null;
    }
    let updated;
    try {
      updated = await accountRepository.update(id, fields);
    } catch (err) {
      if (err?.code === '23505') throw new ConflictError(`An account named "${fields.name}" already exists`);
      if (err?.code === '23503') throw new ValidationError('funding_account_id does not reference an existing account');
      throw err;
    }
    if (!updated) throw new NotFoundError(`Account ${id} not found`);
    return updated;
  },

  /**
   * Hard-delete an account. Accounts protect history: delete is only possible
   * with zero referencing rows (FK ON DELETE RESTRICT); otherwise a 409 routes
   * the caller to the close flow (lifecycle D5: active → closed → deleted).
   */
  async remove(id) {
    let removed;
    try {
      removed = await accountRepository.remove(id);
    } catch (err) {
      if (err?.code === '23503') {
        throw new ConflictError(
          `Account ${id} still has activity referencing it and cannot be deleted. Close the account instead.`,
        );
      }
      throw err;
    }
    if (!removed) throw new NotFoundError(`Account ${id} not found`);
    return removed;
  },
};

export default accountService;
