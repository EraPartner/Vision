#!/bin/zsh

###############################################################################
# Stop Local PostgreSQL Server
###############################################################################

BACKEND_DIR="/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend"
POSTGRES_DATA_DIR="$BACKEND_DIR/postgres_data"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ ! -d "$POSTGRES_DATA_DIR/base" ]; then
    echo "${RED}✗${NC} PostgreSQL data directory not found!"
    exit 1
fi

if ! pg_ctl -D "$POSTGRES_DATA_DIR" status &> /dev/null; then
    echo "${YELLOW}⚠${NC} PostgreSQL server is not running"
else
    echo "Stopping local PostgreSQL server..."
    pg_ctl -D "$POSTGRES_DATA_DIR" stop -m fast
    echo "${GREEN}✓${NC} PostgreSQL server stopped"
fi

