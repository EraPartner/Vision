#!/bin/bash

###############################################################################
# PostgreSQL Setup Script - Project Root Version
# 
# This script initializes a local PostgreSQL database cluster in the project
# root's postgres_data directory.
#
# Usage: ./scripts/db/setup_postgres.sh
###############################################################################

set -e

# Project root
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
POSTGRES_DATA_DIR="$PROJECT_ROOT/postgres_data"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo "${BLUE}║   PostgreSQL Setup for Financial Transaction Manager          ║${NC}"
echo "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Function to check if PostgreSQL is installed
check_postgres_installed() {
    if command -v initdb &> /dev/null && command -v postgres &> /dev/null; then
        PG_VERSION=$(postgres --version | awk '{print $3}')
        echo "${GREEN}✓${NC} PostgreSQL $PG_VERSION is installed"
        return 0
    else
        echo "${RED}✗${NC} PostgreSQL is not installed"
        return 1
    fi
}

# Check PostgreSQL installation
if ! check_postgres_installed; then
    echo ""
    echo "Installation instructions:"
    echo "  macOS (Homebrew):  brew install postgresql@15"
    echo "  Linux (Ubuntu):    sudo apt-get install postgresql postgresql-contrib"
    echo "  Linux (Fedora):    sudo dnf install postgresql postgresql-server"
    exit 1
fi

# Check if data directory already exists
if [ -d "$POSTGRES_DATA_DIR/base" ]; then
    echo "${YELLOW}⚠${NC} PostgreSQL data directory already initialized at:"
    echo "  $POSTGRES_DATA_DIR"
    echo ""
    echo "To reinitialize, run:"
    echo "  rm -rf '$POSTGRES_DATA_DIR' && ./scripts/db/setup_postgres.sh"
    exit 0
fi

# Create postgres_data directory
echo ""
echo "Creating PostgreSQL data directory..."
mkdir -p "$POSTGRES_DATA_DIR"
echo "${GREEN}✓${NC} Directory created: $POSTGRES_DATA_DIR"

# Initialize the database cluster
echo ""
echo "Initializing PostgreSQL database cluster..."
echo "  (This may take a moment...)"

if initdb -D "$POSTGRES_DATA_DIR" > /dev/null 2>&1; then
    echo "${GREEN}✓${NC} Database cluster initialized successfully"
else
    echo "${RED}✗${NC} Failed to initialize database cluster"
    rm -rf "$POSTGRES_DATA_DIR"
    exit 1
fi

# Configure PostgreSQL to use port 5433 (non-standard to avoid conflicts)
echo ""
echo "Configuring PostgreSQL..."
if [ -f "$POSTGRES_DATA_DIR/postgresql.conf" ]; then
    # Set custom port
    sed -i.bak "s/#port = 5432/port = 5433/" "$POSTGRES_DATA_DIR/postgresql.conf" || true
    echo "${GREEN}✓${NC} Configured port: 5433"
fi

echo ""
echo "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
echo "${GREEN}║   PostgreSQL Setup Complete!                                  ║${NC}"
echo "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Next steps:"
echo "  1. Start PostgreSQL: ./start.sh"
echo "  2. OR run Alembic migrations: alembic -c config/alembic.ini upgrade head"
echo ""
