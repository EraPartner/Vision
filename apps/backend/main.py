"""
Financial Transaction Manager API

Main application entry point. Combines routes and middleware configuration.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from api import (
    transactions_router,
    categories_router,
    recipients_router,
    statistics_router,
    import_router,
    admin_router
)
from api.api_schemas import RootOptionsResponse, APIRootResponse, MethodInfo
from api.hateoas_links import get_root_links
from config.config import get_settings
from config.logging_config import setup_logging
from database.connection import init_db

# Setup logging
logger = setup_logging(__name__, use_json=True)

# Get configuration
settings = get_settings()


# Define lifespan handler to replace deprecated on_event
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("Starting up Financial Transaction Manager API")
    init_db()
    logger.info("Database initialized")

    yield

    # Shutdown
    logger.info("Shutting down Financial Transaction Manager API")


# Create FastAPI app
app = FastAPI(
    title=settings.api.title,
    description=settings.api.description,
    version=settings.api.version,
    lifespan=lifespan,
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.api.cors_origins,
    allow_credentials=settings.api.cors_credentials,
    allow_methods=settings.api.cors_methods,
    allow_headers=settings.api.cors_headers,
)

# Include route modules
app.include_router(transactions_router)
app.include_router(categories_router)
app.include_router(recipients_router)
app.include_router(statistics_router)
app.include_router(import_router)
app.include_router(admin_router)


@app.options("/api/", response_model=RootOptionsResponse, tags=["Root"])
async def root_options(request: Request):
    """
    OPTIONS method for API root endpoint discovery.

    Allows clients to discover what HTTP methods are available on the API root endpoint
    and view all available API resources.

    Returns:
        RootOptionsResponse: Available methods and all API resource links
    """
    return RootOptionsResponse(
        methods=[
            MethodInfo(
                method="GET",
                description="Retrieve API root with available resources"
            )
        ],
        description="API root discovery endpoint for Level 3 REST API (HATEOAS)",
        links=get_root_links(request)
    )


@app.get("/api/", response_model=APIRootResponse, status_code=200, tags=["Root"])
async def root(request: Request):
    """API root discovery endpoint with HATEOAS links"""
    return APIRootResponse(
        version=settings.api.version,
        title=settings.api.title,
        description=settings.api.description,
        links=get_root_links(request),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.server.host, port=settings.server.port)
