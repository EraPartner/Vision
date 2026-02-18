#!/bin/zsh

###############################################################################
# Check Local PostgreSQL Server Status
###############################################################################

BACKEND_DIR="/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend"
POSTGRES_DATA_DIR="$BACKEND_DIR/postgres_data"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

if [ ! -d "$POSTGRES_DATA_DIR/base" ]; then
    echo "${RED}✗${NC} PostgreSQL data directory not found!"
    echo "Run ./utils/setup_local_postgres.sh first to initialize"
    exit 1
fi

echo "${BLUE}Local PostgreSQL Server Status:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
pg_ctl -D "$POSTGRES_DATA_DIR" status || echo "${RED}✗${NC} Server is not running"

if pg_ctl -D "$POSTGRES_DATA_DIR" status &> /dev/null; then
    echo ""
    echo "${BLUE}Database Information:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    psql -h localhost -p 5433 -d postgres -U $(whoami) -c "SELECT datname as database, pg_size_pretty(pg_database_size(datname)) as size FROM pg_database WHERE datname NOT IN ('template0', 'template1', 'postgres') ORDER BY datname;"
fi

