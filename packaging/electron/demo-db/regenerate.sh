#!/usr/bin/env bash
# Regenerate packaging/electron/demo-db/01-demo.sql from generate.mjs against a
# HEAD-migrated schema, fully isolated from your real Vision database.
#
# Why this exists: generate.mjs only emits the synthetic *data*. To bake it into a
# Postgres image we need it sitting on the real, migrated schema. This spins up a
# throwaway Postgres, runs Vision's guarded migration runner to head, loads the data (the ADR-088
# dual-write trigger resolves each transaction's account_id onto the typed accounts
# the generator pre-creates), then dumps schema + data.
#
# The dump disables triggers on restore (`pg_dump --data-only --disable-triggers`):
# the baked image reloads the data with the dual-write trigger present, and without
# this the trigger would re-create bare placeholder accounts (and collide on the
# UNIQUE account name) depending on table load order. Disabling triggers on reload
# loads the already-correct account_id values verbatim.
#
# Usage:  packaging/electron/demo-db/regenerate.sh
# Env:    REGEN_PORT (host port for the throwaway DB, default 55432)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DEMO_DB_DIR="$REPO/packaging/electron/demo-db"
OUT="$DEMO_DB_DIR/01-demo.sql"
CTN="vision-demo-regen-$$"
PORT="${REGEN_PORT:-55432}"
URL="postgresql://ftm_user:ftm_password@localhost:${PORT}/financial_transactions"
export PGPASSWORD=ftm_password

# Prefer the Homebrew postgresql@18 client (matches the demo DB's server major),
# but fall back to whatever psql/pg_dump is on PATH so this also runs on
# non-Homebrew hosts. Override PGBIN to point at a specific install.
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@18/bin}"
if [ -x "$PGBIN/psql" ] && [ -x "$PGBIN/pg_dump" ]; then
  PSQL="$PGBIN/psql"
  PGDUMP="$PGBIN/pg_dump"
else
  PSQL="$(command -v psql || true)"
  PGDUMP="$(command -v pg_dump || true)"
fi

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker required"; exit 1; }
[ -n "$PSQL" ] && [ -x "$PSQL" ] || { echo "ERROR: psql not found (set PGBIN or 'brew install postgresql@18')"; exit 1; }
[ -n "$PGDUMP" ] && [ -x "$PGDUMP" ] || { echo "ERROR: pg_dump not found (set PGBIN or 'brew install postgresql@18')"; exit 1; }

# Pick a working alembic: the repo venv if its interpreter resolves (it won't on the
# host when the venv was built inside the devcontainer), else a system alembic that can
# import psycopg2 / python-dotenv / sqlalchemy.
ALEMBIC="${ALEMBIC:-$REPO/venv/bin/alembic}"
if ! "$ALEMBIC" --version >/dev/null 2>&1; then ALEMBIC="$(command -v alembic || true)"; fi
[ -n "$ALEMBIC" ] && "$ALEMBIC" --version >/dev/null 2>&1 \
  || { echo "ERROR: no usable alembic (repo venv broken and no system alembic with psycopg2/python-dotenv/sqlalchemy)"; exit 1; }

# `-v` also drops the anonymous volume Docker auto-creates for postgres:18-alpine's
# declared VOLUME /var/lib/postgresql (we run it without a named mount). Without -v
# every regen run orphaned a ~50–95 MB throwaway data dir.
cleanup(){ docker rm -f -v "$CTN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> [1/6] throwaway Postgres ($CTN) on 127.0.0.1:$PORT"
docker run -d --name "$CTN" \
  -e POSTGRES_USER=ftm_user -e POSTGRES_PASSWORD=ftm_password -e POSTGRES_DB=financial_transactions \
  -p "127.0.0.1:${PORT}:5432" postgres:18-alpine >/dev/null
for i in $(seq 1 30); do
  docker exec "$CTN" pg_isready -U ftm_user -d financial_transactions >/dev/null 2>&1 && break
  sleep 1; [ "$i" -eq 30 ] && { echo "ERROR: Postgres did not become ready"; exit 1; }
done

echo "==> [2/6] guarded migration runner upgrade head ($ALEMBIC)"
# Pre-create alembic_version with a wide column. Alembic otherwise creates it as
# varchar(32) on first run, which truncates the long revision ids (e.g.
# 0003_import_batch_id_on_transactions = 36 chars). Empty table => alembic still
# migrates from base; the wider column is harmless (the baked DB boots already at
# head, so no migration runs at demo runtime).
"$PSQL" -q -h localhost -p "$PORT" -U ftm_user -d financial_transactions \
  -c "CREATE TABLE IF NOT EXISTS alembic_version (version_num VARCHAR(128) NOT NULL CONSTRAINT alembic_version_pkc PRIMARY KEY);"
( cd "$REPO" && DATABASE_URL="$URL" ALEMBIC_BIN="$ALEMBIC" bun run apps/node-backend/scripts/db-migrate.js upgrade head )

echo "==> [3/6] generate + load synthetic data"
node "$DEMO_DB_DIR/generate.mjs" > /tmp/vision-demo-data.sql
"$PSQL" -v ON_ERROR_STOP=1 -q -h localhost -p "$PORT" -U ftm_user -d financial_transactions -f /tmp/vision-demo-data.sql >/dev/null

echo "==> [4/6] dump schema + data (triggers disabled on restore)"
{
  "$PGDUMP" --schema-only --no-owner --no-privileges -h localhost -p "$PORT" -U ftm_user financial_transactions
  "$PGDUMP" --data-only --disable-triggers --no-owner --no-privileges -h localhost -p "$PORT" -U ftm_user financial_transactions
} > "$OUT"
echo "    wrote $OUT ($(wc -l < "$OUT" | tr -d ' ') lines)"

echo "==> [5/6] validate: reload the dump into a fresh database"
docker exec "$CTN" psql -q -U ftm_user -d postgres \
  -c "DROP DATABASE IF EXISTS regen_verify;" -c "CREATE DATABASE regen_verify;" >/dev/null
if ! "$PSQL" -v ON_ERROR_STOP=1 -q -h localhost -p "$PORT" -U ftm_user -d regen_verify -f "$OUT" >/tmp/vision-demo-verify.log 2>&1; then
  echo "ERROR: reload failed — tail of /tmp/vision-demo-verify.log:"; tail -25 /tmp/vision-demo-verify.log; exit 1
fi

echo "==> [6/6] sanity checks on the reloaded data"
chk(){ "$PSQL" -tA -h localhost -p "$PORT" -U ftm_user -d regen_verify -c "$1"; }
echo "    accounts:                 $(chk 'SELECT count(*) FROM accounts;') (expect 6)"
echo "    account types:            $(chk "SELECT string_agg(DISTINCT type::text, ',' ORDER BY type::text) FROM accounts;")"
echo "    txns linked to account:   $(chk 'SELECT count(*) FROM transactions WHERE account_id IS NOT NULL;') / $(chk 'SELECT count(*) FROM transactions;')"
echo "    holdings linked (lots):   $(chk 'SELECT count(*) FROM portfolio_transactions WHERE account_id IS NOT NULL;')"
echo "    liability balance (€):    $(chk "SELECT balance FROM transactions WHERE bank_account='KBC Woonkrediet' ORDER BY date DESC, id DESC LIMIT 1;")"
echo "    alembic_version:          $(chk 'SELECT version_num FROM alembic_version;')"
echo "==> done. 01-demo.sql is ready to bake into vision-demo-db."
