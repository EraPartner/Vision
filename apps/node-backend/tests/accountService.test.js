import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repositories/accountRepository.js', () => {
  const repo = {
    getAll: vi.fn(),
    getCount: vi.fn(),
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

  it('rejects an absurd statement_balance above the money-column ceiling', async () => {
    await expect(
      accountService.create({
        name: 'KBC', statement_balance: 1e15, statement_balance_date: '2026-07-01',
      }),
    ).rejects.toThrow(ValidationError);
    expect(accountRepository.create).not.toHaveBeenCalled();
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

  it('closing also sets in_net_worth=false so the account leaves every aggregate (§1 F3)', async () => {
    accountRepository.getById.mockResolvedValueOnce({ id: 1, is_active: true, in_net_worth: true });
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { is_active: false });
    const fields = accountRepository.update.mock.calls[0][1];
    expect(fields.is_active).toBe(false);
    expect(fields.in_net_worth).toBe(false);
  });

  it('an explicit in_net_worth in the same close PATCH wins over the close default', async () => {
    accountRepository.getById.mockResolvedValueOnce({ id: 1, is_active: true, in_net_worth: true });
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { is_active: false, in_net_worth: true });
    const fields = accountRepository.update.mock.calls[0][1];
    expect(fields.in_net_worth).toBe(true); // explicit intent respected
  });

  it('reactivating does NOT auto-restore in_net_worth (explicit user control)', async () => {
    accountRepository.getById.mockResolvedValueOnce({ id: 1, is_active: false, in_net_worth: false });
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { is_active: true });
    const fields = accountRepository.update.mock.calls[0][1];
    expect('in_net_worth' in fields).toBe(false);
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

// funding_account_id must not close a loop. Self-reference was already rejected;
// these pin the multi-hop ancestor walk (A→B→A and longer), its termination on
// data that is ALREADY cyclic, and that create skips the walk entirely.
describe('accountService — funding chain cycles', () => {
  // Mock the accounts graph: id → funding_account_id (undefined = chain ends).
  const graph = (edges) => {
    accountRepository.getById.mockImplementation(async (id) => (
      id in edges ? { id: Number(id), funding_account_id: edges[id] ?? null } : undefined
    ));
  };

  // clearAllMocks() keeps implementations, so drop the graph explicitly —
  // otherwise it would answer getById for every later test in this file.
  afterEach(() => accountRepository.getById.mockReset());

  it('rejects a two-hop cycle (A funds B, then B funds A)', async () => {
    graph({ 2: 1 }); // account 2 is already funded by account 1
    await expect(
      accountService.update(1, { funding_account_id: 2 }),
    ).rejects.toThrow(/funding cycle/);
    expect(accountRepository.update).not.toHaveBeenCalled();
  });

  it('rejects a longer chain closing back on the edited account (A→B→C→D→A)', async () => {
    graph({ 2: 3, 3: 4, 4: 1 });
    await expect(
      accountService.update(1, { funding_account_id: 2 }),
    ).rejects.toThrow(/funding cycle/);
    expect(accountRepository.update).not.toHaveBeenCalled();
  });

  it('accepts a funding chain that terminates without reaching the edited account', async () => {
    graph({ 2: 3, 3: undefined });
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { funding_account_id: 2 });
    expect(accountRepository.update).toHaveBeenCalledWith(1, { funding_account_id: 2 });
  });

  // The pre-existing-cycle case: this guard did not exist before, so the stored
  // graph may already loop. The walk must stop instead of hanging the request.
  it('terminates on a pre-existing upstream cycle that does not involve the edited account', async () => {
    graph({ 2: 3, 3: 2 }); // 2 ↔ 3 already loop, account 1 is outside it
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { funding_account_id: 2 });
    expect(accountRepository.update).toHaveBeenCalledWith(1, { funding_account_id: 2 });
    // Bounded by the visited set: id 2 (existence check) then id 3, then stop.
    expect(accountRepository.getById).toHaveBeenCalledTimes(2);
  });

  it('does not walk on create — a not-yet-existing account cannot be an ancestor', async () => {
    graph({ 2: 3, 3: 2 }); // would loop forever if the walk ran
    accountRepository.create.mockResolvedValueOnce({ id: 9 });
    await accountService.create({ name: 'New', funding_account_id: 2 });
    expect(accountRepository.create).toHaveBeenCalledWith({ name: 'New', funding_account_id: 2 });
    expect(accountRepository.getById).toHaveBeenCalledTimes(1); // existence check only
  });
});

