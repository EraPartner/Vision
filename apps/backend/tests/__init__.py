"""
Tests package for Financial Transaction Manager API.

This package contains comprehensive unit and integration tests for all API endpoints
and business logic. Tests are organized by functional areas:

- test_main.py: Application startup, configuration, and core functionality
- test_admin.py: Administrative endpoints and database operations
- test_categories.py: Category CRUD operations and business logic
- conftest.py: Shared fixtures and test configuration

Test Categories:
- Unit tests: Fast, isolated tests for individual functions/methods
- Integration tests: Tests that verify component interaction
- Database tests: Tests that require database operations
- Slow tests: Long-running or complex tests

Usage:
    # Run all tests
    pytest tests/

    # Run specific test file
    pytest tests/test_categories.py

    # Run tests with coverage
    pytest --cov=. tests/

    # Run specific test categories
    pytest -m unit tests/
    pytest -m database tests/
"""
