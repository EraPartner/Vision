"""
Admin API routes for database lifecycle operations

This module provides administrative endpoints for managing the database lifecycle,
including initialization and reset operations. These endpoints should be used with
caution, especially in production environments.

Level 3 REST API Implementation (HATEOAS - Hypermedia As The Engine Of Application State)
Responses include hypermedia links that guide clients on available actions.
"""
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import inspect

from api.api_schemas import MessageResponse, AdminStatusResponse, Link, OptionsResponse, MethodInfo
from api.hateoas_links import get_base_url
from config.config import get_settings
from config.logging_config import setup_logging
from database.connection import init_db, engine
from database.models import Base

router = APIRouter(prefix="/api/admin", tags=["admin"])
logger = setup_logging(__name__)


# ==================== Helper Functions ====================

def get_admin_links(request: Request) -> List[Link]:
    """
    Generate HATEOAS links for admin resources based on current state.

    Args:
        request: FastAPI Request object for constructing absolute URLs

    Returns:
        List of Link objects describing available actions
    """
    base_url = get_base_url(request)
    links = [
        Link(
            rel="self",
            href=f"{base_url}/api/admin",
            method="GET",
            title="Get current database administration status"
        ),
        Link(
            rel="init",
            href=f"{base_url}/api/admin/database/init",
            method="POST",
            title="Initialise the database"
        ),
    ]

    # Add reset link only if enabled in configuration
    settings = get_settings()
    if settings.admin.enable_reset_db:
        links.append(
            Link(
                rel="reset",
                href=f"{base_url}/api/admin/database/reset?force=true",
                method="POST",
                title="Reset the database (DESTRUCTIVE - use with caution)"
            )
        )

    return links


def get_database_status() -> tuple[bool, int]:
    """
    Get the current database initialisation status.

    Returns:
        Tuple of (is_initialised: bool, table_count: int)
    """
    try:
        inspector = inspect(engine)
        tables = inspector.get_table_names()
        return len(tables) > 0, len(tables)
    except Exception as e:
        logger.error(f"Error inspecting database: {e}")
        return False, 0


# ==================== Level 3 REST API Endpoints (HATEOAS) ====================

