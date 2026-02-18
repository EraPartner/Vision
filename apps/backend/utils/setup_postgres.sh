#!/bin/zsh

###############################################################################
# PostgreSQL Setup Script for Financial Transaction Manager
#
# This script automates the PostgreSQL database setup for the migration from
# SQLite to PostgreSQL.
#
# Usage: ./setup_postgres.sh
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DB_NAME="financial_transactions"
DB_USER="ftm_user"
DB_PASSWORD=""
DB_HOST="localhost"
DB_PORT="5432"
PG_SUPERUSER=""

echo "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo "${BLUE}║   PostgreSQL Setup for Financial Transaction Manager          ║${NC}"
echo "${BLUE}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Function to check if PostgreSQL is installed
check_postgres_installed() {
    if command -v psql &> /dev/null; then
        PG_VERSION=$(psql --version | awk '{print $3}')
        echo "${GREEN}✓${NC} PostgreSQL $PG_VERSION is installed"
        return 0
    else
        echo "${RED}✗${NC} PostgreSQL is not installed"
        return 1
    fi
}

# Function to check if PostgreSQL service is running
check_postgres_running() {
    if pg_isready -h localhost -p 5432 &> /dev/null; then
        echo "${GREEN}✓${NC} PostgreSQL service is running"
        return 0
    else
        echo "${YELLOW}⚠${NC} PostgreSQL service is not running"
        return 1
    fi
}

# Function to prompt for password
prompt_password() {
    echo ""
    echo "Please enter a secure password for the database user '$DB_USER':"
    echo "(Password will not be displayed)"
    read -s DB_PASSWORD
    echo ""
    echo "Confirm password:"
    read -s DB_PASSWORD_CONFIRM
    echo ""

    if [ "$DB_PASSWORD" != "$DB_PASSWORD_CONFIRM" ]; then
        echo "${RED}✗${NC} Passwords do not match!"
        exit 1
    fi

    if [ -z "$DB_PASSWORD" ]; then
        echo "${RED}✗${NC} Password cannot be empty!"
        exit 1
    fi

    echo "${GREEN}✓${NC} Password confirmed"
}

# Function to detect PostgreSQL superuser
detect_pg_superuser() {
    # On macOS with Homebrew, the superuser is the current macOS user
    # On Linux, it's typically 'postgres'
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS - use current user
        PG_SUPERUSER=$(whoami)
    else
        # Linux - try 'postgres' user
        PG_SUPERUSER="postgres"
    fi

    # Verify the superuser can connect (explicitly specify postgres database)
    if PGPASSWORD="" psql -U "$PG_SUPERUSER" -d postgres -h localhost -c "SELECT 1" &> /dev/null; then
        echo "${GREEN}✓${NC} Detected PostgreSQL superuser: $PG_SUPERUSER"
        return 0
    else
        echo "${YELLOW}⚠${NC} Could not connect as '$PG_SUPERUSER', trying 'postgres'..."
        PG_SUPERUSER="postgres"
        if PGPASSWORD="" psql -U "$PG_SUPERUSER" -d postgres -h localhost -c "SELECT 1" &> /dev/null; then
            echo "${GREEN}✓${NC} Connected as PostgreSQL superuser: $PG_SUPERUSER"
            return 0
        else
            echo "${RED}✗${NC} Could not detect PostgreSQL superuser"
            echo "Please ensure PostgreSQL is properly configured"
            return 1
        fi
    fi
}

# Check PostgreSQL installation
echo "${BLUE}[1/6]${NC} Checking PostgreSQL installation..."
if ! check_postgres_installed; then
    echo ""
    echo "${YELLOW}PostgreSQL is not installed. Install it using:${NC}"
    echo ""
    echo "  ${BLUE}macOS:${NC}    brew install postgresql@15"
    echo "  ${BLUE}Ubuntu:${NC}   sudo apt install postgresql postgresql-contrib"
    echo "  ${BLUE}Windows:${NC}  Download from https://www.postgresql.org/download/windows/"
    echo ""
    exit 1
fi

# Check if PostgreSQL is running
echo ""
echo "${BLUE}[2/6]${NC} Checking PostgreSQL service..."
if ! check_postgres_running; then
    echo ""
    echo "Starting PostgreSQL service..."

    # Try to start PostgreSQL (OS-specific)
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        if command -v brew &> /dev/null; then
            brew services start postgresql@15 || brew services start postgresql
            sleep 2
        fi
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux
        sudo systemctl start postgresql
        sleep 2
    fi

    # Check again
    if check_postgres_running; then
        echo "${GREEN}✓${NC} PostgreSQL service started successfully"
    else
        echo "${RED}✗${NC} Failed to start PostgreSQL service"
        echo "Please start PostgreSQL manually and run this script again"
        exit 1
    fi
