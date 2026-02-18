#!/bin/zsh

###############################################################################
# Local PostgreSQL Setup Script for Financial Transaction Manager
#
# This script creates a local PostgreSQL database cluster in the backend
# directory, similar to how SQLite stores its database file locally.
#
# Usage: ./setup_local_postgres.sh
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BACKEND_DIR="/Users/computer/Documents/Personal/Scripts/Projects/Vault Voyager/apps/backend"
POSTGRES_DATA_DIR="$BACKEND_DIR/postgres_data"
POSTGRES_LOG="$BACKEND_DIR/postgres_data/postgres.log"
DB_NAME="financial_transactions"
DB_USER="ftm_user"
DB_PASSWORD=""
DB_HOST="localhost"
DB_PORT="5433"  # Use non-default port to avoid conflicts

echo "${BLUE}╔════════════════════════════════════════════════════════════════╗${NC}"
echo "${BLUE}║   Local PostgreSQL Setup for Financial Transaction Manager    ║${NC}"
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

# Function to prompt for password
prompt_password() {
    echo ""
    echo "${BLUE}Authentication Setup:${NC}"
    echo "Do you want to set up password authentication or use passwordless (trust) authentication?"
    echo ""
    echo "  ${GREEN}1)${NC} Passwordless (trust) - No password required (like SQLite)"
    echo "  ${GREEN}2)${NC} Password - Require password for connections"
    echo ""
    echo -n "Choose option (1 or 2) [1]: "
    read AUTH_CHOICE
    AUTH_CHOICE=${AUTH_CHOICE:-1}

    if [ "$AUTH_CHOICE" = "1" ]; then
        echo "${GREEN}✓${NC} Using passwordless authentication (trust)"
        DB_PASSWORD=""
        USE_PASSWORD_AUTH=false
        return 0
    fi

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
    USE_PASSWORD_AUTH=true
}

# Check PostgreSQL installation
echo "${BLUE}[1/6]${NC} Checking PostgreSQL installation..."
if ! check_postgres_installed; then
    echo ""
    echo "${YELLOW}PostgreSQL is not installed. Install it using:${NC}"
    echo ""
    echo "  ${BLUE}macOS:${NC}    brew install postgresql@15"
    echo ""
    exit 1
fi

# Check if data directory already exists
echo ""
echo "${BLUE}[2/6]${NC} Checking local PostgreSQL data directory..."
if [ -d "$POSTGRES_DATA_DIR/base" ]; then
    echo "${YELLOW}⚠${NC} PostgreSQL data directory already exists at:"
    echo "  ${POSTGRES_DATA_DIR}"
    echo ""
    echo -n "Do you want to reinitialize? This will DELETE all existing data! (y/N): "
    read -r REPLY
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "${YELLOW}Stopping any running local PostgreSQL instance...${NC}"
        if [ -f "$POSTGRES_DATA_DIR/postmaster.pid" ]; then
            pg_ctl -D "$POSTGRES_DATA_DIR" stop -m fast || true
            sleep 2
        fi
        echo "${YELLOW}Removing existing data directory...${NC}"
        rm -rf "$POSTGRES_DATA_DIR"
        mkdir -p "$POSTGRES_DATA_DIR"
    else
        echo "${GREEN}✓${NC} Using existing data directory"
        SKIP_INIT=true
    fi
else
    mkdir -p "$POSTGRES_DATA_DIR"
    echo "${GREEN}✓${NC} Created data directory at: $POSTGRES_DATA_DIR"
fi

