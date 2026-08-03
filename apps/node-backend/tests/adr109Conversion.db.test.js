/**
 * Migration-level test for the ADR-109 one-time conversion (0087): a legacy
 * table-inheritance database must convert to the flat shape without losing a
 * single row, gain the FKs the view shape could never hold, roll back via the
 * rename-based downgrade, and convert again on re-upgrade.
 *
 * The fresh harness database is flat-shaped from the 0001 baseline, so the
 * legacy shape has to be CONSTRUCTED: this test builds a throwaway database
 * (same pattern as startupMaterializedViews.db.test.js — derived from
 * TEST_DATABASE_URL so host/credentials match), migrates it to 0051, replays
 * the legacy chain's inheritance DDL (legacy 0013/0014/0016/0017/0018: base +
 * child tables + JOIN views + INSTEAD OF trigger, pre-0013 `*_legacy`
 * snapshots holding the canonical index names, and an asset_class enum
 * WITHOUT 'metals'), lets the real 0052..0086 legacy branches run, seeds rows
 * across every child table, and only then runs the conversion.
 *
 * Nothing here touches TEST_DATABASE_URL's own tables.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hasTestDatabase } from './setup/db.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ALEMBIC_BIN = process.env.ALEMBIC_BIN || 'alembic';
const ALEMBIC_CONFIG = path.join(REPO_ROOT, 'config/alembic.ini');

const REV_BEFORE_LEGACY_BRANCHES = '0051_account_id_dual_write_trigger';
const REV_BEFORE_CONVERSION = '0086_portfolio_transactions_import_batch_id';

/** Throwaway database, derived from TEST_DATABASE_URL so host/credentials match. */
function scratchDbName() {
  const base = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://x/x').pathname.replace(/^\//, '');
  return `${base}_adr109`;
}

function scratchUrl() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://x/x');
  url.pathname = `/${scratchDbName()}`;
  return url.toString();
}

function alembic(...args) {
  return execFileAsync(ALEMBIC_BIN, ['-c', ALEMBIC_CONFIG, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: scratchUrl() },
    timeout: 120_000,
  });
}

/** @type {pg.Client|null} */
let db = null;

async function q(sql, params) {
  return /** @type {pg.Client} */ (db).query(sql, params);
}

async function scalar(sql, params) {
  const res = await q(sql, params);
  return res.rows[0] ? Object.values(res.rows[0])[0] : undefined;
}

