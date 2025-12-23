"""
Admin API routes for DB lifecycle operations (CLI init-db, reset-db)
"""
from fastapi import APIRouter, HTTPException, Query

from config.logging_config import setup_logging
from database.connection import init_db, engine
from database.models import Base

router = APIRouter(prefix="/api/admin", tags=["admin"])
logger = setup_logging(__name__)


@router.post("/init-db")
async def init_db_endpoint():
    """Initialize database tables (idempotent)"""
    try:
        init_db()
        return {"message": "Database initialized successfully"}
    except Exception as e:
        logger.error(f"Error initializing DB: {e}")
        raise HTTPException(status_code=500, detail="Error initializing database")


@router.post("/reset-db")
async def reset_db_endpoint(force: bool = Query(False, description="Must be true to drop all data")):
    """Reset database: drop all tables and recreate"""
    if not force:
        raise HTTPException(status_code=400, detail="Set force=true to confirm reset (DESTRUCTIVE)")
    try:
        Base.metadata.drop_all(bind=engine)
        Base.metadata.create_all(bind=engine)
        return {"message": "Database reset successfully"}
    except Exception as e:
        logger.error(f"Error resetting DB: {e}")
        raise HTTPException(status_code=500, detail="Error resetting database")