@router.options("", response_model=OptionsResponse, description="Discover available methods on admin endpoint")
async def admin_options(request: Request):
    """
    OPTIONS method for admin endpoint discovery.

    Allows clients to discover what HTTP methods are available on the admin endpoint.

    Returns:
        OptionsResponse: Available methods and HATEOAS links
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Get current database administration status"
            ),
            MethodInfo(
                method="POST",
                description="Initialise database or reset (see links for actions)"
            )
        ],
        links=get_admin_links(request)
    )


@router.get("", response_model=AdminStatusResponse, description="Get database administration status")
async def get_admin_status(request: Request):
    """
    Get current database administration status with available actions.

    Returns current database state and available administrative actions as HATEOAS links.
    This is a Level 3 REST API endpoint that allows clients to discover available actions.

    Returns:
        AdminStatusResponse: Current database status with links to available actions

    Example:
        >>> # GET /api/admin/status
        {
            "is_initialised": true,
            "table_count": 8,
            "timestamp": "2026-01-29T10:30:00.000000",
            "links": [
                {
                    "rel": "self",
                    "href": "http://localhost:3002/api/admin/status",
                    "method": "GET",
                    "title": "Get current database administration status"
                },
                {
                    "rel": "init",
                    "href": "http://localhost:3002/api/admin/database/init",
                    "method": "POST",
                    "title": "Initialise the database"
                }
            ]
        }
    """
    try:
        is_initialised, table_count = get_database_status()
        return AdminStatusResponse(
            is_initialised=is_initialised,
            table_count=table_count,
            timestamp=datetime.now(timezone.utc).isoformat(),
            links=get_admin_links(request)
        )
    except Exception as e:
        logger.error(f"Error getting admin status: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/database/init", response_model=MessageResponse, status_code=201, description="Initialise the database")
async def initialise_database(request: Request):
    """
    Initialise database tables (idempotent operation) with HATEOAS links.

    Creates all tables defined in the SQLAlchemy models if they don't already exist.
    This operation is safe to run multiple times - it will not drop or modify existing
    tables or data. Response includes links to available next actions.

    This is a Level 3 REST API endpoint that returns hypermedia links.

    Returns:
        MessageResponse: Success message with HATEOAS links to available actions.

    Raises:
        HTTPException: 500 error if database initialisation fails.

    Example:
        >>> # POST /api/admin/database/init
        {
            "message": "Database initialised successfully",
            "details": {"note": "All tables created or verified"},
            "links": [
                {
                    "rel": "self",
                    "href": "http://localhost:3002/api/admin/status",
                    "method": "GET",
                    "title": "Get current database administration status"
                }
            ]
        }

    Note:
        - This operation is idempotent and safe to run multiple times
        - Existing tables and data are preserved
        - Only missing tables are created
        - Clients should follow the links in the response to discover available actions

    Use Cases:
        - First-time setup of the database
        - Creating missing tables after adding new models
        - Recovery after accidental table deletion
    """
    try:
        init_db()
        logger.info("Database initialized successfully")
        return MessageResponse(message="Database initialized successfully",
                               details={"note": "All tables created or verified"},
                               links=get_admin_links(request))
    except Exception as e:
        logger.error(f"Error initializing DB: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Error initializing database: {str(e)}"
        )


async def reset_database(
        request: Request,
        force: bool = Query(
            False,
            description="Must be set to true to confirm the destructive operation"
        )
):
    """
    Reset database by dropping and recreating all tables (DESTRUCTIVE) with HATEOAS links.

    WARNING: This operation will permanently delete ALL data in the database!

    Drops all existing tables and recreates them from scratch. This operation cannot
    be undone and will result in complete data loss. Always ensure you have a backup
    before running this endpoint. Response includes HATEOAS links to available actions.

    This is a Level 3 REST API endpoint that returns hypermedia links.

    Args:
        request: FastAPI Request object for generating absolute URLs
        force (bool): Must be explicitly set to True to confirm the destructive operation.
            Defaults to False.

    Returns:
        MessageResponse: Success message with HATEOAS links and reset confirmation.

    Raises:
        HTTPException: 400 error if force parameter is not True.
        HTTPException: 500 error if database reset fails.

    Example:
        >>> # POST /api/admin/database/reset?force=true
        {
            "message": "Database reset successfully",
            "details": {"warning": "All previous data has been permanently deleted"},
            "links": [
                {
                    "rel": "init",
                    "href": "http://localhost:3002/api/admin/database/init",
                    "method": "POST",
                    "title": "Initialise the database"
                }
            ]
        }

    Warning:
        This is a DESTRUCTIVE operation that cannot be undone. All data will be
        permanently deleted. Always backup your database before using this endpoint.

    Note:
        - Requires explicit force=true query parameter
        - Should be disabled or restricted in production environments
        - Consider implementing additional authentication/authorisation checks
        - Clients should follow the links in the response to discover next actions

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
        error_response = MessageResponse(
            message="Database reset requires force=true parameter",
            details={"error": "Set force=true query parameter to confirm reset (DESTRUCTIVE OPERATION)"},
            links=get_admin_links(request)
        )
        return JSONResponse(
            content=error_response.model_dump(),
            status_code=400
        )

    try:
        logger.warning("Database reset initiated - dropping all tables")
        Base.metadata.drop_all(bind=engine)
        Base.metadata.create_all(bind=engine)
        logger.info("Database reset completed successfully")

        return MessageResponse(
            message="Database reset successfully",
            details={"warning": "All previous data has been permanently deleted"},
            links=get_admin_links(request)
        )
    except Exception as e:
        logger.error(f"Error resetting DB: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Error resetting database: {str(e)}"
        )


# Conditionally register endpoints based on config
_settings = get_settings()
if _settings.admin.enable_reset_db:
    # Register Level 3 HATEOAS endpoint
    router.post(
        "/database/reset",
        response_model=MessageResponse,
        status_code=200,
        description="Reset the Database (DESTRUCTIVE)"
    )(reset_database)
