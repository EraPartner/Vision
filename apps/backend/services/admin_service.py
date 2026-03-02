from datetime import datetime, timezone
from typing import List, Tuple

from fastapi import Request
from pydantic import HttpUrl
from sqlalchemy import inspect
from sqlalchemy.orm import Session

from api.api_schemas import Link
from config.logging_config import setup_logging
from database.connection import engine
from database.models import Base

logger = setup_logging(__name__)

def check_database_status(db: Session | None = None) -> Tuple[bool, int]:
    """Return (is_initialised, table_count) by inspecting engine metadata.

    Accepts an optional `db` session. If not provided, uses module-level engine.
    """
    try:
        engine_to_inspect = db.bind if db and db.bind is not None else engine
        inspector = inspect(engine_to_inspect)
        tables = inspector.get_table_names()
        return len(tables) > 0, len(tables)
    except Exception:
        logger.exception("Database status inspection failed")
        return False, 0


def perform_initialise(db: Session) -> None:
    """Create missing tables for SQLAlchemy models (idempotent).

    Raises exceptions on failure.
    """
    Base.metadata.create_all(bind=db.bind)


def perform_reset(db: Session) -> None:
    """Drop and recreate all tables (DESTRUCTIVE).

    Raises exceptions on failure.
    """
    Base.metadata.drop_all(bind=db.bind)
    Base.metadata.create_all(bind=db.bind)