// ---------------------------------------------------------------------------
// Legacy-shape DDL: what a real legacy install carried into the new chain at
// 0051 (legacy 0013 inheritance + 0014/0017 view trigger + 0016 fx_rate +
// 0017 provider columns/metals + 0018 metals transactions), including the
// pre-0013 snapshots that still own the canonical index/constraint names and
// an asset_class enum without 'metals' (legacy 0004 never had it; the view
// emits asset_class as TEXT so legacy installs never needed the enum value).
// ---------------------------------------------------------------------------
const LEGACYIZE_SQL = `
BEGIN;
ALTER TABLE asset_price_history DROP CONSTRAINT fk_aph_investment;
ALTER TABLE portfolio_import_staging_rows DROP CONSTRAINT fk_pf_staging_resolved_investment;
ALTER TABLE portfolio_import_staging_rows DROP CONSTRAINT fk_pf_staging_override_investment;

ALTER TABLE investments RENAME TO investments_legacy;
ALTER TABLE portfolio_transactions RENAME TO portfolio_transactions_legacy;

ALTER TABLE watchlist ALTER COLUMN asset_class TYPE text USING asset_class::text;
ALTER TABLE investments_legacy ALTER COLUMN asset_class TYPE text USING asset_class::text;
ALTER TABLE portfolio_import_batches ALTER COLUMN default_asset_class TYPE text USING default_asset_class::text;
DROP TYPE asset_class;
CREATE TYPE asset_class AS ENUM ('stock','etf','crypto','real_estate','savings','bond');
ALTER TABLE watchlist ALTER COLUMN asset_class TYPE asset_class USING asset_class::asset_class;
ALTER TABLE investments_legacy ALTER COLUMN asset_class TYPE asset_class USING asset_class::asset_class;
ALTER TABLE portfolio_import_batches ALTER COLUMN default_asset_class TYPE asset_class USING default_asset_class::asset_class;

CREATE TABLE investments_base (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    price_provider price_provider DEFAULT 'manual',
    price_provider_id VARCHAR(200),
    price_provider_url VARCHAR(500),
    price_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    price_provider_latest_url VARCHAR(500),
    price_provider_latest_path VARCHAR(300),
    price_provider_history_url VARCHAR(500),
    price_provider_history_path VARCHAR(300),
    price_provider_history_ts_path VARCHAR(300),
    price_provider_history_price_path VARCHAR(300)
);
CREATE TABLE stock_investments (id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass), symbol VARCHAR(20), current_price NUMERIC(18,6), PRIMARY KEY (id)) INHERITS (investments_base);
CREATE TABLE etf_investments (id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass), symbol VARCHAR(20), current_price NUMERIC(18,6), PRIMARY KEY (id)) INHERITS (investments_base);
CREATE TABLE crypto_investments (id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass), symbol VARCHAR(50), current_price NUMERIC(18,6), PRIMARY KEY (id)) INHERITS (investments_base);
CREATE TABLE metals_investments (id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass), symbol VARCHAR(20), current_price NUMERIC(18,6), PRIMARY KEY (id)) INHERITS (investments_base);
CREATE TABLE real_estate_investments (id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass), current_price NUMERIC(18,6), location VARCHAR(300), municipality VARCHAR(200), cadastral_income NUMERIC(12,2), municipality_tax_rate NUMERIC(8,4), PRIMARY KEY (id)) INHERITS (investments_base);
CREATE TABLE savings_investments (id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass), current_price NUMERIC(18,6), interest_rate NUMERIC(8,4), PRIMARY KEY (id)) INHERITS (investments_base);
CREATE TABLE bond_investments (id INTEGER NOT NULL DEFAULT nextval('investments_base_id_seq'::regclass), current_price NUMERIC(18,6), interest_rate NUMERIC(8,4), maturity_date DATE, PRIMARY KEY (id)) INHERITS (investments_base);

CREATE TABLE portfolio_transactions_base (
    id SERIAL PRIMARY KEY,
    investment_id INTEGER NOT NULL,
    type portfolio_txn_type NOT NULL,
    date DATE NOT NULL,
    amount NUMERIC(18,4) NOT NULL,
    fees NUMERIC(18,4) DEFAULT 0,
    taxes NUMERIC(18,4) DEFAULT 0,
    currency VARCHAR(10) NOT NULL DEFAULT 'EUR',
    note TEXT,
    is_recurring BOOLEAN NOT NULL DEFAULT false,
    recurrence_interval recurrence_interval,
    recurrence_end_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fx_rate_to_eur NUMERIC(20,10)
);
CREATE TABLE stock_transactions (id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass), investment_id INTEGER NOT NULL, units NUMERIC(18,8), price_per_unit NUMERIC(18,6), PRIMARY KEY (id)) INHERITS (portfolio_transactions_base);
CREATE TABLE etf_transactions (id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass), investment_id INTEGER NOT NULL, units NUMERIC(18,8), price_per_unit NUMERIC(18,6), PRIMARY KEY (id)) INHERITS (portfolio_transactions_base);
CREATE TABLE crypto_transactions (id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass), investment_id INTEGER NOT NULL, units NUMERIC(18,8), price_per_unit NUMERIC(18,6), PRIMARY KEY (id)) INHERITS (portfolio_transactions_base);
CREATE TABLE metals_transactions (id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass), investment_id INTEGER NOT NULL, units NUMERIC(18,8), price_per_unit NUMERIC(18,6), PRIMARY KEY (id)) INHERITS (portfolio_transactions_base);
CREATE TABLE real_estate_transactions (id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass), investment_id INTEGER NOT NULL, PRIMARY KEY (id)) INHERITS (portfolio_transactions_base);
CREATE TABLE savings_transactions (id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass), investment_id INTEGER NOT NULL, PRIMARY KEY (id)) INHERITS (portfolio_transactions_base);
CREATE TABLE bond_transactions (id INTEGER NOT NULL DEFAULT nextval('portfolio_transactions_base_id_seq'::regclass), investment_id INTEGER NOT NULL, PRIMARY KEY (id)) INHERITS (portfolio_transactions_base);

CREATE INDEX idx_investments_base_is_active ON investments_base(is_active);
CREATE INDEX idx_portfolio_transactions_base_investment_id ON portfolio_transactions_base(investment_id);
CREATE INDEX idx_portfolio_transactions_base_date ON portfolio_transactions_base(date);

CREATE VIEW investments AS
SELECT
    ib.id, ib.name,
    CASE
        WHEN si.id IS NOT NULL THEN 'stock'
        WHEN ei.id IS NOT NULL THEN 'etf'
        WHEN ci.id IS NOT NULL THEN 'crypto'
        WHEN mi.id IS NOT NULL THEN 'metals'
        WHEN rei.id IS NOT NULL THEN 'real_estate'
        WHEN savi.id IS NOT NULL THEN 'savings'
        WHEN bi.id IS NOT NULL THEN 'bond'
    END as asset_class,
    ib.currency, ib.notes, ib.is_active, ib.price_provider, ib.price_provider_id,
    ib.price_provider_url, ib.price_updated_at, ib.created_at, ib.updated_at,
    COALESCE(si.symbol, ei.symbol, ci.symbol, mi.symbol) as symbol,
    COALESCE(si.current_price, ei.current_price, ci.current_price, mi.current_price, rei.current_price, savi.current_price, bi.current_price) as current_price,
    savi.interest_rate as interest_rate,
    bi.maturity_date as maturity_date,
    rei.location as location, rei.municipality as municipality,
    rei.cadastral_income as cadastral_income, rei.municipality_tax_rate as municipality_tax_rate,
    ib.price_provider_latest_url, ib.price_provider_latest_path,
    ib.price_provider_history_url, ib.price_provider_history_path,
    ib.price_provider_history_ts_path, ib.price_provider_history_price_path
FROM investments_base ib
LEFT JOIN stock_investments si ON ib.id = si.id
LEFT JOIN etf_investments ei ON ib.id = ei.id
LEFT JOIN crypto_investments ci ON ib.id = ci.id
LEFT JOIN metals_investments mi ON ib.id = mi.id
LEFT JOIN real_estate_investments rei ON ib.id = rei.id
LEFT JOIN savings_investments savi ON ib.id = savi.id
LEFT JOIN bond_investments bi ON ib.id = bi.id;

CREATE VIEW portfolio_transactions AS
SELECT
    ptb.id, ptb.investment_id, ptb.type, ptb.date, ptb.amount,
    COALESCE(st.units, et.units, ct.units, mt.units) as units,
    COALESCE(st.price_per_unit, et.price_per_unit, ct.price_per_unit, mt.price_per_unit) as price_per_unit,
    ptb.fees, ptb.taxes, ptb.currency, ptb.note, ptb.is_recurring,
    ptb.recurrence_interval, ptb.recurrence_end_date, ptb.created_at, ptb.updated_at,
    ptb.fx_rate_to_eur
FROM portfolio_transactions_base ptb
LEFT JOIN stock_transactions st ON ptb.id = st.id
LEFT JOIN etf_transactions et ON ptb.id = et.id
LEFT JOIN crypto_transactions ct ON ptb.id = ct.id
LEFT JOIN metals_transactions mt ON ptb.id = mt.id;

CREATE OR REPLACE FUNCTION investments_view_update_instead()
RETURNS trigger AS $$
BEGIN
    UPDATE investments_base
       SET name = NEW.name, currency = NEW.currency, notes = NEW.notes,
           is_active = NEW.is_active, price_updated_at = NEW.price_updated_at
     WHERE id = OLD.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER update_investments_view_instead
    INSTEAD OF UPDATE ON investments
    FOR EACH ROW EXECUTE FUNCTION investments_view_update_instead();
COMMIT;
`;

