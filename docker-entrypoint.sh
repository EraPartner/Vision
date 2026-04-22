#!/bin/sh
# Docker entrypoint for Vision app container
# Runs Alembic migrations before starting the backend

set -e

echo "[entrypoint] Starting Vision app container..."

# Use venv Python
VENV_PYTHON="/venv/bin/python3"

# Wait for database to be ready using Python/psycopg2
MAX_ATTEMPTS=30
echo "[entrypoint] Waiting for database to be ready..."

$VENV_PYTHON -c "
import os
import sys
import time
import psycopg2

def wait_for_db():
    host = os.environ.get('DB_HOST', 'db')
    port = os.environ.get('DB_PORT', '5432')
    user = os.environ.get('DB_USER', 'ftm_user')
    password = os.environ.get('DB_PASSWORD', os.environ.get('POSTGRES_PASSWORD', ''))
    dbname = os.environ.get('DB_NAME', 'financial_transactions')

    for attempt in range(1, $MAX_ATTEMPTS + 1):
        try:
            conn = psycopg2.connect(
                host=host, port=port, user=user, password=password, dbname=dbname,
                connect_timeout=3
            )
            conn.close()
            print('[entrypoint] Database is ready!')
            sys.exit(0)
        except psycopg2.OperationalError as e:
            print(f'[entrypoint] Waiting for database... (attempt {attempt}/$MAX_ATTEMPTS)')
            if attempt == $MAX_ATTEMPTS:
                print(f'[entrypoint] ERROR: Database did not become ready: {e}')
                sys.exit(1)
            time.sleep(1)

wait_for_db()
"

echo "[entrypoint] Running Alembic migrations..."
cd /app

# Check whether alembic_version exists.
# If missing, we are on a fresh DB — alembic upgrade head will bootstrap schema
# from the 0001 baseline (ADR-027: Alembic is the single source of schema DDL).
ALEMBIC_VERSION_EXISTS=$($VENV_PYTHON -c "
import os
import psycopg2

conn = psycopg2.connect(
    host=os.environ.get('DB_HOST', 'db'),
    port=os.environ.get('DB_PORT', '5432'),
    user=os.environ.get('DB_USER', 'ftm_user'),
    password=os.environ.get('DB_PASSWORD', os.environ.get('POSTGRES_PASSWORD', '')),
    database=os.environ.get('DB_NAME', 'financial_transactions')
)
cur = conn.cursor()
cur.execute(\"\"\"
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'alembic_version'
    )
\"\"\")
exists = cur.fetchone()[0]
cur.close()
conn.close()
print('1' if exists else '0')
")

if [ "$ALEMBIC_VERSION_EXISTS" = "1" ]; then
    # Fix alembic_version column size if needed (for long revision IDs)
    $VENV_PYTHON -c "
import os
import psycopg2

def fix_alembic_version_column():
    try:
        conn = psycopg2.connect(
            host=os.environ.get('DB_HOST', 'db'),
            port=os.environ.get('DB_PORT', '5432'),
            user=os.environ.get('DB_USER', 'ftm_user'),
            password=os.environ.get('DB_PASSWORD', os.environ.get('POSTGRES_PASSWORD', '')),
            database=os.environ.get('DB_NAME', 'financial_transactions')
        )
        cur = conn.cursor()
        cur.execute(\"\"\"
            SELECT character_maximum_length
            FROM information_schema.columns
            WHERE table_name = 'alembic_version' AND column_name = 'version_num'
        \"\"\")
        result = cur.fetchone()
        if result and result[0] < 64:
            print(f'[entrypoint] Expanding alembic_version.version_num from {result[0]} to 64...')
            cur.execute('ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(64)')
            conn.commit()
            print('[entrypoint] Column expanded successfully')
        cur.close()
        conn.close()
    except Exception as e:
        print(f'[entrypoint] Warning: Could not fix alembic_version column: {e}')

fix_alembic_version_column()
" 2>/dev/null || true

    # Legacy-rev reconciliation (ADR-027 port).
    # Pre-port DBs are stamped with revisions now moved to alembic/legacy_versions/
    # (e.g. 0031_ai_chat_tables). The legacy chain and the new 0001_initial
    # baseline describe the same schema, so stamp forward without running DDL.
    CURRENT_REV_DB=$($VENV_PYTHON -c "
import os, psycopg2
conn = psycopg2.connect(
    host=os.environ.get('DB_HOST','db'),
    port=os.environ.get('DB_PORT','5432'),
    user=os.environ.get('DB_USER','ftm_user'),
    password=os.environ.get('DB_PASSWORD', os.environ.get('POSTGRES_PASSWORD','')),
    database=os.environ.get('DB_NAME','financial_transactions')
)
cur = conn.cursor()
cur.execute('SELECT version_num FROM alembic_version LIMIT 1')
row = cur.fetchone()
print(row[0] if row else '')
cur.close()
conn.close()
" 2>/dev/null)

    if [ -n "$CURRENT_REV_DB" ] && [ "$CURRENT_REV_DB" != "0001_initial" ]; then
        if [ -f "alembic/legacy_versions/${CURRENT_REV_DB}.py" ]; then
            echo "[entrypoint] Legacy alembic rev '$CURRENT_REV_DB' detected; rewriting alembic_version to 0001_initial (ADR-027)."
            # `alembic stamp` validates the current rev against versions/, which
            # fails for legacy ids. Rewrite the row directly — schema is already
            # equivalent to the 0001_initial baseline.
            $VENV_PYTHON -c "
import os, psycopg2
conn = psycopg2.connect(
    host=os.environ.get('DB_HOST','db'),
    port=os.environ.get('DB_PORT','5432'),
    user=os.environ.get('DB_USER','ftm_user'),
    password=os.environ.get('DB_PASSWORD', os.environ.get('POSTGRES_PASSWORD','')),
    database=os.environ.get('DB_NAME','financial_transactions')
)
cur = conn.cursor()
cur.execute(\"UPDATE alembic_version SET version_num = '0001_initial'\")
conn.commit()
cur.close()
conn.close()
print('[entrypoint] alembic_version rewritten to 0001_initial')
" || {
                echo "[entrypoint] ERROR: failed to rewrite alembic_version"
                exit 1
            }
        fi
    fi

    # Skip Alembic upgrade when already at head — saves ~1-3s on warm boots.
    CURRENT_REV=$($VENV_PYTHON -m alembic -c config/alembic.ini current 2>/dev/null | awk 'NR==1 {print $1}')
    HEAD_REV=$($VENV_PYTHON -m alembic -c config/alembic.ini heads 2>/dev/null | awk 'NR==1 {print $1}')
    if [ -n "$CURRENT_REV" ] && [ -n "$HEAD_REV" ] && [ "$CURRENT_REV" = "$HEAD_REV" ]; then
        echo "[entrypoint] Alembic already at head ($CURRENT_REV); skipping upgrade."
    else
        echo "[entrypoint] Running: $VENV_PYTHON -m alembic -c config/alembic.ini upgrade head"
        $VENV_PYTHON -m alembic -c config/alembic.ini upgrade head || {
            echo "[entrypoint] ERROR: Alembic migration failed"
            exit 1
        }
    fi
else
    echo "[entrypoint] alembic_version not found; running alembic upgrade head on fresh DB."
    $VENV_PYTHON -m alembic -c config/alembic.ini upgrade head || {
        echo "[entrypoint] ERROR: Alembic bootstrap failed on fresh DB"
        exit 1
    }
fi

echo "[entrypoint] Starting backend application..."
exec bun run apps/node-backend/src/main.js
