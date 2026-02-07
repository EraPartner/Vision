"""
Financial Transaction Manager API

Main application entry point. Combines routes and middleware configuration.
"""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from typing import AsyncGenerator

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api import (
    transactions_router,
    categories_router,
    recipients_router,
    info_router,
    import_router,
    admin_router
)
from api.api_schemas import RootOptionsResponse, APIRootResponse, MethodInfo
from api.hateoas_links import get_root_links
from config.config import get_settings
from config.logging_config import setup_logging
from database.connection import init_db

# Setup logging
logger = setup_logging(__name__)

# Get configuration
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Application lifespan manager for startup and shutdown events.

    Handles:
    - Database initialisation with comprehensive error handling
    - Configuration validation
    - Structured logging for audit trails
    - Graceful error propagation

    Args:
        app: FastAPI application instance

    Yields:
        None: Control back to FastAPI framework

    Raises:
        SystemExit: If critical startup operations fail
    """
    # Startup operations
    logger.info(
        "Starting up Financial Transaction Manager API",
        extra={
            "operation": "startup",
            "resource_type": "application",
            "version": settings.api.version,
            "environment": settings.server.environment
        }
    )

    try:
        # Validate critical configuration
        _validate_startup_configuration()

        # Initialise database with retry logic
        await _initialise_database_with_retry()

        logger.info(
            "Application startup completed successfully",
            extra={
                "operation": "startup_complete",
                "resource_type": "application",
                "status": "success"
            }
        )

    except Exception as e:
        logger.error(
            "Critical failure during application startup",
            extra={
                "operation": "startup",
                "resource_type": "application",
                "status": "failed",
                "error_type": type(e).__name__
            },
            exc_info=True
        )
        # Re-raise to prevent application from starting with invalid state
        raise SystemExit(f"Application startup failed: {str(e)}") from e

    yield

    # Shutdown operations
    logger.info(
        "Shutting down Financial Transaction Manager API",
        extra={
            "operation": "shutdown",
            "resource_type": "application"
        }
    )


def _validate_startup_configuration() -> None:
    """
    Validate critical configuration settings at startup.

    Raises:
        ValueError: If required configuration is missing or invalid
    """
    if not settings.api.title:
        raise ValueError("API title configuration is required")

    if not settings.api.version:
        raise ValueError("API version configuration is required")

    logger.debug(
        "Configuration validation completed",
        extra={
            "operation": "config_validation",
            "resource_type": "configuration",
            "status": "success"
        }
    )


async def _initialise_database_with_retry(max_retries: int = 3) -> None:
    """
    Initialise database with retry logic for robustness.

    Args:
        max_retries: Maximum number of retry attempts

    Raises:
        Exception: If database initialisation fails after all retries
    """
    for attempt in range(1, max_retries + 1):
        try:
            init_db()
            logger.info(
                "Database initialised successfully",
                extra={
                    "operation": "database_init",
                    "resource_type": "database",
                    "status": "success",
                    "attempt": attempt
                }
            )
            return

        except Exception as e:
            logger.warning(
                f"Database initialisation attempt {attempt} failed",
                extra={
                    "operation": "database_init",
                    "resource_type": "database",
                    "status": "retry",
                    "attempt": attempt,
                    "max_retries": max_retries,
                    "error_type": type(e).__name__
                },
                exc_info=attempt == max_retries  # Only log full traceback on final failure
            )

            if attempt == max_retries:
                raise

            # Brief delay before retry
            await asyncio.sleep(1.0)


# Create FastAPI app with enhanced configuration
app = FastAPI(
    title=settings.api.title,
    description=settings.api.description,
    version=settings.api.version,
    lifespan=lifespan,
    docs_url="/docs" if settings.server.environment == "development" else None,
    redoc_url="/redoc" if settings.server.environment == "development" else None,
)


# Add global exception handler for better error management
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    Global exception handler to ensure consistent error responses.

    Prevents sensitive information leakage while maintaining audit trails.

    Args:
        request: The request that caused the exception
        exc: The exception that was raised

    Returns:
        JSONResponse: Standardised error response
    """
    logger.error(
        "Unhandled exception occurred",
        extra={
            "operation": "global_exception_handler",
            "resource_type": "application",
            "status": "error",
            "error_type": type(exc).__name__,
            "path": str(request.url.path),
            "method": request.method,
            "client_ip": request.client.host if request.client else "unknown"
        },
        exc_info=True
    )

    # Return generic error message to prevent information leakage
    return JSONResponse(
        status_code=500,
        content={
            "detail": "An internal server error occurred. Please try again later.",
            "error_code": "INTERNAL_SERVER_ERROR"
        }
    )


# Add CORS middleware with security considerations
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.api.cors_origins,
    allow_credentials=settings.api.cors_credentials,
    allow_methods=settings.api.cors_methods,
    allow_headers=settings.api.cors_headers,
)


# Health check endpoint for monitoring
@app.get("/health", tags=["Health"], include_in_schema=False)
async def health_check() -> JSONResponse:
    """
    Health check endpoint for load balancers and monitoring systems.

    Returns basic application health status without exposing sensitive information.

    Returns:
        JSONResponse: Health status information
    """
    logger.debug(
        "Health check requested",
        extra={
            "operation": "health_check",
            "resource_type": "health"
        }
    )

    return JSONResponse(
        status_code=200,
        content={
            "status": "healthy",
            "service": "financial-transaction-manager",
            "version": settings.api.version,
            "timestamp": datetime.now().isoformat(),
        }
    )


# Register route modules with error handling
_ROUTERS = [
    ("transactions", transactions_router),
    ("categories", categories_router),
    ("recipients", recipients_router),
    ("info", info_router),
    ("import", import_router),
    ("admin", admin_router)
]