// Seeded through the child tables, exactly like the legacy write paths did.
// Includes the pathologies the conversion must handle: a bond interest_rate
// the legacy view never exposed, a dangling account_id / import_batch_id on
// child rows (the base-table FK never bound children), an orphan
// asset_price_history row, and dangling staging-row investment references.
const SEED_SQL = `
BEGIN;
INSERT INTO accounts (id, name, display_name) VALUES (1, 'IBKR', 'Interactive Brokers'), (2, 'Degiro', 'Degiro');
SELECT setval(pg_get_serial_sequence('accounts','id'), 10, false);

INSERT INTO stock_investments (id, name, currency, is_active, price_provider, symbol, current_price, price_provider_latest_url)
VALUES (1, 'Apple Inc', 'USD', true, 'yahoo', 'AAPL', 227.25, 'https://example.com/aapl');
INSERT INTO etf_investments (id, name, currency, is_active, symbol, current_price) VALUES (2, 'VWCE', 'EUR', true, 'VWCE', 132.50);
INSERT INTO crypto_investments (id, name, currency, is_active, symbol, current_price) VALUES (3, 'Bitcoin', 'EUR', true, 'BTC', 91000.123456);
INSERT INTO metals_investments (id, name, currency, is_active, symbol, current_price) VALUES (4, 'Gold', 'EUR', true, 'XAU', 2500.75);
INSERT INTO real_estate_investments (id, name, currency, is_active, current_price, location, municipality, cadastral_income, municipality_tax_rate)
VALUES (5, 'Antwerp Apartment', 'EUR', true, 320000, 'Antwerp', 'Antwerpen', 1250.50, 2.9500);
INSERT INTO savings_investments (id, name, currency, is_active, current_price, interest_rate) VALUES (6, 'Savings', 'EUR', true, 15000, 2.1500);
INSERT INTO bond_investments (id, name, currency, is_active, current_price, interest_rate, maturity_date)
VALUES (7, 'State Bond 2027', 'EUR', true, 10000, 3.3000, '2027-09-04');
SELECT setval('investments_base_id_seq', 7, true);

INSERT INTO stock_transactions (id, investment_id, type, date, amount, fees, currency, fx_rate_to_eur, account_id, units, price_per_unit)
VALUES (1, 1, 'buy', '2025-01-15', 4545.00, 1.00, 'USD', 0.9210000000, 1, 20.00000000, 227.250000),
       (2, 1, 'sell', '2025-11-20', 1136.25, 1.00, 'USD', NULL, 1, 5.00000000, 227.250000);
INSERT INTO etf_transactions (id, investment_id, type, date, amount, currency, is_recurring, recurrence_interval, account_id, units, price_per_unit)
VALUES (3, 2, 'buy', '2025-03-01', 1325.00, 'EUR', true, 'monthly', 2, 10.00000000, 132.500000);
INSERT INTO crypto_transactions (id, investment_id, type, date, amount, currency, units, price_per_unit)
VALUES (4, 3, 'buy', '2025-05-10', 4550.01, 'EUR', 0.05000000, 91000.123456);
INSERT INTO metals_transactions (id, investment_id, type, date, amount, currency, account_id, units, price_per_unit)
VALUES (5, 4, 'buy', '2025-02-14', 2500.75, 'EUR', 999, 1.00000000, 2500.750000);
INSERT INTO real_estate_transactions (id, investment_id, type, date, amount, currency) VALUES (6, 5, 'buy', '2024-07-01', 320000.00, 'EUR');
INSERT INTO savings_transactions (id, investment_id, type, date, amount, currency) VALUES (7, 6, 'interest', '2025-12-31', 322.50, 'EUR');
INSERT INTO bond_transactions (id, investment_id, type, date, amount, currency) VALUES (8, 7, 'buy', '2024-09-04', 10000.00, 'EUR');
SELECT setval('portfolio_transactions_base_id_seq', 8, true);

INSERT INTO portfolio_import_batches (id, adapter_name, status, rows_total, rows_imported) VALUES (41, 'ibkr_csv', 'complete', 1, 1);
SELECT setval(pg_get_serial_sequence('portfolio_import_batches','id'), 50, false);
UPDATE stock_transactions SET import_batch_id = 41 WHERE id = 1;
UPDATE etf_transactions SET import_batch_id = 77777 WHERE id = 3;

INSERT INTO asset_price_history (investment_id, price_date, close_price, source)
VALUES (1, '2026-07-31', 227.25, 'provider'), (9999, '2026-07-31', 1.00, 'provider');

INSERT INTO portfolio_import_staging_rows (batch_id, row_index, status, resolved_investment_id, user_override_investment_id)
VALUES (41, 0, 'committed', 1, NULL), (41, 1, 'error', 8888, 7777);

INSERT INTO investment_ticker_prefs (investment_id, show_in_ticker) VALUES (3, false);
COMMIT;
`;