fi

# Detect PostgreSQL superuser
echo ""
echo "${BLUE}[3/6]${NC} Detecting PostgreSQL superuser..."
if ! detect_pg_superuser; then
    echo "${RED}✗${NC} Failed to detect PostgreSQL superuser"
    exit 1
fi

# Get database password
echo ""
echo "${BLUE}[4/6]${NC} Database user configuration..."
prompt_password

# Create database and user
echo ""
echo "${BLUE}[5/7]${NC} Creating database and user..."

# Create SQL commands
SQL_COMMANDS="
-- Create user if not exists
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '$DB_USER') THEN
        CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
    ELSE
        ALTER USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
    END IF;
END
\$\$;

-- Create database if not exists
SELECT 'CREATE DATABASE $DB_NAME'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
"

# Execute SQL commands
echo "$SQL_COMMANDS" | psql -U "$PG_SUPERUSER" -d postgres -h localhost 2>&1 | grep -v "NOTICE:" || {
    echo "${YELLOW}⚠${NC} If you see authentication errors, you may need to:"
    echo "   1. Run: psql -U $PG_SUPERUSER -d postgres"
    echo "   2. Execute the commands manually from the error output above"
    echo ""
    read -p "Press Enter to continue if you've manually set up the database..."
}

# Grant schema privileges
echo ""
echo "${BLUE}[6/7]${NC} Setting up schema permissions..."
SCHEMA_SQL="
GRANT ALL ON SCHEMA public TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $DB_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO $DB_USER;
"

echo "$SCHEMA_SQL" | psql -U "$PG_SUPERUSER" -d $DB_NAME -h localhost 2>&1 | grep -v "NOTICE:" || true

# Test connection
echo ""
echo "${BLUE}[7/7]${NC} Testing database connection..."
if PGPASSWORD=$DB_PASSWORD psql -U $DB_USER -d $DB_NAME -h $DB_HOST -c "SELECT version();" &> /dev/null; then
    echo "${GREEN}✓${NC} Database connection successful!"
else
    echo "${RED}✗${NC} Failed to connect to database"
    echo "Please verify your setup and try again"
    exit 1
fi

# Generate DATABASE_URL
DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"

# Display connection info
echo ""
echo "${GREEN}╔═══════════════════════════════════════════════��════════════════╗${NC}"
echo "${GREEN}║                     Setup Completed Successfully!              ║${NC}"
echo "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "${BLUE}Database Configuration:${NC}"
echo "  Database Name: ${GREEN}$DB_NAME${NC}"
echo "  Database User: ${GREEN}$DB_USER${NC}"
echo "  Host:          ${GREEN}$DB_HOST${NC}"
echo "  Port:          ${GREEN}$DB_PORT${NC}"
echo ""
echo "${BLUE}Connection String:${NC}"
echo "  ${YELLOW}$DATABASE_URL${NC}"
echo ""
echo "${BLUE}Next Steps:${NC}"
echo "  1. Add these variables to your ${GREEN}config/.env.local${NC} file:"
echo ""
echo "     ${YELLOW}# Source database (existing SQLite)${NC}"
echo "     ${YELLOW}SOURCE_DATABASE_URL=\"sqlite:///$(pwd)/financial_transactions.db\"${NC}"
echo ""
echo "     ${YELLOW}# Target database (new PostgreSQL)${NC}"
echo "     ${YELLOW}TARGET_DATABASE_URL=\"$DATABASE_URL\"${NC}"
echo ""
echo "  2. Install Python PostgreSQL driver:"
echo "     ${GREEN}pip install psycopg2-binary${NC}"
echo ""
echo "  3. Run the migration script:"
echo "     ${GREEN}python -m utils.migrate_sqlite_to_postgres${NC}"
echo ""
echo "  4. Update DATABASE_URL in .env.local to use PostgreSQL:"
echo "     ${GREEN}DATABASE_URL=\"$DATABASE_URL\"${NC}"
echo ""
echo "${BLUE}Documentation:${NC}"
echo "  See ${GREEN}docs/migration-sqlite-to-postgresql.md${NC} for detailed guide"
echo ""

