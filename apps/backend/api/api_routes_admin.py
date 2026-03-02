"""Administrative API routes for database lifecycle operations.

Provides administrative endpoints for managing database lifecycle operations,
including initialisation and reset. These endpoints require elevated privileges
and should be restricted in production environments.

Level 3 REST API (HATEOAS) implementation where responses include hypermedia
links guiding clients to available actions.

Security Considerations:
    - All endpoints should be protected with authentication/authorisation
    - Reset operations are destructive and must be explicitly enabled
    - Rate limiting recommended to prevent abuse
    - Audit logging enabled for all operations
"""
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Query, Request, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from api.api_schemas import MessageResponse, AdminStatusResponse, OptionsResponse, MethodInfo
from config.config import get_settings
from config.logging_config import setup_logging
from database.connection import get_db
from services.admin_service import (
    check_database_status,
    perform_initialise,
    perform_reset,
)
from services.hateoas_links import generate_admin_links

router = APIRouter(prefix="/api/admin", tags=["admin"])
logger = setup_logging(__name__)



@router.options("", response_model=OptionsResponse, description="Discover available admin operations")
async def admin_options(request: Request):
    """Discover available HTTP methods on admin endpoint (CORS preflight support).

    Enables clients to discover available administrative operations before
    making actual requests. Essential for CORS preflight requests in browsers.

    Returns:
        OptionsResponse: Available methods with descriptions and HATEOAS links

    Security Note:
        Should be protected with same authorisation as other admin endpoints.
    """
    return OptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve current database administration status"
            ),
            MethodInfo(
                method="POST",
                description="Perform administrative actions (init or reset)"
            )
        ],
        links=generate_admin_links(request)
    )