// Pins for the zod swap (ZOD-05): exact boundaries, coercions, and the strip
// semantics of sanitize() must survive byte-identical.
describe('accountService — sanitize pins (create)', () => {
  it('accepts a statement_balance exactly at the +/- money-column ceiling', async () => {
    accountRepository.create.mockResolvedValue({ id: 1 });
    await accountService.create({ name: 'A', statement_balance: 1e12, statement_balance_date: '2026-07-01' });
    await accountService.create({ name: 'B', statement_balance: -1e12, statement_balance_date: '2026-07-01' });
    expect(accountRepository.create).toHaveBeenCalledTimes(2);
  });

  it('rejects a statement_balance just past the ceiling (either sign)', async () => {
    await expect(accountService.create({
      name: 'A', statement_balance: 1e12 + 1, statement_balance_date: '2026-07-01',
    })).rejects.toThrow(ValidationError);
    await expect(accountService.create({
      name: 'A', statement_balance: -(1e12 + 1), statement_balance_date: '2026-07-01',
    })).rejects.toThrow(ValidationError);
    expect(accountRepository.create).not.toHaveBeenCalled();
  });

  it('coerces a numeric-string statement_balance via Number()', async () => {
    accountRepository.create.mockResolvedValueOnce({ id: 1 });
    await accountService.create({
      name: 'A', statement_balance: '123.45', statement_balance_date: '2026-07-01',
    });
    expect(accountRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ statement_balance: 123.45 }),
    );
  });

  it('rejects malformed statement_balance_date shapes (strict YYYY-MM-DD)', async () => {
    for (const bad of ['2026-7-01', '01-07-2026', 20260701, 'banana']) {
      await expect(accountService.create({
        name: 'A', statement_balance: 1, statement_balance_date: bad,
      })).rejects.toThrow(ValidationError);
    }
    expect(accountRepository.create).not.toHaveBeenCalled();
  });

  // The reject half of this pin only listed values a `Number()` coercion fails
  // on. The forms it accepts were the damaging ones and went untested: '1e3'
  // arrived as the real account 1000, so assertFundingAccountValid's existence
  // check passed and the account was funded from one nobody named.
  it('coerces a numeric-string funding_account_id and rejects zero/fractional/retargeting ids', async () => {
    accountRepository.getById.mockResolvedValueOnce({ id: 7 });
    accountRepository.create.mockResolvedValueOnce({ id: 1 });
    await accountService.create({ name: 'A', funding_account_id: '7' });
    expect(accountRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ funding_account_id: 7 }),
    );
    for (const funding_account_id of [
      0, 1.5, -1, 'abc', '12abc',
      '1e3', '0x10', '0o17', '0b11', true, [7], '+7', ' 7 ', '7.0',
    ]) {
      await expect(
        accountService.create({ name: 'A', funding_account_id }),
        `expected ${JSON.stringify(funding_account_id)} to be rejected`,
      ).rejects.toThrow(ValidationError);
    }
  });

  it('rejects non-string and whitespace-only names', async () => {
    await expect(accountService.create({ name: 123 })).rejects.toThrow(ValidationError);
    await expect(accountService.create({ name: '   ' })).rejects.toThrow(ValidationError);
  });

  it('rejects a non-string display_name / institution and trims string ones', async () => {
    await expect(accountService.create({ name: 'A', display_name: 42 })).rejects.toThrow(ValidationError);
    await expect(accountService.create({ name: 'A', institution: {} })).rejects.toThrow(ValidationError);
    accountRepository.create.mockResolvedValueOnce({ id: 1 });
    await accountService.create({ name: 'A', display_name: '  Main  ', institution: ' KBC ' });
    expect(accountRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ display_name: 'Main', institution: 'KBC' }),
    );
  });

  it('rejects an explicit null/empty currency (an explicit key must carry a real code)', async () => {
    await expect(accountService.create({ name: 'A', currency: null })).rejects.toThrow(ValidationError);
    await expect(accountService.create({ name: 'A', currency: '' })).rejects.toThrow(ValidationError);
  });

  it('rejects unknown enum values for every enum field', async () => {
    for (const [key, bad] of [
      ['liquidity_class', 'frozen'], ['tax_wrapper', 'offshore'], ['owner', 'them'],
    ]) {
      await expect(accountService.create({ name: 'A', [key]: bad })).rejects.toThrow(ValidationError);
    }
  });

  it('rejects truthy non-boolean flags (1 is not true)', async () => {
    await expect(accountService.create({ name: 'A', spendable: 1 })).rejects.toThrow(ValidationError);
  });

  it('strips unknown body fields entirely (allowlist semantics)', async () => {
    accountRepository.create.mockResolvedValueOnce({ id: 1 });
    await accountService.create({ name: 'A', evil_column: 'x; DROP TABLE', balance: 999 });
    expect(accountRepository.create).toHaveBeenCalledWith({ name: 'A' });
  });
});

describe('accountService — sanitize pins (update)', () => {
  it('rejects an explicit null name on update (name is not clearable)', async () => {
    await expect(accountService.update(1, { name: null })).rejects.toThrow(ValidationError);
    expect(accountRepository.update).not.toHaveBeenCalled();
  });

  it('trims an updated name', async () => {
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, { name: '  New  ' });
    expect(accountRepository.update).toHaveBeenCalledWith(1, { name: 'New' });
  });

  it('forwards an empty PATCH body as an empty field set', async () => {
    accountRepository.update.mockResolvedValueOnce({ id: 1 });
    await accountService.update(1, {});
    expect(accountRepository.update).toHaveBeenCalledWith(1, {});
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
    expect(accountRepository.getAll).toHaveBeenCalledWith({ active: false, limit: null, offset: 0 });
  });

  // Absent pagination keeps the pre-pagination contract: the query is
  // unbounded, so the rows returned ARE the total and no COUNT is issued.
  it('lists every account and derives total from the rows when unpaginated', async () => {
    accountRepository.getAll.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const result = await accountService.list();
    expect(result).toEqual({ items: [{ id: 1 }, { id: 2 }], total: 2 });
    expect(accountRepository.getCount).not.toHaveBeenCalled();
  });

  it('counts separately when a page is requested, so total is the full match count', async () => {
    accountRepository.getAll.mockResolvedValueOnce([{ id: 1 }]);
    accountRepository.getCount.mockResolvedValueOnce(9);
    const result = await accountService.list({ active: true, limit: 1, offset: 2 });
    expect(accountRepository.getAll).toHaveBeenCalledWith({ active: true, limit: 1, offset: 2 });
    expect(accountRepository.getCount).toHaveBeenCalledWith({ active: true });
    expect(result).toEqual({ items: [{ id: 1 }], total: 9 });
  });

  it('throws NotFound for a missing account', async () => {
    accountRepository.getById.mockResolvedValueOnce(undefined);
    await expect(accountService.get(123)).rejects.toThrow(NotFoundError);
  });
});
