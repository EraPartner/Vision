#!/bin/bash

###############################################################################
# Check Local PostgreSQL Server Status (Project Root)
###############################################################################

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
POSTGRES_DATA_DIR="$PROJECT_ROOT/postgres_data"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

if ! command -v pg_ctl >/dev/null 2>&1; then
    echo "${RED}✗${NC} pg_ctl not found in PATH"
    exit 1
fi

if [ ! -d "$POSTGRES_DATA_DIR/base" ]; then
    echo "${RED}✗${NC} PostgreSQL data directory not found!"
    echo "Run ./scripts/db/setup_postgres.sh first to initialize"
    exit 1
fi

echo "${BLUE}Local PostgreSQL Server Status:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
pg_ctl -D "$POSTGRES_DATA_DIR" status || echo "${RED}✗${NC} Server is not running"

if pg_ctl -D "$POSTGRES_DATA_DIR" status >/dev/null 2>&1; then
    echo ""
    echo "${BLUE}Database Information:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    if command -v psql >/dev/null 2>&1; then
        psql -h localhost -p 5433 -d postgres -U "$(whoami)" -c "SELECT datname AS database, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database WHERE datname NOT IN ('template0', 'template1', 'postgres') ORDER BY datname;"
    else
        echo "psql not found in PATH; skipping database listing."
    fi
fi
