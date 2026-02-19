"""
Test configuration and fixtures for the Financial Transaction Manager API.

Provides shared test fixtures, database setup, and testing utilities.
"""
import sys
from pathlib import Path
from typing import Generator

# Add the backend directory to Python path for imports
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import StaticPool

from database.connection import get_db
from database.models import Base
from main import app


@pytest.fixture(scope="function")
def test_db() -> Generator[Session, None, None]:
    """
    Create a test database for each test function.
    Uses in-memory SQLite for fast, isolated tests.
    """
    # Create temporary in-memory database with proper SQLite configuration
    engine = create_engine(
        "sqlite:///:memory:",
        echo=False,
        connect_args={
            "check_same_thread": False,  # Allow SQLite to be used across threads
        },
        poolclass=StaticPool,  # Use StaticPool to maintain connection
    )
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    # Create all tables
    Base.metadata.create_all(bind=engine)

    # Create session
    session = TestingSessionLocal()

    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture(scope="function")
def client(test_db: Session) -> TestClient:
    """
    Create a test client with database dependency override.
    """

    def override_get_db():
        try:
            yield test_db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)

    yield client

    # Clean up
    app.dependency_overrides.clear()


@pytest.fixture
def sample_category_data():
    """Sample category data for testing."""
    return {
        "general": "groceries",
        "detail": "food",
        "description": "Food and grocery purchases"
    }


@pytest.fixture
def sample_category_update_data():
    """Sample category update data for testing."""
    return {
        "general": "updated_groceries",
        "detail": "updated_food",
        "description": "Updated description"
    }


@pytest.fixture
def sample_assign_category_data():
    """Sample category assignment data for testing."""
    return {
        "category_general": "groceries",
        "category_detail": "food",
        "recipient_ids": [1, 2, 3]
    }


@pytest.fixture
def multiple_categories_data():
    """Multiple sample categories for testing."""
    return [
        {"general": "groceries", "detail": "food", "description": "Food items"},
        {"general": "groceries", "detail": "beverages", "description": "Drinks"},
        {"general": "transport", "detail": "fuel", "description": "Vehicle fuel"},
        {"general": "transport", "detail": "maintenance", "description": "Vehicle maintenance"},
        {"general": "utilities", "detail": "electricity", "description": "Electric bills"}
    ]


@pytest.fixture
def sample_recipient_data():
    """Sample recipient data for testing."""
    return {
        "name": "john smith",
        "notes": "Test recipient",
        "is_active": True
    }


@pytest.fixture
def sample_recipient_update_data():
    """Sample recipient update data for testing."""
    return {
        "name": "updated recipient",
        "notes": "Updated notes"
    }


@pytest.fixture
def multiple_recipients_data():
    """Multiple sample recipients for testing."""
    return [
        {"name": "JOHN SMITH", "is_active": True},
        {"name": "JANE DOE", "is_active": True},
        {"name": "BOB JOHNSON", "is_active": True},
        {"name": "ALICE WILLIAMS", "is_active": True},
        {"name": "CHARLIE BROWN", "is_active": True}
    ]
