#!/bin/bash

###############################################################################
# Start Local PostgreSQL Server (Project Root)
###############################################################################

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
POSTGRES_DATA_DIR="$PROJECT_ROOT/postgres_data"
POSTGRES_LOG="$POSTGRES_DATA_DIR/postgres.log"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

if ! command -v pg_ctl >/dev/null 2>&1; then
    echo "${RED}✗${NC} pg_ctl not found in PATH"
    echo "Install PostgreSQL first (or add pg_ctl to PATH)."
    exit 1
fi

if [ ! -d "$POSTGRES_DATA_DIR/base" ]; then
    echo "${RED}✗${NC} PostgreSQL data directory not found!"
    echo "Run ./scripts/db/setup_postgres.sh first to initialize"
    exit 1
fi

if pg_ctl -D "$POSTGRES_DATA_DIR" status >/dev/null 2>&1; then
    echo "${YELLOW}⚠${NC} PostgreSQL server is already running"
    pg_ctl -D "$POSTGRES_DATA_DIR" status
else
    echo "Starting local PostgreSQL server..."
    pg_ctl -D "$POSTGRES_DATA_DIR" -l "$POSTGRES_LOG" start -w -t 10

    if pg_ctl -D "$POSTGRES_DATA_DIR" status >/dev/null 2>&1; then
        echo "${GREEN}✓${NC} PostgreSQL server started successfully"
        echo "  Port: 5433"
        echo "  Log: $POSTGRES_LOG"
    else
        echo "${RED}✗${NC} Failed to start PostgreSQL server"
        echo "Check log: $POSTGRES_LOG"
        exit 1
    fi
fi
