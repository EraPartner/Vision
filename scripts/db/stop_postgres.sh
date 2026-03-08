#!/bin/bash

###############################################################################
# Stop Local PostgreSQL Server (Project Root)
###############################################################################

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
POSTGRES_DATA_DIR="$PROJECT_ROOT/postgres_data"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

if ! command -v pg_ctl >/dev/null 2>&1; then
    echo "${RED}✗${NC} pg_ctl not found in PATH"
    exit 1
fi

if [ ! -d "$POSTGRES_DATA_DIR/base" ]; then
    echo "${RED}✗${NC} PostgreSQL data directory not found!"
    exit 1
fi

if ! pg_ctl -D "$POSTGRES_DATA_DIR" status >/dev/null 2>&1; then
    echo "${YELLOW}⚠${NC} PostgreSQL server is not running"
else
    echo "Stopping local PostgreSQL server..."
    pg_ctl -D "$POSTGRES_DATA_DIR" stop -m fast
    echo "${GREEN}✓${NC} PostgreSQL server stopped"
fi
