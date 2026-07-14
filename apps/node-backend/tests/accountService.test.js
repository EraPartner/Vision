import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repositories/accountRepository.js', () => {
  const repo = {
    getAll: vi.fn(),
    getById: vi.fn(),
    getByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    resolveOrCreateByName: vi.fn(),
  };
  return { default: repo, accountRepository: repo };
});

import accountRepository from '../src/repositories/accountRepository.js';
import { accountService } from '../src/services/accountService.js';
import { ValidationError, NotFoundError, ConflictError } from '../src/middleware/errorHandler.js';

const pgErr = (code) => Object.assign(new Error(code), { code });

beforeEach(() => vi.clearAllMocks());

describe('accountService.create', () => {
  it('rejects a missing name', async () => {
    await expect(accountService.create({})).rejects.toThrow(ValidationError);
    expect(accountRepository.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown type enum', async () => {
    await expect(accountService.create({ name: 'X', type: 'wallet_typo' })).rejects.toThrow(ValidationError);
  });

  it('rejects a malformed currency', async () => {
    await expect(accountService.create({ name: 'X', currency: 'euro' })).rejects.toThrow(ValidationError);
  });

  it('trims name, uppercases currency, and forwards only provided fields', async () => {
    accountRepository.create.mockResolvedValueOnce({ id: 1, name: 'KBC' });
    await accountService.create({ name: '  KBC  ', currency: 'eur', type: 'checking', owner: 'me' });
    expect(accountRepository.create).toHaveBeenCalledWith({
      name: 'KBC',
      currency: 'EUR',
      type: 'checking',
      owner: 'me',
    });
  });

  it('maps a unique-violation (23505) to ConflictError', async () => {
    accountRepository.create.mockRejectedValueOnce(pgErr('23505'));
    await expect(accountService.create({ name: 'KBC' })).rejects.toThrow(ConflictError);
  });

  it('rejects a statement_balance without its date', async () => {
    await expect(
      accountService.create({ name: 'KBC', statement_balance: 120.5 }),
    ).rejects.toThrow(ValidationError);
    expect(accountRepository.create).not.toHaveBeenCalled();
  });

  it('accepts a statement_balance with its date', async () => {
    accountRepository.create.mockResolvedValueOnce({ id: 1 });
    await accountService.create({
      name: 'KBC', statement_balance: 120.5, statement_balance_date: '2026-07-01',
    });
    expect(accountRepository.create).toHaveBeenCalled();
  });

  it('rejects a funding_account_id pointing at a nonexistent account with 400, not 500', async () => {
    accountRepository.getById.mockResolvedValueOnce(undefined); // referenced account missing
    await expect(
      accountService.create({ name: 'KBC', funding_account_id: 999 }),
    ).rejects.toThrow(ValidationError);
    expect(accountRepository.create).not.toHaveBeenCalled();
  });

  it('accepts a funding_account_id that references an existing account', async () => {
    accountRepository.getById.mockResolvedValueOnce({ id: 7, name: 'Funder' });
    accountRepository.create.mockResolvedValueOnce({ id: 1 });
    await accountService.create({ name: 'KBC', funding_account_id: 7 });
    expect(accountRepository.create).toHaveBeenCalled();
  });

  it('maps a FK violation (23503) on create to a ValidationError (400)', async () => {
    accountRepository.getById.mockResolvedValueOnce({ id: 7 }); // passes the existence pre-check
    accountRepository.create.mockRejectedValueOnce(pgErr('23503')); // lost a race with a delete
    await expect(
      accountService.create({ name: 'KBC', funding_account_id: 7 }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('accountService.update', () => {
  it('throws NotFound when the row does not exist', async () => {
    accountRepository.update.mockResolvedValueOnce(undefined);
    await expect(accountService.update(9, { display_name: 'x' })).rejects.toThrow(NotFoundError);
  });

  it('rejects a non-boolean flag', async () => {
    await expect(accountService.update(1, { in_net_worth: 'yes' })).rejects.toThrow(ValidationError);
  });

  it('rejects a self-referencing funding_account_id with 400', async () => {
    await expect(
      accountService.update(5, { funding_account_id: 5 }),
    ).rejects.toThrow(ValidationError);
    expect(accountRepository.update).not.toHaveBeenCalled();
  });

  it('rejects a funding_account_id pointing at a nonexistent account with 400, not 500', async () => {
    accountRepository.getById.mockResolvedValueOnce(undefined);
    await expect(
      accountService.update(1, { funding_account_id: 999 }),
    ).rejects.toThrow(ValidationError);
    expect(accountRepository.update).not.toHaveBeenCalled();
  });

  it('forwards explicit null as SQL NULL for clearable fields (PATCH-to-clear)', async () => {
    accountRepository.getById.mockResolvedValueOnce({
      id: 1, statement_balance: 99, statement_balance_date: '2026-07-01',
    });
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, {
      display_name: null,
      institution: null,
      funding_account_id: null,
      statement_balance: null,
      statement_balance_date: null,
    });
    expect(accountRepository.update).toHaveBeenCalledWith(1, {
      display_name: null,
      institution: null,
      funding_account_id: null,
      statement_balance: null,
      statement_balance_date: null,
    });
  });

  it('still drops omitted fields (undefined never reaches the repository)', async () => {
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { display_name: 'Main' });
    expect(accountRepository.update).toHaveBeenCalledWith(1, { display_name: 'Main' });
  });

  it('rejects setting a statement_balance when the stored date is NULL (merged-state check)', async () => {
    accountRepository.getById.mockResolvedValueOnce({
      id: 1, statement_balance: null, statement_balance_date: null,
    });
    await expect(
      accountService.update(1, { statement_balance: 99 }),
    ).rejects.toThrow(ValidationError);
    expect(accountRepository.update).not.toHaveBeenCalled();
  });

  it('rejects clearing the date while a balance stays stored', async () => {
    accountRepository.getById.mockResolvedValueOnce({
      id: 1, statement_balance: 99, statement_balance_date: '2026-07-01',
    });
    await expect(
      accountService.update(1, { statement_balance_date: null }),
    ).rejects.toThrow(ValidationError);
  });

  it('allows setting a balance when the stored date already exists', async () => {
    accountRepository.getById.mockResolvedValueOnce({
      id: 1, statement_balance: 50, statement_balance_date: '2026-07-01',
    });
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { statement_balance: 99 });
    expect(accountRepository.update).toHaveBeenCalledWith(1, { statement_balance: 99 });
  });

  it('stamps closed_at when archiving an active account (lifecycle D5)', async () => {
    accountRepository.getById.mockResolvedValueOnce({ id: 1, is_active: true });
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { is_active: false });
    const fields = accountRepository.update.mock.calls[0][1];
    expect(fields.is_active).toBe(false);
    expect(fields.closed_at).toBeInstanceOf(Date);
  });

  it('keeps the original closed_at on a redundant re-archive', async () => {
    accountRepository.getById.mockResolvedValueOnce({ id: 1, is_active: false, closed_at: '2026-01-01T00:00:00Z' });
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { is_active: false });
    const fields = accountRepository.update.mock.calls[0][1];
    expect('closed_at' in fields).toBe(false);
  });

  it('clears closed_at when reactivating', async () => {
    accountRepository.getById.mockResolvedValueOnce({ id: 1, is_active: false, closed_at: '2026-01-01T00:00:00Z' });
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { is_active: true });
    const fields = accountRepository.update.mock.calls[0][1];
    expect(fields.closed_at).toBeNull();
  });

  it('never accepts closed_at from the request body', async () => {
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { display_name: 'X', closed_at: '2020-01-01T00:00:00Z' });
    const fields = accountRepository.update.mock.calls[0][1];
    expect('closed_at' in fields).toBe(false);
  });

  it('allows clearing balance and date together', async () => {
    accountRepository.getById.mockResolvedValueOnce({
      id: 1, statement_balance: 99, statement_balance_date: '2026-07-01',
    });
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { statement_balance: null, statement_balance_date: null });
    expect(accountRepository.update).toHaveBeenCalledWith(1, {
      statement_balance: null, statement_balance_date: null,
    });
  });
});

describe('accountService.remove', () => {
  it('maps a FK violation (23503) to ConflictError (archive instead)', async () => {
    accountRepository.remove.mockRejectedValueOnce(pgErr('23503'));
    await expect(accountService.remove(1)).rejects.toThrow(ConflictError);
  });

  it('throws NotFound when nothing was deleted', async () => {
    accountRepository.remove.mockResolvedValueOnce(undefined);
    await expect(accountService.remove(1)).rejects.toThrow(NotFoundError);
  });

  it('returns the id on success', async () => {
    accountRepository.remove.mockResolvedValueOnce(7);
    await expect(accountService.remove(7)).resolves.toBe(7);
  });
});

describe('accountService.list / get', () => {
  it('passes the active filter through', async () => {
    accountRepository.getAll.mockResolvedValueOnce([]);
    await accountService.list({ active: false });
    expect(accountRepository.getAll).toHaveBeenCalledWith({ active: false });
  });

  it('throws NotFound for a missing account', async () => {
    accountRepository.getById.mockResolvedValueOnce(undefined);
    await expect(accountService.get(123)).rejects.toThrow(NotFoundError);
  });
});
