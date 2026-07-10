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
    try {
      return await accountRepository.create(fields);
    } catch (err) {
      if (err?.code === '23505') throw new ConflictError(`An account named "${fields.name}" already exists`);
      throw err;
    }
  },

  async update(id, body) {
    const fields = sanitize(body, { requireName: false });
    let updated;
    try {
      updated = await accountRepository.update(id, fields);
    } catch (err) {
      if (err?.code === '23505') throw new ConflictError(`An account named "${fields.name}" already exists`);
      throw err;
    }
    if (!updated) throw new NotFoundError(`Account ${id} not found`);
    return updated;
  },

  /**
   * Hard-delete an account. Accounts protect history: if transactions or planned
   * transactions still reference it (FK ON DELETE RESTRICT), surface a 409 with a
   * clear instruction to archive (set is_active=false) instead.
   */
  async remove(id) {
    let removed;
    try {
      removed = await accountRepository.remove(id);
    } catch (err) {
      if (err?.code === '23503') {
        throw new ConflictError(
          `Account ${id} still has transactions and cannot be deleted. Archive it instead (set is_active=false).`,
        );
      }
      throw err;
    }
    if (!removed) throw new NotFoundError(`Account ${id} not found`);
    return removed;
  },
};

export default accountService;
