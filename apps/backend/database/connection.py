import sys

"""Database connection and session management module.

This module handles:
- Database engine creation with support for SQLite and PostgreSQL
- Session factory configuration
- Dependency injection for database sessions in FastAPI
- Database initialization

The module automatically configures the database connection based on the
DATABASE_URL setting and handles environment-specific configurations
(SQLite for development, PostgreSQL for production).
"""
import os

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

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

    Raises:
        SQLAlchemy exceptions if table creation fails (e.g., permission issues).
    """
    from database.models import Base
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables initialized")
