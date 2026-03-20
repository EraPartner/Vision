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
        # Check current column size
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

# Run Alembic upgrade
echo "[entrypoint] Running: $VENV_PYTHON -m alembic -c config/alembic.ini upgrade head"
$VENV_PYTHON -m alembic -c config/alembic.ini upgrade head || {
    echo "[entrypoint] Warning: Alembic migration failed (may be non-fatal if already applied)"
    # Don't exit - let the app start anyway, schemaInit.js will handle it
}

echo "[entrypoint] Starting backend application..."
exec bun run apps/node-backend/src/main.js
