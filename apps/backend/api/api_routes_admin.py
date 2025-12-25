"""
Admin API routes for database lifecycle operations

This module provides administrative endpoints for managing the database lifecycle,
including initialization and reset operations. These endpoints should be used with
caution, especially in production environments.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from config.logging_config import setup_logging
from database.connection import init_db, engine
from database.models import Base

router = APIRouter(prefix="/api/admin", tags=["admin"])
logger = setup_logging(__name__)


class AdminResponse(BaseModel):
    """Standard response model for admin operations"""
    message: str
    details: dict | None = None


@router.post("/init-db", response_model=AdminResponse)
async def init_db_endpoint():
    """Initialize database tables (idempotent operation).

    Creates all tables defined in the SQLAlchemy models if they don't already exist.
    This operation is safe to run multiple times - it will not drop or modify existing
    tables or data.

    Returns:
        AdminResponse: Success message with database initialization status.

    Raises:
        HTTPException: 500 error if database initialization fails.

    Examples:
        >>> # Example response
        {
            "message": "Database initialized successfully",
            "details": null
        }

    Note:
        - This operation is idempotent and safe to run multiple times
        - Existing tables and data are preserved
        - Only missing tables are created

    Use Cases:
        - First-time setup of the database
        - Creating missing tables after adding new models
        - Recovery after accidental table deletion
    """
    try:
        init_db()
        logger.info("Database initialized successfully")
        return AdminResponse(message="Database initialized successfully")
    except Exception as e:
        logger.error(f"Error initializing DB: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Error initializing database: {str(e)}"
        )


@router.post("/reset-db", response_model=AdminResponse)
async def reset_db_endpoint(
        force: bool = Query(
            False,
            description="Must be set to true to confirm the destructive operation"
        )
):
    """Reset database by dropping and recreating all tables (DESTRUCTIVE).

    WARNING: This operation will permanently delete ALL data in the database!

    Drops all existing tables and recreates them from scratch. This operation cannot
    be undone and will result in complete data loss. Always ensure you have a backup
    before running this endpoint.

    Args:
        force (bool): Must be explicitly set to True to confirm the destructive operation.
            Defaults to False.

    Returns:
        AdminResponse: Success message with reset confirmation and warning about data loss.

    Raises:
        HTTPException: 400 error if force parameter is not True.
        HTTPException: 500 error if database reset fails.

    Examples:
        >>> # Example successful response
        {
            "message": "Database reset successfully",
            "details": {
                "warning": "All previous data has been permanently deleted"
            }
        }

    Warning:
        This is a DESTRUCTIVE operation that cannot be undone. All data will be
        permanently deleted. Always backup your database before using this endpoint.

    Note:
        - Requires explicit force=true query parameter
        - Should be disabled or restricted in production environments
        - Consider implementing additional authentication/authorization checks

    Use Cases:
        - Development environment resets
        - Test data cleanup
        - Schema migration when starting fresh

    Recommendations:
        - Always backup your database before using this endpoint
        - Use database migrations (e.g., Alembic) for production schema changes
        - Restrict access to this endpoint in production
    """
    if not force:
        logger.warning("Database reset attempted without force=true")
        raise HTTPException(
            status_code=400,
            detail="Set force=true query parameter to confirm reset (DESTRUCTIVE OPERATION)"
        )

    try:
        logger.warning("Database reset initiated - dropping all tables")
        Base.metadata.drop_all(bind=engine)
        Base.metadata.create_all(bind=engine)
        logger.info("Database reset completed successfully")

        return AdminResponse(
            message="Database reset successfully",
            details={"warning": "All previous data has been permanently deleted"}
        )
    except Exception as e:
        logger.error(f"Error resetting DB: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Error resetting database: {str(e)}"
        )