const haveDb = hasTestDatabase();

describe.skipIf(!haveDb)('ADR-109 conversion migration (0087)', () => {
  beforeAll(async () => {
    const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? '');
    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${scratchDbName()}`);
    await admin.end();

    db = new pg.Client({ connectionString: scratchUrl() });
    await db.connect();
    // Same preflight db-migrate performs: modern revision ids overflow the
    // VARCHAR(32) alembic would otherwise create.
    await q('CREATE TABLE alembic_version (version_num VARCHAR(64) NOT NULL, CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))');

    await alembic('upgrade', REV_BEFORE_LEGACY_BRANCHES);
    await q(LEGACYIZE_SQL);
    // The real 0052/0061/0079/0086 now run their legacy (inheritance) branches.
    await alembic('upgrade', REV_BEFORE_CONVERSION);
    await q(SEED_SQL);
  }, 180_000);

  afterAll(async () => {
    if (db) await db.end();
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratchDbName()} WITH (FORCE)`);
    await admin.end();
  });

  /**
   * Run the conversion against a corrupted legacy state and assert it refuses
   * with the curated pre-flight error, leaving the database untouched at 0086
   * with the legacy view still working.
   */
  async function expectUpgradeRefused(pattern) {
    let err = null;
    try {
      await alembic('upgrade', 'head');
    } catch (e) {
      err = e;
    }
    expect(err, 'expected alembic upgrade to be refused by the pre-flight').not.toBeNull();
    expect(`${err.stderr ?? ''}\n${err.stdout ?? ''}\n${err.message ?? ''}`).toMatch(pattern);
    // Untouched at 0086: still the legacy shape, and the legacy views still answer
    // (row counts are asserted per-case — the injected corruption itself can
    // legitimately change what the view shows until it is cleaned up).
    expect(await scalar('SELECT version_num FROM alembic_version')).toBe(REV_BEFORE_CONVERSION);
    expect(await scalar("SELECT relkind::text FROM pg_class WHERE oid = to_regclass('public.investments')")).toBe('v');
    expect(await scalar("SELECT to_regclass('public.legacy_inh_investments_base')")).toBeNull();
    expect(Number(await scalar('SELECT count(*) FROM investments'))).toBeGreaterThanOrEqual(7);
    expect(Number(await scalar('SELECT count(*) FROM portfolio_transactions'))).toBeGreaterThanOrEqual(8);
  }

  it('data pre-flight refuses corrupt legacy states with actionable errors, leaving 0086 intact', async () => {
    // (a) crypto symbol longer than the canonical VARCHAR(20) (legacy child is VARCHAR(50)).
    await q("UPDATE crypto_investments SET symbol = 'BTC-EXTREMELY-LONG-TICKER' WHERE id = 3");
    await expectUpgradeRefused(/ADR-109 conversion: crypto investment symbol\(s\) longer than 20 characters[\s\S]*crypto_investments id 3 symbol 'BTC-EXTREMELY-LONG-TICKER'/);
    await q("UPDATE crypto_investments SET symbol = 'BTC' WHERE id = 3");

    // (b) same id present in two transaction child tables (reachable organically from a
    //     behind-max sequence resync + one ordinary insert into another child).
    await q("INSERT INTO etf_transactions (id, investment_id, type, date, amount, currency) VALUES (1, 2, 'buy', '2026-01-01', 1, 'EUR')");
    await expectUpgradeRefused(/ADR-109 conversion: portfolio transaction id\(s\) 1 exist in more than one asset-class child table/);
    await q('DELETE FROM etf_transactions WHERE id = 1');

    // (c) base-only investments_base row with no child — no asset_class to convert with;
    //     the error must say the refusal is by design and what to do.
    await q("INSERT INTO investments_base (id, name) VALUES (99, 'orphan base row')");
    await expectUpgradeRefused(/ADR-109 conversion: investments_base row\(s\) 99 have no asset-class child row[\s\S]*deliberately refuses/);
    await q('DELETE FROM ONLY investments_base WHERE id = 99');
  }, 180_000);

  it('converts, preserves every row, enforces the FKs, rolls back, and re-converts', async () => {
    // Sanity: the constructed database really is legacy-shaped.
    expect(await scalar("SELECT relkind::text FROM pg_class WHERE oid = to_regclass('public.investments')")).toBe('v');
    expect(await scalar("SELECT 'metals' = ANY(enum_range(NULL::asset_class)::text[])")).toBe(false);

    // Legacy investments sequence runs AHEAD of the surviving rows (top rows were
    // deleted on this hypothetical install): the conversion must not re-issue
    // ids the legacy install already used.
    await q("SELECT setval('investments_base_id_seq', 500)");

    // ------------------------------------------------------------------ upgrade
    await alembic('upgrade', 'head');

    // Flat tables took the canonical names; legacy relations renamed aside.
    expect(await scalar("SELECT relkind::text FROM pg_class WHERE oid = to_regclass('public.investments')")).toBe('r');
    expect(await scalar("SELECT relkind::text FROM pg_class WHERE oid = to_regclass('public.portfolio_transactions')")).toBe('r');
    expect(await scalar("SELECT to_regclass('public.legacy_inh_investments_base') IS NOT NULL")).toBe(true);
    expect(await scalar("SELECT to_regclass('public.investments_base')")).toBeNull();

    // Row-for-row parity against the renamed legacy view (which still reads the
    // renamed inheritance tables) — every column the view exposes.
    expect(Number(await scalar(`
      SELECT count(*) FROM (
        SELECT id, name, asset_class::text, currency, notes, is_active, symbol, current_price,
               maturity_date, location, municipality, cadastral_income, municipality_tax_rate,
               created_at, updated_at
        FROM investments
        EXCEPT
        SELECT id, name, asset_class::text, currency, notes, is_active, symbol, current_price,
               maturity_date, location, municipality, cadastral_income, municipality_tax_rate,
               created_at, updated_at
        FROM legacy_inh_investments) d`))).toBe(0);
    expect(Number(await scalar('SELECT count(*) FROM investments'))).toBe(7);
    expect(Number(await scalar(`
      SELECT count(*) FROM (
        SELECT id, investment_id, type::text, date, amount, units, price_per_unit, fees, taxes,
               currency, note, is_recurring, recurrence_interval::text, recurrence_end_date,
               created_at, updated_at, fx_rate_to_eur,
               CASE WHEN id = 5 THEN NULL ELSE account_id END,
               CASE WHEN id = 3 THEN NULL ELSE import_batch_id END
        FROM legacy_inh_portfolio_transactions
        EXCEPT
        SELECT id, investment_id, type::text, date, amount, units, price_per_unit, fees, taxes,
               currency, note, is_recurring, recurrence_interval::text, recurrence_end_date,
               created_at, updated_at, fx_rate_to_eur, account_id, import_batch_id
        FROM portfolio_transactions) d`))).toBe(0);
    expect(Number(await scalar('SELECT count(*) FROM portfolio_transactions'))).toBe(8);

    // The bond interest_rate the legacy VIEW never exposed is preserved from the child table.
    expect(Number(await scalar('SELECT interest_rate FROM investments WHERE id = 7'))).toBe(3.3);
    expect(await scalar('SELECT interest_rate FROM legacy_inh_investments WHERE id = 7')).toBeNull();

    // Dangling links (unenforceable on legacy children) were nulled; valid ones kept.
    expect(await scalar('SELECT account_id FROM portfolio_transactions WHERE id = 5')).toBeNull();
    expect(await scalar('SELECT import_batch_id FROM portfolio_transactions WHERE id = 3')).toBeNull();
    expect(Number(await scalar('SELECT account_id FROM portfolio_transactions WHERE id = 1'))).toBe(1);
    expect(Number(await scalar('SELECT import_batch_id FROM portfolio_transactions WHERE id = 1'))).toBe(41);

    // Sequences: GREATEST(legacy sequence's next value, MAX(id)+1). The investments
    // side had its legacy sequence pushed AHEAD to 500 → next id is 501, never a
    // reused one; the portfolio side's high-water mark is MAX(id)+1 = 9. (Read
    // non-consumingly — later FK-violation INSERTs below burn nextval values.)
    expect(Number(await scalar(`
      SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END
        FROM portfolio_transactions_flat_id_seq`))).toBe(9);
    const inserted = await q(
      "INSERT INTO investments (name, asset_class, currency, symbol) VALUES ('New', 'metals', 'EUR', 'XAG') RETURNING id",
    );
    expect(inserted.rows[0].id).toBe(501);
    // updated_at trigger reattached.
    await q('UPDATE investments SET current_price = 1 WHERE id = 501');
    expect(await scalar('SELECT updated_at > created_at FROM investments WHERE id = 501')).toBe(true);
    await q('DELETE FROM investments WHERE id = 501');

    // The FKs the view shape could never hold are real now — and enforced.
    // contype 'n' (per-column NOT NULL) exists only on PG >= 18; exclude it so
    // the exact list is portable across the PG 16 (local) / 18 (CI) split.
    const cons = (await q(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'portfolio_transactions'::regclass AND contype <> 'n' ORDER BY conname",
    )).rows.map((r) => r.conname);
    expect(cons).toEqual([
      'portfolio_transactions_account_id_fkey',
      'portfolio_transactions_import_batch_id_fkey',
      'portfolio_transactions_investment_id_fkey',
      'portfolio_transactions_pkey',
    ]);
    // On PG >= 18 the catalogued NOT NULL constraints are minted with the
    // transient *_flat table name; 0087 renames them to the fresh-install
    // names. No constraint on either canonical table may keep a _flat_ name.
    const flatNamed = await scalar(
      "SELECT count(*)::int FROM pg_constraint WHERE conrelid IN ('investments'::regclass, 'portfolio_transactions'::regclass) AND conname LIKE '%\\_flat\\_%'",
    );
    expect(flatNamed).toBe(0);
    await expect(
      q("INSERT INTO portfolio_transactions (investment_id, type, date, amount) VALUES (4242, 'buy', '2026-01-01', 1)"),
    ).rejects.toThrow(/portfolio_transactions_investment_id_fkey/);
    await expect(q('DELETE FROM accounts WHERE id = 1')).rejects.toThrow(/portfolio_transactions_account_id_fkey/);

    // 0026/0040 parity: orphan price row deleted, staging FKs added with dangling refs nulled.
    expect(Number(await scalar('SELECT count(*) FROM asset_price_history'))).toBe(1);
    expect(await scalar('SELECT resolved_investment_id FROM portfolio_import_staging_rows WHERE row_index = 1')).toBeNull();
    expect(Number(await scalar('SELECT resolved_investment_id FROM portfolio_import_staging_rows WHERE row_index = 0'))).toBe(1);

    // The enum gained 'metals' (the flat asset_class column needs it).
    expect(await scalar("SELECT 'metals' = ANY(enum_range(NULL::asset_class)::text[])")).toBe(true);

    // The 0061 side table is untouched.
    expect(await scalar('SELECT show_in_ticker FROM investment_ticker_prefs WHERE investment_id = 3')).toBe(false);

    // ---------------------------------------------------------------- downgrade
    // Back to the revision BEFORE the conversion (not `-1`: head has moved past
    // 0087 — e.g. 0088's money-precision alignment — and those later downgrades
    // must also unwind for the legacy shape to be restorable).
    await alembic('downgrade', REV_BEFORE_CONVERSION);

    expect(await scalar("SELECT relkind::text FROM pg_class WHERE oid = to_regclass('public.investments')")).toBe('v');
    expect(await scalar("SELECT to_regclass('public.investments_base') IS NOT NULL")).toBe(true);
    expect(Number(await scalar('SELECT count(*) FROM pg_class WHERE relname LIKE $1', ['legacy\\_inh\\_%']))).toBe(0);
    expect(Number(await scalar('SELECT count(*) FROM pg_constraint WHERE conname LIKE $1', ['legacy\\_inh\\_%']))).toBe(0);
    // Data readable through the restored view, dangling links back as they were.
    expect(Number(await scalar('SELECT count(*) FROM investments'))).toBe(7);
    expect(Number(await scalar('SELECT count(*) FROM portfolio_transactions'))).toBe(8);
    expect(Number(await scalar('SELECT account_id FROM portfolio_transactions WHERE id = 5'))).toBe(999);
    // The canonical PK name went back to the pre-0013 snapshot it came from.
    expect(await scalar(
      "SELECT c.relname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid WHERE i.relname = 'investments_pkey'",
    )).toBe('investments_legacy');

    // --------------------------------------------------------------- re-upgrade
    await alembic('upgrade', 'head');
    expect(await scalar("SELECT relkind::text FROM pg_class WHERE oid = to_regclass('public.investments')")).toBe('r');
    expect(Number(await scalar('SELECT count(*) FROM investments'))).toBe(7);
    expect(Number(await scalar('SELECT count(*) FROM portfolio_transactions'))).toBe(8);
  }, 180_000);

  it('is a strict no-op on a database that is already flat', async () => {
    // The conversion already ran above; running the chain again must change nothing.
    const before = await scalar(
      "SELECT md5(string_agg(c.relname || ':' || c.relkind::text, ',' ORDER BY c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'",
    );
    await alembic('upgrade', 'head');
    const after = await scalar(
      "SELECT md5(string_agg(c.relname || ':' || c.relkind::text, ',' ORDER BY c.relname)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'",
    );
    expect(after).toBe(before);
  });
});
