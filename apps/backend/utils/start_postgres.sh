#!/bin/zsh

###############################################################################
# Start Local PostgreSQL Server
###############################################################################

BACKEND_DIR="/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend"
POSTGRES_DATA_DIR="$BACKEND_DIR/postgres_data"
POSTGRES_LOG="$POSTGRES_DATA_DIR/postgres.log"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ ! -d "$POSTGRES_DATA_DIR/base" ]; then
    echo "${RED}✗${NC} PostgreSQL data directory not found!"
    echo "Run ./utils/setup_local_postgres.sh first to initialize"
    exit 1
fi

if pg_ctl -D "$POSTGRES_DATA_DIR" status &> /dev/null; then
    echo "${YELLOW}⚠${NC} PostgreSQL server is already running"
    pg_ctl -D "$POSTGRES_DATA_DIR" status
else
    echo "Starting local PostgreSQL server..."
    pg_ctl -D "$POSTGRES_DATA_DIR" -l "$POSTGRES_LOG" start
    sleep 2

    if pg_ctl -D "$POSTGRES_DATA_DIR" status &> /dev/null; then
        echo "${GREEN}✓${NC} PostgreSQL server started successfully"
        echo "  Port: 5433"
        echo "  Log: $POSTGRES_LOG"
    else
        echo "${RED}✗${NC} Failed to start PostgreSQL server"
        echo "Check log: $POSTGRES_LOG"
        exit 1
    fi
fi

