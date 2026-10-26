/**
 * Real-PostgreSQL behaviour of the account repository: filtering, pagination,
 * identity lookup and whitelisted writes. Replaces mocked-pool tests that only
 * asserted the SQL text the repository emitted.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDbSuiteLock,
  closeTestPool,
  getTestPool,
  hasTestDatabase,
  releaseDbSuiteLock,
} from "./setup/db.ts";
import { closePool } from "../src/database/connection.ts";
import accountRepository from "../src/repositories/accountRepository.ts";
import { accountService } from "../src/services/accountService.ts";
import {
  asAccountId,
} from "@vision/types/brands";
import { must } from "./helpers/must.ts";

const SUFFIX = `ARB${process.pid}`;
const createdIds: number[] = [];

async function createAccount(
  name: string,
  fields: Record<string, unknown> = {},
) {
  const row = await accountRepository.create({
    name: `${name} ${SUFFIX}`,
    display_name: `${name} ${SUFFIX}`,
    currency: "EUR",
    ...fields,
  });
  createdIds.push(row.id);
  return row;
}

describe.skipIf(!hasTestDatabase())("account repository (real DB)", () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(process.env.TEST_DATABASE_URL);
    await acquireDbSuiteLock();
  }, 180_000);

  afterEach(async () => {
    const pool = must(getTestPool(), "getTestPool()");
    const ids = createdIds.splice(0);
    await pool.query(
      "DELETE FROM account_statement_balances WHERE account_id = ANY($1::int[])",
      [ids],
    );
    await pool.query(
      "UPDATE accounts SET funding_account_id = NULL WHERE id = ANY($1::int[])",
      [ids],
    );
    await pool.query("DELETE FROM accounts WHERE id = ANY($1::int[])", [ids]);
  });

  afterAll(async () => {
    try {
      await releaseDbSuiteLock();
    } finally {
      await closeTestPool();
      await closePool();
    }
  });

  it("filters the account list and count by active status", async () => {
    const active = await createAccount("Active");
    const inactive = await createAccount("Inactive", { is_active: false });

    const ids = async (opts: Parameters<typeof accountService.list>[0]) =>
      (await accountService.list(opts)).items.map((row) => row.id);

    const all = await ids({});
    expect(all).toEqual(expect.arrayContaining([active.id, inactive.id]));

    const activeOnly = await ids({ active: true });
    expect(activeOnly).toContain(active.id);
    expect(activeOnly).not.toContain(inactive.id);

    const inactiveOnly = await ids({ active: false });
    expect(inactiveOnly).toContain(inactive.id);
    expect(inactiveOnly).not.toContain(active.id);

    expect(await accountRepository.getCount({ active: false })).toBe(
      inactiveOnly.length,
    );
    expect(await accountRepository.getCount({ active: true })).toBe(
      activeOnly.length,
    );
  });

  it("returns every account without a limit and pages by name when given one", async () => {
    await createAccount("Page A");
    await createAccount("Page B");
    await createAccount("Page C");

    const everything = await accountRepository.getAll({});
    expect(everything.length).toBe(await accountRepository.getCount({}));
    const names = everything.map((row) => row.name);
    expect(names).toEqual([...names].sort());

    const page = await accountRepository.getAll({ limit: 2, offset: 1 });
    expect(page.map((row) => row.id)).toEqual(
      everything.slice(1, 3).map((row) => row.id),
    );
  });

  it("finds an account by id and by case/whitespace-insensitive name", async () => {
    const created = await createAccount("Brokerage");
    expect((await accountRepository.getById(created.id))?.name).toBe(
      created.name,
    );
    expect(await accountRepository.getById(asAccountId(-1))).toBeUndefined();
    expect(
      (await accountRepository.getByName(`  ${created.name.toUpperCase()} `))
        ?.id,
    ).toBe(created.id);
  });

  it("creates and updates only whitelisted fields", async () => {
    const created = await createAccount("Whitelist", {
      bogus: "ignored",
      type: undefined,
    });
    expect(created.currency).toBe("EUR");
    expect(created.type).toBe("checking");

    const updated = await accountRepository.update(created.id, {
      display_name: "Renamed display",
      nope: 1,
    });
    expect(updated?.display_name).toBe("Renamed display");
    expect(updated?.name).toBe(created.name);

    const renamed = await accountRepository.update(created.id, {
      name: `Renamed ${SUFFIX}`,
    });
    expect(renamed?.name).toBe(`Renamed ${SUFFIX}`);

    // No writable field: the current row comes back unchanged.
    expect(
      (await accountRepository.update(created.id, { nope: 1 }))?.name,
    ).toBe(`Renamed ${SUFFIX}`);
    expect(
      await accountRepository.update(asAccountId(-1), { currency: "USD" }),
    ).toBeUndefined();
  });

  it("removes an account and reports a missing one as undefined", async () => {
    const created = await createAccount("Removable");
    expect(await accountRepository.remove(created.id)).toBe(created.id);
    expect(await accountRepository.remove(created.id)).toBeUndefined();
  });

  it("resolves a trimmed name to one identity and keeps multi-currency sticky", async () => {
    const name = `Resolve ${SUFFIX}`;
    const id = must((await accountRepository.resolveOrCreateByName(`  ${name}  `)), "(await accountRepository.resolveOrCreateByName(` ${name} `))");
    createdIds.push(id);
    expect((await accountRepository.getById(id))?.name).toBe(name);
    expect(
      await accountRepository.resolveOrCreateByName(name.toLowerCase()),
    ).toBe(id);

    await accountRepository.resolveOrCreateByName(name, {
      multiCurrencyCash: true,
    });
    await accountRepository.resolveOrCreateByName(name);
    const pool = must(getTestPool(), "getTestPool()");
    const { rows } = await pool.query(
      "SELECT name, multi_currency_cash FROM accounts WHERE id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ name, multi_currency_cash: true });

    expect(
      await accountRepository.resolveOrCreateByName("   "),
    ).toBeUndefined();
  });
  it("normalizes and allowlists account input in the service", async () => {
    const funder = await createAccount("Funder");
    const created = await accountService.create({
      name: `  KBC ${SUFFIX}  `,
      currency: "eur",
      funding_account_id: funder.id,
      evil_column: "x; DROP TABLE",
      balance: 999,
    });
    createdIds.push(created.id);
    expect(created).toMatchObject({
      name: `KBC ${SUFFIX}`,
      currency: "EUR",
      funding_account_id: funder.id,
    });

    await accountService.update(created.id, { display_name: "Main" });
    const cleared = await accountService.update(created.id, {
      name: `  New ${SUFFIX}  `,
      display_name: null,
      funding_account_id: null,
    });
    expect(cleared).toMatchObject({
      name: `New ${SUFFIX}`,
      display_name: null,
      funding_account_id: null,
    });
    // An empty PATCH body changes nothing.
    expect((await accountService.update(created.id, {})).name).toBe(
      `New ${SUFFIX}`,
    );

    await accountService.setStatementBalance(created.id, "usd", {
      balance: "12.34",
      date: "2026-09-04",
    });
    const { rows } = await must(getTestPool(), "getTestPool()").query(
      `SELECT currency, balance::float8 AS balance,
              to_char(balance_date, 'YYYY-MM-DD') AS balance_date
         FROM account_statement_balances WHERE account_id = $1`,
      [created.id],
    );
    expect(rows).toEqual([
      { currency: "USD", balance: 12.34, balance_date: "2026-09-04" },
    ]);
  });
});