# Initialize PostgreSQL cluster
if [ "$SKIP_INIT" != "true" ]; then
    echo ""
    echo "${BLUE}[3/6]${NC} Initializing PostgreSQL database cluster..."
    initdb -D "$POSTGRES_DATA_DIR" -U $(whoami) --encoding=UTF8 --locale=en_US.UTF-8
    echo "${GREEN}✓${NC} Database cluster initialized"

    # Configure PostgreSQL to use custom port
    echo ""
    echo "${BLUE}[4/6]${NC} Configuring PostgreSQL..."
    echo "port = $DB_PORT" >> "$POSTGRES_DATA_DIR/postgresql.conf"
    echo "listen_addresses = 'localhost'" >> "$POSTGRES_DATA_DIR/postgresql.conf"
    echo "unix_socket_directories = '/tmp'" >> "$POSTGRES_DATA_DIR/postgresql.conf"
    echo "logging_collector = on" >> "$POSTGRES_DATA_DIR/postgresql.conf"
    echo "log_directory = 'log'" >> "$POSTGRES_DATA_DIR/postgresql.conf"
    echo "log_filename = 'postgresql-%Y-%m-%d_%H%M%S.log'" >> "$POSTGRES_DATA_DIR/postgresql.conf"

    # Configure authentication - use trust for local connections (passwordless)
    cat > "$POSTGRES_DATA_DIR/pg_hba.conf" << 'EOF'
# PostgreSQL Client Authentication Configuration File
# TYPE  DATABASE        USER            ADDRESS                 METHOD

# Local connections use trust (no password required)
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust

# Allow replication connections (if needed)
local   replication     all                                     trust
host    replication     all             127.0.0.1/32            trust
host    replication     all             ::1/128                 trust
EOF

    echo "${GREEN}✓${NC} Configuration updated (passwordless authentication enabled)"
else
    echo ""
    echo "${BLUE}[3/6]${NC} Skipping initialization (using existing cluster)"
    echo "${BLUE}[4/6]${NC} Skipping configuration"
fi

# Start PostgreSQL server
echo ""
echo "${BLUE}[5/6]${NC} Starting local PostgreSQL server..."

# Check if already running
if pg_ctl -D "$POSTGRES_DATA_DIR" status &> /dev/null; then
    echo "${GREEN}✓${NC} PostgreSQL server is already running"
else
    pg_ctl -D "$POSTGRES_DATA_DIR" -l "$POSTGRES_LOG" start
    sleep 3

    if pg_ctl -D "$POSTGRES_DATA_DIR" status &> /dev/null; then
        echo "${GREEN}✓${NC} PostgreSQL server started successfully"
        echo "  Log file: $POSTGRES_LOG"
    else
        echo "${RED}✗${NC} Failed to start PostgreSQL server"
        echo "Check log file: $POSTGRES_LOG"
        exit 1
    fi
fi

