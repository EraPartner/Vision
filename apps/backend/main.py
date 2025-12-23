"""
Financial Transaction Manager API

Main application entry point. Combines routes and middleware configuration.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api import (
    transactions_router,
    categories_router,
    recipients_router,
    statistics_router,
    import_router,
    admin_router
)
from config.config import get_settings
from config.logging_config import setup_logging
from database.connection import init_db

# Setup logging
logger = setup_logging(__name__)

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


@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "message": "Financial Transaction Manager API",
        "status": "running",
        "version": settings.api.version,
        "environment": settings.environment
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=settings.server.host, port=settings.server.port)