@router.get("", response_model=AdminStatusResponse, description="Retrieve database administration status")
async def get_admin_status(request: Request, db: Session = Depends(get_db)):
    """Retrieve current database administration status with available actions.

    Provides database initialisation state and dynamically generated links to
    available administrative operations. Implements Level 3 REST (HATEOAS) for
    client-driven navigation.

    Args:
        request: FastAPI request for URL construction
        db: Database session (injected)

    Returns:
        AdminStatusResponse: Database status with HATEOAS links

    Raises:
        HTTPException: 500 if status retrieval fails

    Example Response:
        {
            "is_initialised": true,
            "table_count": 8,
            "timestamp": "2026-02-19T10:30:00.000000",
            "links": [
                {
                    "rel": "self",
                    "href": "http://localhost:3002/api/admin",
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

    Performance Note:
        Lightweight operation - only inspects table metadata without querying data.
    """
    try:
        is_initialised, table_count = check_database_status(db)
        return AdminStatusResponse(
            is_initialised=is_initialised,
            table_count=table_count,
            timestamp=datetime.now(timezone.utc),
            links=generate_admin_links(request)
        )
    except Exception as e:
        logger.error(
            "Admin status retrieval failed",
            extra={
                "operation": "get_admin_status",
                "resource_type": "admin",
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to retrieve administration status"
        )


@router.post("/database/init", response_model=MessageResponse, status_code=201,
             description="Initialise database tables")
async def initialise_database(request: Request, db: Session = Depends(get_db)):
    """Initialise database tables (idempotent, safe operation).

    Creates all tables defined in SQLAlchemy models if they don't exist.
    Preserves existing tables and data - safe to run multiple times.

    Idempotent operation suitable for:
    - Initial application setup
    - Adding tables after model updates
    - Recovery after accidental table deletion

    Args:
        request: FastAPI request for URL construction
        db: Database session (injected)

    Returns:
        MessageResponse: Success confirmation with HATEOAS links

    Raises:
        HTTPException: 500 if initialisation fails

    Example Response:
        {
            "message": "Database initialised successfully",
            "details": {"note": "All tables created or verified"},
            "links": [
                {
                    "rel": "self",
                    "href": "http://localhost:3002/api/admin",
                    "method": "GET",
                    "title": "Get current database administration status"
                }
            ]
        }

    Performance Note:
        Fast operation - only creates missing tables, doesn't modify existing data.

    Security Note:
        Should require elevated privileges in production environments.
    """
    try:
        perform_initialise(db)
        logger.info(
            "Database initialised successfully",
            extra={
                "operation": "database_init",
                "resource_type": "database",
                "status": "success"
            }
        )
        return MessageResponse(
            message="Database initialised successfully",
            details={"note": "All tables created or verified"},
            links=generate_admin_links(request)
        )
    except Exception as e:
        logger.error(
            "Database initialisation failed",
            extra={
                "operation": "database_init",
                "resource_type": "database",
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(
            status_code=500,
            detail=f"Database initialisation failed: {str(e)}"
        )


@router.post(
    "/database/reset",
    response_model=MessageResponse,
    status_code=200,
    description="Reset Database (DESTRUCTIVE)"
)
async def reset_database(
    request: Request,
    db: Session = Depends(get_db),
    force: bool = Query(
        False,
        description="Must be true to confirm destructive operation"
    )
):
    """Reset database by dropping and recreating all tables (DESTRUCTIVE).

    ⚠️ WARNING: Permanently deletes ALL data - cannot be undone!

    Drops all tables and recreates them from schema. Requires explicit confirmation
    via force=true parameter to prevent accidental data loss.

    Recommended for:
    - Development environment resets
    - Test data cleanup
    - Schema migrations when starting fresh

    Args:
        request: FastAPI Request for generating URLs
        db: Database session (injected)
        force: Must be explicitly true to execute (safety measure)

    Returns:
        MessageResponse: Confirmation with HATEOAS links

    Raises:
        HTTPException: 400 if force parameter not true
        HTTPException: 500 if reset fails

    Example Response (Success):
        {
            "message": "Database reset successfully",
            "details": {"warning": "All previous data permanently deleted"},
            "links": [...]
        }

    Example Response (Safety Check):
        HTTP 400 Bad Request
        {
            "message": "Database reset requires force=true parameter",
            "details": {"error": "Set force=true to confirm reset"},
            ...
        }

    Security Notes:
        - Should be disabled in production (configurable)
        - Requires elevated authorisation
        - Always backup before using
        - Consider implementing additional confirmation mechanisms
        - Rate limit to prevent abuse

    Performance Note:
        Potentially slow operation depending on database size and constraints.
    """
    settings = get_settings()

    if not settings.admin.enable_reset_db:
        raise HTTPException(status_code=404, detail="Database reset endpoint disabled")

    if not force:
        logger.warning(
            "Database reset rejected - force parameter not provided",
            extra={
                "operation": "reset_database",
                "resource_type": "database",
                "status": "rejected",
                "reason": "force_parameter_missing"
            }
        )
        error_response = MessageResponse(
            message="Database reset requires force=true parameter",
            details={"error": "Set force=true query parameter to confirm reset (DESTRUCTIVE)"},
            links=generate_admin_links(request)
        )
        return JSONResponse(
            content=error_response.model_dump(),
            status_code=400
        )

    try:
        logger.warning(
            "Database reset initiated - dropping all tables",
            extra={
                "operation": "reset_database",
                "resource_type": "database",
                "status": "in_progress"
            }
        )
        perform_reset(db)
        logger.info(
            "Database reset completed successfully",
            extra={
                "operation": "reset_database",
                "resource_type": "database",
                "status": "success"
            }
        )

        return MessageResponse(
            message="Database reset successfully",
            details={"warning": "All previous data permanently deleted"},
            links=generate_admin_links(request)
        )
    except Exception as e:
        logger.error(
            "Database reset failed",
            extra={
                "operation": "reset_database",
                "resource_type": "database",
                "status": "failed"
            },
            exc_info=True
        )
        raise HTTPException(
            status_code=500,
            detail=f"Database reset failed: {str(e)}"
        )
