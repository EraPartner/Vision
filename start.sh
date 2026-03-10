#!/bin/bash

###############################################################################
# Finance Tracker - Full Startup Script
# Starts: PostgreSQL → Backend → Vite Frontend
# Uses bun as the runtime
###############################################################################

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
POSTGRES_DATA_DIR="$PROJECT_ROOT/postgres_data"
POSTGRES_LOG="$POSTGRES_DATA_DIR/postgres.log"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Cleanup function for graceful shutdown
cleanup() {
    echo ""
    echo "${BLUE}🛑 Shutting down...${NC}"

    # Stop frontend
    if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        kill "$FRONTEND_PID" 2>/dev/null
        echo "${GREEN}✓${NC} Frontend stopped"
    fi

    # Stop backend
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        kill "$BACKEND_PID" 2>/dev/null
        echo "${GREEN}✓${NC} Backend stopped"
    fi

    # Stop PostgreSQL
    if pg_ctl -D "$POSTGRES_DATA_DIR" status &>/dev/null; then
        pg_ctl -D "$POSTGRES_DATA_DIR" stop -m fast 2>/dev/null
        echo "${GREEN}✓${NC} PostgreSQL stopped"
    fi

    exit 0
}
trap cleanup EXIT INT TERM

echo "${BLUE}🚀 Starting Finance Tracker...${NC}"
echo ""

# ==================== 1. PostgreSQL ====================

echo "${BLUE}[1/3]${NC} Starting PostgreSQL..."

if [ ! -d "$POSTGRES_DATA_DIR/base" ]; then
    echo "${RED}✗${NC} PostgreSQL data directory not found at:"
    echo "  $POSTGRES_DATA_DIR"
    echo ""
    echo "Run the setup script first:"
    echo "  ./scripts/db/setup_postgres.sh"
    exit 1
fi

if pg_ctl -D "$POSTGRES_DATA_DIR" status &>/dev/null; then
    echo "${YELLOW}⚠${NC} PostgreSQL is already running"
else
    pg_ctl -D "$POSTGRES_DATA_DIR" -l "$POSTGRES_LOG" start -w -t 10
    if pg_ctl -D "$POSTGRES_DATA_DIR" status &>/dev/null; then
        echo "${GREEN}✓${NC} PostgreSQL started (log: $POSTGRES_LOG)"
    else
        echo "${RED}✗${NC} Failed to start PostgreSQL. Check: $POSTGRES_LOG"
        exit 1
    fi
fi

# ==================== 2. Backend ====================

echo "${BLUE}[2/3]${NC} Starting backend API..."
cd "$PROJECT_ROOT/apps/node-backend"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "  Installing backend dependencies..."
    bun install
fi

PROJECT_ROOT="$PROJECT_ROOT" bun run src/main.js > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
cd "$PROJECT_ROOT"

# Wait for backend health check
echo "  Waiting for backend..."
for i in $(seq 1 10); do
    if curl -s http://localhost:3002/health > /dev/null 2>&1; then
        echo "${GREEN}✓${NC} Backend API running on http://localhost:3002"
        break
    fi
    if [ "$i" -eq 10 ]; then
        echo "${RED}✗${NC} Backend failed to start. Log:"
        cat /tmp/backend.log
        exit 1
    fi
    sleep 1
done

# ==================== 3. Vite Frontend ====================

echo "${BLUE}[3/3]${NC} Starting frontend..."
echo "${GREEN}✓${NC} All services starting. Frontend at http://localhost:8080"
echo ""

cd "$PROJECT_ROOT/apps/frontend" && bun run dev