# Get database password
if [ "$SKIP_INIT" != "true" ]; then
    echo ""
    echo "${BLUE}[6/6]${NC} Database user configuration..."
    prompt_password

    # Create database and user
    echo ""
    echo "Creating database and user..."

    # Create SQL commands based on authentication method
    if [ "$USE_PASSWORD_AUTH" = "true" ]; then
        # Password-based authentication
        SQL_COMMANDS="
        -- Create user with password
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
        SELECT 'CREATE DATABASE $DB_NAME OWNER $DB_USER'
        WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec

        -- Grant privileges
        GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
        "
    else
        # Passwordless (trust) authentication
        SQL_COMMANDS="
        -- Create user without password (trust authentication)
        DO \$\$
        BEGIN
            IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '$DB_USER') THEN
                CREATE USER $DB_USER;
            END IF;
        END
        \$\$;

        -- Create database if not exists
        SELECT 'CREATE DATABASE $DB_NAME OWNER $DB_USER'
        WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec

        -- Grant privileges
        GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
        "
    fi

    # Execute SQL commands
    echo "$SQL_COMMANDS" | psql -h localhost -p $DB_PORT -d postgres -U $(whoami) 2>&1 | grep -v "NOTICE:" || true

    # Grant schema privileges
    SCHEMA_SQL="
    GRANT ALL ON SCHEMA public TO $DB_USER;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $DB_USER;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO $DB_USER;
    ALTER DATABASE $DB_NAME OWNER TO $DB_USER;
    "

    echo "$SCHEMA_SQL" | psql -h localhost -p $DB_PORT -d $DB_NAME -U $(whoami) 2>&1 | grep -v "NOTICE:" || true

    # Test connection
    echo ""
    echo "Testing database connection..."
    if [ "$USE_PASSWORD_AUTH" = "true" ]; then
        if PGPASSWORD=$DB_PASSWORD psql -U $DB_USER -d $DB_NAME -h $DB_HOST -p $DB_PORT -c "SELECT version();" &> /dev/null; then
            echo "${GREEN}✓${NC} Database connection successful!"
        else
            echo "${RED}✗${NC} Failed to connect to database"
            echo "Please verify your setup and try again"
            exit 1
        fi
    else
        if psql -U $DB_USER -d $DB_NAME -h $DB_HOST -p $DB_PORT -c "SELECT version();" &> /dev/null; then
            echo "${GREEN}✓${NC} Database connection successful (passwordless)!"
        else
            echo "${RED}✗${NC} Failed to connect to database"
            echo "Please verify your setup and try again"
            exit 1
        fi
    fi

    # Generate DATABASE_URL
    if [ "$USE_PASSWORD_AUTH" = "true" ]; then
        DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
    else
        DATABASE_URL="postgresql://$DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
    fi

    # Display connection info
    echo ""
    echo "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo "${GREEN}║                     Setup Completed Successfully!              ║${NC}"
    echo "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "${BLUE}Database Configuration:${NC}"
    echo "  Database Name: ${GREEN}$DB_NAME${NC}"
    echo "  Database User: ${GREEN}$DB_USER${NC}"
    echo "  Host:          ${GREEN}$DB_HOST${NC}"
    echo "  Port:          ${GREEN}$DB_PORT${NC} ${YELLOW}(custom port to avoid conflicts)${NC}"
    echo "  Data Directory: ${GREEN}$POSTGRES_DATA_DIR${NC}"
    if [ "$USE_PASSWORD_AUTH" = "false" ]; then
        echo "  Authentication: ${GREEN}Passwordless (trust)${NC} ${YELLOW}(like SQLite!)${NC}"
    else
        echo "  Authentication: ${GREEN}Password required${NC}"
    fi
    echo ""
    echo "${BLUE}Connection String:${NC}"
    echo "  ${YELLOW}$DATABASE_URL${NC}"
    echo ""
    echo "${BLUE}Next Steps:${NC}"
    echo "  1. Add these variables to your ${GREEN}config/.env.local${NC} file:"
    echo ""
    echo "     ${YELLOW}# Source database (existing SQLite)${NC}"
    echo "     ${YELLOW}SOURCE_DATABASE_URL=\"sqlite:///$BACKEND_DIR/financial_transactions.db\"${NC}"
    echo ""
    echo "     ${YELLOW}# Target database (new local PostgreSQL)${NC}"
    echo "     ${YELLOW}TARGET_DATABASE_URL=\"$DATABASE_URL\"${NC}"
    echo ""
    echo "  2. Run the migration script:"
    echo "     ${GREEN}python -m utils.migrate_sqlite_to_postgres${NC}"
    echo ""
    echo "  3. Update DATABASE_URL in .env.local to use PostgreSQL:"
    echo "     ${GREEN}DATABASE_URL=\"$DATABASE_URL\"${NC}"
    echo ""
else
    echo ""
    echo "${BLUE}[6/6]${NC} Using existing database configuration"
    echo ""
    echo "${GREEN}╔════════════════════════════════════════════════════════════════╗${NC}"
    echo "${GREEN}║              Local PostgreSQL Server is Running!               ║${NC}"
    echo "${GREEN}╚════════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "${BLUE}Database Location:${NC}"
    echo "  Data Directory: ${GREEN}$POSTGRES_DATA_DIR${NC}"
    echo "  Log File:       ${GREEN}$POSTGRES_LOG${NC}"
    echo "  Port:           ${GREEN}$DB_PORT${NC}"
    echo ""
fi

echo "${BLUE}Server Management Commands:${NC}"
echo "  Start:  ${GREEN}pg_ctl -D \"$POSTGRES_DATA_DIR\" start${NC}"
echo "  Stop:   ${GREEN}pg_ctl -D \"$POSTGRES_DATA_DIR\" stop${NC}"
echo "  Status: ${GREEN}pg_ctl -D \"$POSTGRES_DATA_DIR\" status${NC}"
echo "  Connect: ${GREEN}psql -h localhost -p $DB_PORT -d $DB_NAME -U $DB_USER${NC}"
echo ""

