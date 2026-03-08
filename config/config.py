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
