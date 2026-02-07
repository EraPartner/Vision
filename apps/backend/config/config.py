"""
Configuration management for the Financial Transaction Manager

Handles environment-based settings and configuration validation.
"""
import os
from dataclasses import dataclass
from functools import lru_cache

# Load variables from .env.local.local if present (highest priority), then fall back to process env
from dotenv import load_dotenv

# Explicitly load .env.local.local in backend directory
CONFIG_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_LOCAL_PATH = os.path.join(CONFIG_DIR, ".env.local")

if os.path.exists(ENV_LOCAL_PATH):
    load_dotenv(ENV_LOCAL_PATH, override=True)


@dataclass
class ServerConfig:
    """Server configuration (sensitive values loaded from .env.local)"""
    host: str = os.getenv("HOSTNAME", "localhost")
    port: int = int(os.getenv("PORT", "8000"))
    environment: str = os.getenv("ENVIRONMENT", "development")


@dataclass
class DatabaseConfig:
    """Database configuration with validation"""
    url: str = os.getenv("DATABASE_URL", "sqlite:///./financial_transactions.db")
    echo: bool = os.getenv("DB_ECHO", "False").lower() == "true"
    pool_size: int = int(os.getenv("DB_POOL_SIZE", "5"))
    max_overflow: int = int(os.getenv("DB_MAX_OVERFLOW", "10"))


@dataclass
class APIConfig:
    """API configuration with CORS validation"""
    title: str = "Financial Transaction Manager"
    version: str = "1.0.0"
    description: str = "Import and manage financial transactions from various banks"

    # CORS settings
    cors_origins: list[str] = None
    cors_credentials: bool = True
    cors_methods: list[str] = None
    cors_headers: list[str] = None

    def __post_init__(self) -> None:
        """Initialise CORS configuration with defaults."""
        if self.cors_origins is None:
            cors_env = os.getenv("CORS_ORIGINS", "http://localhost:5174")
            self.cors_origins = [origin.strip() for origin in cors_env.split(",")]
        if self.cors_methods is None:
            self.cors_methods = ["*"]
        if self.cors_headers is None:
            self.cors_headers = ["*"]


@dataclass
class AdminConfig:
    """Admin API configuration"""
    enable_reset_db: bool = os.getenv("ENABLE_RESET_DB", "False").lower() == "true"


@dataclass
class Settings:
    """Main application settings with validation"""
    debug: bool = os.getenv("DEBUG", "True").lower() == "true"

    server: ServerConfig = None
    database: DatabaseConfig = None
    api: APIConfig = None
    admin: AdminConfig = None

    def __post_init__(self) -> None:
        """Initialise all configuration sections."""
        if self.server is None:
            self.server = ServerConfig()
        if self.database is None:
            self.database = DatabaseConfig()
        if self.api is None:
            self.api = APIConfig()
        if self.admin is None:
            self.admin = AdminConfig()

    def is_production(self) -> bool:
        """Check if running in production environment."""
        return self.server.environment.lower() == "production"

    def is_development(self) -> bool:
        """Check if running in development environment."""
        return self.server.environment.lower() == "development"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Get application settings (cached)"""
    return Settings()
