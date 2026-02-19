import sys

"""Database connection and session management module.

This module handles:
- Database engine creation with support for SQLite and PostgreSQL
- Session factory configuration
- Dependency injection for database sessions in FastAPI
- Database initialization
- Automatic PostgreSQL database creation

The module automatically configures the database connection based on the
DATABASE_URL setting and handles environment-specific configurations
(SQLite for development, PostgreSQL for production).
"""
import os
from urllib.parse import urlparse

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from sqlalchemy.exc import OperationalError

from config.config import get_settings
from config.logging_config import setup_logging

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

logger = setup_logging(__name__)

# Get configuration
settings = get_settings()
database_config = settings.database

# Get the directory where this file is located
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(BASE_DIR)

# Configure database URL with proper path handling for SQLite
DATABASE_URL = database_config.url
if DATABASE_URL.startswith("sqlite") and not DATABASE_URL.startswith("sqlite:///"):
    # Ensure proper SQLite absolute path
    DEFAULT_DB_PATH = os.path.join(BACKEND_DIR, "financial_transactions.db")
    DATABASE_URL = f"sqlite:///{DEFAULT_DB_PATH}"

logger.info(f"Database location: {DATABASE_URL[:50]}...")

# Create SQLAlchemy engine with environment-specific configuration
if DATABASE_URL.startswith("sqlite"):
    # SQLite configuration (development/testing)
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=database_config.echo,
    )
else:
    # PostgreSQL or other production database configuration
    engine = create_engine(
        DATABASE_URL,
        pool_size=database_config.pool_size,
        max_overflow=database_config.max_overflow,
        pool_pre_ping=True,
        echo=database_config.echo,
    )

# Session factory configuration
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Declarative base for all ORM models
Base = declarative_base()


def get_db():
    """Get a database session for dependency injection.

    This is a FastAPI dependency that provides a database session to routes.
    The session is automatically closed after use to ensure proper resource cleanup.

    Yields:
        Session: SQLAlchemy database session.

    Example:
        @router.get("/users")
        async def get_all_users(db = Depends(get_db)):
            # db is automatically provided by FastAPI dependency injection
            result = db.query(User).all()
            return result

    Note:
        Always use this as a dependency in FastAPI routes to ensure proper
        session management. Do not create sessions manually.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_postgresql_database_exists(database_url: str) -> None:
    """
    Ensure that the PostgreSQL database exists, creating it if necessary.

    This function connects to the PostgreSQL server using the 'postgres' database
    (which always exists) and creates the target database if it doesn't exist.

    Only applicable for PostgreSQL databases. SQLite databases are created
    automatically by SQLAlchemy.

    Args:
        database_url: Full database connection URL

    Raises:
        OperationalError: If connection to PostgreSQL server fails
        Exception: For other database-related errors

    Note:
        - This function is idempotent - safe to call multiple times
        - Requires PostgreSQL user to have CREATE DATABASE privilege
        - Uses 'postgres' database for initial connection
    """
    if not database_url.startswith("postgresql"):
        logger.debug("Database is not PostgreSQL, skipping database creation check")
        return

    # Parse the database URL to extract connection details
    parsed_url = urlparse(database_url)
    database_name = parsed_url.path.lstrip('/')

    if not database_name:
        logger.warning("No database name found in DATABASE_URL")
        return

    # Build connection URL to the 'postgres' database (which always exists)
    # This allows us to check/create the target database
    postgres_url = database_url.replace(f"/{database_name}", "/postgres")

    logger.info(
        f"Checking if PostgreSQL database '{database_name}' exists",
        extra={
            "operation": "database_check",
            "resource_type": "database",
            "database_name": database_name
        }
    )

    try:
        # Connect to postgres database to check if target database exists
        temp_engine = create_engine(postgres_url, isolation_level="AUTOCOMMIT")

        with temp_engine.connect() as conn:
            # Check if database exists
            result = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :dbname"),
                {"dbname": database_name}
            )
            exists = result.fetchone() is not None

            if exists:
                logger.info(
                    f"PostgreSQL database '{database_name}' already exists",
                    extra={
                        "operation": "database_check",
                        "resource_type": "database",
                        "database_name": database_name,
                        "status": "exists"
                    }
                )
            else:
                # Create the database
                logger.info(
                    f"Creating PostgreSQL database '{database_name}'",
                    extra={
                        "operation": "database_create",
                        "resource_type": "database",
                        "database_name": database_name,
                        "status": "creating"
                    }
                )

                # Create database (cannot use parameterized query for database name)
                # Using text() with properly quoted identifier
                conn.execute(text(f'CREATE DATABASE "{database_name}"'))

                logger.info(
                    f"PostgreSQL database '{database_name}' created successfully",
                    extra={
                        "operation": "database_create",
                        "resource_type": "database",
                        "database_name": database_name,
                        "status": "success"
                    }
                )

        temp_engine.dispose()

    except OperationalError as e:
        logger.error(
            f"Failed to connect to PostgreSQL server: {str(e)}",
            extra={
                "operation": "database_check",
                "resource_type": "database",
                "status": "connection_failed",
                "error_type": type(e).__name__
            },
            exc_info=True
        )
        raise
    except Exception as e:
        logger.error(
            f"Unexpected error during database creation: {str(e)}",
            extra={
                "operation": "database_create",
                "resource_type": "database",
                "status": "failed",
                "error_type": type(e).__name__
            },
            exc_info=True
        )
        raise


def init_db():
    """Initialize database tables based on SQLAlchemy models.

    Creates all tables defined in the models using the declarative base metadata.
    This operation is idempotent - tables that already exist are not recreated.

    The function:
    - Creates all tables from registered models
    - Logs successful initialization
    - Handles SQLite and PostgreSQL databases

    Example:
        # Call during application startup
        if __name__ == "__main__":
            init_db()
            # All tables are now created

    Note:
        - Safe to call multiple times
        - Does not drop existing tables
        - Should be called once on application startup
        - Use database migrations (Alembic) for schema changes in production
        - For PostgreSQL, ensure_postgresql_database_exists() should be called first

    Raises:
        SQLAlchemy exceptions if table creation fails (e.g., permission issues).
    """
    from database.models import Base
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables initialized")
