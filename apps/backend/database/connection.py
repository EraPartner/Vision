import os
# Import config
import sys

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

# Get settings
settings = get_settings()
database_config = settings.database

# Get the directory where this file is located
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(BASE_DIR)

# Use configured database URL
DATABASE_URL = database_config.url
if DATABASE_URL.startswith("sqlite") and not DATABASE_URL.startswith("sqlite:///"):
    # Ensure proper sqlite path
    DEFAULT_DB_PATH = os.path.join(BACKEND_DIR, "financial_transactions.db")
    DATABASE_URL = f"sqlite:///{DEFAULT_DB_PATH}"

logger.info(f"Database location: {DATABASE_URL[:50]}...")

# Create engine with appropriate settings
if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=database_config.echo,
    )
else:
    # PostgreSQL or other production databases
    engine = create_engine(
        DATABASE_URL,
        pool_size=database_config.pool_size,
        max_overflow=database_config.max_overflow,
        pool_pre_ping=True,
        echo=database_config.echo,
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """Dependency to get database session"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """Initialize database tables"""
    from database.models import Base
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables initialized")