for router_name, router in _ROUTERS:
    try:
        app.include_router(router)
        logger.debug(
            f"Successfully registered {router_name} router",
            extra={
                "operation": "router_registration",
                "resource_type": "router",
                "router_name": router_name,
                "status": "success"
            }
        )
    except Exception as e:
        logger.error(
            f"Failed to register {router_name} router",
            extra={
                "operation": "router_registration",
                "resource_type": "router",
                "router_name": router_name,
                "status": "failed",
                "error_type": type(e).__name__
            },
            exc_info=True
        )
        raise SystemExit(f"Critical error: Failed to register {router_name} router") from e

logger.info(
    "All route modules configured successfully",
    extra={
        "operation": "router_setup",
        "resource_type": "application",
        "router_count": len(_ROUTERS)
    }
)


@app.options("/api/", response_model=RootOptionsResponse, tags=["Root"])
async def root_options(request: Request) -> RootOptionsResponse:
    """
    OPTIONS method for API root endpoint discovery.

    Provides Level 3 REST API (HATEOAS) compliance by allowing clients to discover
    available HTTP methods and navigate the API through hypermedia links.

    This endpoint supports API discoverability and follows REST maturity model
    Level 3 by including hypermedia controls that guide client interactions.

    Args:
        request: FastAPI Request object for generating absolute URLs

    Returns:
        RootOptionsResponse: Available methods and all API resource links

    Security:
        - Logs client access for audit purposes
        - Does not expose sensitive system information
        - Provides safe navigation endpoints only

    Example Response:
        {
            "methods": [{"method": "GET", "description": "..."}],
            "description": "API root discovery endpoint...",
            "links": [...]
        }
    """
    client_ip = "unknown"
    if request.client:
        client_ip = request.client.host

    logger.debug(
        "API root OPTIONS request received",
        extra={
            "operation": "root_options",
            "resource_type": "api_root",
            "client_ip": client_ip,
            "user_agent": request.headers.get("user-agent", "unknown")
        }
    )

    try:
        return RootOptionsResponse(
            methods=[
                MethodInfo(
                    method="GET",
                    description="Retrieve API root with available resources"
                ),
                MethodInfo(
                    method="OPTIONS",
                    description="Discover available methods on API root"
                )
            ],
            description="API root discovery endpoint for Level 3 REST API (HATEOAS)",
            links=get_root_links(request)
        )
    except Exception as e:
        logger.error(
            "Error generating root options response",
            extra={
                "operation": "root_options",
                "resource_type": "api_root",
                "status": "failed",
                "error_type": type(e).__name__
            },
            exc_info=True
        )
        raise HTTPException(
            status_code=500,
            detail="Unable to generate API options"
        ) from e


@app.get("/api/", response_model=APIRootResponse, status_code=200, tags=["Root"])
async def root(request: Request) -> APIRootResponse:
    """
    API root discovery endpoint with HATEOAS links.

    Serves as the entry point for Level 3 REST API navigation, providing hypermedia
    links that guide clients to available resources and operations. This endpoint
    implements the HATEOAS (Hypermedia As The Engine Of Application State) principle.

    Features:
    - API version information
    - Hypermedia links to all available resources
    - Self-documenting through links
    - Audit logging for access tracking

    Args:
        request: FastAPI Request object for generating absolute URLs

    Returns:
        APIRootResponse: API metadata and navigation links

    Security:
        - Logs all access for audit purposes
        - No sensitive information exposed
        - Rate limiting applied through middleware

    Example Response:
        {
            "version": "1.0.0",
            "title": "Financial Transaction Manager",
            "description": "...",
            "links": [...]
        }
    """
    client_ip = "unknown"
    if request.client:
        client_ip = request.client.host

    logger.info(
        "API root accessed",
        extra={
            "operation": "root_access",
            "resource_type": "api_root",
            "client_ip": client_ip,
            "user_agent": request.headers.get("user-agent", "unknown"),
            "api_version": settings.api.version
        }
    )

    try:
        return APIRootResponse(
            version=settings.api.version,
            title=settings.api.title,
            description=settings.api.description,
            links=get_root_links(request),
        )
    except Exception as e:
        logger.error(
            "Error generating root response",
            extra={
                "operation": "root_access",
                "resource_type": "api_root",
                "status": "failed",
                "error_type": type(e).__name__
            },
            exc_info=True
        )
        raise HTTPException(
            status_code=500,
            detail="Unable to generate API root response"
        ) from e


def main() -> None:
    """
    Main entry point function for the application.

    This function contains the logic that would normally be in the __main__ block,
    making it testable while maintaining the same functionality.
    """
    import uvicorn

    try:
        logger.info(
            "Starting development server",
            extra={
                "operation": "dev_server_start",
                "resource_type": "server",
                "host": settings.server.host,
                "port": settings.server.port,
                "environment": settings.server.environment
            }
        )

        uvicorn.run(
            "main:app",
            host=settings.server.host,
            port=settings.server.port,
            log_level="info" if settings.server.environment == "production" else "debug",
            access_log=True,
            reload=settings.server.environment == "development"
        )

    except Exception as e:
        logger.error(
            "Failed to start development server",
            extra={
                "operation": "dev_server_start",
                "resource_type": "server",
                "status": "failed",
                "error_type": type(e).__name__
            },
            exc_info=True
        )
        raise SystemExit("Development server failed to start") from e


if __name__ == "__main__":
    """
    Direct execution entry point for development and testing.
    
    In production, this application should be run using a proper ASGI server
    like Gunicorn with Uvicorn workers for better performance and reliability.
    
    Example production command:
        gunicorn main:app -w 4 -k uvicorn.workers.UvicornWorker
    """
    main()
